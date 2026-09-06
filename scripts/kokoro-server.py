#!/usr/bin/env python3
"""Persistent Kokoro TTS server - keeps model loaded in GPU memory.

Exposes two interfaces:
1. Unix socket at /tmp/kokoro-server.sock (legacy, used by kokoro-client.sh)
2. HTTP server on port 8880 with OpenAI-compatible /v1/audio/speech endpoint
"""
import sys, os, json, socket, struct, tempfile, stat, io, threading, time
from http.server import HTTPServer, BaseHTTPRequestHandler
import soundfile as sf

os.environ.setdefault("LD_LIBRARY_PATH",
    "/home/clawbox/.local/lib:"
    "/home/clawbox/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib:"
    "/usr/local/cuda/lib64")

SOCKET_PATH = "/tmp/kokoro-server.sock"
HTTP_PORT = int(os.environ.get("KOKORO_HTTP_PORT", "8880"))
IDLE_TIMEOUT = int(os.environ.get("IDLE_TIMEOUT", "300"))  # 5 min default

_last_activity = time.monotonic()

def touch_activity():
    global _last_activity
    _last_activity = time.monotonic()

def _idle_watchdog():
    while True:
        time.sleep(30)
        idle = time.monotonic() - _last_activity
        if idle >= IDLE_TIMEOUT:
            print(f"Idle for {int(idle)}s, shutting down.", flush=True)
            # Take the socket with us. os._exit runs no cleanup, so the file
            # outlived every idle shutdown and `[ -S … ]` — the cheap "is the
            # server up?" test the callers make — kept answering yes for a
            # socket nothing was listening on. Best effort: a socket we cannot
            # unlink is still no reason to stay resident.
            try:
                os.unlink(SOCKET_PATH)
            except OSError:
                pass
            os._exit(0)

# Voice mapping: OpenAI voice names -> Kokoro voices
VOICE_MAP = {
    "alloy": "af_heart",
    "echo": "af_heart",
    "fable": "af_heart",
    "onyx": "am_michael",
    "nova": "af_heart",
    "shimmer": "af_heart",
    "af_heart": "af_heart",
    "am_michael": "am_michael",
}
DEFAULT_VOICE = "af_heart"

pipeline = None
pipeline_lock = threading.Lock()

# Can THIS process turn a word it has never seen into phonemes?
#
# "ok" / "absent" / "unknown", and the distinction is the point: "unknown" is a
# shape this could not read, never a verdict about the box.
phonemiser_state = "unknown"

# Nothing any lexicon holds, so a working espeak fallback phonemises all three
# and a missing one drops all three. The same words install-voice.sh's
# kokoro_check_phonemiser uses, deliberately: the two must agree about what
# "working" means.
PHONEMISER_PROBE_WORDS = ("zorblattic", "frobnicator", "squibbled")
# misaki's unknown-token marker (U+2753). It also emits nothing at all when the
# G2P was built with unk='', so both count as dropped.
UNKNOWN_PHONEME_MARKER = chr(10067)


def phonemiser_verdict(g2p):
    """"ok" when out-of-vocabulary words phonemise, "absent" when they vanish.

    WHY AT RUNTIME, when install-voice.sh already checks it. That check runs in
    ANOTHER PROCESS, at install time, and this server builds its own KPipeline
    later — so the install-time verdict is a probe-once for the life of the box.
    A `pip install --upgrade`, a wiped ~/.local or a python minor bump can lose
    espeakng-loader while the stamp, `import kokoro, torch` and this server's
    own health all stay green, and every out-of-vocabulary word — a name, a
    brand, "ClawBox" itself — is then dropped from every spoken reply with
    nothing to show for it.
    kokoro builds the fallback inside a try/except and degrades to
    `logger.warning('EspeakFallback not Enabled: OOD words will be skipped')`
    with `fallback=None`; nothing downstream reads that warning.

    BEHAVIOUR, not structure: it asks for SOMETHING back for a word no lexicon
    has. `kokoro` is installed unpinned, so a check written against today's
    attribute names would start failing WORKING boxes the day misaki renames
    one — anything this cannot read is "unknown" and is never graded.
    """
    try:
        dropped = [
            word for word in PHONEMISER_PROBE_WORDS
            if not ((g2p(word)[0] or "").replace(UNKNOWN_PHONEME_MARKER, "").strip())
        ]
    except Exception as exc:
        print(
            f"WARN: could not exercise the phonemiser ({type(exc).__name__}: {exc}) "
            "-- not treating that as a verdict",
            flush=True,
        )
        return "unknown"
    return "absent" if dropped else "ok"


def health_payload():
    """What /health answers. Degraded is still SERVING — see load_model."""
    return {
        "status": "degraded" if phonemiser_state == "absent" else "ok",
        "model": "kokoro-82m",
        "phonemiser": phonemiser_state,
    }


def load_model():
    global phonemiser_state
    from kokoro import KPipeline
    print("Loading Kokoro model on GPU...", flush=True)
    p = KPipeline(lang_code='a')
    print(f"Model loaded on {next(p.model.parameters()).device}", flush=True)
    phonemiser_state = phonemiser_verdict(getattr(p, "g2p", None))
    if phonemiser_state == "absent":
        # WARNED, never refused. Dropping out-of-vocabulary words beats not
        # speaking at all, and a box whose only other engine is the cloud voice
        # would go silent on a refusal. /health says "degraded" so the fact is
        # readable from outside this journal.
        print(
            "WARN: the espeak phonemiser is unavailable — out-of-vocabulary words "
            "(names, brands, ClawBox itself) will be DROPPED from speech. "
            "The espeakng-loader wheel kokoro pulls in is missing or broken; "
            "reinstall it with the box's voice install.",
            flush=True,
        )
    else:
        print(f"Phonemiser: {phonemiser_state}", flush=True)
    return p

def generate_audio(text, voice=DEFAULT_VOICE):
    """Generate audio, returns WAV bytes."""
    kokoro_voice = VOICE_MAP.get(voice, voice if voice else DEFAULT_VOICE)
    buf = io.BytesIO()
    with pipeline_lock:
        for _i, (_gs, _ps, audio) in enumerate(pipeline(text, voice=kokoro_voice)):
            sf.write(buf, audio, 24000, format='WAV')
            break  # first segment
    buf.seek(0)
    return buf.read()

def generate_to_file(text, output_path, voice=DEFAULT_VOICE):
    """Generate audio into a file the CLIENT created — see resolve_output."""
    kokoro_voice = VOICE_MAP.get(voice, voice if voice else DEFAULT_VOICE)
    with pipeline_lock:
        for _i, (_gs, _ps, audio) in enumerate(pipeline(text, voice=kokoro_voice)):
            # A file object rather than the path: soundfile's path form opens
            # (and follows) whatever is at that name when it runs, which would
            # undo the lstat resolve_output just made. `format` is mandatory
            # with a file object; the subtype stays PCM_16, what the path form
            # wrote (verified against soundfile 0.14.0 on the box).
            with open_output(output_path) as f:
                sf.write(f, audio, 24000, format="WAV")
            break

# ── OpenAI-compatible HTTP handler ──────────────────────────────────────────

class TTSHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[HTTP] {args[0]}", flush=True)

    def do_GET(self):
        if self.path == "/health" or self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(health_payload()).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        touch_activity()
        if self.path != "/v1/audio/speech":
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Not found"}).encode())
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length > 0 else {}

            text = body.get("input", "")
            voice = body.get("voice", DEFAULT_VOICE)
            resp_format = body.get("response_format", "wav")

            if not text:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "input is required"}).encode())
                return

            wav_data = generate_audio(text, voice)

            # Convert to requested format via ffmpeg, fall back to WAV
            audio_data = wav_data
            content_type = "audio/wav"
            if resp_format in ("mp3", "opus"):
                try:
                    import subprocess
                    fmt = {"mp3": ("mp3", "audio/mpeg"), "opus": ("opus", "audio/opus")}[resp_format]
                    proc = subprocess.run(
                        ["ffmpeg", "-y", "-i", "pipe:0", "-f", fmt[0], "-ab", "64k", "pipe:1"],
                        input=wav_data, capture_output=True, timeout=30)
                    if proc.returncode == 0:
                        audio_data = proc.stdout
                        content_type = fmt[1]
                except FileNotFoundError:
                    print("[HTTP] ffmpeg not found, returning WAV", flush=True)

            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(audio_data)))
            self.end_headers()
            self.wfile.write(audio_data)

        except Exception as e:
            print(f"[HTTP] Error: {e}", flush=True)
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

# ── Unix socket server (legacy) ────────────────────────────────────────────
#
# WHO may speak on this socket, and WHERE it will write. Every legitimate
# client is this same user: clawbox-tts.sh's kokoro_via_server (run by the
# gateway units and the web server, all User=clawbox) and kokoro-client.sh —
# plus root, which no file mode stops anyway. The socket used to be chmod 0666
# in a sticky /tmp and `output` went straight to sf.write, so any other local
# uid (a compromised avahi-daemon, the captive portal's dnsmasq as nobody)
# could name ~/.openclaw/openclaw.json and have it truncated with WAV bytes.
# Three gates now, each enough on its own: the socket's mode, the peer's uid,
# and the shape of the output path.
#
# The whole region between this heading and "# ── Main" is executed by
# src/tests/unit/kokoro-server-socket.test.ts with stubs in front of it, so
# nothing in it may reach for soundfile, kokoro or the pipeline directly.

def peer_uid_allowed(uid):
    """This process's own user, or root. Nobody else has business here."""
    return uid in (os.getuid(), 0)


def peer_uid(conn):
    """The uid on the other end, as the kernel reports it (SO_PEERCRED: pid, uid, gid)."""
    creds = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    _pid, uid, _gid = struct.unpack("3i", creds)
    return uid


def resolve_output(path):
    """The one output shape honoured, or a ValueError saying why not.

    Both real clients mktemp the WAV BEFORE asking, directly in the temp dir:
      scripts/openclaw/clawbox-tts.sh (kokoro_via_server's caller, line 743):
        TMPWAV="$(mktemp "${TMPDIR:-/tmp}/clawbox-tts_XXXXXX.wav")"
      scripts/kokoro-client.sh (line 9):
        TMPWAV=$(mktemp /tmp/kokoro_XXXXXX.wav)
    So exactly that is required: an absolute *.wav path whose directory IS /tmp
    (or this process's own tempfile dir, /tmp unless TMPDIR moves it — never
    /var/tmp, which no client uses), already existing as a regular file of
    ours. A symlink is refused by lstat; a file nobody made is refused rather
    than created, because nothing here creates files: the client made it, the
    server only fills it. Raised rather than returned, so serve_unix's one
    except arm answers `ERR:<reason>` exactly as it does for a bad body, and
    clawbox-tts.sh's fallback path takes over with the refusal in its notes.
    """
    if not isinstance(path, str) or not path:
        raise ValueError("output required")
    if not os.path.isabs(path):
        raise ValueError("output must be an absolute path")
    if not path.endswith(".wav"):
        raise ValueError("output must end in .wav")
    allowed = {"/tmp", os.path.realpath(tempfile.gettempdir())}
    if os.path.realpath(os.path.dirname(path)) not in allowed:
        raise ValueError("output must be a file directly in the temp directory")
    try:
        st = os.lstat(path)
    except OSError:
        raise ValueError("output must already exist (the client creates it with mktemp)")
    if not stat.S_ISREG(st.st_mode):
        raise ValueError("output must be a regular file, not a symlink")
    if st.st_uid != os.getuid():
        raise ValueError("output must be owned by the user running this server")
    return path


def open_output(path):
    """Open an already-resolved output for writing, refusing a symlink.

    resolve_output has just lstat'd the path as a regular file of ours, but a
    caller could swap a symlink in between that check and this open —
    O_NOFOLLOW turns the swap into an ELOOP instead of a write through the
    link, and the absence of O_CREAT means this can never bring a file into
    existence anywhere.
    """
    fd = os.open(path, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC)
    return os.fdopen(fd, "wb")


def serve_unix(pipe):
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    # Bind under a umask of our own, so the socket is never wider than 0600
    # for even the instant between bind and chmod — the user manager's umask
    # is not ours to rely on — then say 0600 outright: owner only, and root
    # ignores modes anyway.
    prev_umask = os.umask(0o177)
    try:
        sock.bind(SOCKET_PATH)
    finally:
        os.umask(prev_umask)
    os.chmod(SOCKET_PATH, 0o600)
    sock.listen(5)
    print(f"Kokoro Unix socket listening on {SOCKET_PATH}", flush=True)

    while True:
        conn, _ = sock.accept()
        try:
            # The mode-independent gate: it survives any umask or chmod drift
            # in the unit, and a refused peer does not count as activity.
            uid = peer_uid(conn)
            if not peer_uid_allowed(uid):
                print(f"[Unix] Refused a connection from uid {uid}", flush=True)
                conn.sendall(b"ERR:refused: not this server's user")
                continue
            touch_activity()
            data = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
            req = json.loads(data.decode())
            text = req["text"]
            output = resolve_output(req.get("output"))
            voice = req.get("voice", DEFAULT_VOICE)
            generate_to_file(text, output, voice)
            conn.sendall(b"OK")
        except Exception as e:
            print(f"[Unix] Error: {e}", flush=True)
            try:
                conn.sendall(f"ERR:{e}".encode())
            except Exception as exc:
                print(f"[Unix] Failed to send error response: {exc}", flush=True)
        finally:
            conn.close()

# ── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    pipeline = load_model()

    # Start Unix socket server in background thread
    unix_thread = threading.Thread(target=serve_unix, args=(pipeline,), daemon=True)
    unix_thread.start()

    # Start idle watchdog
    threading.Thread(target=_idle_watchdog, daemon=True).start()

    # Start HTTP server in main thread
    server = HTTPServer(("0.0.0.0", HTTP_PORT), TTSHandler)
    print(f"Kokoro HTTP server listening on port {HTTP_PORT}", flush=True)
    print(f"OpenAI-compatible endpoint: http://localhost:{HTTP_PORT}/v1/audio/speech", flush=True)
    server.serve_forever()
