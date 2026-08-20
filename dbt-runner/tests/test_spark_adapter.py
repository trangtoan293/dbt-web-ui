import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapters.spark import SparkAdapter
from app.services.dbt_service import (
    DBT_PROFILE_SECRET_PLACEHOLDER,
    build_adapter_config_from_connection_row,
)


def _output(content):
    return yaml.safe_load(content)["proj"]["outputs"]["dev"]


def test_spark_session_omits_empty_port_and_preserves_parameters():
    adapter = SparkAdapter(
        {
            "method": "session",
            "host": "local[*]",
            "port": 0,
            "schema": "{{ env_var('SCHEMA_NAME', 'integration') }}",
            "threads": 2,
            "connect_timeout": 60,
            "connect_retries": 3,
            "retry_all": True,
            "server_side_parameters": {
                "spark.remote": "sc://spark-connect:15002",
                "spark.sql.catalog.integration.type": "hive",
            },
        }
    )

    output = _output(adapter.generate_profiles_yml("proj"))

    assert output["type"] == "spark"
    assert output["method"] == "session"
    assert output["host"] == "local[*]"
    assert "port" not in output
    assert output["schema"] == "{{ env_var('SCHEMA_NAME', 'integration') }}"
    assert output["threads"] == 2
    assert output["server_side_parameters"]["spark.remote"] == "sc://spark-connect:15002"


def test_spark_secret_mapping_uses_placeholder_not_plaintext():
    adapter = SparkAdapter(
        {
            "method": "http",
            "host": "spark.example.com",
            "port": 443,
            "schema": "integration",
            "user": "svc",
            "secret_type": "token",
            "token": DBT_PROFILE_SECRET_PLACEHOLDER,
            "cluster": "abc",
            "organization": "org",
        }
    )

    output = _output(adapter.generate_profiles_yml("proj"))

    assert output["token"] == DBT_PROFILE_SECRET_PLACEHOLDER
    assert output["port"] == 443
    assert "password" not in output


def test_spark_database_only_written_when_equal_to_schema():
    output = _output(
        SparkAdapter(
            {
                "method": "thrift",
                "host": "spark.example.com",
                "port": 10000,
                "schema": "analytics",
                "database": "wrong",
            }
        ).generate_profiles_yml("proj")
    )

    assert "database" not in output

    output = _output(
        SparkAdapter(
            {
                "method": "thrift",
                "host": "spark.example.com",
                "port": 10000,
                "schema": "analytics",
                "database": "analytics",
            }
        ).generate_profiles_yml("proj")
    )

    assert output["database"] == "analytics"


def test_spark_connection_row_mapper_handles_no_secret():
    conn_type, config, needs_secret = build_adapter_config_from_connection_row(
        {
            "connection_type": "spark",
            "host": "local[*]",
            "port": 0,
            "database": "integration",
            "username": "",
            "password_encrypted": None,
            "extra_config": {
                "method": "session",
                "secret_type": "none",
                "server_side_parameters": {"spark.remote": "sc://spark:15002"},
            },
        }
    )

    assert conn_type == "spark"
    assert needs_secret is False
    assert config["schema"] == "integration"
    assert config["server_side_parameters"]["spark.remote"] == "sc://spark:15002"
    assert "password" not in config
    assert "token" not in config
