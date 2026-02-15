#!/usr/bin/env python3
"""Fast Whisper STT client - talks to persistent server, falls back to direct."""
import sys, os, json, socket

SOCKET_PATH = "/tmp/whisper-server.sock"

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
    segments, info = model.transcribe(audio_path)
    return " ".join(seg.text.strip() for seg in segments).strip()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: stt-client.py <audio_file> [model_size]", file=sys.stderr)
        sys.exit(1)
    audio = sys.argv[1]
    model = sys.argv[2] if len(sys.argv) > 2 else "base"
    
    if os.path.exists(SOCKET_PATH):
        try:
            print(transcribe_via_server(audio))
            sys.exit(0)
        except Exception:
            pass
    print(transcribe_direct(audio, model))
