#!/bin/bash
# Post-install optimizations for ClawBox: TTS caching, CPU affinity, pre-cached phrases
# Runs as part of install.sh after voice pipeline is set up
set -euo pipefail

CLAWBOX_USER="clawbox" 
CLAWBOX_HOME="/home/${CLAWBOX_USER}"
WORKSPACE="$CLAWBOX_HOME/.openclaw/workspace"
SCRIPTS_DST="$WORKSPACE/scripts"

echo "=== ClawBox Optimizations ==="

# ── 1. TTS Caching Script ─────────────────────────────────────────────────

echo "[1/4] Installing TTS cache system..."
mkdir -p "$SCRIPTS_DST"

cat > "$SCRIPTS_DST/tts-cached.sh" << 'TTS_EOF'
#!/bin/bash
# Cached TTS — generates audio via Kokoro, caches by text hash.
# Usage: tts-cached.sh "text to speak"
# Returns: path to cached .opus file
set -euo pipefail

CACHE_DIR="$HOME/.openclaw/cache/tts"
SERVE_DIR="/tmp/tts-cache"
mkdir -p "$CACHE_DIR" "$SERVE_DIR"

TEXT="$1"
HASH=$(echo -n "$TEXT" | sha256sum | cut -c1-16)
CACHED="$CACHE_DIR/${HASH}.opus"
SERVE="$SERVE_DIR/${HASH}.opus"

if [ -f "$CACHED" ]; then
    # Hardlink to /tmp for message tool access
    ln -f "$CACHED" "$SERVE" 2>/dev/null || cp "$CACHED" "$SERVE"
    echo "$SERVE"
    exit 0
fi

# Generate via Kokoro HTTP API
TMPWAV=$(mktemp /tmp/tts_XXXXXX.wav)
trap "rm -f $TMPWAV" EXIT

curl -s -X POST http://localhost:8880/v1/audio/speech \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"kokoro-82m\",\"voice\":\"af_heart\",\"input\":$(echo "$TEXT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')}" \
    --output "$TMPWAV"

if [ ! -s "$TMPWAV" ]; then
    echo "TTS generation failed" >&2
    exit 1
fi

# Convert to opus and cache
ffmpeg -y -i "$TMPWAV" -c:a libopus -b:a 64k -ar 48000 "$CACHED" 2>/dev/null

ln -f "$CACHED" "$SERVE" 2>/dev/null || cp "$CACHED" "$SERVE"
echo "$SERVE"
TTS_EOF

chmod +x "$SCRIPTS_DST/tts-cached.sh"
chown "$CLAWBOX_USER:$CLAWBOX_USER" "$SCRIPTS_DST/tts-cached.sh"
echo "  ✓ TTS cache script installed"

# ── 2. CPU Optimization Script ────────────────────────────────────────────

echo "[2/4] Installing CPU optimizer..."

cat > "$SCRIPTS_DST/optimize-cpu.sh" << 'CPU_EOF'
#!/bin/bash
# Optimize CPU usage for AI workloads on Jetson
set -euo pipefail

echo "=== CPU Optimization ==="

# Set CPU threading environment variables
export OMP_NUM_THREADS=6
export MKL_NUM_THREADS=6  
export NUMEXPR_NUM_THREADS=6
export VECLIB_MAXIMUM_THREADS=6

# Find AI processes and set CPU affinity
echo "Setting CPU affinity for AI processes..."

# Kokoro TTS - use cores 0-2
KOKORO_PID=$(pgrep -f kokoro-server.py || echo "")
if [ -n "$KOKORO_PID" ]; then
    taskset -cp 0-2 "$KOKORO_PID"
    echo "  Kokoro TTS → cores 0-2"
fi

# Whisper STT - use cores 3-5  
WHISPER_PID=$(pgrep -f whisper-server.py || echo "")
if [ -n "$WHISPER_PID" ]; then
    taskset -cp 3-5 "$WHISPER_PID"
    echo "  Whisper STT → cores 3-5"
fi

# OpenClaw gateway - can use all cores
GATEWAY_PID=$(pgrep -f openclaw-gateway || echo "")
if [ -n "$GATEWAY_PID" ]; then
    taskset -cp 0-5 "$GATEWAY_PID"
    echo "  OpenClaw Gateway → all cores"
fi

# Add threading env vars to bashrc if not present
BASHRC="$HOME/.bashrc"
if ! grep -q "OMP_NUM_THREADS" "$BASHRC" 2>/dev/null; then
    echo "" >> "$BASHRC"
    echo "# AI Threading Optimization" >> "$BASHRC"
    echo "export OMP_NUM_THREADS=6" >> "$BASHRC"
    echo "export MKL_NUM_THREADS=6" >> "$BASHRC"
    echo "export NUMEXPR_NUM_THREADS=6" >> "$BASHRC"
    echo "export VECLIB_MAXIMUM_THREADS=6" >> "$BASHRC"
    echo "Threading env vars added to .bashrc"
fi

echo "CPU optimization applied!"
CPU_EOF

chmod +x "$SCRIPTS_DST/optimize-cpu.sh"
chown "$CLAWBOX_USER:$CLAWBOX_USER" "$SCRIPTS_DST/optimize-cpu.sh"
echo "  ✓ CPU optimizer installed"

# ── 3. Pre-cache Common Phrases ───────────────────────────────────────────

echo "[3/4] Pre-caching common phrases..."

# Wait for services to be ready
sleep 5

# Pre-cache as clawbox user
su - "$CLAWBOX_USER" -c "
phrases=(
# Greetings
'Hello!' 'Hey!' 'Hi there!' 'Good morning!' 'Good evening!'
# Acknowledgments  
'Got it.' 'Done.' 'On it.' 'Sure.' 'Okay.' 'Fixed.' 'Good.' 'Nice.' 'Right.'
'Working on it.' 'Let me check.' 'Here you go.' 'No problem.' 'All done.' 'Ready.'
# Questions
'What'"'"'s up?' 'What do you need?' 'Anything else?' 'Want me to continue?'
'Should I go ahead?' 'What'"'"'s next?'
# Status
'Everything looks good.' 'All systems running.' 'Nothing new.'
'Still working on it.' 'Almost done.' 'That'"'"'s done.'
# Common responses
'Yes.' 'No.' 'Not sure.' 'Let me think about that.' 'Good question.'
'Makes sense.' 'I agree.' 'You'"'"'re right.' 'My bad.' 'Sorry about that.'
)

cached=0
for phrase in \"\${phrases[@]}\"; do
    if timeout 10 bash \"$SCRIPTS_DST/tts-cached.sh\" \"\$phrase\" >/dev/null 2>&1; then
        cached=\$((cached + 1))
    fi
done
echo \"  ✓ Pre-cached \$cached phrases\"
"

# ── 4. Apply CPU Optimization ─────────────────────────────────────────────

echo "[4/4] Applying CPU optimization..."
su - "$CLAWBOX_USER" -c "bash '$SCRIPTS_DST/optimize-cpu.sh'" 2>/dev/null || true

echo ""
echo "=== Optimizations Complete ==="
echo "  • TTS caching system with ~50 pre-cached phrases"
echo "  • CPU affinity optimization for AI workloads"  
echo "  • Threading environment variables configured"