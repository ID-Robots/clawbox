"""Strict validation/loading of operator-supplied trusted control UI origins.

This is a narrow escape hatch for genuinely cross-origin or custom-origin
Control UI deployments (for example, a reverse proxy on a different
hostname or port). Same-origin access via `<hostname>.local`,
Tailscale `.ts.net` names, or a private LAN IP already works without any
entry here — see gateway-proxy.ts's isReflectableHost() and
gateway-pre-start.sh's LAN_IPS enumeration.

Contract: a JSON array of strings at CLAWBOX_CONTROL_UI_ORIGINS_FILE (or the
default path below) is read, validated, and merged into the gateway's
generated `controlUi.allowedOrigins` list. A missing file is normal (no
extras, no warning). Anything malformed is dropped with a warning — this
module never raises, since a malformed file must not block gateway boot.
"""

import ipaddress
import json
import os
import re
import urllib.parse

DEFAULT_ORIGINS_PATH = "/home/clawbox/clawbox/data/control-ui-origins.json"
ORIGINS_PATH_ENV_VAR = "CLAWBOX_CONTROL_UI_ORIGINS_FILE"

# DNS-style hostname: dot-separated labels, each starting/ending with an
# alphanumeric, letters/digits/hyphens in between. Dotted-decimal input is
# validated separately as IPv4 so the Python and TypeScript loaders cannot
# disagree about malformed values such as 999.999.999.999.
_HOSTNAME_RE = re.compile(
    r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$"
)


def resolve_origins_path():
    """The path to read configured extra origins from, honoring the env override."""
    return os.environ.get(ORIGINS_PATH_ENV_VAR) or DEFAULT_ORIGINS_PATH


def normalize_origin(raw):
    """Validate and normalize a single origin.

    Accepts exact http/https origins only — no wildcard, no credentials, no
    path beyond "/", no query, no fragment, and a resolvable host[:port].
    Normalizes scheme/host to lowercase, IPv6 hosts to bracket form, and
    drops the port when it's the scheme's default (or when the origin has
    a bare "/" or no path).

    Returns (normalized_origin, warning) — exactly one of the two is None.
    """
    if not isinstance(raw, str):
        return None, f"origin must be a string, got {type(raw).__name__}: {raw!r}"

    # urllib.parse and the WHATWG URL parser disagree on several raw inputs
    # (for example, WHATWG silently removes tabs/newlines while urlsplit can
    # reinterpret backslashes around userinfo). Keep the accepted language to
    # printable ASCII and reject parser-sensitive escape characters before
    # either implementation gets a chance to normalize them.
    if any(ord(char) < 0x20 or ord(char) > 0x7E for char in raw) or any(
        char in raw for char in ("\\", "%")
    ):
        return None, f"origin contains a forbidden raw character: {raw!r}"

    value = raw.strip()
    if not value:
        return None, "origin is empty"
    if "*" in value:
        return None, f"wildcard origins are not allowed: {raw!r}"

    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        # e.g. a malformed bracketed IPv6 host — urlsplit validates and
        # raises ValueError itself rather than just leaving fields empty.
        return None, f"origin could not be parsed: {raw!r}"

    scheme = parsed.scheme.lower()
    if scheme not in ("http", "https"):
        return None, f"origin scheme must be http or https: {raw!r}"

    if parsed.username is not None or parsed.password is not None:
        return None, f"origin must not contain credentials: {raw!r}"

    if parsed.path not in ("", "/"):
        return None, f"origin must not contain a path: {raw!r}"
    if parsed.query:
        return None, f"origin must not contain a query string: {raw!r}"
    if parsed.fragment:
        return None, f"origin must not contain a fragment: {raw!r}"

    try:
        port = parsed.port
    except ValueError:
        return None, f"origin has an invalid port: {raw!r}"

    hostname = parsed.hostname
    if not hostname:
        return None, f"origin is missing a host: {raw!r}"
    hostname = hostname.lower()

    if ":" in hostname:
        # Bracketed IPv6 literal — urlsplit strips the brackets for .hostname.
        try:
            ipv6 = ipaddress.IPv6Address(hostname)
        except ValueError:
            return None, f"origin has an invalid IPv6 host: {raw!r}"
        host_part = f"[{ipv6.compressed}]"
    else:
        if not _HOSTNAME_RE.match(hostname):
            return None, f"origin has an invalid host: {raw!r}"
        if re.fullmatch(r"[0-9.]+", hostname):
            try:
                ipaddress.IPv4Address(hostname)
            except ValueError:
                return None, f"origin has an invalid IPv4 host: {raw!r}"
        host_part = hostname

    default_port = 443 if scheme == "https" else 80
    port_part = "" if port is None or port == default_port else f":{port}"

    return f"{scheme}://{host_part}{port_part}", None


def load_configured_origins(path):
    """Load, validate, and de-duplicate the JSON array of extra origins at `path`.

    A missing file returns ([], []) — no extras, no warning. Any other
    failure (unreadable file, invalid JSON, non-array top level, invalid
    entries) is reported as a warning string and excluded from the result;
    this function never raises.
    """
    if not path or not os.path.isfile(path):
        return [], []

    try:
        with open(path, encoding="utf-8") as f:
            raw_text = f.read()
    except OSError as exc:
        return [], [f"could not read control UI origins file {path}: {exc}"]
    except UnicodeDecodeError as exc:
        return [], [f"control UI origins file {path} is not valid UTF-8: {exc}"]

    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        return [], [f"control UI origins file {path} is not valid JSON: {exc}"]

    if not isinstance(data, list):
        return [], [
            (
                f"control UI origins file {path} must contain a JSON array, "
                f"got {type(data).__name__}"
            )
        ]

    warnings = []
    origins = []
    seen = set()
    for index, entry in enumerate(data):
        normalized, warning = normalize_origin(entry)
        if warning:
            warnings.append(f"control UI origins file {path} entry {index}: {warning}")
            continue
        if normalized not in seen:
            seen.add(normalized)
            origins.append(normalized)

    return origins, warnings


def merge_origins(defaults, extras):
    """Merge `extras` into `defaults`: defaults first, de-duplicated, order preserved."""
    merged = list(defaults)
    seen = set(merged)
    for origin in extras:
        if origin not in seen:
            seen.add(origin)
            merged.append(origin)
    return merged
