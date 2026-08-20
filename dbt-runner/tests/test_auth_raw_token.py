import pytest
from fastapi import Request
from app.core.auth import extract_bearer_token


def _req(headers):
    scope = {"type": "http", "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()]}
    return Request(scope)


def test_extract_bearer_token_present():
    r = _req({"authorization": "Bearer abc.def.ghi"})
    assert extract_bearer_token(r) == "abc.def.ghi"


def test_extract_bearer_token_absent():
    r = _req({})
    assert extract_bearer_token(r) is None
