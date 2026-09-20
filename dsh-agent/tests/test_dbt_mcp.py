"""The reference tool hands the model one slice, not the whole document."""

import os

import pytest

os.environ.setdefault("DBT_PROJECT_ID", "test-project")

from dbt_mcp.__main__ import _reference_view  # noqa: E402

REFERENCE = {
    "renderer": "dbt-charts 1.2.3",
    "topics": [{"slug": "filters", "title": "Filters", "body": "run `dct validate` first"}],
    "examples": [{"slug": "sales/summary", "title": "Sales", "notes": "", "yaml": "title: Sales"}],
    "explore_subset": {"blocked_keys": ["source", "sql"]},
}


def test_index_lists_slugs_without_their_bodies():
    view = _reference_view(REFERENCE, "")
    assert view["renderer"] == "dbt-charts 1.2.3"
    assert view["topics"] == ["filters"]
    assert view["samples"] == ["sample:sales/summary"]


def test_topic_returns_its_body():
    assert _reference_view(REFERENCE, "filters")["body"] == "run `dct validate` first"


def test_sample_prefix_selects_a_whole_board():
    # A slug with a slash in it must survive the prefix split.
    assert _reference_view(REFERENCE, "sample:sales/summary")["yaml"] == "title: Sales"


@pytest.mark.parametrize("topic", ["nope", "sample:nope"])
def test_unknown_slug_answers_with_what_there_is(topic):
    view = _reference_view(REFERENCE, topic)
    assert "error" in view
    assert view.get("topics") or view.get("samples")


def test_a_failed_call_is_passed_through_untouched():
    failure = {"error": "dbt-runner returned 503", "body": "down"}
    assert _reference_view(failure, "filters") is failure


@pytest.mark.parametrize("topic", ["", "filters", "sample:sales/summary", "nope"])
def test_every_answer_corrects_the_engine_docs(topic):
    """The text tells the reader to run `dct`; the correction must ride with it.

    Without this the assistant goes looking for a CLI and a dbt_charts.yml that
    this deployment does not have - with the shell, across the whole filesystem.
    """
    view = _reference_view(REFERENCE, topic)
    assert "no `dct` command" in view["dbt_craft"]
    assert view["explore_subset"] == {"blocked_keys": ["source", "sql"]}
