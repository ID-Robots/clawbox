"""A stand-in for the two services a backup run talks to, on one loopback port.

  * the portal — `POST /api/clawkeep/credentials` and `/api/clawkeep/heartbeat`;
  * the storage — the slice of the S3 API `clawkeep.s3` uses, path-style:
    ListObjectsV2 (paginated, `page_size` keys a page), PutObject, GetObject,
    HeadObject and DeleteObject.

It speaks real HTTP, so a test that points the daemon at it runs `requests`,
boto3's signing, its paginator and its transfer manager for real rather than
a mock of them. What it does NOT do is enforce the quota it hands out: like
the real storage, it accepts any PUT the credentials allow. Whether a backup
fits is the device's decision, which is the thing under test.

Knobs, all plain attributes on :class:`FakeCloud`:
  quota_bytes     what `/credentials` reports as `quotaBytes`
  page_size       keys per listing page (small, so a listing has several)
  fail_listing    True: every listing answers 500 InternalError
  hang_listing    an Event every listing waits on, then drops the connection
                  unanswered: a store that takes the request and never replies
  hold_uploads    an Event a snapshot PUT waits on before it is stored
"""

from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlsplit
from xml.sax.saxutils import escape

BUCKET = "backups"
PREFIX = "users/u_test/repo/"
TOKEN = "claw_test_token"


@dataclass(frozen=True)
class StoredObject:
    body: bytes
    modified: datetime


class FakeCloud:
    def __init__(self, *, quota_bytes: int, page_size: int = 2) -> None:
        self.quota_bytes = quota_bytes
        self.page_size = page_size
        self.fail_listing = False
        self.hang_listing: threading.Event | None = None
        self.hold_uploads: threading.Event | None = None
        self.upload_arrived = threading.Event()
        #: Full object key → what is stored there.
        self.objects: dict[str, StoredObject] = {}
        #: Every heartbeat body the portal received, in order.
        self.heartbeats: list[dict[str, Any]] = []
        #: Every request, in order, as `(verb, detail)` — verbs CREDENTIALS,
        #: HEARTBEAT, LIST (detail: the continuation token, "" for a first
        #: page), GET, HEAD, PUT and DELETE (detail: the object name).
        self.requests: list[tuple[str, str]] = []
        self._lock = threading.Lock()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _handler_for(self))
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    # ── lifecycle ────────────────────────────────────────────────────────

    def __enter__(self) -> FakeCloud:
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        if self.hang_listing is not None:
            self.hang_listing.set()
        if self.hold_uploads is not None:
            self.hold_uploads.set()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(10)

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    # ── what a test seeds and reads back ─────────────────────────────────

    def seed(self, name: str, body: bytes, *, modified: datetime | None = None) -> None:
        with self._lock:
            self.objects[PREFIX + name] = StoredObject(
                body, modified or datetime.now(timezone.utc),
            )

    def contents(self) -> dict[str, StoredObject]:
        """Everything under the prefix by object name — bytes AND timestamps,
        so "untouched" can be asserted rather than "same names"."""
        with self._lock:
            return {key[len(PREFIX):]: obj for key, obj in self.objects.items()}

    def snapshots(self) -> dict[str, bytes]:
        return {
            name: obj.body for name, obj in self.contents().items() if name != "manifest.json"
        }

    def manifest(self) -> dict[str, Any]:
        return json.loads(self.contents()["manifest.json"].body)

    def used_bytes(self) -> int:
        return sum(len(body) for body in self.snapshots().values())

    def count(self, verb: str) -> int:
        with self._lock:
            return sum(1 for seen, _ in self.requests if seen == verb)

    def writes(self) -> list[tuple[str, str]]:
        """Every request that changed the bucket."""
        with self._lock:
            return [r for r in self.requests if r[0] in ("PUT", "DELETE")]

    # ── the two services ─────────────────────────────────────────────────

    def _note(self, verb: str, detail: str) -> None:
        with self._lock:
            self.requests.append((verb, detail))

    def credentials(self) -> dict[str, Any]:
        return {
            "accessKeyId": "test-access-key",
            "secretAccessKey": "test-secret-key",
            "sessionToken": "test-session-token",
            "endpoint": self.url,
            "bucket": BUCKET,
            "prefix": PREFIX,
            "expiresAt": 4_102_444_800_000,
            "quotaBytes": self.quota_bytes,
            "cloudBytes": 0,
        }

    def list_page(self, prefix: str, token: str, url_encoded: bool) -> str:
        with self._lock:
            keys = sorted(key for key in self.objects if key.startswith(prefix))
            if token:
                keys = [key for key in keys if key > token]
            page, more = keys[: self.page_size], len(keys) > self.page_size
            entries = [(key, self.objects[key]) for key in page]

        def text(value: str) -> str:
            return escape(quote(value, safe="/") if url_encoded else value)

        parts = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
            f"<Name>{BUCKET}</Name><Prefix>{text(prefix)}</Prefix>",
            f"<KeyCount>{len(entries)}</KeyCount><MaxKeys>{self.page_size}</MaxKeys>",
            f"<IsTruncated>{'true' if more else 'false'}</IsTruncated>",
        ]
        if url_encoded:
            parts.append("<EncodingType>url</EncodingType>")
        if token:
            parts.append(f"<ContinuationToken>{escape(token)}</ContinuationToken>")
        if more:
            parts.append(f"<NextContinuationToken>{escape(page[-1])}</NextContinuationToken>")
        for key, obj in entries:
            stamp = obj.modified.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
            parts.append(
                f"<Contents><Key>{text(key)}</Key><LastModified>{stamp}</LastModified>"
                f"<ETag>&quot;{hashlib.md5(obj.body).hexdigest()}&quot;</ETag>"
                f"<Size>{len(obj.body)}</Size><StorageClass>STANDARD</StorageClass></Contents>"
            )
        parts.append("</ListBucketResult>")
        return "".join(parts)


def _decode_aws_chunked(raw: bytes) -> bytes:
    """`aws-chunked` framing — `<hex size>[;extension]\\r\\n<data>\\r\\n`… and a
    zero chunk, optionally with trailers — as newer SDKs send a streamed body."""
    out, at = bytearray(), 0
    while at < len(raw):
        end = raw.index(b"\r\n", at)
        size = int(raw[at:end].split(b";", 1)[0], 16)
        if size == 0:
            break
        out += raw[end + 2 : end + 2 + size]
        at = end + 2 + size + 2
    return bytes(out)


def _handler_for(cloud: FakeCloud) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            pass

        # ── plumbing ─────────────────────────────────────────────────────

        def _body(self) -> bytes:
            if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
                raw = bytearray()
                while True:
                    size = int(self.rfile.readline().split(b";", 1)[0].strip() or b"0", 16)
                    if size == 0:
                        while self.rfile.readline().strip():
                            pass
                        break
                    raw += self.rfile.read(size)
                    self.rfile.readline()
                data = bytes(raw)
            else:
                data = self.rfile.read(int(self.headers.get("Content-Length", "0") or 0))
            streamed = self.headers.get("x-amz-content-sha256", "").startswith("STREAMING-")
            if streamed or "aws-chunked" in self.headers.get("Content-Encoding", ""):
                return _decode_aws_chunked(data)
            return data

        def _send(
            self, status: int, body: bytes = b"", content_type: str = "application/xml",
            **headers: str,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            for name, value in headers.items():
                self.send_header(name, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _s3_error(self, status: int, code: str, message: str) -> None:
            self._send(status, (
                '<?xml version="1.0" encoding="UTF-8"?>'
                f"<Error><Code>{code}</Code><Message>{message}</Message>"
                "<RequestId>fake</RequestId></Error>"
            ).encode())

        def _key(self) -> tuple[str, dict[str, list[str]]]:
            """The object key after `/<bucket>/` ("" for the bucket itself)."""
            split = urlsplit(self.path)
            path = unquote(split.path)
            marker = f"/{BUCKET}"
            key = path[len(marker):].lstrip("/") if path.startswith(marker) else path
            return key, parse_qs(split.query, keep_blank_values=True)

        # ── portal ───────────────────────────────────────────────────────

        def do_POST(self) -> None:  # noqa: N802
            raw = self._body()
            if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                self._send(401, b'{"error":"unauthorized"}', "application/json")
                return
            if self.path == "/api/clawkeep/credentials":
                cloud._note("CREDENTIALS", "")
                self._send(200, json.dumps(cloud.credentials()).encode(), "application/json")
            elif self.path == "/api/clawkeep/heartbeat":
                beat = json.loads(raw or b"{}")
                with cloud._lock:
                    cloud.heartbeats.append(beat)
                    cloud.requests.append(("HEARTBEAT", str(beat.get("status", ""))))
                self._send(200, b"{}", "application/json")
            else:
                self._send(404, b'{"error":"not found"}', "application/json")

        # ── storage ──────────────────────────────────────────────────────

        def do_GET(self) -> None:  # noqa: N802
            key, query = self._key()
            if not key and "list-type" in query:
                token = query.get("continuation-token", [""])[0]
                cloud._note("LIST", token)
                hang = cloud.hang_listing
                if hang is not None:
                    hang.wait(60)
                    self.close_connection = True
                    return
                if cloud.fail_listing:
                    self._s3_error(500, "InternalError", "We encountered an internal error.")
                    return
                page = cloud.list_page(
                    query.get("prefix", [""])[0], token,
                    query.get("encoding-type", [""])[0] == "url",
                )
                self._send(200, page.encode())
                return
            self._object(key, "GET")

        def do_HEAD(self) -> None:  # noqa: N802
            self._object(self._key()[0], "HEAD")

        def _object(self, key: str, verb: str) -> None:
            cloud._note(verb, key[len(PREFIX):] if key.startswith(PREFIX) else key)
            with cloud._lock:
                obj = cloud.objects.get(key)
            if obj is None:
                self._s3_error(404, "NoSuchKey", "The specified key does not exist.")
                return
            self._send(
                200, obj.body, "application/octet-stream",
                ETag=f'"{hashlib.md5(obj.body).hexdigest()}"',
            )

        def do_PUT(self) -> None:  # noqa: N802
            key, _ = self._key()
            body = self._body()
            name = key[len(PREFIX):] if key.startswith(PREFIX) else key
            if name != "manifest.json":
                cloud.upload_arrived.set()
                if cloud.hold_uploads is not None:
                    cloud.hold_uploads.wait(60)
            with cloud._lock:
                cloud.requests.append(("PUT", name))
                cloud.objects[key] = StoredObject(body, datetime.now(timezone.utc))
            self._send(200, ETag=f'"{hashlib.md5(body).hexdigest()}"')

        def do_DELETE(self) -> None:  # noqa: N802
            key, _ = self._key()
            with cloud._lock:
                cloud.requests.append(
                    ("DELETE", key[len(PREFIX):] if key.startswith(PREFIX) else key),
                )
                cloud.objects.pop(key, None)
            self._send(204)

    return Handler
