"""The guard that stops a user pointing a connection at our own Postgres."""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.host_guard import HostNotAllowed, assert_host_allowed


class HostGuardTest(unittest.TestCase):
    def test_loopback_is_refused(self):
        with self.assertRaises(HostNotAllowed):
            assert_host_allowed("127.0.0.1", 5432)

    def test_cloud_metadata_is_refused(self):
        with self.assertRaises(HostNotAllowed):
            assert_host_allowed("169.254.169.254", 80)

    def test_private_address_refused_by_default(self):
        with patch("app.core.host_guard.settings") as settings:
            settings.ingest_allow_private_hosts = False
            with self.assertRaises(HostNotAllowed):
                assert_host_allowed("10.1.2.3", 5432, own=[])

    def test_private_address_allowed_when_opted_in(self):
        with patch("app.core.host_guard.settings") as settings:
            settings.ingest_allow_private_hosts = True
            assert_host_allowed("10.1.2.3", 5432, own=[])

    def test_own_database_refused_by_name(self):
        with patch("app.core.host_guard.settings") as settings:
            settings.ingest_allow_private_hosts = True
            with self.assertRaises(HostNotAllowed):
                assert_host_allowed(
                    "warehouse.internal", 5432, own=[("warehouse.internal", 5432)]
                )

    def test_own_database_refused_by_ip_when_private_hosts_allowed(self):
        """The bypass that matters: same host, typed as an IP instead of a name.

        Every on-premise deployment sets INGEST_ALLOW_PRIVATE_HOSTS=true, which
        is exactly when a name-only check stops protecting anything.
        """
        with patch("app.core.host_guard.settings") as settings:
            settings.ingest_allow_private_hosts = True
            with self.assertRaises(HostNotAllowed):
                assert_host_allowed("10.4.5.6", 5432, own=[("10.4.5.6", 5432)])

    def test_different_port_on_own_host_is_allowed(self):
        """A second database on the same machine is a legitimate source."""
        with patch("app.core.host_guard.settings") as settings:
            settings.ingest_allow_private_hosts = True
            assert_host_allowed("10.4.5.6", 15432, own=[("10.4.5.6", 5432)])

    def test_unresolvable_host_is_refused(self):
        with self.assertRaises(HostNotAllowed):
            assert_host_allowed("no-such-host.invalid", 5432)


if __name__ == "__main__":
    unittest.main()
