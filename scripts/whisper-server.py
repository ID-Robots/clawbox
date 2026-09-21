#!/usr/bin/env python3
"""Persistent Whisper STT server - keeps model loaded in GPU memory."""
import sys, os, json, socket, struct, time, threading

os.environ.setdefault("LD_LIBRARY_PATH", "/home/clawbox/.local/lib:/home/clawbox/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib:/usr/local/cuda/lib64")

SOCKET_PATH = "/tmp/whisper-server.sock"
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")
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
            os._exit(0)

def load_model():
    from faster_whisper import WhisperModel
    try:
        import ctranslate2
        ctranslate2.get_supported_compute_types("cuda")
        device, compute = "cuda", "float16"
    except Exception:
        device, compute = "cpu", "int8"
    print(f"Loading Whisper '{MODEL_SIZE}' on {device} ({compute})...", flush=True)
    model = WhisperModel(MODEL_SIZE, device=device, compute_type=compute)
    print(f"Whisper model loaded on {device}", flush=True)
    return model

def transcribe(model, audio_path):
    segments, _info = model.transcribe(audio_path)
    text = " ".join(seg.text.strip() for seg in segments)
    return text.strip()

# ── Unix socket server ──────────────────────────────────────────────────────
#
# WHO may speak on this socket. Every legitimate client is this same user —
# stt-client.py, run by the gateway's media row and the web server's
# chat/transcribe, both User=clawbox — plus root, which no file mode stops
# anyway. The socket used to be chmod 0666 in a sticky /tmp, so any other local
# uid could make this process read (and burn GPU time transcribing) any file
# the clawbox user can open. Two gates now, the same pair kokoro-server.py has:
# the socket's mode and the peer's uid. The `audio` field itself is deliberately
# NOT confined to a directory: it is a READ path OpenClaw's media row hands in
# from wherever the gateway downloaded a channel voice note, and an allow-list
# there would silently break Telegram voice notes.
#
# The region between this heading and "if __name__" is executed by
# src/tests/unit/whisper-server-socket.test.ts with stubs in front of it, so
# nothing in it may import faster_whisper.

def peer_uid_allowed(uid):
    """This process's own user, or root. Nobody else has business here."""
    return uid in (os.getuid(), 0)


def peer_uid(conn):
    """The uid on the other end, as the kernel reports it (SO_PEERCRED: pid, uid, gid)."""
    creds = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    _pid, uid, _gid = struct.unpack("3i", creds)
    return uid


def serve(model):
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
    print(f"Whisper server listening on {SOCKET_PATH}", flush=True)

    while True:
        conn, _ = sock.accept()
        try:
            # The mode-independent gate: it survives any umask or chmod drift
            # in the unit, and a refused peer does not count as activity.
            uid = peer_uid(conn)
            if not peer_uid_allowed(uid):
                print(f"Refused a connection from uid {uid}", flush=True)
                conn.sendall(json.dumps({"ok": False, "error": "refused: not this server's user"}).encode())
                continue
            touch_activity()
            data = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
            req = json.loads(data.decode())
            audio_path = req["audio"]
            text = transcribe(model, audio_path)
            conn.sendall(json.dumps({"ok": True, "text": text}).encode())
        except Exception as e:
            print(f"Error: {e}", flush=True)
            try:
                conn.sendall(json.dumps({"ok": False, "error": str(e)}).encode())
            except Exception as exc:
                print(f"Failed to send error response: {exc}", flush=True)
        finally:
            conn.close()

if __name__ == "__main__":
    model = load_model()
    threading.Thread(target=_idle_watchdog, daemon=True).start()
    serve(model)
