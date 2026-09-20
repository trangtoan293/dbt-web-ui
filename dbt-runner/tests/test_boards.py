import asyncio
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.boards import parse_board, prepare_sql, validate_board, render_board, compose_board, add_chart, preview_query, preview_sql, explore_restrictions
from app.services.chart_reference import reference

BOARD = '''title: Sales dashboard
queries:
  sales: select 'Jan' as month, 20 as revenue
charts:
  trend: {type: bar, query: sales, x: month, y: revenue}
  detail: {type: table, query: sales}
rows:
  - cols: [trend, detail]
'''

def test_validate_multichart_board_with_real_engine():
    result = asyncio.run(validate_board(BOARD))
    assert result['valid']

def test_render_runs_each_query_once_and_preserves_layout():
    calls = []
    async def query(sql):
        calls.append(sql)
        return {'success': True, 'columns': ['month', 'revenue'], 'data': [{'month': 'Jan', 'revenue': 20}]}
    result = asyncio.run(render_board(BOARD, {}, query))
    assert len(calls) == 1
    assert result['html'].count('<svg') >= 1
    assert 'Sales dashboard' in result['html']
    assert result['query_count'] == 1

@pytest.mark.parametrize('sql', ['delete from orders', 'select 1; drop table orders', 'select * into backup from orders', "select * from read_csv('/etc/passwd')", "select {{ env_var('SECRET') }}", "select {{ cycler.__init__.__globals__ }}", 'with t as (delete from x returning *) select * from t'])
def test_rejects_unsafe_sql(sql):
    with pytest.raises(ValueError): prepare_sql(sql, {})

def test_variables_are_literals_and_refs_are_retained():
    sql = prepare_sql("select * from {{ ref('sales', 'orders') }} where {{ filter('region', region) }}", {'region': "x' OR 1=1 --"})
    assert 'ref("sales", "orders")' in sql
    assert "'x'' OR 1=1 --'" in sql

@pytest.mark.parametrize('extra', ['source: /etc/passwd', 'extends: /etc/passwd', 'theme: /etc/passwd', 'html_policy: trusted-raw'])
def test_external_sources_are_not_allowed(extra):
    with pytest.raises(ValueError): parse_board(BOARD + '\n' + extra)

def test_yaml_errors_report_line():
    with pytest.raises(ValueError, match='[Ll]ine'): parse_board('charts: [\n')

def test_rejects_cross_file_charts():
    board = yaml.safe_load(BOARD)
    for reference in ['other.charts.secret', {'ref': 'other.charts.secret'}]:
        board['charts']['trend'] = reference
        with pytest.raises(ValueError): parse_board(yaml.safe_dump(board))

def test_rejects_duplicate_keys_and_aliases():
    for text in ['title: a\ntitle: b\n' + BOARD, 'x: &x [*x]\n' + BOARD]:
        with pytest.raises(ValueError): parse_board(text)

def test_invalid_chart_is_reported_before_query_execution():
    result = asyncio.run(validate_board(BOARD.replace('type: bar', 'type: nonexistent')))
    assert not result['valid']
    assert result['diagnostics']

def test_inline_queries_render_without_warehouse():
    board = yaml.safe_load(BOARD)
    board['queries']['sales'] = {'columns': ['month', 'revenue'], 'values': [['Jan', 20]]}
    async def forbidden(sql): raise AssertionError('warehouse should not be called')
    result = asyncio.run(render_board(yaml.safe_dump(board), {}, forbidden))
    assert '<svg' in result['html']

def test_compose_preserves_existing_charts_and_creates_refreshable_sql():
    from app.services.charts import ChartRequest, render_chart
    snapshot = asyncio.run(render_chart(ChartRequest(data=[{'month': 'Jan', 'revenue': 20}], columns=['month', 'revenue'], chart_type='bar', x='month', y='revenue')))
    composed = compose_board(BOARD, snapshot['yaml'], "select 'Jan' as month, 20 as revenue", ['month', 'revenue'])
    board = parse_board(composed['yaml'])
    assert len(board['charts']) == 3
    assert 'adapter.quote("month")' in board['queries']['query_1']
    assert asyncio.run(validate_board(composed['yaml']))['valid']

def test_many_references_do_not_corrupt_placeholder_names():
    sql = 'select ' + ', '.join("{{ adapter.quote('col" + str(i) + "') }}" for i in range(12)) + ' from example'
    prepared = prepare_sql(sql, {})
    assert 'adapter.quote("col10")' in prepared
    assert '__board_ref' not in prepared

def test_diagnostic_points_to_authored_chart_line():
    result = asyncio.run(validate_board(BOARD.replace('type: bar', 'type: nonexistent')))
    assert result['diagnostics']['errors'][0]['line'] == 5

def test_filters_are_bound_on_each_refresh():
    content = BOARD.replace("select 'Jan' as month, 20 as revenue", "select 'Jan' as month, 20 as revenue where {{ filter('region', region) }}") + '\nvariables:\n  region:\n    input: select\n    options: {static: [US, EU]}\n    default: US\n'
    calls = []
    async def query(sql):
        calls.append(sql)
        return {'success': True, 'columns': ['month', 'revenue'], 'data': [{'month': 'Jan', 'revenue': 20}]}
    asyncio.run(render_board(content, {'region': 'EU'}, query))
    assert "region = 'EU'" in calls[0]

def test_board_routes_check_project_owner_before_parsing_or_execution(monkeypatch):
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient
    from app.routers import charts
    app = FastAPI()
    app.include_router(charts.router)
    app.dependency_overrides[charts.get_session] = lambda: None
    app.dependency_overrides[charts.get_dbt_service] = lambda: None
    async def user(*args): return 'owner'
    checked = []
    async def ownership(session, project, uid):
        checked.append((project, uid))
        if project != 'mine': raise HTTPException(403, 'Forbidden')
    monkeypatch.setattr(charts, 'resolve_user_id', user)
    monkeypatch.setattr(charts, 'verify_project_ownership', ownership)
    with TestClient(app) as client:
        assert client.post('/charts/mine/board/validate', json={'yaml': BOARD}).status_code == 401
        app.dependency_overrides[charts.require_user] = lambda: {'sub': 'owner'}
        assert client.post('/charts/other/board/render', json={'yaml': BOARD}).status_code == 403
        for action in ('chart', 'query'):
            assert client.post(f'/charts/other/board/{action}', json={'yaml': BOARD}).status_code == 403
        assert client.post('/charts/mine/board/validate', json={'yaml': BOARD}).json()['valid']
        assert checked == [('other', 'owner'), ('other', 'owner'), ('other', 'owner'), ('mine', 'owner')]

COMMENTED = '''# Operations board — keep this comment
title: Sales dashboard
queries:
  sales: select 'Jan' as month, 20 as revenue
charts:
  trend: {type: bar, query: sales, x: month, y: revenue}
rows:
  - trend
'''


async def _rows(sql):
    return {'success': True, 'columns': ['month', 'revenue'], 'data': [{'month': 'Jan', 'revenue': 20}]}


def test_unknown_column_is_refused_instead_of_rendering_an_empty_chart():
    # dct renders a misspelled column as an empty chart and still exits 0.
    with pytest.raises(ValueError, match='revenu'):
        asyncio.run(render_board(COMMENTED.replace('y: revenue', 'y: revenu'), {}, _rows))


def test_render_warnings_carry_the_engine_fix_at_the_authored_line():
    warning = asyncio.run(render_board(COMMENTED, {}, _rows))['warnings'][0]
    assert warning['code'].startswith('WARN-')
    assert warning['fix'] and warning['chart'] == 'trend'
    assert COMMENTED.splitlines()[warning['line'] - 1].startswith('  trend:')


def test_add_chart_preserves_comments_and_extends_the_layout():
    added = add_chart(COMMENTED, {'query': 'sales', 'type': 'line', 'x': 'month', 'y': 'revenue',
                                  'number_format': 'currency'}, ['month', 'revenue'])
    board = parse_board(added['yaml'])
    assert 'keep this comment' in added['yaml']
    assert board['charts'][added['name']]['style'] == {'number_format': 'currency'}
    assert board['rows'] == ['trend', added['name']]
    assert asyncio.run(render_board(added['yaml'], {}, _rows))['html'].count('<svg') >= 2


def test_add_chart_leaves_a_tabs_layout_to_the_author():
    tabbed = COMMENTED.replace('rows:\n  - trend\n', 'tabs:\n  items:\n    - title: One\n      rows: [trend]\n')
    added = add_chart(tabbed, {'query': 'sales', 'type': 'table'}, ['month', 'revenue'])
    assert added['name'] in parse_board(added['yaml'])['charts']
    assert 'tabs' in added['notice']


@pytest.mark.parametrize('spec', [
    {'query': 'sales', 'type': 'line', 'x': 'month', 'y': 'missing'},
    {'query': 'sales', 'type': 'sankey', 'x': 'month', 'y': 'revenue'},
    {'query': 'other', 'type': 'line', 'x': 'month', 'y': 'revenue'},
    {'query': 'sales', 'type': 'line', 'x': 'month', 'y': 'revenue', 'name': 'trend'},
])
def test_add_chart_rejects_unusable_specs(spec):
    with pytest.raises(ValueError):
        add_chart(COMMENTED, spec, ['month', 'revenue'])


def test_preview_query_returns_the_columns_the_chart_builder_offers():
    result = asyncio.run(preview_query(COMMENTED, {}, 'sales', _rows))
    assert result['columns'] == ['month', 'revenue'] and result['rows'] == [['Jan', 20]]


def test_render_returns_the_outline_and_variables_without_a_second_validate_pass():
    result = asyncio.run(render_board(BOARD, {}, _rows))
    assert result['outline'] == {'queries': ['sales'],
                                 'charts': [{'name': 'trend', 'type': 'bar', 'query': 'sales'},
                                            {'name': 'detail', 'type': 'table', 'query': 'sales'}]}
    assert result['variables'] == {}


@pytest.mark.parametrize('slug', [example['slug'] for example in reference()['examples']])
def test_bundled_samples_render_through_the_app_subset(slug):
    async def forbidden(sql): raise AssertionError('samples carry inline data')
    sample = next(item for item in reference()['examples'] if item['slug'] == slug)
    assert '<svg' in asyncio.run(render_board(sample['yaml'], {}, forbidden))['html']


def test_reference_topics_come_from_the_installed_package():
    slugs = [topic['slug'] for topic in reference()['topics']]
    assert {'charts', 'variables', 'layout', 'queries'} <= set(slugs)


def test_chart_builder_creates_a_whole_board_from_sql():
    added = add_chart('', {'sql': "select region, sum(amount) as total from {{ ref('orders') }} group by 1",
                           'type': 'bar', 'x': 'region', 'y': 'total'}, ['region', 'total'])
    board = parse_board(added['yaml'])
    assert board['queries'][added['query']].startswith('select region')
    assert board['charts'][added['name']]['query'] == added['query']
    assert board['rows'] == [added['name']]


def test_chart_builder_adds_its_sql_to_an_existing_board():
    added = add_chart(COMMENTED, {'sql': "select region, sum(amount) as total\nfrom {{ ref('orders') }}\ngroup by 1",
                                  'type': 'kpi', 'y': 'total'}, ['region', 'total'])
    board = parse_board(added['yaml'])
    assert 'keep this comment' in added['yaml']
    assert set(board['queries']) == {'sales', added['query']}
    assert board['rows'] == ['trend', added['name']]


@pytest.mark.parametrize('sql', ['delete from orders', "select * from read_csv('/etc/passwd')", 'select 1; drop table orders'])
def test_chart_builder_refuses_sql_a_board_query_could_not_hold(sql):
    with pytest.raises(ValueError):
        add_chart('', {'sql': sql, 'type': 'table'}, ['a'])


def test_preview_sql_runs_the_prepared_statement_only():
    seen = []
    async def runner(sql):
        seen.append(sql)
        return {'success': True, 'columns': ['region'], 'data': [{'region': 'EU'}]}
    result = asyncio.run(preview_sql("select region from {{ ref('orders') }}", runner))
    assert result == {'columns': ['region'], 'row_count': 1, 'rows': [['EU']]}
    assert 'ref("orders")' in seen[0]
    with pytest.raises(ValueError):
        asyncio.run(preview_sql('drop table orders', runner))
    with pytest.raises(ValueError):
        asyncio.run(preview_sql('   ', runner))


@pytest.mark.parametrize('kind', ['bar', 'line', 'area', 'scatter', 'pie', 'donut', 'histogram', 'heatmap', 'kpi', 'table'])
def test_every_offered_chart_type_validates_with_a_number_format(kind):
    # Only some families own a number_format slot; the rest reject it as an unknown field.
    spec = {'sql': "select region, sum(amount) as total from {{ ref('orders') }} group by 1",
            'type': kind, 'x': 'region', 'y': 'total', 'color': 'total', 'number_format': 'currency'}
    added = add_chart('', spec, ['region', 'total'])
    assert asyncio.run(validate_board(added['yaml']))['valid'], kind


def test_a_comment_only_board_is_new_work_not_a_broken_one():
    placeholder = '# A new dashboard.\n# Add chart writes the first query.\n'
    added = add_chart(placeholder, {'sql': "select month, sum(amount) as revenue from {{ ref('orders') }} group by 1",
                                    'type': 'bar', 'x': 'month', 'y': 'revenue'}, ['month', 'revenue'])
    assert added['yaml'].startswith('# A new dashboard.')
    assert parse_board(added['yaml'])['charts'][added['name']]['query'] == added['query']


@pytest.mark.parametrize('title', ['Monthly revenue', ''])
def test_a_built_board_renders_without_engine_warnings(title):
    # A board title above a single titled chart reads as two headers for one chart.
    async def rows(sql):
        return {'success': True, 'columns': ['month', 'revenue'],
                'data': [{'month': '2026-01', 'revenue': 91200}, {'month': '2026-02', 'revenue': 104300}]}
    added = add_chart('# new\n', {'sql': "select month, sum(amount) as revenue from {{ ref('orders') }} group by 1",
                                  'type': 'line', 'x': 'month', 'y': 'revenue', 'title': title,
                                  'number_format': 'currency'}, ['month', 'revenue'])
    assert asyncio.run(render_board(added['yaml'], {}, rows))['warnings'] == []


def test_every_documented_blocked_key_is_actually_refused():
    """The subset served to the assistant must be the subset enforced here.

    dbt-charts documents its own CLI syntax; Explore accepts less. That list is
    published through /charts/reference, so a key that drifts out of the
    validator would be advertised as forbidden while quietly working - or worse,
    the reverse.
    """
    restrictions = explore_restrictions()
    for key in restrictions['blocked_keys']:
        board = f"title: Probe\n{key}: anything\nqueries:\n  q: select 1 as n\ncharts:\n  c: {{type: table, query: q}}\n"
        with pytest.raises(ValueError) as failure:
            parse_board(board)
        assert key in str(failure.value)


def test_a_query_is_a_string_not_a_mapping_with_sql():
    """`sql:` is the shape the renderer's own docs teach, and it is refused."""
    documented_by_the_engine = "title: Probe\nqueries:\n  q:\n    sql: select 1 as n\ncharts:\n  c: {type: table, query: q}\n"
    with pytest.raises(ValueError):
        parse_board(documented_by_the_engine)
    assert parse_board("title: Probe\nqueries:\n  q: select 1 as n\ncharts:\n  c: {type: table, query: q}\n")


def test_the_reference_carries_the_subset_beside_the_engine_docs():
    published = reference()
    assert published['explore_subset'] == explore_restrictions()
    assert 'source' in published['explore_subset']['blocked_keys']
