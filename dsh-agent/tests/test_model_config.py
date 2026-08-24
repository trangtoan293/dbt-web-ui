"""Reading the caller's provider configuration off the request.

The frontend proxy sends the harness's own `llm-pi-ai` providers dict and the
secrets beside it. Both reach files and an environment the harness parses, so
neither is taken on trust.
"""

import base64
import json

from app.model_config import ModelConfig


def encode(payload) -> str:
    return base64.b64encode(json.dumps(payload).encode()).decode()


PROVIDERS = {
    "acme": {"apiKeyEnv": "ACME_API_KEY", "api": "openai-completions",
             "baseURL": "https://gateway.acme.example/v1", "models": [{"id": "acme-large"}]},
    "openai": {"apiKeyEnv": "OPENAI_API_KEY"},
}


def test_carries_the_adapter_dict_and_its_secrets():
    config = ModelConfig.from_headers(
        encode(PROVIDERS), encode({"ACME_API_KEY": "sk-acme"}), "acme", "acme-large"
    )

    assert config.providers == PROVIDERS
    assert config.credentials == {"ACME_API_KEY": "sk-acme"}
    assert (config.route, config.model) == ("acme", "acme-large")


def test_the_overlay_patches_the_adapter_already_in_the_composition():
    """llm-pi-ai is a base row: patch its config, do not insert a second one."""
    config = ModelConfig.from_headers(encode(PROVIDERS), None, None, None)

    assert config.overlay() == [{"id": "llm-pi-ai", "config": {"providers": PROVIDERS}}]
    # Nothing configured means no overlay at all, so the base composition's own
    # adapter serves the deployment default.
    assert ModelConfig().overlay() is None


def test_absent_and_malformed_headers_are_ignored_not_fatal():
    for providers in (None, "", "not base64", base64.b64encode(b"[1,2]").decode()):
        config = ModelConfig.from_headers(providers, None, None, None)
        assert config.providers == {}
        assert config.overlay() is None


def test_a_reference_that_is_not_an_environment_name_is_dropped():
    """These become environment variables and settings keys."""
    config = ModelConfig.from_headers(
        encode({"good": {"apiKeyEnv": "A_API_KEY"}, "bad route": {"apiKeyEnv": "X"},
                "../escape": {"apiKeyEnv": "X"}, "notadict": "x"}),
        encode({"A_API_KEY": "sk-a", "lower_case": "sk-b", "WITH-DASH": "sk-c", "EMPTY": "  "}),
        None, None,
    )

    assert list(config.providers) == ["good"]
    assert config.credentials == {"A_API_KEY": "sk-a"}


def test_a_route_the_caller_did_not_choose_carries_no_model():
    """The model belongs to a route; naming one without the other is not a choice."""
    config = ModelConfig.from_headers(encode(PROVIDERS), None, None, "acme-large")

    assert config.route is None and config.model is None


def test_the_fingerprint_changes_with_anything_that_needs_a_restart():
    base = ModelConfig.from_headers(
        encode(PROVIDERS), encode({"ACME_API_KEY": "sk-acme"}), "acme", "acme-large")

    same = ModelConfig.from_headers(
        encode(PROVIDERS), encode({"ACME_API_KEY": "sk-acme"}), "acme", "acme-large")
    assert base.fingerprint == same.fingerprint

    for changed in (
        ModelConfig.from_headers(encode(PROVIDERS), encode({"ACME_API_KEY": "rotated"}),
                                 "acme", "acme-large"),
        ModelConfig.from_headers(encode({**PROVIDERS, "acme": {"apiKeyEnv": "ACME_API_KEY"}}),
                                 encode({"ACME_API_KEY": "sk-acme"}), "acme", "acme-large"),
        ModelConfig.from_headers(encode(PROVIDERS), encode({"ACME_API_KEY": "sk-acme"}),
                                 "openai", "gpt-x"),
        ModelConfig.from_headers(encode(PROVIDERS), encode({"ACME_API_KEY": "sk-acme"}),
                                 "acme", "acme-think"),
    ):
        assert changed.fingerprint != base.fingerprint


def test_the_fingerprint_never_carries_a_secret():
    config = ModelConfig.from_headers(None, encode({"A_API_KEY": "sk-plaintext"}), None, None)

    assert "sk-plaintext" not in config.fingerprint


def test_an_oversized_header_is_refused():
    huge = base64.b64encode(json.dumps({"r": {"x": "y" * 70_000}}).encode()).decode()

    assert ModelConfig.from_headers(huge, None, None, None).providers == {}
