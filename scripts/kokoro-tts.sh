#!/bin/bash
# Kokoro TTS wrapper for OpenClaw
# Usage: kokoro-tts.sh "text to speak" /output/path.mp3
export LD_LIBRARY_PATH=/home/clawbox/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib:/usr/local/cuda/lib64:${LD_LIBRARY_PATH}
export CUDA_HOME=/usr/local/cuda

# `pip install --user kokoro` puts the CLI at ~/.local/bin/kokoro, and only a
# login shell's profile puts that on PATH. This is the cold-start fallback
# kokoro-client.sh execs, and it is reached from systemd units and ssh commands
# that read no profile, where a bare `kokoro` was "command not found" and every
# cold start failed (TASK-1355; clawbox-tts.sh resolves its own the same way
# since TASK-420). Appended, so a kokoro the caller's PATH already finds still
# wins; /home/clawbox too, for a caller whose HOME is not the clawbox user's.
# KOKORO_BIN overrides the lot.
for dir in "${HOME:-/home/clawbox}/.local/bin" /home/clawbox/.local/bin; do
  case ":${PATH:-}:" in
    *":$dir:"*) ;;
    *) PATH="${PATH:+$PATH:}$dir" ;;
  esac
done
export PATH
KOKORO_BIN="${KOKORO_BIN:-kokoro}"

TEXT="$1"
OUTPUT="$2"

if [ -z "$TEXT" ] || [ -z "$OUTPUT" ]; then
  echo "Usage: kokoro-tts.sh <text> <output.mp3>" >&2
  exit 1
fi

# Its own message: kokoro's stderr is discarded below, so a missing CLI used to
# arrive as the same "Kokoro TTS failed" as a CUDA error.
if ! command -v "$KOKORO_BIN" >/dev/null 2>&1; then
  echo "Kokoro TTS failed: '$KOKORO_BIN' is not installed (looked on PATH and in ~/.local/bin)" >&2
  exit 1
fi

TMPWAV=$(mktemp /tmp/kokoro_XXXXXX.wav)
trap 'rm -f "$TMPWAV"' EXIT

"$KOKORO_BIN" -t "$TEXT" -o "$TMPWAV" -m af_heart -l a 2>/dev/null

if [ ! -f "$TMPWAV" ] || [ ! -s "$TMPWAV" ]; then
  echo "Kokoro TTS failed" >&2
  exit 1
fi

# Convert WAV to OGG Opus for Telegram voice notes
ffmpeg -y -i "$TMPWAV" -codec:a libopus -b:a 64k -ar 48000 -ac 1 "${OUTPUT%.mp3}.ogg" 2>/dev/null
# Also create MP3 fallback
ffmpeg -y -i "$TMPWAV" -codec:a libmp3lame -b:a 128k -ar 24000 "$OUTPUT" 2>/dev/null

if [ ! -f "$OUTPUT" ] || [ ! -s "$OUTPUT" ]; then
  echo "Kokoro TTS failed" >&2
  exit 1
fi

echo "$OUTPUT"
