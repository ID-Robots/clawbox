#!/usr/bin/env python3
"""Persistent Whisper STT server - keeps model loaded in GPU memory."""
import sys, os, json, socket

os.environ.setdefault("LD_LIBRARY_PATH", "/home/clawbox/.local/lib:/home/clawbox/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib:/usr/local/cuda/lib64")

SOCKET_PATH = "/tmp/whisper-server.sock"
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")

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
    segments, info = model.transcribe(audio_path)
    text = " ".join(seg.text.strip() for seg in segments)
    return text.strip()

def serve(model):
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(SOCKET_PATH)
    os.chmod(SOCKET_PATH, 0o666)
    sock.listen(5)
    print(f"Whisper server listening on {SOCKET_PATH}", flush=True)

    while True:
        conn, _ = sock.accept()
        try:
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
            except:
                pass
        finally:
            conn.close()

if __name__ == "__main__":
    model = load_model()
    serve(model)
