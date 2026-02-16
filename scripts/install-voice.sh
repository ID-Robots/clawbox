#!/bin/bash
# Install local voice pipeline: faster-whisper (STT) + Kokoro (TTS)
# With CUDA GPU acceleration and persistent model servers for fast inference.
# Runs as clawbox user. Requires espeak-ng to be installed (system package).
set -euo pipefail

CLAWBOX_USER="clawbox"
CLAWBOX_HOME="/home/${CLAWBOX_USER}"
WORKSPACE="$CLAWBOX_HOME/.openclaw/workspace"
PIP="pip3"

echo "=== Voice Pipeline Installer (GPU-Accelerated) ==="

# ── Detect CUDA availability ────────────────────────────────────────────────

HAS_CUDA=false
# Check PATH first, then the standard Jetson CUDA location
NVCC=$(command -v nvcc 2>/dev/null || echo "")
if [ -z "$NVCC" ] && [ -x /usr/local/cuda/bin/nvcc ]; then
  export PATH="/usr/local/cuda/bin:$PATH"
  NVCC=/usr/local/cuda/bin/nvcc
fi
if [ -n "$NVCC" ]; then
  HAS_CUDA=true
  echo "  CUDA detected: $($NVCC --version | tail -1)"
fi

# ── Step 1: Install CUDA PyTorch (if available) ─────────────────────────────

if $HAS_CUDA; then
  echo "[1/7] Installing CUDA-enabled PyTorch for Jetson..."
  # JP v61 wheel works on JetPack 6.1+ (including 6.2.x)
  TORCH_URL="https://developer.download.nvidia.com/compute/redist/jp/v61/pytorch/torch-2.5.0a0+872d972e41.nv24.08.17622132-cp310-cp310-linux_aarch64.whl"
  su - "$CLAWBOX_USER" -c "$PIP install --user nvidia-cusparselt-cu12" 2>&1 | tail -3
  su - "$CLAWBOX_USER" -c "$PIP install --user --no-cache-dir '$TORCH_URL'" 2>&1 | tail -3

  # Set up LD_LIBRARY_PATH in .bashrc if not already there
  BASHRC="$CLAWBOX_HOME/.bashrc"
  if ! grep -q "cusparselt" "$BASHRC" 2>/dev/null; then
    echo 'export LD_LIBRARY_PATH=/home/clawbox/.local/lib:/home/clawbox/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib:/usr/local/cuda/lib64:${LD_LIBRARY_PATH}' >> "$BASHRC"
    echo 'export CUDA_HOME=/usr/local/cuda' >> "$BASHRC"
  fi
else
  echo "[1/7] No CUDA detected, using CPU PyTorch..."
fi

# ── Step 2: Install faster-whisper ───────────────────────────────────────────

echo "[2/7] Installing faster-whisper (STT)..."
su - "$CLAWBOX_USER" -c "$PIP install --user faster-whisper" 2>&1 | tail -3

# ── Step 3: Build CTranslate2 with CUDA (if available) ──────────────────────

if $HAS_CUDA; then
  echo "[3/7] Building CTranslate2 with CUDA support..."
  BUILD_DIR="/tmp/CTranslate2"
  if [ ! -f "$CLAWBOX_HOME/.local/lib/libctranslate2.so" ]; then
    rm -rf "$BUILD_DIR"
    su - "$CLAWBOX_USER" -c "
      cd /tmp
      git clone --depth 1 https://github.com/OpenNMT/CTranslate2.git
      cd CTranslate2
      git submodule update --init --recursive 2>/dev/null || true
      mkdir build && cd build
      cmake .. -DWITH_CUDA=ON -DWITH_CUDNN=ON -DOPENMP_RUNTIME=NONE \\
        -DCMAKE_INSTALL_PREFIX=$CLAWBOX_HOME/.local \\
        -DCUDA_TOOLKIT_ROOT_DIR=/usr/local/cuda -DWITH_MKL=OFF -DBUILD_CLI=OFF
      make -j\$(nproc)
      make install
    " 2>&1 | tail -5

    # Build Python bindings
    su - "$CLAWBOX_USER" -c "
      export LD_LIBRARY_PATH=$CLAWBOX_HOME/.local/lib:/usr/local/cuda/lib64:\$LD_LIBRARY_PATH
      export LIBRARY_PATH=$CLAWBOX_HOME/.local/lib:\$LIBRARY_PATH
      export CPLUS_INCLUDE_PATH=$CLAWBOX_HOME/.local/include:\$CPLUS_INCLUDE_PATH
      cd /tmp/CTranslate2/python && $PIP install --user .
    " 2>&1 | tail -5

    rm -rf "$BUILD_DIR"
    echo "  CTranslate2 built with CUDA support"
  else
    echo "  CTranslate2 already installed"
  fi
else
  echo "[3/7] Skipping CTranslate2 CUDA build (no CUDA)"
fi

# ── Step 4: Install Kokoro TTS ───────────────────────────────────────────────

echo "[4/7] Installing Kokoro TTS..."
su - "$CLAWBOX_USER" -c "$PIP install --user 'numpy<2' 'transformers<5' kokoro soundfile Pillow" 2>&1 | tail -3

# ── Step 5: Pre-download models ─────────────────────────────────────────────

echo "[5/7] Pre-downloading Whisper model (base)..."
DEVICE="cpu"
COMPUTE="auto"
if $HAS_CUDA; then
  DEVICE="cuda"
  COMPUTE="float16"
fi
su - "$CLAWBOX_USER" -c "
  export LD_LIBRARY_PATH=$CLAWBOX_HOME/.local/lib:$CLAWBOX_HOME/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib:/usr/local/cuda/lib64:\$LD_LIBRARY_PATH
  python3 -c \"
from faster_whisper import WhisperModel
model = WhisperModel('base', device='$DEVICE', compute_type='$COMPUTE')
print('Whisper base model ready on $DEVICE')
\"" 2>&1 | tail -3

echo "[6/7] Pre-downloading Kokoro model..."
su - "$CLAWBOX_USER" -c "
  export LD_LIBRARY_PATH=$CLAWBOX_HOME/.local/lib:$CLAWBOX_HOME/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib:/usr/local/cuda/lib64:\$LD_LIBRARY_PATH
  python3 -c \"
from kokoro import KPipeline
pipeline = KPipeline(lang_code='a')
print('Kokoro model ready on', next(pipeline.model.parameters()).device)
\"" 2>&1 | tail -5

# ── Step 6: Deploy scripts ───────────────────────────────────────────────────

echo "[7/7] Deploying voice server scripts..."
SCRIPTS_SRC="$(dirname "$0")"
SCRIPTS_DST="$WORKSPACE/scripts"
mkdir -p "$SCRIPTS_DST"

# Copy server and client scripts from repo
for f in kokoro-server.py kokoro-client.sh kokoro-tts.sh whisper-server.py stt-client.py stt.py; do
  if [ -f "$SCRIPTS_SRC/$f" ]; then
    cp "$SCRIPTS_SRC/$f" "$SCRIPTS_DST/$f"
  fi
done
chmod +x "$SCRIPTS_DST"/*.sh 2>/dev/null || true
chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$WORKSPACE"

# Install systemd user services for persistent model servers
SYSTEMD_USER="$CLAWBOX_HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_USER"

LD_PATH="/home/clawbox/.local/lib:/home/clawbox/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib:/usr/local/cuda/lib64"

cat > "$SYSTEMD_USER/kokoro-server.service" << EOF
[Unit]
Description=Kokoro TTS Server (GPU)
After=default.target

[Service]
Type=simple
Environment=LD_LIBRARY_PATH=$LD_PATH
ExecStart=/usr/bin/python3 $SCRIPTS_DST/kokoro-server.py
Restart=no

[Install]
WantedBy=default.target
EOF

cat > "$SYSTEMD_USER/whisper-server.service" << EOF
[Unit]
Description=Whisper STT Server (GPU)
After=default.target

[Service]
Type=simple
Environment=LD_LIBRARY_PATH=$LD_PATH
Environment=WHISPER_MODEL=base
ExecStart=/usr/bin/python3 $SCRIPTS_DST/whisper-server.py
Restart=no

[Install]
WantedBy=default.target
EOF

chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$SYSTEMD_USER"

# Enable lingering so user services start on boot without login
loginctl enable-linger "$CLAWBOX_USER" 2>/dev/null || true

# Reload service files (servers start on demand via stt-client.py)
su - "$CLAWBOX_USER" -c "
  export XDG_RUNTIME_DIR=/run/user/\$(id -u)
  systemctl --user daemon-reload
" 2>/dev/null || true

echo ""
echo "=== Voice Pipeline Installed ==="
if $HAS_CUDA; then
  echo "  Mode: GPU-accelerated (CUDA)"
  echo "  PyTorch: 2.5.0 (NVIDIA Jetson)"
  echo "  CTranslate2: Built with CUDA"
else
  echo "  Mode: CPU"
fi
echo "  STT: Whisper (base) via on-demand server (~1.8s)"
echo "  TTS: Kokoro-82M via on-demand server (~2s)"
echo "  Services: kokoro-server, whisper-server (on-demand, auto-stop after idle)"
