#!/usr/bin/env python3
"""Persistent Kokoro TTS server - keeps model loaded in GPU memory."""
import sys, os, json, socket, struct, tempfile
import soundfile as sf

os.environ.setdefault("LD_LIBRARY_PATH", "/home/clawbox/.local/lib:/home/clawbox/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib:/usr/local/cuda/lib64")

SOCKET_PATH = "/tmp/kokoro-server.sock"

def load_model():
    from kokoro import KPipeline
    print("Loading Kokoro model on GPU...", flush=True)
    pipeline = KPipeline(lang_code='a')
    print(f"Model loaded on {next(pipeline.model.parameters()).device}", flush=True)
    return pipeline

def generate(pipeline, text, output_path):
    for i, (gs, ps, audio) in enumerate(pipeline(text, voice='af_heart')):
        sf.write(output_path, audio, 24000)
        break  # first segment only for short text

def serve(pipeline):
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(SOCKET_PATH)
    os.chmod(SOCKET_PATH, 0o666)
    sock.listen(5)
    print(f"Kokoro server listening on {SOCKET_PATH}", flush=True)
    
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
            text = req["text"]
            output = req.get("output", "/tmp/kokoro_out.wav")
            generate(pipeline, text, output)
            conn.sendall(b"OK")
        except Exception as e:
            print(f"Error: {e}", flush=True)
            try:
                conn.sendall(f"ERR:{e}".encode())
            except:
                pass
        finally:
            conn.close()

if __name__ == "__main__":
    pipeline = load_model()
    serve(pipeline)
