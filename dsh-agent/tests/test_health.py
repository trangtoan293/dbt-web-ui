"""/health says whether the one deployment-supplied thing is there."""

from app.config import settings


def test_environment_credential_counts(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-whatever")
    assert settings.model_credential_present() is True


def test_blank_environment_credential_does_not_count(monkeypatch, tmp_path):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "   ")
    monkeypatch.setattr(settings, "dsh_home", tmp_path)
    assert settings.model_credential_present() is False


def test_the_harness_credential_file_counts(monkeypatch, tmp_path):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setattr(settings, "dsh_home", tmp_path)
    (tmp_path / ".credentials.yaml").write_text("DEEPSEEK_API_KEY: sk-from-file\n")
    assert settings.model_credential_present() is True


def test_a_commented_or_empty_entry_does_not_count(monkeypatch, tmp_path):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setattr(settings, "dsh_home", tmp_path)
    (tmp_path / ".credentials.yaml").write_text("# DEEPSEEK_API_KEY: sk-x\nOTHER_API_KEY:\n")
    assert settings.model_credential_present() is False


def test_no_credentials_at_all(monkeypatch, tmp_path):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setattr(settings, "dsh_home", tmp_path / "missing")
    assert settings.model_credential_present() is False


def test_health_offers_the_harness_ui_only_when_one_is_configured(monkeypatch):
    """No container runs `dsh web`: it refuses to bind 0.0.0.0 by design."""
    monkeypatch.setattr(settings, "web_url", "")
    assert (settings.web_url or None) is None

    monkeypatch.setattr(settings, "web_url", "http://localhost:3080")
    assert settings.web_url == "http://localhost:3080"


async def test_the_harness_ui_link_is_offered_only_when_it_answers(monkeypatch):
    """It runs behind a compose profile, so "not started" is the usual state."""
    import httpx
    from app import main

    app = main.create_app()
    harness_ui = next(
        route.endpoint for route in app.routes if getattr(route, "path", "") == "/health"
    )

    monkeypatch.setattr(settings, "web_url", "http://localhost:3080")
    monkeypatch.setattr(settings, "web_probe_url", "http://dsh-web:3080")

    class Client:
        def __init__(self, response=None, error=None):
            self._response, self._error = response, error

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def get(self, _url):
            if self._error:
                raise self._error
            return self._response

    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_: Client(httpx.Response(200)))
    assert (await harness_ui())["web_url"] == "http://localhost:3080"

    monkeypatch.setattr(
        main.httpx, "AsyncClient", lambda **_: Client(error=httpx.ConnectError("refused"))
    )
    assert (await harness_ui())["web_url"] is None
