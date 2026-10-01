#!/bin/bash
# Kokoro TTS wrapper for OpenClaw
# Usage: kokoro-tts.sh "text to speak" /output/path.mp3
export LD_LIBRARY_PATH=/home/clawbox/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib:/usr/local/cuda/lib64:${LD_LIBRARY_PATH}
export CUDA_HOME=/usr/local/cuda
# `kokoro` is the console script `pip3 install --user kokoro` puts in
# ~/.local/bin, which only a login shell adds to PATH. The setup server,
# `ssh host cmd`, cron and the gateway run non-login shells, so without this
# every cold start was "command not found" and then "Kokoro TTS failed".
export PATH="$HOME/.local/bin${PATH:+:$PATH}"

TEXT="$1"
OUTPUT="$2"

if [ -z "$TEXT" ] || [ -z "$OUTPUT" ]; then
  echo "Usage: kokoro-tts.sh <text> <output.mp3>" >&2
  exit 1
fi

TMPWAV=$(mktemp /tmp/kokoro_XXXXXX.wav)
trap 'rm -f "$TMPWAV"' EXIT

# The synthesiser's stderr, kept for the last run only, so the next failure
# says why instead of vanishing into /dev/null. A log that cannot be written
# (say another user's file in a sticky /tmp) must not cost the speech: a
# redirection that fails skips the command it belongs to.
KOKORO_LOG="${TMPDIR:-/tmp}/kokoro-tts.log"
( umask 077 && : > "$KOKORO_LOG" ) 2>/dev/null || KOKORO_LOG=/dev/null

kokoro -t "$TEXT" -o "$TMPWAV" -m af_heart -l a 2>"$KOKORO_LOG"

if [ ! -f "$TMPWAV" ] || [ ! -s "$TMPWAV" ]; then
  echo "Kokoro TTS failed" >&2
  if [ "$KOKORO_LOG" != /dev/null ] && [ -s "$KOKORO_LOG" ]; then
    echo "  last lines of $KOKORO_LOG:" >&2
    tail -n 5 "$KOKORO_LOG" | sed 's/^/    /' >&2
  fi
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
