from app.config import Settings


def test_cors_defaults_do_not_allow_every_origin():
    config = Settings(_env_file=None)

    assert "*" not in config.cors_origins
    assert "*" not in config.cors_allow_methods
    assert "*" not in config.cors_allow_headers
