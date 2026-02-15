#!/bin/bash
# Kokoro TTS wrapper for OpenClaw
# Usage: kokoro-tts.sh "text to speak" /output/path.mp3
export LD_LIBRARY_PATH=/home/clawbox/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib:/usr/local/cuda/lib64:${LD_LIBRARY_PATH}
export CUDA_HOME=/usr/local/cuda

TEXT="$1"
OUTPUT="$2"

if [ -z "$TEXT" ] || [ -z "$OUTPUT" ]; then
  echo "Usage: kokoro-tts.sh <text> <output.mp3>" >&2
  exit 1
fi

TMPWAV=$(mktemp /tmp/kokoro_XXXXXX.wav)
trap "rm -f $TMPWAV" EXIT

kokoro -t "$TEXT" -o "$TMPWAV" -m af_heart -l a 2>/dev/null

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
