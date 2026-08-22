"""Allow/deny checks for connection targets chosen by a user.

Every connection test and every ingest job points dbt-runner at a host the
requesting user typed in. Without a check, a user can aim one at this
deployment's own Postgres, read `connections.password_encrypted` for every
other user, and walk away with their warehouse credentials - a privilege
escalation through an entirely legitimate-looking UI flow. Cloud metadata
endpoints (169.254.169.254) are the same story for instance credentials.

Used by both the connection router and the ingest runner: a guard on only one
of the two paths is a guard nobody can rely on.
"""

import ipaddress
import logging
import socket
from typing import Iterable
from urllib.parse import urlparse

from app.config import settings

logger = logging.getLogger(__name__)


class HostNotAllowed(ValueError):
    """Raised when a target host is refused by policy."""


# Cloud instance-metadata services. Reachable from inside a container and hand
# out credentials to anyone who asks, so these are never allowed.
_METADATA_NETWORKS = (
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("fe80::/10"),
)

_LOOPBACK_HINT = (
    "loopback resolves to dbt-runner itself inside the container, not to your "
    "database host - use the service name or LAN address"
)


def _endpoint(url: str) -> tuple[str, int | None] | None:
    """Extract (host, port) from a connection URL, ignoring unparseable input."""
    if not url:
        return None
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    if not parsed.hostname:
        return None
    try:
        port = parsed.port
    except ValueError:
        port = None
    return parsed.hostname.lower(), port


def own_infrastructure() -> set[tuple[str, int | None]]:
    """Endpoints belonging to this deployment, which no source may target."""
    endpoints = set()
    for url in (settings.database_url, settings.lake_catalog_url, settings.redis_url):
        endpoint = _endpoint(url)
        if endpoint:
            endpoints.add(endpoint)
    return endpoints


def _resolve(host: str) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    """Resolve a hostname to every address it currently answers with."""
    try:
        return [ipaddress.ip_address(host)]
    except ValueError:
        pass

    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise HostNotAllowed(f"Host '{host}' could not be resolved: {exc}") from exc

    addresses = []
    for info in infos:
        try:
            addresses.append(ipaddress.ip_address(info[4][0]))
        except ValueError:
            continue
    if not addresses:
        raise HostNotAllowed(f"Host '{host}' resolved to no usable address")
    return addresses


def _reject(host: str, reason: str) -> None:
    # The message reaches the user, so it names the host they typed and the
    # policy that refused it - never the internal endpoint it collided with.
    raise HostNotAllowed(f"Target host '{host}' is not allowed: {reason}")


def assert_host_allowed(
    host: str,
    port: int | None = None,
    *,
    own: Iterable[tuple[str, int | None]] | None = None,
) -> None:
    """Refuse hosts that reach this deployment's own infrastructure.

    Checks the *resolved* addresses rather than the hostname, so a name that
    points at 127.0.0.1 or the metadata service is caught regardless of what it
    is called.

    ponytail: resolves for the check, but the client re-resolves when it
    connects, so a racing DNS change can still slip past. Pinning the address
    into each connection string is the fix if this ever guards untrusted users
    rather than employees of one company.
    """
    host = (host or "").strip().lower()
    if not host:
        _reject(host, "no host given")

    addresses = _resolve(host)

    # Compare resolved addresses, not names: with INGEST_ALLOW_PRIVATE_HOSTS on
    # - which every on-premise deployment needs - a name check alone is bypassed
    # by typing the app database's LAN IP instead of its service name.
    for infra_host, infra_port in own if own is not None else own_infrastructure():
        if port is not None and infra_port is not None and port != infra_port:
            continue
        if host == infra_host:
            _reject(host, "it is this deployment's own database or cache")
        try:
            infra_addresses = set(_resolve(infra_host))
        except HostNotAllowed:
            continue  # own endpoint unresolvable here; the name check above still applies
        if infra_addresses & set(addresses):
            _reject(host, "it is this deployment's own database or cache")

    for address in addresses:
        if any(address in network for network in _METADATA_NETWORKS):
            _reject(host, "link-local and cloud metadata addresses are blocked")
        if address.is_loopback:
            _reject(host, _LOOPBACK_HINT)
        if address.is_private and not settings.ingest_allow_private_hosts:
            _reject(
                host,
                "private network addresses are blocked - set "
                "INGEST_ALLOW_PRIVATE_HOSTS=true for on-premise warehouses",
            )
