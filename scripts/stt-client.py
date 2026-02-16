#!/usr/bin/env python3
"""Fast Whisper STT client - talks to persistent server, falls back to direct."""
import sys, os, json, socket, subprocess, time

SOCKET_PATH = "/tmp/whisper-server.sock"

def ensure_servers():
    """Start voice servers on demand if not running."""
    env = os.environ.copy()
    env["XDG_RUNTIME_DIR"] = f"/run/user/{os.getuid()}"
    for svc in ["whisper-server", "kokoro-server"]:
        subprocess.run(
            ["systemctl", "--user", "start", f"{svc}.service"],
            env=env, capture_output=True, timeout=10,
        )
    # Wait for whisper socket to be ready (model load can take a while)
    for _ in range(60):
        if os.path.exists(SOCKET_PATH):
            try:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.connect(SOCKET_PATH)
                s.close()
                return True
            except (ConnectionRefusedError, OSError):
                pass
        time.sleep(1)
    return False

def transcribe_via_server(audio_path):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(SOCKET_PATH)
    sock.sendall(json.dumps({"audio": audio_path}).encode())
    sock.shutdown(socket.SHUT_WR)
    data = b""
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data += chunk
    sock.close()
    resp = json.loads(data.decode())
    if resp.get("ok"):
        return resp["text"]
    raise RuntimeError(resp.get("error", "unknown"))

def transcribe_direct(audio_path, model_size="base"):
    os.environ.setdefault("LD_LIBRARY_PATH", "/home/clawbox/.local/lib:/home/clawbox/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib:/usr/local/cuda/lib64")
    from faster_whisper import WhisperModel
    try:
        import ctranslate2
        ctranslate2.get_supported_compute_types("cuda")
        device, compute = "cuda", "float16"
    except Exception:
        device, compute = "cpu", "int8"
    model = WhisperModel(model_size, device=device, compute_type=compute)
    segments, _info = model.transcribe(audio_path)
    return " ".join(seg.text.strip() for seg in segments).strip()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: stt-client.py <audio_file> [model_size]", file=sys.stderr)
        sys.exit(1)
    audio = sys.argv[1]
    model = sys.argv[2] if len(sys.argv) > 2 else "base"

    # Start servers on demand (whisper for STT, kokoro for upcoming TTS response)
    ensure_servers()

    try:
        print(transcribe_via_server(audio))
    except Exception as e:
        print(f"Server error ({e}), falling back to direct", file=sys.stderr)
        print(transcribe_direct(audio, model))
