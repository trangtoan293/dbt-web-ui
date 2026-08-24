"""Handing the harness UI a credential, and refusing to when it would leak."""

from app import harness_ui
from app.config import settings
from app.model_config import ModelConfig


def config(**credentials):
    return ModelConfig(credentials=credentials)


def test_writes_the_key_for_a_single_user_deployment(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "web_home", tmp_path / "web-home")
    monkeypatch.setattr(settings, "auth_disabled", True)

    assert harness_ui.provision_credential(config(DEEPSEEK_API_KEY="sk-user-own")) is True

    path = tmp_path / "web-home" / ".credentials.yaml"
    assert path.read_text() == "DEEPSEEK_API_KEY: sk-user-own\n"
    # The harness refuses a credential file anyone else can read.
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700


def test_refuses_when_the_deployment_has_several_users(tmp_path, monkeypatch):
    """That UI has no authentication: one user's key would serve everyone."""
    monkeypatch.setattr(settings, "web_home", tmp_path / "web-home")
    monkeypatch.setattr(settings, "auth_disabled", False)

    assert harness_ui.provision_credential(config(DEEPSEEK_API_KEY="sk-user-own")) is False
    assert not (tmp_path / "web-home").exists()


def test_no_key_and_no_configured_home_are_both_no_ops(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "auth_disabled", True)

    monkeypatch.setattr(settings, "web_home", tmp_path / "web-home")
    assert harness_ui.provision_credential(ModelConfig()) is False

    monkeypatch.setattr(settings, "web_home", None)
    assert harness_ui.provision_credential(config(DEEPSEEK_API_KEY="sk-user-own")) is False


def test_a_value_that_would_rewrite_the_document_is_refused(tmp_path, monkeypatch):
    """The file is a YAML mapping and nothing else; the harness rejects any
    deviation, so a value carrying a newline or a colon must never be written."""
    monkeypatch.setattr(settings, "web_home", tmp_path / "web-home")
    monkeypatch.setattr(settings, "auth_disabled", True)

    assert harness_ui.provision_credential(config(A_API_KEY="sk-a\nOTHER_API_KEY: sk-b")) is False
    assert harness_ui.provision_credential(config(A_API_KEY="sk-a: b")) is False
    assert not (tmp_path / "web-home" / ".credentials.yaml").exists()


def test_rewriting_the_same_key_leaves_the_file_alone(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "web_home", tmp_path / "web-home")
    monkeypatch.setattr(settings, "auth_disabled", True)

    harness_ui.provision_credential(config(DEEPSEEK_API_KEY="sk-same"))
    path = tmp_path / "web-home" / ".credentials.yaml"
    stamp = path.stat().st_mtime_ns

    assert harness_ui.provision_credential(config(DEEPSEEK_API_KEY="sk-same")) is True
    assert path.stat().st_mtime_ns == stamp, "an unchanged key should not touch the file"


def test_routes_are_mirrored_as_settings_never_as_secrets(tmp_path, monkeypatch):
    """The UI needs a route as well as a key, or its first-run dialog persists."""
    import yaml

    monkeypatch.setattr(settings, "web_home", tmp_path / "web-home")
    monkeypatch.setattr(settings, "auth_disabled", True)

    written = harness_ui.provision_credential(ModelConfig(
        providers={"acme": {"apiKeyEnv": "ACME_API_KEY", "api": "openai-completions",
                            "baseURL": "https://g.example/v1", "models": [{"id": "acme-large"}]}},
        credentials={"ACME_API_KEY": "sk-acme"},
        route="acme", model="acme-large",
    ))

    assert written is True
    document = yaml.safe_load((tmp_path / "web-home" / "settings.yaml").read_text())
    assert document == {"llm-pi-ai": {"providers": {
        "acme": {"apiKeyEnv": "ACME_API_KEY", "api": "openai-completions",
                 "baseURL": "https://g.example/v1", "models": [{"id": "acme-large"}]},
    }}}
    # The settings document names the reference; the secret is in the other file.
    assert "sk-acme" not in (tmp_path / "web-home" / "settings.yaml").read_text()
    assert (tmp_path / "web-home" / ".credentials.yaml").read_text() == "ACME_API_KEY: sk-acme\n"


def test_the_settings_document_keeps_what_that_ui_stored_itself(tmp_path, monkeypatch):
    """It is the harness UI's document too; only the routes section is ours."""
    import yaml

    home = tmp_path / "web-home"
    home.mkdir()
    (home / "settings.yaml").write_text(yaml.safe_dump({
        "client-ui": {"theme": "dark"},
        "llm-pi-ai": {"providers": {"stale": {"apiKeyEnv": "STALE_API_KEY"}}, "other": 1},
    }))
    monkeypatch.setattr(settings, "web_home", home)
    monkeypatch.setattr(settings, "auth_disabled", True)

    harness_ui.provision_credential(ModelConfig(
        providers={"openai": {"apiKeyEnv": "OPENAI_API_KEY"}},
        credentials={"OPENAI_API_KEY": "sk-a"},
    ))

    document = yaml.safe_load((home / "settings.yaml").read_text())
    assert document["client-ui"] == {"theme": "dark"}
    assert document["llm-pi-ai"]["other"] == 1
    assert document["llm-pi-ai"]["providers"] == {"openai": {"apiKeyEnv": "OPENAI_API_KEY"}}
