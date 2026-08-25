"""A lakehouse as a connection: what it accepts, and what it must refuse.

External mode takes a catalog URL, a data path and a schema name from whoever
fills in the form, which makes this the file where the four ways that goes wrong
are pinned down:

  S1  a catalog aimed at this deployment's own Postgres reads every other
      user's encrypted warehouse credentials through ordinary model SQL
  S2  a schema name is concatenated into DDL, where no bound parameter is
      accepted
  S3  a data path inside this deployment's lake directory reads and overwrites
      another user's managed lake
  S4  pinning write options on a catalog changes how its *owner* writes too
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.host_guard import HostNotAllowed
from app.services import lakes
from ingest import lakehouse
from ingest.lakehouse import LakeRef, LakehouseError

LAKE_ID = "3f8b1c2d-0000-4000-8000-abcdefabcdef"


def _row(**overrides):
    row = {
        "id": LAKE_ID,
        "connection_type": "ducklake",
        "host": "",
        "port": 0,
        "database": "",
        "username": "",
        "password_encrypted": None,
        "extra_config": {"mode": "managed"},
    }
    row.update(overrides)
    return row


class MetadataSchemaTest(unittest.TestCase):
    """S2: the name goes into `ATTACH ... (METADATA_SCHEMA '...')` verbatim."""

    def test_plain_identifiers_pass(self):
        for name in ("lake_shared", "_x", "Lake$1", "a" * 63):
            self.assertEqual(lakehouse.validate_metadata_schema(name), name)

    def test_injection_attempts_are_refused(self):
        for name in (
            "lake'; DROP SCHEMA public CASCADE; --",
            "lake shared",
            "1lake",
            "",
            "a" * 64,
            "lake--",
        ):
            with self.assertRaises(LakehouseError, msg=name):
                lakehouse.validate_metadata_schema(name)

    def test_a_bad_schema_stops_the_attach_rather_than_reaching_duckdb(self):
        lake = LakeRef(
            catalog_url="sqlite:////tmp/x.sqlite",
            data_path="/tmp/lake",
            metadata_schema="oops'; DROP TABLE t; --",
        )
        with self.assertRaises(LakehouseError):
            lakehouse._connect(lake)


class DataPathTest(unittest.TestCase):
    """S3: an external lake may not point at this deployment's own storage."""

    def setUp(self):
        self.own = Path("/srv/managed-lakes")
        patcher = patch.object(lakehouse, "settings")
        self.settings = patcher.start()
        self.addCleanup(patcher.stop)
        self.settings.lake_data_dir = str(self.own)
        self.settings.storage_dir = "/srv/storage"
        self.settings.lake_external_data_roots = ""

    def test_object_storage_always_passes(self):
        for url in ("s3://company-lake/warehouse/", "gs://bucket/lake", "az://c/lake"):
            self.assertEqual(lakehouse.validate_data_path(url), url)

    def test_a_path_inside_our_own_lake_directory_is_refused(self):
        self.settings.lake_external_data_roots = "/srv"
        for path in (str(self.own), str(self.own / "someone-elses-project")):
            with self.assertRaises(LakehouseError, msg=path) as caught:
                lakehouse.validate_data_path(path)
            self.assertIn("own lake directory", str(caught.exception))

    def test_a_local_path_needs_a_configured_root(self):
        with self.assertRaises(LakehouseError) as caught:
            lakehouse.validate_data_path("/mnt/shared-lake")
        self.assertIn("LAKE_EXTERNAL_DATA_ROOTS", str(caught.exception))

    def test_a_local_path_under_a_configured_root_passes(self):
        self.settings.lake_external_data_roots = "/mnt/shared-lake, /mnt/other"
        self.assertEqual(
            lakehouse.validate_data_path("/mnt/shared-lake/warehouse"),
            "/mnt/shared-lake/warehouse",
        )

    def test_traversal_out_of_a_configured_root_is_refused(self):
        self.settings.lake_external_data_roots = "/mnt/shared-lake"
        with self.assertRaises(LakehouseError):
            lakehouse.validate_data_path("/mnt/shared-lake/../../etc")

    def test_empty_is_refused(self):
        with self.assertRaises(LakehouseError):
            lakehouse.validate_data_path("")


class LakeRefFromRowTest(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(lakehouse, "settings")
        self.settings = patcher.start()
        self.addCleanup(patcher.stop)
        self.settings.lake_catalog_url = "postgresql://u:pw@catalog:5432/app"
        self.settings.database_url = ""
        self.settings.lake_data_dir = "/srv/managed-lakes"
        self.settings.storage_dir = "/srv/storage"
        self.settings.lake_external_data_roots = "/mnt/shared"

    def test_a_managed_lake_takes_its_location_from_settings(self):
        """Not from the row: rotating LAKE_CATALOG_URL must move every lake."""
        lake = lakes.lake_ref_from_row(
            _row(host="ignored", database="ignored", username="ignored")
        )
        self.assertEqual(lake.catalog_url, "postgresql://u:pw@catalog:5432/app")
        self.assertEqual(lake.metadata_schema, lakehouse.metadata_schema(LAKE_ID))
        self.assertEqual(lake.data_path, str(lakehouse.data_dir(LAKE_ID)))
        self.assertTrue(lake.managed)
        self.assertTrue(lake.maintained)

    def test_a_managed_lake_keeps_a_name_the_migration_stored(self):
        """Backfilled rows carry the schema an older release derived."""
        lake = lakes.lake_ref_from_row(
            _row(extra_config={"mode": "managed", "metadata_schema": "lake_legacy"})
        )
        self.assertEqual(lake.metadata_schema, "lake_legacy")

    def test_an_external_lake_defaults_to_unmaintained(self):
        """Somebody else's collector already runs there; two cannot share files."""
        lake = lakes.lake_ref_from_row(
            _row(
                host="lake-db",
                port=5432,
                database="lakehouse",
                username="reader",
                extra_config={
                    "mode": "external",
                    "metadata_schema": "shared_lake",
                    "data_path": "/mnt/shared/warehouse",
                },
            ),
            password="s3cret",
        )
        self.assertFalse(lake.managed)
        self.assertFalse(lake.maintained)
        self.assertEqual(lake.metadata_schema, "shared_lake")
        self.assertIn("s3cret", lake.catalog_url)

    def test_an_external_sqlite_catalog_is_a_file_path(self):
        lake = lakes.lake_ref_from_row(
            _row(
                database="/mnt/shared/catalog.sqlite",
                extra_config={
                    "mode": "external",
                    "catalog_type": "sqlite",
                    "metadata_schema": "main",
                    "data_path": "s3://bucket/lake",
                },
            ),
            password="",
        )
        self.assertEqual(lake.catalog_url, "sqlite:///mnt/shared/catalog.sqlite")

    def test_an_external_lake_with_a_refused_path_never_becomes_a_ref(self):
        with self.assertRaises(LakehouseError):
            lakes.lake_ref_from_row(
                _row(
                    host="lake-db",
                    database="lakehouse",
                    extra_config={
                        "mode": "external",
                        "metadata_schema": "shared_lake",
                        "data_path": "/etc",
                    },
                ),
                password="",
            )

    def test_an_unknown_mode_is_refused(self):
        with self.assertRaises(LakehouseError):
            lakes.lake_ref_from_row(_row(extra_config={"mode": "whatever"}))


class CatalogHostGuardTest(unittest.IsolatedAsyncioTestCase):
    """S1: the privilege-escalation path, and the one that must never regress."""

    async def test_a_catalog_on_our_own_database_is_refused(self):
        with patch("app.services.lakes.assert_host_allowed") as guard:
            guard.side_effect = HostNotAllowed("that is this deployment's database")
            with self.assertRaises(HostNotAllowed):
                await lakes._assert_catalog_host_allowed(
                    "postgresql://u:p@postgres:5432/dbtcraft"
                )

    async def test_a_sqlite_catalog_has_no_host_to_check(self):
        with patch("app.services.lakes.assert_host_allowed") as guard:
            await lakes._assert_catalog_host_allowed("sqlite:////mnt/lake/catalog.sqlite")
        guard.assert_not_called()

    async def test_validation_refuses_an_external_lake_pointed_at_us(self):
        with patch.object(lakehouse, "settings") as settings:
            settings.lake_data_dir = "/srv/managed-lakes"
            settings.storage_dir = "/srv/storage"
            settings.lake_external_data_roots = "/mnt/shared"
            with patch("app.services.lakes.assert_host_allowed") as guard:
                guard.side_effect = HostNotAllowed("nope")
                with self.assertRaises(HostNotAllowed):
                    await lakes.validate_lake_payload(
                        {
                            "mode": "external",
                            "metadata_schema": "shared_lake",
                            "data_path": "/mnt/shared/warehouse",
                        },
                        host="postgres",
                        port=5432,
                        database="dbtcraft",
                        username="dbtcraft",
                        password="pw",
                    )

    async def test_a_managed_payload_ignores_everything_the_form_sent(self):
        """The one way to make a managed lake point somewhere it should not."""
        with patch.object(lakehouse, "settings") as settings:
            settings.lake_catalog_url = "postgresql://u:pw@catalog:5432/app"
            settings.database_url = ""
            settings.lake_data_dir = "/srv/managed-lakes"
            settings.storage_dir = "/srv/storage"
            stored = await lakes.validate_lake_payload(
                {
                    "mode": "managed",
                    "metadata_schema": "attacker_chosen",
                    "data_path": "/etc",
                },
                connection_id=LAKE_ID,
            )
            # Inside the patch: both expectations are derived from settings too.
            self.assertEqual(
                stored["metadata_schema"], lakehouse.metadata_schema(LAKE_ID)
            )
            self.assertEqual(stored["data_path"], str(lakehouse.data_dir(LAKE_ID)))
        self.assertTrue(stored["maintained"])


class BuildsIntoLakeTest(unittest.TestCase):
    """`+database: lake` is what makes dbt materialise into the lake at all."""

    PROJECT_YML = """\
name: 'shop'
profile: 'shop'

# These configurations specify where dbt should look for different types of files.
model-paths: ["models"]

models:
  shop:
    staging:
      +schema: staging
      +materialized: view
    marts:
      +schema: marts
      +materialized: table
"""

    def setUp(self):
        import tempfile

        self.root = Path(tempfile.mkdtemp(prefix="lake-yml-"))
        (self.root / "dbt_project.yml").write_text(self.PROJECT_YML)
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, True))

    def _text(self) -> str:
        return (self.root / "dbt_project.yml").read_text()

    def test_enabling_pins_models_at_the_lake(self):
        self.assertFalse(lakes.builds_into_lake(self.root))
        self.assertTrue(lakes.set_builds_into_lake(self.root, True))
        self.assertTrue(lakes.builds_into_lake(self.root))
        self.assertIn("    +database: lake", self._text())

    def test_the_pin_lands_under_the_project_key_so_every_model_inherits(self):
        lakes.set_builds_into_lake(self.root, True)
        lines = self._text().splitlines()
        models = lines.index("models:")
        self.assertEqual(lines[models + 1].strip(), "shop:")
        self.assertEqual(lines[models + 2], "    +database: lake")

    def test_disabling_removes_it(self):
        lakes.set_builds_into_lake(self.root, True)
        self.assertTrue(lakes.set_builds_into_lake(self.root, False))
        self.assertFalse(lakes.builds_into_lake(self.root))
        self.assertNotIn("+database", self._text())

    def test_disabling_twice_changes_nothing(self):
        self.assertFalse(lakes.set_builds_into_lake(self.root, False))

    def test_comments_survive(self):
        """A YAML round trip would delete every comment dbt ships in this file."""
        lakes.set_builds_into_lake(self.root, True)
        lakes.set_builds_into_lake(self.root, False)
        self.assertIn(
            "# These configurations specify where dbt should look", self._text()
        )
        self.assertEqual(self._text(), self.PROJECT_YML)

    def test_a_file_with_no_models_block_says_so(self):
        (self.root / "dbt_project.yml").write_text("name: 'shop'\nprofile: 'shop'\n")
        with self.assertRaises(LakehouseError):
            lakes.set_builds_into_lake(self.root, True)


if __name__ == "__main__":
    unittest.main()
