"""The three ingest source kinds, their validation, and the incremental cursor.

What is pinned here is the boundary, not dlt: every identifier, path, host and
URL a source configuration carries is checked before it reaches a subprocess, and
each check has a reason a reviewer can read off the test name.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings
from app.core.host_guard import HostNotAllowed
from ingest import file_source, rest_source, sql_source


class SqlSourceUrlTest(unittest.TestCase):
    """One URL builder, whatever shape the facts arrive in.

    The host guard resolves DNS, so it is stubbed here and exercised on its own
    in HostGuardTest with address literals - a unit test must not depend on a
    name server answering.
    """

    def setUp(self) -> None:
        patcher = patch.object(sql_source, "assert_host_allowed")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_mysql_is_a_supported_source(self):
        self.assertIn("mysql", sql_source.supported_source_types())
        url = sql_source.build_url(
            "mysql",
            host="db.example.com",
            port=3306,
            database="crm",
            username="reader",
            password="pw",
        )
        self.assertEqual(url, "mysql+pymysql://reader:pw@db.example.com:3306/crm")

    def test_mysql_has_no_dbt_adapter(self):
        """The registry stays the list of warehouses dbt can actually run."""
        from adapters import ADAPTERS

        self.assertNotIn("mysql", ADAPTERS)
        self.assertIn("mysql", sql_source.SOURCE_ONLY_TYPES)

    def test_a_password_with_url_metacharacters_survives(self):
        url = sql_source.build_url(
            "postgresql",
            host="h",
            port=5432,
            database="d",
            username="u",
            password="p@ss/w:rd?",
        )
        self.assertIn("u:p%40ss%2Fw%3Ard%3F@h", url)

    def test_oracle_reaches_a_service_not_a_database(self):
        url = sql_source.build_source_url(
            {
                "connection_type": "oracle",
                "host": "ora",
                "port": 1521,
                "database": "ignored",
                "username": "u",
                "extra_config": {"service": "ORCLPDB1"},
            },
            "pw",
        )
        self.assertTrue(url.endswith("/ORCLPDB1"))

    def test_request_body_spellings_all_reach_the_same_url(self):
        """The connection-test body says `dbname`; the row says `database`."""
        from_config = sql_source.build_url_from_config(
            "postgresql",
            {"host": "h", "port": 5432, "dbname": "d", "user": "u", "password": "p"},
        )
        from_row = sql_source.build_source_url(
            {
                "connection_type": "postgresql",
                "host": "h",
                "port": 5432,
                "database": "d",
                "username": "u",
            },
            "p",
        )
        self.assertEqual(from_config, from_row)

    def test_an_unsupported_type_is_refused_by_name(self):
        with self.assertRaises(sql_source.UnsupportedSource) as ctx:
            sql_source.build_url(
                "dremio", host="h", port=9047, database="d", username="u", password="p"
            )
        self.assertIn("dremio", str(ctx.exception))


class FileSourceTest(unittest.TestCase):
    """A filesystem source is fenced to INGEST_FILE_ROOTS or it does not run."""

    def setUp(self) -> None:
        self._roots = settings.ingest_file_roots
        self.root = Path(__file__).resolve().parent
        settings.ingest_file_roots = str(self.root)

    def tearDown(self) -> None:
        settings.ingest_file_roots = self._roots

    def test_a_path_under_a_configured_root_is_accepted(self):
        config = file_source.build_config(
            {"bucket_url": str(self.root), "file_glob": "*.csv", "format": "csv"},
            "raw_files",
        )
        self.assertEqual(config["type"], "filesystem")
        self.assertEqual(config["bucket_url"], f"file://{self.root}")
        self.assertEqual(config["table"], "raw_files")

    def test_a_path_outside_every_root_is_refused(self):
        with self.assertRaises(file_source.UnsupportedFileSource):
            file_source.build_config({"bucket_url": "/etc", "format": "csv"}, "t")

    def test_traversal_out_of_a_root_is_refused_after_resolution(self):
        """`root/..` resolves above the root, so resolving before comparing is the check."""
        with self.assertRaises(file_source.UnsupportedFileSource):
            file_source.build_config(
                {"bucket_url": f"{self.root}/../../../..", "format": "csv"}, "t"
            )

    def test_with_no_roots_configured_the_feature_is_off(self):
        settings.ingest_file_roots = ""
        with self.assertRaises(file_source.UnsupportedFileSource) as ctx:
            file_source.build_config({"bucket_url": str(self.root)}, "t")
        self.assertIn("INGEST_FILE_ROOTS", str(ctx.exception))

    def test_a_glob_cannot_climb_or_start_from_root(self):
        for glob in ("../secrets/*", "/etc/*"):
            with self.assertRaises(file_source.UnsupportedFileSource):
                file_source.validate_glob(glob)

    def test_object_storage_says_why_rather_than_failing_obscurely(self):
        with self.assertRaises(file_source.UnsupportedFileSource) as ctx:
            file_source.validate_bucket_url("s3://bucket/path")
        self.assertIn("credentials", str(ctx.exception))

    def test_an_unknown_format_is_refused(self):
        with self.assertRaises(file_source.UnsupportedFileSource):
            file_source.validate_format("xlsx")


class RestSourceTest(unittest.TestCase):
    def setUp(self) -> None:
        patcher = patch.object(rest_source, "assert_host_allowed")
        patcher.start()
        self.addCleanup(patcher.stop)

    def _config(self, **overrides):
        base = {
            "base_url": "https://api.example.com/v1",
            "resources": [{"name": "orders", "path": "orders"}],
        }
        base.update(overrides)
        return base

    def test_a_minimal_public_api_needs_no_connection(self):
        config = rest_source.build_config(self._config(), ["orders"], None, "")
        self.assertEqual(config["type"], "rest_api")
        self.assertEqual(config["client"]["base_url"], "https://api.example.com/v1/")
        self.assertNotIn("auth", config["client"])
        self.assertEqual(config["resources"][0]["endpoint"]["path"], "orders")

    def test_a_non_http_scheme_is_refused(self):
        for url in ("file:///etc/passwd", "gopher://x/"):
            with self.assertRaises(rest_source.UnsupportedRestSource):
                rest_source.validate_base_url(url)

    def test_a_resource_cannot_escape_the_base_path(self):
        with self.assertRaises(rest_source.UnsupportedRestSource):
            rest_source.build_config(
                self._config(resources=[{"name": "orders", "path": "../../admin"}]),
                ["orders"],
                None,
                "",
            )

    def test_resource_names_and_the_table_list_must_agree(self):
        """The names become destination tables, so they cannot drift apart."""
        with self.assertRaises(rest_source.UnsupportedRestSource):
            rest_source.build_config(self._config(), ["orders", "customers"], None, "")
        with self.assertRaises(rest_source.UnsupportedRestSource):
            rest_source.build_config(
                self._config(resources=[{"name": "invoices", "path": "invoices"}]),
                ["orders"],
                None,
                "",
            )

    def test_a_param_carrying_behaviour_is_refused(self):
        with self.assertRaises(rest_source.UnsupportedRestSource):
            rest_source.build_config(
                self._config(
                    resources=[
                        {
                            "name": "orders",
                            "path": "orders",
                            "params": {"since": {"type": "resolve", "field": "id"}},
                        }
                    ]
                ),
                ["orders"],
                None,
                "",
            )

    def test_bearer_auth_comes_from_the_connection_row(self):
        connection = {"extra_config": {"auth_type": "bearer"}, "username": None}
        config = rest_source.build_config(
            self._config(), ["orders"], connection, "s3cr3t"
        )
        self.assertEqual(
            config["client"]["auth"], {"type": "bearer", "token": "s3cr3t"}
        )

    def test_api_key_auth_needs_the_parameter_name_the_api_expects(self):
        connection = {"extra_config": {"auth_type": "api_key"}, "username": None}
        with self.assertRaises(rest_source.UnsupportedRestSource):
            rest_source.build_auth(connection, "k")
        connection["extra_config"]["api_key_name"] = "X-API-Key"
        self.assertEqual(
            rest_source.build_auth(connection, "k"),
            {"type": "api_key", "name": "X-API-Key", "api_key": "k", "location": "header"},
        )

    def test_an_auth_type_with_no_stored_secret_is_refused(self):
        connection = {"extra_config": {"auth_type": "bearer"}, "username": None}
        with self.assertRaises(rest_source.UnsupportedRestSource):
            rest_source.build_auth(connection, "")

    def test_the_cursor_becomes_a_request_parameter_when_asked(self):
        """Filtering after fetching every page costs the same as no cursor.

        dlt's endpoint form takes `start_param` and rejects `type`; its parameter
        form is the other way round. Only the endpoint form is built, so this
        also pins that no `type` key appears - dlt raises on it.
        """
        config = rest_source.build_config(
            self._config(
                resources=[
                    {
                        "name": "orders",
                        "path": "orders",
                        "incremental_param": "updated_since",
                    }
                ]
            ),
            ["orders"],
            None,
            "",
            cursor_field="updated_at",
            cursor_initial_value="2026-01-01",
        )
        endpoint = config["resources"][0]["endpoint"]
        self.assertEqual(
            endpoint["incremental"],
            {
                "cursor_path": "updated_at",
                "initial_value": "2026-01-01",
                "start_param": "updated_since",
            },
        )
        self.assertNotIn("type", endpoint["incremental"])
        self.assertNotIn("_start_param", endpoint)
        self.assertNotIn("params", endpoint)

    def test_a_cursor_with_no_parameter_still_dedupes(self):
        config = rest_source.build_config(
            self._config(), ["orders"], None, "", cursor_field="updated_at"
        )
        endpoint = config["resources"][0]["endpoint"]
        self.assertEqual(endpoint["incremental"], {"cursor_path": "updated_at"})

    def test_a_cursor_parameter_with_no_cursor_field_is_refused(self):
        """Otherwise it would be silently dropped and the load stay a full read."""
        with self.assertRaises(rest_source.UnsupportedRestSource) as ctx:
            rest_source.build_config(
                self._config(
                    resources=[
                        {"name": "orders", "path": "orders", "incremental_param": "since"}
                    ]
                ),
                ["orders"],
                None,
                "",
            )
        self.assertIn("no cursor field", str(ctx.exception))

    def test_the_cursor_parameter_cannot_also_be_a_fixed_one(self):
        with self.assertRaises(rest_source.UnsupportedRestSource):
            rest_source.build_config(
                self._config(
                    resources=[
                        {
                            "name": "orders",
                            "path": "orders",
                            "params": {"since": "2020-01-01"},
                            "incremental_param": "since",
                        }
                    ]
                ),
                ["orders"],
                None,
                "",
                cursor_field="updated_at",
            )

    def test_a_bad_paginator_type_is_refused(self):
        with self.assertRaises(rest_source.UnsupportedRestSource):
            rest_source.build_config(
                self._config(paginator={"type": "exec"}), ["orders"], None, ""
            )


class IncrementalHintTest(unittest.TestCase):
    """What the runner does with a cursor, without running dlt.

    `_apply_hints` is the difference between reading a source's new rows and
    reading all of it every time, so it is checked directly rather than through
    a load.
    """

    def _source(self, names):
        source = MagicMock()
        source.resources = {name: MagicMock() for name in names}
        return source

    def test_a_cursor_is_applied_to_every_table(self):
        from ingest import runner

        source = self._source(["a", "b"])
        runner._apply_hints(
            source,
            ["a", "b"],
            {"cursor_field": "updated_at", "cursor_initial_value": "2026-01-01"},
            "sql_database",
        )
        for name in ("a", "b"):
            hints = source.resources[name].apply_hints.call_args.kwargs
            self.assertIn("incremental", hints)

    def test_no_cursor_and_no_merge_touches_nothing(self):
        from ingest import runner

        source = self._source(["a"])
        runner._apply_hints(source, ["a"], {}, "sql_database")
        source.resources["a"].apply_hints.assert_not_called()

    def test_merge_still_gets_its_primary_key(self):
        from ingest import runner

        source = self._source(["a"])
        runner._apply_hints(
            source,
            ["a"],
            {"write_disposition": "merge", "primary_key": ["id"]},
            "sql_database",
        )
        hints = source.resources["a"].apply_hints.call_args.kwargs
        self.assertEqual(hints["write_disposition"], "merge")
        self.assertEqual(hints["primary_key"], ["id"])

    def test_the_offset_paginator_is_refused_without_a_page_size(self):
        """dlt's OffsetPaginator takes `limit` as a required argument.

        Without this the UI's own paginator list contained an option that always
        died inside dlt with a TypeError, well after the load had started.
        """
        from ingest.rest_source import UnsupportedRestSource, _validate_paginator

        with self.assertRaises(UnsupportedRestSource) as caught:
            _validate_paginator({"type": "offset"})
        self.assertIn("page size", str(caught.exception))

        self.assertEqual(
            _validate_paginator({"type": "offset", "limit": 100}),
            {"type": "offset", "limit": 100},
        )
        # A form field sends a string; dlt builds from it and then fails on the
        # second page, so the number has to arrive as a number.
        self.assertEqual(
            _validate_paginator({"type": "offset", "limit": "100"}),
            {"type": "offset", "limit": 100},
        )
        with self.assertRaises(UnsupportedRestSource):
            _validate_paginator({"type": "offset", "limit": "many"})

    def test_rest_api_keeps_its_cursor_in_its_own_config(self):
        """An HTTP cursor has to be sent, which a hint applied here cannot do."""
        from ingest import runner

        source = self._source(["a"])
        runner._apply_hints(
            source, ["a"], {"cursor_field": "updated_at"}, "rest_api"
        )
        source.resources["a"].apply_hints.assert_not_called()

    def test_a_filesystem_resource_takes_hints_too(self):
        """It arrives as a single piped resource, not a source with a mapping."""
        from ingest import runner

        resource = MagicMock(spec=["apply_hints"])
        runner._apply_hints(
            resource, ["files"], {"cursor_field": "modification_date"}, "filesystem"
        )
        resource.apply_hints.assert_called_once()


class HostGuardTest(unittest.TestCase):
    """Both SQL and REST sources are user-supplied hosts the server then reaches.

    Address literals only: the point is the policy, not DNS. Link-local is
    refused even with private hosts allowed, which is what makes a cloud
    metadata endpoint unreachable from an ingest source.
    """

    def setUp(self) -> None:
        self._private = settings.ingest_allow_private_hosts
        settings.ingest_allow_private_hosts = True

    def tearDown(self) -> None:
        settings.ingest_allow_private_hosts = self._private

    def test_a_sql_source_cannot_aim_at_link_local(self):
        with self.assertRaises(HostNotAllowed):
            sql_source.build_url(
                "mysql",
                host="169.254.169.254",
                port=3306,
                database="d",
                username="u",
                password="p",
            )

    def test_a_rest_source_cannot_aim_at_cloud_metadata(self):
        with self.assertRaises(HostNotAllowed):
            rest_source.validate_base_url("http://169.254.169.254/latest/meta-data/")

    def test_private_hosts_are_refused_unless_the_deployment_opted_in(self):
        settings.ingest_allow_private_hosts = False
        with self.assertRaises(HostNotAllowed):
            rest_source.validate_base_url("http://10.1.2.3/api/")


class SourceOnlyTypesAreNotWarehousesTest(unittest.TestCase):
    """A credential lives in `connections` whether or not dbt can run against it.

    That is the whole reason these types are in the same table, and the reason
    assigning one as a project's warehouse needs a message rather than an
    "unsupported type" error - it is a UI mistake, not a missing mapping.
    """

    def test_mysql_and_rest_are_refused_as_a_project_warehouse(self):
        from app.services.dbt_service import build_adapter_config_from_connection_row

        for conn_type in ("mysql", "rest"):
            with self.subTest(conn_type=conn_type):
                with self.assertRaises(ValueError) as ctx:
                    build_adapter_config_from_connection_row(
                        {"connection_type": conn_type, "extra_config": {}}
                    )
                message = str(ctx.exception)
                self.assertIn("ingest source", message)
                self.assertIn("not a warehouse", message)


class JobConfigDispatchTest(unittest.TestCase):
    """The router picks the source type; each module decides what it may contain."""

    def setUp(self) -> None:
        from app.routers import ingest as ingest_router

        self.router = ingest_router
        patcher = patch.object(sql_source, "assert_host_allowed")
        patcher.start()
        self.addCleanup(patcher.stop)
        rest_patcher = patch.object(rest_source, "assert_host_allowed")
        rest_patcher.start()
        self.addCleanup(rest_patcher.stop)

    def _row(self, **overrides):
        row = {
            "id": "s1",
            "project_id": "p1",
            "source_type": "sql_database",
            "tables": ["customers"],
            "source_config": None,
            "cursor_field": None,
            "cursor_initial_value": None,
            "connection_type": "postgresql",
            "host": "src-db",
            "port": 5432,
            "database": "crm",
            "username": "u",
            "password_encrypted": None,
            "extra_config": None,
        }
        row.update(overrides)
        return row

    def test_a_sql_source_carries_a_url_and_its_tables(self):
        block = self.router._build_source_block(self._row(), ["customers"], None, None)
        self.assertEqual(block["type"], "sql_database")
        self.assertIn("src-db", block["url"])
        self.assertEqual(block["tables"], ["customers"])

    def test_a_sql_source_with_no_connection_says_so(self):
        from ingest.sql_source import UnsupportedSource

        with self.assertRaises(UnsupportedSource):
            self.router._build_source_block(
                self._row(connection_type=None), ["customers"], None, None
            )

    def test_a_rest_source_needs_no_connection(self):
        block = self.router._build_source_block(
            self._row(
                source_type="rest_api",
                connection_type=None,
                tables=["orders"],
                source_config={
                    "base_url": "https://api.example.com/v1",
                    "resources": [{"name": "orders", "path": "orders"}],
                },
            ),
            ["orders"],
            None,
            None,
        )
        self.assertEqual(block["type"], "rest_api")
        self.assertNotIn("auth", block["client"])

    def test_a_filesystem_source_loads_one_table(self):
        from ingest.file_source import UnsupportedFileSource

        row = self._row(
            source_type="filesystem",
            connection_type=None,
            tables=["a", "b"],
            source_config={"bucket_url": "/tmp", "format": "csv"},
        )
        with self.assertRaises(UnsupportedFileSource):
            self.router._build_source_block(row, ["a", "b"], None, None)

    def test_a_cursor_is_validated_as_an_identifier(self):
        from fastapi import HTTPException

        cursor, initial = self.router._validated_cursor(
            self._row(cursor_field="updated_at", cursor_initial_value="2026-01-01"),
            "sql_database",
        )
        self.assertEqual((cursor, initial), ("updated_at", "2026-01-01"))
        with self.assertRaises(HTTPException):
            self.router._validated_cursor(
                self._row(cursor_field="updated_at; DROP TABLE x"), "sql_database"
            )

    def test_a_rest_cursor_is_a_json_path_and_a_sql_one_is_not(self):
        """One stored field, two meanings.

        For rest_api the cursor is dlt's `cursor_path` into the response body, so
        `attributes.updated_at` is ordinary. For a SQL source the same string
        would be a column reference, and a dot there is not a column name.
        """
        from fastapi import HTTPException

        row = self._row(cursor_field="attributes.updated_at")
        self.assertEqual(
            self.router._validated_cursor(row, "rest_api")[0], "attributes.updated_at"
        )
        with self.assertRaises(HTTPException):
            self.router._validated_cursor(row, "sql_database")
        # A path is still a path: nothing that could carry a quote or a space.
        with self.assertRaises(HTTPException):
            self.router._validated_cursor(
                self._row(cursor_field="a.b; DROP TABLE x"), "rest_api"
            )

    def test_no_cursor_reads_as_no_cursor_rather_than_an_empty_string(self):
        self.assertEqual(self.router._validated_cursor(self._row(), "sql_database"), (None, None))
        self.assertEqual(
            self.router._validated_cursor(self._row(cursor_field=""), "sql_database"),
            (None, None),
        )

    def test_an_unknown_source_type_is_a_400_not_a_crash(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            self.router._validated_source_type(self._row(source_type="python_script"))
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
