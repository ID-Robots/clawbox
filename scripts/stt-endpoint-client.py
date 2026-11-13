#!/usr/bin/env python3
"""Transcribe one voice note on the owner's own OpenAI-compatible speech server.

The channel half of ClawBox's "your speech server" transcription engine
(TASK-2501 PR-D). OpenClaw runs this as a `type: "cli"` row of
`tools.media.models` for every channel voice note (Telegram and friends) and
reads the transcript from stdout, exactly as it reads `stt-client.py`'s; the
chat microphone asks the same server from src/lib/stt-endpoint.ts.

It reads the same two things that module does, from the app's own data
directory (this script lives in <app>/scripts/):
  - the record `stt_endpoint` = {baseUrl, model} in data/config.json;
  - the optional key in data/.stt-endpoint-key (0600). Never printed.

THE ADDRESS RULE IS THE SAME, and it is applied before a byte is sent: the
host is resolved and every address must be loopback or on the private LAN
(RFC 1918, CGNAT, IPv6 unique-local) and none may be link-local, multicast or
unspecified. A name that does not resolve is refused. Redirects are not
followed. So a voice note never leaves the owner's network through this
script, whatever the record says.

Exit 0 with the transcript on stdout; anything else is a failure OpenClaw
records for this row. Standard library only: the gateway runs it with
/usr/bin/python3 and no virtualenv.
"""

import ipaddress
import json
import mimetypes
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.environ.get("CLAWBOX_DEVICE_STORE") or os.path.join(APP_ROOT, "data", "config.json")
KEY_FILE = os.path.join(os.path.dirname(STORE), ".stt-endpoint-key")
TIMEOUT_S = 110  # under the row's own timeoutSeconds (120)
MAX_ANSWER = 1024 * 1024

# isPrivateIp (src/lib/private-address.ts) minus what refusedEngineHost and
# isLanAddress (src/lib/stt-endpoint.ts) take back out.
_LAN = [ipaddress.ip_network(n) for n in (
    "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10",
    "::1/128", "fc00::/7",
)]


def fail(msg):
    sys.stderr.write("stt-endpoint-client: %s\n" % msg)
    sys.exit(1)


def is_lan(addr):
    try:
        ip = ipaddress.ip_address(addr.split("%")[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return any(ip in net for net in _LAN if net.version == ip.version)


_real_getaddrinfo = socket.getaddrinfo


def pin_host(host):
    """Resolve `host` ONCE, check every answer, and pin the connection to it.

    THE ADDRESS CHECKED IS THE ADDRESS DIALLED: after this, every lookup of
    the name in this process answers the checked addresses only, so a DNS
    answer that changes between the check and the connect (rebinding) cannot
    carry a voice note off the network. Answers False when the host is not on
    this box or the local network, or does not resolve.
    """
    bare = host.strip("[]").lower().rstrip(".")
    if not bare:
        return False
    try:
        infos = _real_getaddrinfo(bare, None)
    except (socket.gaierror, UnicodeError, OSError):
        return False
    if not infos or not all(is_lan(info[4][0]) for info in infos):
        return False

    def pinned(name, port, *args, **kwargs):
        if isinstance(name, str) and name.strip("[]").lower().rstrip(".") == bare:
            # Every checked address, in the resolver's order, so a name with both
            # ::1 and 127.0.0.1 falls back the way any client would.
            out = []
            for addr in dict.fromkeys(info[4][0] for info in infos):
                out.extend(_real_getaddrinfo(addr, port, *args, **kwargs))
            return out
        raise OSError("stt-endpoint-client connects to the checked speech server only")

    socket.getaddrinfo = pinned
    return True


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401 — never follow
        return None


def main():
    if len(sys.argv) != 2:
        fail("usage: stt-endpoint-client.py <audio file>")
    audio_path = sys.argv[1]
    try:
        with open(STORE, encoding="utf-8") as fh:
            store = json.load(fh)
    except Exception as exc:  # noqa: BLE001 — every failure is "no record"
        fail("the device store could not be read (%s)" % type(exc).__name__)
    record = store.get("stt_endpoint") if isinstance(store, dict) else None
    if not isinstance(record, dict):
        fail("no speech server is saved")
    base = record.get("baseUrl")
    model = record.get("model")
    if not isinstance(base, str) or not isinstance(model, str) or not base or not model:
        fail("the saved speech server is incomplete")
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        fail("the saved speech server address is not http(s)")
    if not pin_host(parsed.hostname or ""):
        fail("the speech server is not on this box or the local network; nothing was sent")
    key = None
    try:
        with open(KEY_FILE, encoding="utf-8") as fh:
            key = fh.read().strip() or None
    except OSError:
        key = None

    try:
        with open(audio_path, "rb") as fh:
            audio = fh.read()
    except OSError as exc:
        fail("could not read the voice note (%s)" % type(exc).__name__)
    name = os.path.basename(audio_path) or "voice.ogg"
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    boundary = "clawbox-%s" % uuid.uuid4().hex
    parts = []
    for field, value in (("model", model), ("response_format", "json")):
        parts.append(
            ("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n" % (boundary, field, value)).encode()
        )
    parts.append(
        ("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\nContent-Type: %s\r\n\r\n"
         % (boundary, name.replace('"', ""), ctype)).encode()
    )
    body = b"".join(parts) + audio + ("\r\n--%s--\r\n" % boundary).encode()
    headers = {"Content-Type": "multipart/form-data; boundary=%s" % boundary, "Accept": "application/json"}
    if key:
        headers["Authorization"] = "Bearer %s" % key
    req = urllib.request.Request(base.rstrip("/") + "/audio/transcriptions", data=body, headers=headers, method="POST")
    # No proxy: a LAN request routed through an outbound proxy would leave the network.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)
    try:
        with opener.open(req, timeout=TIMEOUT_S) as res:
            raw = res.read(MAX_ANSWER + 1)
    except urllib.error.HTTPError as exc:
        fail("the speech server answered HTTP %d" % exc.code)
    except (urllib.error.URLError, OSError) as exc:
        fail("could not reach the speech server (%s)" % type(exc).__name__)
    if len(raw) > MAX_ANSWER:
        fail("the speech server's answer is too large")
    try:
        text = json.loads(raw.decode("utf-8")).get("text")
    except Exception:  # noqa: BLE001
        fail("the speech server's answer is not JSON")
    if not isinstance(text, str):
        fail("the speech server answered without a transcript")
    sys.stdout.write(text.strip() + "\n")


if __name__ == "__main__":
    main()
