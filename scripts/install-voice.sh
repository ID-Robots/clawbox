#!/bin/bash
# Install local voice pipeline: faster-whisper (STT) + Kokoro (TTS)
# Runs as clawbox user. Requires espeak-ng to be installed (system package).
set -euo pipefail

CLAWBOX_USER="clawbox"
CLAWBOX_HOME="/home/clawbox"
PIP="pip3"

echo "=== Voice Pipeline Installer ==="

# ── Step 1: Install Python packages ─────────────────────────────────────────

echo "[1/4] Installing faster-whisper (STT)..."
su - "$CLAWBOX_USER" -c "$PIP install --user faster-whisper" 2>&1 | tail -3

echo "[2/4] Installing Kokoro TTS..."
su - "$CLAWBOX_USER" -c "$PIP install --user 'numpy<2' kokoro soundfile Pillow" 2>&1 | tail -3

# ── Step 2: Pre-download models ─────────────────────────────────────────────

echo "[3/4] Pre-downloading Whisper model (tiny)..."
su - "$CLAWBOX_USER" -c "python3 -c \"
from faster_whisper import WhisperModel
model = WhisperModel('tiny', device='cpu', compute_type='int8')
print('Whisper tiny model ready')
\"" 2>&1 | tail -2

echo "[4/4] Pre-downloading Kokoro model..."
su - "$CLAWBOX_USER" -c "python3 -c \"
from kokoro import KPipeline
pipeline = KPipeline(lang_code='a')
print('Kokoro model ready')
\"" 2>&1 | tail -5

echo ""
echo "=== Voice Pipeline Installed ==="
echo "  STT: faster-whisper (tiny model)"
echo "  TTS: Kokoro-82M"
