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
