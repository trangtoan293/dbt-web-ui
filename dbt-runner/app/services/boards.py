"""Project boards: bounded SQL snapshots rendered by dbt-charts without credentials.

The YAML is the saved source of truth. SQL is executed by the authenticated dbt
service, never by dct; only inline results and declarative layout reach dct.
"""
import copy
import json
import math
import re
from collections.abc import Awaitable, Callable

import sqlglot
from sqlglot import exp
import yaml
from jinja2 import Environment, nodes

from app.services.charts import FORMATTED_TYPES, MAX_BYTES, render_board_yaml

MAX_QUERIES = 12
MAX_CHARTS = 24
MAX_VARIABLES = 20
MAX_ROWS = 1000
THEMES = {'clarity', 'paper', 'vivid', 'neon', 'stark'}
# Keys that would make a board reach outside itself - another file, another
# connection, raw HTML - or carry SQL where the loader does not scan it.
BLOCKED_KEYS = {'source', 'sources', 'extends', 'ref', 'html_policy', 'url', 'file', 'path', 'sql', 'connection'}
VARIABLE_INPUTS = {'select', 'multiselect', 'text', 'input', 'number', 'date', 'checkbox'}
VARIABLE_FIELDS = {'input', 'label', 'default', 'options', 'required', 'notes'}


def explore_restrictions() -> dict:
    """What an Explore board may contain, as data rather than as prose.

    dbt-charts documents its own full syntax, which assumes its CLI and a
    project-level `dbt_charts.yml`. Explore runs the queries itself and accepts
    a subset, so anything reading those docs - the guide, the assistant - has to
    be told the subset too. Served from the same constants the validator uses so
    the two cannot drift.
    """
    return {
        'blocked_keys': sorted(BLOCKED_KEYS),
        'max_queries': MAX_QUERIES,
        'max_charts': MAX_CHARTS,
        'max_variables': MAX_VARIABLES,
        'max_rows_per_query': MAX_ROWS,
        'themes': sorted(THEMES),
        'variable_inputs': sorted(VARIABLE_INPUTS),
        'variable_fields': sorted(VARIABLE_FIELDS),
        'notes': [
            'A query is a plain SQL string under queries.<name>, or an inline '
            '{columns, values} object - never a mapping with a `sql:` key.',
            'Queries run against this project\'s own dbt profile and target. '
            'A board never names a source or a connection.',
            'Templates ({{ }}) are allowed only inside a query string, and only '
            'ref(), source(), adapter.quote(), variables and filter().',
            'queries and variables live at the board root; every chart.query '
            'must name one of them.',
        ],
    }


class BoardLoader(yaml.SafeLoader):
    def compose_node(self, parent, index):
        if self.check_event(yaml.AliasEvent):
            raise ValueError('YAML aliases are not supported. Define values explicitly.')
        return super().compose_node(parent, index)

    def construct_mapping(self, node, deep=False):
        result = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in result:
                raise ValueError(f'Line {key_node.start_mark.line + 1}: duplicate or non-string YAML key')
            result[key] = self.construct_object(value_node, deep=deep)
        return result


def _safe_tree(value, depth=0):
    if depth > 25:
        raise ValueError('Board nesting exceeds 25 levels')
    if isinstance(value, dict):
        for key, child in value.items():
            if key in BLOCKED_KEYS:
                raise ValueError(f'{key}: external sources, includes and raw HTML are not enabled in Explore boards')
            if key == 'theme' and child not in THEMES:
                raise ValueError('Choose a built-in theme: clarity, paper, vivid, neon or stark')
            _safe_tree(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            _safe_tree(child, depth + 1)
    elif isinstance(value, str):
        if any(token in value for token in ('{{', '{%', '{#')):
            raise ValueError('Templates are only allowed inside SQL queries')
    elif value is not None and not isinstance(value, (int, float, bool)):
        raise ValueError('Only JSON-compatible YAML values are supported')
    elif isinstance(value, float) and not math.isfinite(value):
        raise ValueError('Numbers must be finite')


def parse_board(content: str) -> dict:
    if len(content.encode()) > MAX_BYTES:
        raise ValueError('Board exceeds 2 MB')
    try:
        board = yaml.load(content, Loader=BoardLoader)
    except yaml.YAMLError as exc:
        mark = getattr(exc, 'problem_mark', None)
        raise ValueError(f'Line {mark.line + 1 if mark else 1}: {getattr(exc, "problem", "Invalid YAML")}') from exc
    except RecursionError as exc:
        raise ValueError('Board nesting is too deep') from exc
    if not isinstance(board, dict):
        raise ValueError('Line 1: a board must be a YAML mapping')
    queries = board.get('queries', {})
    if not isinstance(queries, dict) or not 1 <= len(queries) <= MAX_QUERIES:
        raise ValueError('Define between 1 and 12 named queries')
    if not isinstance(board.get('charts'), dict) or not 1 <= len(board['charts']) <= MAX_CHARTS:
        raise ValueError(f'Define between 1 and {MAX_CHARTS} named charts')
    if any(not isinstance(chart, dict) for chart in board['charts'].values()):
        raise ValueError('Define chart objects inline; cross-file chart references are not enabled')
    display = {key: value for key, value in board.items() if key not in {'queries', 'variables'}}
    _safe_tree(display)
    def check_queries(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in {'queries', 'variables'}:
                    raise ValueError('Define queries and variables at the board root only')
                if key == 'query' and (not isinstance(child, str) or child not in queries):
                    raise ValueError('Every chart query must reference a named board query')
                check_queries(child)
        elif isinstance(value, list):
            for child in value:
                check_queries(child)
    check_queries(display)
    variables = board.get('variables', {})
    if not isinstance(variables, dict) or len(variables) > MAX_VARIABLES:
        raise ValueError(f'Define up to {MAX_VARIABLES} variables')
    _safe_tree(variables)
    for name, spec in variables.items():
        if not isinstance(spec, dict) or spec.get('input', 'text') not in VARIABLE_INPUTS:
            raise ValueError(f'Variable {name}: use select, multiselect, text, number, date or checkbox')
        if set(spec) - VARIABLE_FIELDS:
            raise ValueError(f'Variable {name}: use explicit static options and filter() in SQL')
        options = spec.get('options', {})
        if not isinstance(options, dict) or set(options) - {'static'} or not isinstance(options.get('static', []), list):
            raise ValueError(f'Variable {name}: options must use options.static')
    defaults = {name: spec.get('default') for name, spec in variables.items()}
    for name, query in queries.items():
        try:
            if isinstance(query, str):
                prepare_sql(query, defaults)
            else:
                _inline(query)
        except ValueError as exc:
            raise ValueError(f'Query {name}: {exc}') from exc
    return board


def _literal(value):
    if value is None:
        return 'NULL'
    if isinstance(value, bool):
        return 'TRUE' if value else 'FALSE'
    if isinstance(value, (int, float)) and math.isfinite(value):
        return str(value)
    if isinstance(value, str) and len(value) <= 2000 and not any(token in value for token in ('{{', '{%', '{#', '\\', '\x00')):
        return "'" + value.replace("'", "''") + "'"
    raise ValueError('Invalid filter value')


def prepare_sql(sql: str, variables: dict) -> str:
    """Accept only literal dbt refs/quoted columns and SQL-safe variable expressions."""
    if len(sql) > 100_000 or '{%' in sql or '{#' in sql or '__board_ref_' in sql:
        raise ValueError('SQL is too large or contains unsupported template statements')
    try:
        tree = Environment().parse(sql)
    except Exception as exc:
        raise ValueError('Invalid SQL template') from exc
    refs = []
    def expression(node):
        if isinstance(node, nodes.Name) and node.name in variables:
            return _literal(variables[node.name])
        if not isinstance(node, nodes.Call) or node.kwargs or node.dyn_args or node.dyn_kwargs:
            raise ValueError('Only ref(), source(), adapter.quote(), variables and filter() are allowed')
        fn = node.node.name if isinstance(node.node, nodes.Name) else None
        if isinstance(node.node, nodes.Getattr) and isinstance(node.node.node, nodes.Name) and node.node.node.name == 'adapter' and node.node.attr == 'quote':
            fn = 'adapter.quote'
        if fn in {'ref', 'source', 'adapter.quote'}:
            if not all(isinstance(arg, nodes.Const) and isinstance(arg.value, str) and len(arg.value) <= 200 for arg in node.args):
                raise ValueError('dbt references require literal names')
            if len(node.args) not in ({1, 2} if fn == 'ref' else {2} if fn == 'source' else {1}):
                raise ValueError('Invalid dbt reference arguments')
            value = '{{ ' + fn + '(' + ', '.join(json.dumps(arg.value) for arg in node.args) + ') }}'
            refs.append(value)
            return f'__board_ref_{len(refs)-1}'
        if fn == 'filter' and len(node.args) == 2 and isinstance(node.args[0], nodes.Const) and isinstance(node.args[1], nodes.Name):
            col, variable = node.args[0].value, node.args[1].name
            if not isinstance(col, str) or not re.fullmatch(r'[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*', col) or variable not in variables:
                raise ValueError('filter() needs a column identifier and a declared variable')
            value = variables[variable]
            if value is None or value == [] or value == '':
                return '1 = 1'
            if isinstance(value, list):
                if len(value) > 100:
                    raise ValueError('Select at most 100 filter values')
                return f'{col} IN (' + ', '.join(_literal(item) for item in value) + ')'
            return f'{col} = {_literal(value)}'
        raise ValueError('Unsupported SQL template function')
    parts = []
    for output in tree.body:
        if not isinstance(output, nodes.Output):
            raise ValueError('Unsupported SQL template statement')
        parts.extend(node.data if isinstance(node, nodes.TemplateData) else expression(node) for node in output.nodes)
    prepared = ''.join(parts)
    try:
        statements = sqlglot.parse(prepared)
        if len(statements) != 1 or not isinstance(statements[0], exp.Query):
            raise ValueError('Only a single SELECT/WITH query is allowed')
        forbidden = (exp.DDL, exp.DML, exp.Into, exp.Command)
        if any(isinstance(node, forbidden) for node in statements[0].walk()):
            raise ValueError('Queries must be read-only')
        for table in statements[0].find_all(exp.Table):
            if not isinstance(table.this, exp.Identifier):
                raise ValueError('External tables and table functions are not allowed')
        for function in statements[0].find_all(exp.Func):
            if isinstance(function, exp.Anonymous) or re.search(r'READ_|WRITE_|HTTP|EXTERNAL|LOAD_', function.sql_name(), re.I):
                raise ValueError('External, file-access and unrecognized SQL functions are not allowed')
    except sqlglot.errors.SqlglotError as exc:
        raise ValueError(f'Unable to validate read-only SQL: {exc}') from exc
    prepared = re.sub(r'__board_ref_(\d+)\b', lambda match: refs[int(match.group(1))], prepared) if refs else prepared
    return prepared


def compose_board(content: str, chart_yaml: str, sql: str, columns: list) -> dict:
    """Append a snapshot chart as a refreshable, named SQL chart."""
    incoming = parse_board(chart_yaml)
    if len(incoming['charts']) != 1 or not isinstance(columns, list) or not 1 <= len(columns) <= 80 or not all(isinstance(col, str) for col in columns):
        raise ValueError('Choose one chart with 1–80 columns')
    prepare_sql(sql, {})
    board = parse_board(content) if content.strip() else {'title': 'New dashboard', 'queries': {}, 'charts': {}, 'rows': []}
    index = 1
    while f'chart_{index}' in board['charts'] or f'query_{index}' in board['queries']:
        index += 1
    query_name, chart_name = f'query_{index}', f'chart_{index}'
    fields = ', '.join('{{ adapter.quote(' + json.dumps(col) + ') }} as field_' + str(i) for i, col in enumerate(columns))
    board['queries'][query_name] = f'select {fields}\nfrom (\n{sql.strip().rstrip(";")}\n) as chart_data'
    chart = copy.deepcopy(next(iter(incoming['charts'].values())))
    chart['query'] = query_name
    board['charts'][chart_name] = chart
    if 'rows' not in board:
        layouts = {key: board.pop(key) for key in ('cols', 'grid', 'tabs') if key in board}
        board['rows'] = [layouts] if layouts else []
    board['rows'].append(chart_name)
    result = yaml.safe_dump(board, sort_keys=False, allow_unicode=True)
    parse_board(result)
    return {'yaml': result}


def _inline(query):
    if not isinstance(query, dict) or set(query) - {'columns', 'values', 'notes'} or not {'columns', 'values'} <= set(query):
        raise ValueError('Use a SQL string or inline columns/values, not paths or connection settings')
    columns, values = query['columns'], query['values']
    if not isinstance(columns, list) or not 1 <= len(columns) <= 80 or not all(isinstance(col, str) for col in columns) or len(set(columns)) != len(columns):
        raise ValueError('Inline query needs 1–80 unique column names')
    if not isinstance(values, list) or len(values) > MAX_ROWS or any(not isinstance(row, list) or len(row) != len(columns) for row in values):
        raise ValueError('Inline query needs up to 1,000 rows matching the column count')
    _safe_tree(query)
    if len(json.dumps(query).encode()) > MAX_BYTES:
        raise ValueError('Query result exceeds 2 MB')
    return query


def _line_mapper(content: str) -> Callable[[str], int]:
    """The compiler sees normalized YAML; translate its paths to authored line numbers."""
    authored = yaml.compose(content)
    def line_for(path):
        node = authored
        for part in (path or '').split('.'):
            if not isinstance(node, yaml.MappingNode):
                break
            match = next((value for key, value in node.value if key.value == part), None)
            if match is None:
                break
            node = match
        return node.start_mark.line + 1 if node else 1
    return line_for


async def validate_board(content: str) -> dict:
    board = parse_board(content)
    # Validation does not execute SQL or need a warehouse connection.
    board.pop('variables', None)
    board['queries'] = {name: {'columns': ['value'], 'values': [[1]]} if isinstance(query, str) else query for name, query in board['queries'].items()}
    result = await render_board_yaml(yaml.safe_dump(board, sort_keys=False), validate=True)
    line_for = _line_mapper(content)
    report = result.get('diagnostics', {})
    if isinstance(report, dict):
        for item in report.get('errors', []) + report.get('warnings', []):
            item['line'] = line_for(item.get('path', ''))
    result['outline'] = _outline(parse_board(content))
    if result['valid']:
        result['variables'] = parse_board(content).get('variables', {})
    return result


def _outline(board: dict) -> dict:
    """Query and chart names the editor offers without re-parsing YAML in the browser."""
    return {'queries': list(board['queries']),
            'charts': [{'name': name, 'type': chart.get('type', 'bar'), 'query': chart.get('query')}
                       for name, chart in board['charts'].items()]}


# Column-naming chart channels. Unknown names render an empty chart with only a
# warning, so they are rejected here against the columns each query returned.
FIELD_KEYS = ('x', 'y', 'color', 'theta', 'value', 'size', 'shape', 'opacity', 'latitude', 'longitude', 'lookup')


def _check_fields(board: dict) -> None:
    for name, chart in board['charts'].items():
        query = board['queries'].get(chart.get('query'))
        if not isinstance(query, dict):
            continue
        columns = set(query['columns'])
        referenced = []
        for key in FIELD_KEYS:
            value = chart.get(key)
            referenced += [item for item in (value if isinstance(value, list) else [value]) if isinstance(item, str)]
        for holder, key in ((chart.get('sort'), 'by'), (chart.get('support'), 'value')):
            if isinstance(holder, dict) and isinstance(holder.get(key), str):
                referenced.append(holder[key])
        missing = sorted({item for item in referenced if item not in columns})
        if missing:
            # ponytail: top-level channels only; layers[] carry their own query.
            raise ValueError(f'Chart {name}: {", ".join(missing)} is not a column of query {chart["query"]}. '
                             f'Available columns: {", ".join(sorted(columns)) or "none"}')


async def render_board(content: str, values: dict, query_runner: Callable[[str], Awaitable[dict]]) -> dict:
    board = parse_board(content)
    outline = _outline(board)
    variables = board.pop('variables', {})
    if set(values) - set(variables):
        raise ValueError('Unknown dashboard filter')
    bound = {name: values.get(name, spec.get('default')) for name, spec in variables.items()}
    for name, spec in variables.items():
        if spec.get('required') and bound[name] in (None, '', []):
            raise ValueError(f'Filter {name} is required')
    board = copy.deepcopy(board)
    for name, query in board['queries'].items():
        if isinstance(query, str):
            response = await query_runner(prepare_sql(query, bound))
            if not response.get('success'):
                raise ValueError(f'Query {name}: {response.get("error", "failed")}')
            columns = response.get('columns', [])
            board['queries'][name] = _inline({'columns': columns, 'values': [[row.get(col) for col in columns] for row in response.get('data', [])]})
    _check_fields(board)
    materialized = yaml.safe_dump(board, sort_keys=False, allow_unicode=True)
    if len(materialized.encode()) > 8_000_000:
        raise ValueError('Dashboard result exceeds 8 MB; aggregate the queries')
    line_for = _line_mapper(content)
    try:
        result = await render_board_yaml(materialized)
    except ValueError as exc:
        for item in getattr(exc, 'diagnostics', []):
            item['line'] = line_for(item.get('path'))
        raise
    for item in result['warnings']:
        item['line'] = line_for(item.get('path'))
    result.update(query_count=len(board['queries']), yaml=content, variables=variables, outline=outline)
    return result


async def preview_sql(sql: str, query_runner: Callable[[str], Awaitable[dict]], limit: int = 50) -> dict:
    """Run SQL the chart builder is about to save, under the guard a board query passes."""
    if not isinstance(sql, str) or not sql.strip():
        raise ValueError('Write a SELECT query first')
    response = await query_runner(prepare_sql(sql, {}))
    if not response.get('success'):
        raise ValueError(response.get('error', 'Query failed'))
    columns = response.get('columns', [])
    data = response.get('data', [])
    return {'columns': columns, 'row_count': len(data),
            'rows': [[row.get(column) for column in columns] for row in data[:limit]]}


async def preview_query(content: str, values: dict, name: str, query_runner: Callable[[str], Awaitable[dict]], limit: int = 50) -> dict:
    """Run one named query so charts are built from the columns it actually returns."""
    board = parse_board(content)
    query = board['queries'].get(name)
    if query is None:
        raise ValueError(f'Unknown query {name}')
    bound = {key: values.get(key, spec.get('default')) for key, spec in board.get('variables', {}).items()}
    if isinstance(query, dict):
        return {'name': name, 'columns': query['columns'], 'rows': query['values'][:limit], 'row_count': len(query['values'])}
    response = await query_runner(prepare_sql(query, bound))
    if not response.get('success'):
        raise ValueError(f'Query {name}: {response.get("error", "failed")}')
    columns = response.get('columns', [])
    data = response.get('data', [])
    return {'name': name, 'columns': columns, 'row_count': len(data),
            'rows': [[row.get(column) for column in columns] for row in data[:limit]]}


CHART_TYPES = ('bar', 'line', 'area', 'scatter', 'pie', 'donut', 'kpi', 'table', 'histogram', 'heatmap')
NUMBER_FORMATS = ('integer', 'number', 'number_full', 'currency', 'currency_whole', 'currency_full',
                  'percent', 'percent_whole', 'percent_delta')


def _unique(taken, stem: str) -> str:
    index = 1
    while f'{stem}_{index}' in taken:
        index += 1
    return f'{stem}_{index}'


def _field(spec: dict, key: str, columns: list) -> str:
    value = spec.get(key)
    if not isinstance(value, str) or value not in columns:
        raise ValueError(f'Choose {key} from the columns the query returns')
    return value


def _chart_from_spec(spec: dict, columns: list) -> dict:
    kind = spec.get('type')
    if kind not in CHART_TYPES:
        raise ValueError(f'Choose a chart type: {", ".join(CHART_TYPES)}')
    title = str(spec.get('title') or '')[:160]
    chart = {'type': kind, 'query': spec['query']}
    if kind == 'kpi':
        chart['label'] = title or spec.get('y') or 'Value'
        chart['value'] = _field(spec, 'y', columns)
    elif kind == 'table':
        chart['title'] = title or None
    elif kind in ('pie', 'donut'):
        chart.update(title=title or None, theta=_field(spec, 'y', columns), color=_field(spec, 'x', columns))
    elif kind == 'histogram':
        chart.update(title=title or None, x=_field(spec, 'x', columns))
    elif kind == 'heatmap':
        chart.update(title=title or None, x=_field(spec, 'x', columns), y=_field(spec, 'y', columns),
                     color=_field(spec, 'color', columns))
    else:
        chart.update(title=title or None, x=_field(spec, 'x', columns), y=_field(spec, 'y', columns))
        if spec.get('color'):
            chart['color'] = _field(spec, 'color', columns)
    number_format = spec.get('number_format')
    if number_format:
        if number_format not in NUMBER_FORMATS:
            raise ValueError(f'Choose a number format: {", ".join(NUMBER_FORMATS)}')
        # The engine warns when a currency or percent measure carries no format, but
        # only these families own a number_format slot — an arc or a table rejects it.
        if kind == 'kpi':
            chart['style'] = {'value': {'format': number_format}}
        elif kind in FORMATTED_TYPES:
            chart['style'] = {'number_format': number_format}
    return {key: value for key, value in chart.items() if value is not None}


def _top_level(lines: list, key: str):
    return next((index for index, line in enumerate(lines) if line.startswith(key + ':')), None)


def _block_end(lines: list, start: int) -> int:
    """Index just past the last non-blank line of the block owned by line `start`."""
    end = start + 1
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if line.strip() and not line[0].isspace() and not line.startswith('#'):
            break
        if line.strip():
            end = index + 1
    return end


def _query_block(name: str, sql: str) -> list:
    """A literal block scalar keeps the SQL readable and needs no escaping."""
    return [f'  {name}: |'] + ['    ' + line for line in sql.strip().splitlines()]


def _is_blank(content: str) -> bool:
    """Comment-only text is a dashboard nobody has written yet, not a malformed one."""
    try:
        return yaml.load(content, Loader=BoardLoader) is None
    except (yaml.YAMLError, ValueError):
        return False


def _new_board(content: str, query_name: str, sql: str, chart_name: str, chart: dict) -> str:
    body = yaml.safe_dump({chart_name: chart}, sort_keys=False, allow_unicode=True).splitlines()
    kept = [line for line in content.splitlines() if line.strip().startswith('#')]
    # A board title above a single titled chart is two headers for one chart, which the
    # engine reports; let the chart's own title head the board when it has one.
    title = [] if chart.get('title') or chart.get('label') else ['title: New dashboard']
    return '\n'.join([*kept, *title, 'queries:', *_query_block(query_name, sql),
                       'charts:', *['  ' + line for line in body], 'rows:', f'  - {chart_name}']) + '\n'


def add_chart(content: str, spec: dict, columns: list) -> dict:
    """Insert a chart, and the SQL behind it, as text so authored comments survive."""
    if not isinstance(columns, list) or not columns or not all(isinstance(column, str) for column in columns):
        raise ValueError('Run the query first so its columns are known')
    blank = _is_blank(content)
    board = {'queries': {}, 'charts': {}} if blank else parse_board(content)
    sql = spec.get('sql')
    if sql:
        prepare_sql(sql, {})  # the same read-only guard a saved board query passes
        query_name = str(spec.get('query_name') or '').strip() or _unique(board['queries'], 'query')
        if not re.fullmatch(r'[a-zA-Z_]\w{0,60}', query_name) or query_name in board['queries']:
            raise ValueError('Use a new query name of 1–61 letters, digits or underscores')
        if len(board['queries']) >= MAX_QUERIES:
            raise ValueError(f'A board holds at most {MAX_QUERIES} queries; chart an existing one instead')
    else:
        query_name = spec.get('query')
        if query_name not in board['queries']:
            raise ValueError('Choose one of the board queries, or write SQL for a new one')
    chart = _chart_from_spec({**spec, 'query': query_name}, columns)
    name = str(spec.get('name') or '').strip() or _unique(board['charts'], 'chart')
    if not re.fullmatch(r'[a-zA-Z_]\w{0,60}', name) or name in board['charts']:
        raise ValueError('Use a new chart name of 1–61 letters, digits or underscores')
    if blank:
        result = _new_board(content, query_name, sql, name, chart)
        parse_board(result)
        return {'yaml': result, 'name': name, 'query': query_name, 'notice': None}
    lines = content.splitlines()
    charts_at = _top_level(lines, 'charts')
    if charts_at is None:
        raise ValueError('Add a charts: section before inserting a chart')
    layout = next((key for key in ('rows', 'cols', 'grid', 'tabs') if _top_level(lines, key) is not None), None)
    notice = None
    body = yaml.safe_dump({name: chart}, sort_keys=False, allow_unicode=True).splitlines()
    inserts = [(_block_end(lines, charts_at), ['  ' + line for line in body])]
    if sql:
        inserts.append((_block_end(lines, _top_level(lines, 'queries')), _query_block(query_name, sql)))
    if layout in ('rows', 'cols'):
        inserts.append((_block_end(lines, _top_level(lines, layout)), [f'  - {name}']))
    elif layout:
        notice = f'Chart added. Place {name} in the {layout} layout yourself.'
    else:
        inserts.append((len(lines), ['rows:', f'  - {name}']))
    updated = list(lines)
    for at, block in sorted(inserts, key=lambda item: -item[0]):
        updated[at:at] = block
    result = '\n'.join(updated) + '\n'
    try:
        parse_board(result)
    except ValueError:
        # Flow-style or otherwise unusual source: fall back to a normalized dump.
        if sql:
            board['queries'][query_name] = sql
        board['charts'][name] = chart
        if layout in ('rows', 'cols'):
            board[layout].append(name)
        elif not layout:
            board['rows'] = [name]
        result = yaml.safe_dump(board, sort_keys=False, allow_unicode=True)
        parse_board(result)
    return {'yaml': result, 'name': name, 'query': query_name, 'notice': notice}
