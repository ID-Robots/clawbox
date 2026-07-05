"""Trusted-origin helpers for the setup/control UI allowlist.

Kept as an importable module (rather than inline in gateway-pre-start.sh's
heredoc) so the validation is unit-testable. Operators can add extra trusted
origins — VPN / MagicDNS hostnames, a stable HTTPS origin — via the
`controlUi.extraAllowedOrigins` key in openclaw.json instead of patching the
generated allowlist by hand (which drifts across updates). See issue #232.

Design: an explicit allowlist only. Entries must be full http/https origins
(scheme://host[:port]); bare hostnames, wildcards, paths, and credentials are
rejected so a configured value can never quietly widen cross-origin access.
"""
from urllib.parse import urlsplit


def normalize_origin(value):
    """Return the normalized origin (``scheme://host[:port]``, lowercased
    scheme + host, no trailing slash) for a well-formed http/https origin, or
    ``None`` if ``value`` is not a valid full origin."""
    if not isinstance(value, str):
        return None
    v = value.strip()
    if not v or "*" in v:
        return None
    try:
        parts = urlsplit(v)
        port = parts.port  # the property raises ValueError on a bad port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https"):
        return None
    host = parts.hostname
    if not host:
        return None
    # No path/query/fragment and no embedded credentials — an origin is just
    # scheme + host + optional port.
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        return None
    if parts.username or parts.password:
        return None
    origin = parts.scheme + "://" + host.lower()
    if port is not None:
        origin += ":" + str(port)
    return origin


def merge_extra_origins(defaults, configured):
    """Union the validated ``configured`` origins into ``defaults``, preserving
    order and dropping duplicates. Returns ``(merged, invalid)`` where
    ``invalid`` lists the rejected entries so the caller can report them.
    ``configured`` of ``None`` leaves the defaults untouched (default behavior);
    a non-list ``configured`` is reported as invalid and ignored."""
    merged = list(defaults)
    seen = set(merged)
    invalid = []
    if configured is None:
        return merged, invalid
    if not isinstance(configured, list):
        return merged, [configured]
    for entry in configured:
        norm = normalize_origin(entry)
        if norm is None:
            invalid.append(entry)
        elif norm not in seen:
            merged.append(norm)
            seen.add(norm)
    return merged, invalid


def _selftest():
    # Valid origins (scheme/host lowercased, trailing slash + default handling).
    assert normalize_origin("https://box.example.com") == "https://box.example.com"
    assert normalize_origin("http://100.64.0.1:8443") == "http://100.64.0.1:8443"
    assert normalize_origin("HTTP://Box.Local") == "http://box.local"
    assert normalize_origin("https://host/") == "https://host"
    # Invalid: bare host, wrong scheme, wildcard, path/query, credentials, junk.
    for bad in ["box.example.com", "ftp://host", "https://*.example.com",
                "https://host/path", "https://host?q=1", "https://host#f",
                "https://user:pw@host", "https://", "", "   ",
                "http://host:notaport", 42, None, ["x"]]:
        assert normalize_origin(bad) is None, bad
    # Default behavior: no config leaves defaults untouched.
    d = ["http://localhost", "http://clawbox.local"]
    assert merge_extra_origins(d, None) == (d, [])
    # Valid extra union'd in; an existing/duplicate entry is not re-added.
    merged, invalid = merge_extra_origins(d, ["https://vpn.example.ts.net", "http://localhost"])
    assert merged == d + ["https://vpn.example.ts.net"], merged
    assert invalid == []
    # Invalid entry reported, never added to the active list.
    merged, invalid = merge_extra_origins(d, ["not-an-origin", "https://ok.example.com"])
    assert merged == d + ["https://ok.example.com"], merged
    assert invalid == ["not-an-origin"], invalid
    # A non-list config value is reported and ignored.
    merged, invalid = merge_extra_origins(d, "https://single")
    assert merged == d and invalid == ["https://single"]
    print("gateway_origins self-test: OK")


if __name__ == "__main__":
    _selftest()
