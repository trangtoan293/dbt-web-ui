"""Validate a REST API ingest source into a dlt RESTAPIConfig.

dlt's `rest_api` source is configured with a **dict**, which is the only reason
an API can be an ingest source here at all: a Python source definition arriving
in a request body is remote code execution, so everything below is declarative
and every field is checked rather than passed through.

Credentials live in a `connections` row of type `rest`, so an API token is
encrypted by the same key and owned by the same user as a warehouse password -
there is no second place in this product where a secret is stored.

The base URL is a user-supplied host the server then fetches, i.e. the same SSRF
surface as a connection host or a schedule's webhook, so it goes through
`host_guard` here *and* nothing else builds this config.
"""

import re
from typing import Any, Dict, List
from urllib.parse import urlparse

from app.core.host_guard import assert_host_allowed

AUTH_TYPES = ("none", "bearer", "basic", "api_key")

# Where an API key may be put. dlt supports both; anything else would be a
# custom auth class, i.e. code.
API_KEY_LOCATIONS = ("header", "query")

PAGINATOR_TYPES = (
    "auto",
    "json_link",
    "header_link",
    "offset",
    "page_number",
    "cursor",
    "single_page",
)

# A resource name becomes a destination table, so it is the same shape as a SQL
# table name.
_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,62}$")
# An endpoint path, relative to the base URL. No scheme and no climbing, so a
# resource cannot redirect the client at another host or escape the base path.
_PATH_RE = re.compile(r"^[A-Za-z0-9_\-./{}~%]{0,300}$")
_PARAM_KEY_RE = re.compile(r"^[A-Za-z0-9_.\[\]-]{1,64}$")
# dlt's `cursor_path`: a path into the response body, so dotted names are the
# point. Never a SQL identifier - a REST cursor reaches an HTTP query parameter
# and a JSON lookup, and nothing else.
_CURSOR_PATH_RE = re.compile(
    r"^[A-Za-z_][A-Za-z0-9_$]{0,62}(\.[A-Za-z_][A-Za-z0-9_$]{0,62}){0,9}$"
)

MAX_RESOURCES = 25


class UnsupportedRestSource(ValueError):
    """Raised when a REST source's configuration is refused."""


def validate_base_url(raw: str) -> str:
    """Accept an http(s) base URL whose host policy allows, or refuse it."""
    candidate = (raw or "").strip()
    if not candidate:
        raise UnsupportedRestSource("a base URL is required")
    parsed = urlparse(candidate)
    if parsed.scheme not in ("http", "https"):
        raise UnsupportedRestSource(
            f"base URL must be http or https, not '{parsed.scheme or candidate}'"
        )
    if not parsed.hostname:
        raise UnsupportedRestSource(f"'{raw}' has no host")
    # Raises HostNotAllowed, which the router turns into a 400. Not caught here:
    # its message already says which policy refused the host.
    assert_host_allowed(parsed.hostname, parsed.port)
    return candidate.rstrip("/") + "/"


def _validate_path(raw: Any) -> str:
    path = str(raw or "").strip().lstrip("/")
    if ".." in path:
        raise UnsupportedRestSource(f"endpoint path '{raw}' cannot contain '..'")
    if not _PATH_RE.match(path):
        raise UnsupportedRestSource(f"'{raw}' is not a usable endpoint path")
    return path


def _validate_params(raw: Any) -> Dict[str, Any]:
    """Query parameters, as flat scalars only.

    dlt also accepts parameter *objects* carrying a resolver or an incremental -
    those are configuration with behaviour, and behaviour is described by the
    named fields here rather than accepted verbatim. The cursor gets there
    through `incremental.start_param`, which is dlt's own way to send it.
    """
    if raw in (None, ""):
        return {}
    if not isinstance(raw, dict):
        raise UnsupportedRestSource("params must be an object of name/value pairs")
    params: Dict[str, Any] = {}
    for key, value in raw.items():
        name = str(key)
        if not _PARAM_KEY_RE.match(name):
            raise UnsupportedRestSource(f"'{name}' is not a usable parameter name")
        if isinstance(value, bool) or value is None:
            params[name] = value
        elif isinstance(value, (int, float, str)):
            params[name] = value
        else:
            raise UnsupportedRestSource(
                f"parameter '{name}' must be a string, number or boolean"
            )
    return params


def _validate_paginator(raw: Any) -> Any:
    """Pass through a paginator dict after checking its type and scalar fields."""
    if raw in (None, "", "auto"):
        return None
    if isinstance(raw, str):
        raw = {"type": raw}
    if not isinstance(raw, dict):
        raise UnsupportedRestSource("paginator must be an object")
    kind = str(raw.get("type") or "auto")
    if kind not in PAGINATOR_TYPES:
        raise UnsupportedRestSource(
            f"paginator type must be one of {', '.join(PAGINATOR_TYPES)}, not '{kind}'"
        )
    if kind in ("auto", "single_page"):
        return None if kind == "auto" else {"type": kind}
    paginator: Dict[str, Any] = {"type": kind}
    # dlt names these differently per paginator; all of them are scalars, so the
    # check is on the value rather than on which key a given type accepts - dlt
    # rejects a key its paginator does not know, with a better message than a
    # whitelist here would give.
    for key, value in raw.items():
        if key == "type":
            continue
        name = str(key)
        if not _PARAM_KEY_RE.match(name):
            raise UnsupportedRestSource(f"'{name}' is not a usable paginator field")
        if isinstance(value, (int, float, str, bool)) or value is None:
            paginator[name] = value
        else:
            raise UnsupportedRestSource(
                f"paginator field '{name}' must be a string, number or boolean"
            )
    # dlt's OffsetPaginator takes `limit` as a required argument, so a bare
    # {"type": "offset"} reaches it as a TypeError deep inside a load. Refused
    # here instead, where the message can say which field is missing.
    if kind == "offset":
        raw_limit = paginator.get("limit")
        if raw_limit in (None, ""):
            raise UnsupportedRestSource(
                "the offset paginator needs a page size - set 'limit' to the "
                "number of records to request per page"
            )
        # Coerced, not just checked: dlt builds the paginator happily from the
        # string a form field sends and then adds it to an int on the *second*
        # page, so a one-page test passes and a real load does not.
        try:
            limit = int(raw_limit)
        except (TypeError, ValueError):
            raise UnsupportedRestSource(
                f"paginator page size '{raw_limit}' is not a whole number"
            ) from None
        if limit < 1:
            raise UnsupportedRestSource("paginator page size must be at least 1")
        paginator["limit"] = limit
    return paginator


def build_auth(connection: Dict[str, Any] | None, secret: str) -> Dict[str, Any] | None:
    """The dlt client auth block for a `rest` connection row.

    A source with no connection is an unauthenticated API, which is ordinary for
    open data - it is not treated as a misconfiguration.
    """
    if not connection:
        return None
    extra = dict(connection.get("extra_config") or {})
    auth_type = str(extra.get("auth_type") or "none").lower()
    if auth_type not in AUTH_TYPES:
        raise UnsupportedRestSource(
            f"auth type must be one of {', '.join(AUTH_TYPES)}, not '{auth_type}'"
        )
    if auth_type == "none":
        return None
    if not secret:
        raise UnsupportedRestSource(
            f"this connection is configured for {auth_type} auth but stores no "
            "secret - re-enter it on the connection"
        )

    if auth_type == "bearer":
        return {"type": "bearer", "token": secret}
    if auth_type == "basic":
        return {
            "type": "http_basic",
            "username": str(connection.get("username") or ""),
            "password": secret,
        }

    location = str(extra.get("api_key_location") or "header").lower()
    if location not in API_KEY_LOCATIONS:
        raise UnsupportedRestSource(
            f"API key location must be one of {', '.join(API_KEY_LOCATIONS)}"
        )
    name = str(extra.get("api_key_name") or connection.get("username") or "").strip()
    if not name:
        raise UnsupportedRestSource(
            "API key auth needs the parameter name the API expects (for example "
            "'X-API-Key')"
        )
    if not _PARAM_KEY_RE.match(name):
        raise UnsupportedRestSource(f"'{name}' is not a usable API key name")
    return {
        "type": "api_key",
        "name": name,
        "api_key": secret,
        "location": location,
    }


def validate_resources(raw: Any, allowed_names: List[str]) -> List[Dict[str, Any]]:
    """Check the resource list and return it in dlt's shape.

    `allowed_names` is the source's `tables` column: the resource names are what
    land as destination tables, so the two must agree rather than each being
    edited on its own.
    """
    if not isinstance(raw, list) or not raw:
        raise UnsupportedRestSource("a REST source needs at least one resource")
    if len(raw) > MAX_RESOURCES:
        raise UnsupportedRestSource(
            f"a REST source is limited to {MAX_RESOURCES} resources"
        )

    allowed = set(allowed_names)
    resources: List[Dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise UnsupportedRestSource("each resource must be an object")
        name = str(entry.get("name") or "").strip()
        if not _NAME_RE.match(name):
            raise UnsupportedRestSource(f"'{name}' is not a usable resource name")
        if name not in allowed:
            raise UnsupportedRestSource(
                f"resource '{name}' is not in this source's table list"
            )

        endpoint: Dict[str, Any] = {"path": _validate_path(entry.get("path"))}
        params = _validate_params(entry.get("params"))
        if params:
            endpoint["params"] = params
        paginator = _validate_paginator(entry.get("paginator"))
        if paginator:
            endpoint["paginator"] = paginator
        selector = str(entry.get("data_selector") or "").strip()
        if selector:
            if not _PATH_RE.match(selector):
                raise UnsupportedRestSource(
                    f"'{selector}' is not a usable data selector"
                )
            endpoint["data_selector"] = selector

        # Which query parameter carries the cursor's last value. Stored on the
        # endpoint below rather than in `params`, because that is where dlt takes
        # it (`incremental.start_param`) and it must not also be a literal param.
        start_param = str(entry.get("incremental_param") or "").strip()
        if start_param:
            if not _PARAM_KEY_RE.match(start_param):
                raise UnsupportedRestSource(
                    f"'{start_param}' is not a usable parameter name"
                )
            if start_param in endpoint.get("params", {}):
                raise UnsupportedRestSource(
                    f"'{start_param}' cannot be both a fixed parameter and the "
                    "cursor parameter"
                )
            endpoint["_start_param"] = start_param

        resource: Dict[str, Any] = {"name": name, "endpoint": endpoint}
        primary_key = entry.get("primary_key")
        if primary_key:
            keys = primary_key if isinstance(primary_key, list) else [primary_key]
            bad = [k for k in keys if not _NAME_RE.match(str(k))]
            if bad:
                raise UnsupportedRestSource(
                    f"'{bad[0]}' is not a usable primary key column"
                )
            resource["primary_key"] = [str(k) for k in keys]
        resources.append(resource)

    missing = allowed - {r["name"] for r in resources}
    if missing:
        raise UnsupportedRestSource(
            f"no endpoint configured for table(s): {', '.join(sorted(missing))}"
        )
    return resources


def _with_incremental(
    resources: List[Dict[str, Any]], cursor: str, initial: str | None
) -> List[Dict[str, Any]]:
    """Attach the source's cursor to every resource, declaratively.

    Two halves, and only the second one saves any work. `endpoint.incremental`
    makes dlt track the cursor and persist it, so re-loaded rows are deduped.
    `start_param` is what actually sends the last value to the API, turning a
    full re-fetch into a filtered one - a resource that names none is still
    correct, just as expensive as before.

    dlt has two shapes for this and they are not interchangeable: the endpoint
    form (`IncrementalConfig`) takes `start_param` and rejects `type`, while the
    parameter form (`IncrementalParamConfig`) requires `type` and has no
    `start_param`. Using the endpoint form for both is why only one is built here.
    """
    if not _CURSOR_PATH_RE.match(cursor):
        raise UnsupportedRestSource(
            f"'{cursor}' is not a usable cursor path - use field names separated "
            "by dots, for example 'attributes.updated_at'"
        )

    updated: List[Dict[str, Any]] = []
    for resource in resources:
        endpoint = dict(resource["endpoint"])
        incremental: Dict[str, Any] = {"cursor_path": cursor}
        if initial:
            incremental["initial_value"] = initial
        start_param = endpoint.pop("_start_param", None)
        if start_param:
            incremental["start_param"] = start_param
        endpoint["incremental"] = incremental
        updated.append({**resource, "endpoint": endpoint})
    return updated


def build_config(
    source_config: Dict[str, Any] | None,
    tables: List[str],
    connection: Dict[str, Any] | None,
    secret: str,
    cursor_field: str | None = None,
    cursor_initial_value: str | None = None,
) -> Dict[str, Any]:
    """The validated `source` block for a REST ingest job."""
    config = source_config or {}
    # The base URL may sit on the connection (one API, several sources) or on the
    # source (a public API with no connection at all). The source wins.
    connection_extra = dict((connection or {}).get("extra_config") or {})
    base_url = validate_base_url(
        str(config.get("base_url") or connection_extra.get("base_url") or "")
    )
    client: Dict[str, Any] = {"base_url": base_url}
    auth = build_auth(connection, secret)
    if auth:
        client["auth"] = auth
    paginator = _validate_paginator(config.get("paginator"))
    if paginator:
        client["paginator"] = paginator

    resources = validate_resources(config.get("resources"), tables)
    if cursor_field:
        resources = _with_incremental(resources, cursor_field, cursor_initial_value)
    else:
        # A cursor parameter with no cursor field has nothing to send. Refusing is
        # better than dropping it: the form offers the field only once a cursor is
        # set, so reaching here means the two disagree.
        named = [r["name"] for r in resources if "_start_param" in r["endpoint"]]
        if named:
            raise UnsupportedRestSource(
                f"resource(s) {', '.join(named)} name a cursor parameter, but this "
                "source has no cursor field"
            )

    return {"type": "rest_api", "client": client, "resources": resources}


def auth_to_request(
    auth: Dict[str, Any] | None,
) -> tuple[Dict[str, str], Dict[str, str]]:
    """Turn dlt's auth block into the headers and query parameters it stands for.

    dlt does this itself inside a pipeline. A *probe* has no pipeline, so the
    same block is rendered here - from build_auth, so there is still one place
    that decides what each auth type means.
    """
    if not auth:
        return {}, {}
    kind = auth["type"]
    if kind == "bearer":
        return {"Authorization": f"Bearer {auth['token']}"}, {}
    if kind == "http_basic":
        import base64

        raw = f"{auth['username']}:{auth['password']}".encode()
        return {"Authorization": f"Basic {base64.b64encode(raw).decode()}"}, {}
    if auth["location"] == "query":
        return {}, {auth["name"]: auth["api_key"]}
    return {auth["name"]: auth["api_key"]}, {}


def suggest_data_selector(payload: Any) -> tuple[str, int]:
    """Where the records are in a response body, and how many came back.

    dlt auto-detects this most of the time; when it guesses wrong the load
    reports success and zero rows, which is the failure this exists to catch.
    Two levels deep, because `{"result": {"items": [...]}}` is as nested as the
    guess is worth making - past that, someone should read their own API docs.
    """
    if isinstance(payload, list):
        return "", len(payload)
    if not isinstance(payload, dict):
        return "", 0
    for key, value in payload.items():
        if isinstance(value, list):
            return str(key), len(value)
    for key, value in payload.items():
        if isinstance(value, dict):
            for inner_key, inner in value.items():
                if isinstance(inner, list):
                    return f"{key}.{inner_key}", len(inner)
    return "", 0


def _test_headers_params(config: Dict[str, Any]) -> tuple[Dict[str, str], Dict[str, str]]:
    """Render the auth for a connection *test*, whose config is a request body."""
    auth = build_auth(
        {
            "extra_config": {
                "auth_type": config.get("auth_type"),
                "api_key_name": config.get("api_key_name"),
                "api_key_location": config.get("api_key_location"),
            },
            "username": config.get("username"),
        },
        str(config.get("password") or config.get("token") or ""),
    )
    return auth_to_request(auth)


async def probe_rest(config: Dict[str, Any]) -> Dict[str, Any]:
    """GET the base URL with the configured auth and report what came back.

    A 4xx other than 401/403 is reported as success: many APIs have no
    listing at their root, and "the host answered and accepted our credential"
    is the only thing a connection test can honestly claim.
    """
    import httpx

    base_url = validate_base_url(str(config.get("base_url") or config.get("host") or ""))
    headers, params = _test_headers_params(config)

    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
            response = await client.get(base_url, headers=headers, params=params)
    except Exception as exc:
        return {"success": False, "message": f"{type(exc).__name__}: {exc}"}

    if response.status_code in (401, 403):
        return {
            "success": False,
            "message": f"{base_url} rejected the credential (HTTP {response.status_code})",
        }
    if response.status_code >= 500:
        return {
            "success": False,
            "message": f"{base_url} returned HTTP {response.status_code}",
        }
    return {
        "success": True,
        "message": f"Reached {base_url} (HTTP {response.status_code})",
    }


async def probe_endpoint(
    *,
    base_url: str,
    path: Any,
    params: Any = None,
    connection: Dict[str, Any] | None = None,
    secret: str = "",
) -> Dict[str, Any]:
    """Fetch one endpoint the way a load would, and report what came back.

    The whole reason a REST source is hard to configure is that nothing before
    this told you whether the URL, the credential and the record path were right
    - a wrong path is a 404 an hour later, and a wrong `data_selector` is a load
    that reports success and moves no rows. Both are answered by one GET.

    Every value goes through the same validators the real config does, so this
    cannot reach a host, a path or a parameter a load could not.
    """
    import httpx

    url = validate_base_url(base_url) + _validate_path(path)
    headers, query = auth_to_request(build_auth(connection, secret))
    query = {**query, **{k: str(v) for k, v in _validate_params(params).items()}}

    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
            response = await client.get(url, headers=headers, params=query)
    except Exception as exc:
        return {"success": False, "url": url, "message": f"{type(exc).__name__}: {exc}"}

    if response.status_code >= 400:
        return {
            "success": False,
            "url": url,
            "status": response.status_code,
            "message": f"{url} returned HTTP {response.status_code}",
        }

    try:
        payload = response.json()
    except ValueError:
        return {
            "success": False,
            "url": url,
            "status": response.status_code,
            "message": "the response is not JSON, so there are no records to read",
        }

    selector, count = suggest_data_selector(payload)
    sample = payload if isinstance(payload, list) else None
    if sample is None and selector:
        sample = payload
        for part in selector.split("."):
            sample = sample.get(part, [])
    first = sample[0] if isinstance(sample, list) and sample else None

    return {
        "success": True,
        "url": url,
        "status": response.status_code,
        "record_count": count,
        # Blank means "records are at the top level", which is a real answer and
        # the one the form should store - not a missing value to fill in.
        "data_selector": selector,
        "fields": sorted(first.keys())[:40] if isinstance(first, dict) else [],
        "message": f"HTTP {response.status_code}, {count} record(s) found",
    }
