#!/bin/bash
# Fast Kokoro TTS client - talks to persistent server
# Usage: kokoro-client.sh "text" /output/path.mp3
export LD_LIBRARY_PATH=/home/clawbox/.local/lib:/home/clawbox/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib:/usr/local/cuda/lib64:${LD_LIBRARY_PATH}

TEXT="$1"
OUTPUT="$2"
SOCKET="/tmp/kokoro-server.sock"
TMPWAV=$(mktemp /tmp/kokoro_XXXXXX.wav)
trap 'rm -f "$TMPWAV"' EXIT

if [ ! -S "$SOCKET" ]; then
  echo "Kokoro server not running. Falling back to cold start." >&2
  exec bash /home/clawbox/.openclaw/workspace/scripts/kokoro-tts.sh "$TEXT" "$OUTPUT"
fi

# Send request via python (text passed through env to avoid shell injection)
KOKORO_TEXT="$TEXT" KOKORO_OUTPUT="$TMPWAV" KOKORO_SOCKET="$SOCKET" python3 -c "
import socket, json, os
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(os.environ['KOKORO_SOCKET'])
sock.sendall(json.dumps({
    'text': os.environ['KOKORO_TEXT'],
    'output': os.environ['KOKORO_OUTPUT']
}).encode())
sock.shutdown(socket.SHUT_WR)
resp = sock.recv(1024).decode()
sock.close()
if not resp.startswith('OK'):
    raise RuntimeError(resp)
"

if [ ! -f "$TMPWAV" ] || [ ! -s "$TMPWAV" ]; then
  echo "Kokoro server failed, falling back" >&2
  exec bash /home/clawbox/.openclaw/workspace/scripts/kokoro-tts.sh "$TEXT" "$OUTPUT"
fi

ffmpeg -y -i "$TMPWAV" -codec:a libmp3lame -b:a 128k -ar 24000 "$OUTPUT" 2>/dev/null
echo "$OUTPUT"
