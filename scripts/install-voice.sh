#!/bin/bash
# Install local voice pipeline: faster-whisper (STT) + Kokoro (TTS)
# With CUDA GPU acceleration and persistent model servers for fast inference.
# Runs as clawbox user. Requires espeak-ng to be installed (system package).
set -euo pipefail

CLAWBOX_USER="clawbox"
CLAWBOX_HOME="/home/${CLAWBOX_USER}"
WORKSPACE="$CLAWBOX_HOME/.openclaw/workspace"
PIP="pip3"

# ── Piper (CPU fallback engine) ─────────────────────────────────────────────
# Piper is what keeps a spoken reply from becoming silence. Kokoro owns the
# default voice, but it needs CUDA and peaks around 2.6 GB on a 7.6 GB board
# (TASK-382); when it cannot run, scripts/openclaw/clawbox-tts.sh falls through
# to Piper at 136-243 MB. That fallback only exists if Piper is actually on the
# box, so this install is not optional and not "nice to have".
#
# Artifacts are pinned by sha256 to the exact bytes TASK-382 measured, matching
# scripts/bench/tts-bench.py. These are an executable and model weights fetched
# over the network onto a customer device; an unpinned download here is a
# supply-chain hole.
PIPER_VERSION="${PIPER_VERSION:-2023.11.14-2}"
PIPER_DIR="${PIPER_DIR:-$CLAWBOX_HOME/.local/share/piper}"
PIPER_VOICE_DIR="${PIPER_VOICE_DIR:-$PIPER_DIR/voices}"
PIPER_VOICES_BASE="${PIPER_VOICES_BASE:-https://huggingface.co/rhasspy/piper-voices/resolve/main}"
PIPER_TARBALL_SHA256="fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb"
PIPER_EN_ONNX_SHA256="5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f"
PIPER_EN_JSON_SHA256="efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0"
PIPER_BG_ONNX_SHA256="4972fe764468e8501416407ad81662de94cc6c9cdc680fcf807daef04e319f13"
PIPER_BG_JSON_SHA256="ec9a9abdd17384d3db225e83085b2f68b790b112f058417c3a8a2ac58b79e7f0"
# Bulgarian is DEFERRED for this release (Yanko, 2026-08-19): Kokoro has no
# Bulgarian voice, and shipping the Piper one by default would quietly make
# Bulgarian TTS a feature nobody signed off. The download is kept here, behind
# an opt-in, so enabling it later is a flag and not a code change.
INSTALL_BG_VOICE="${CLAWBOX_TTS_INSTALL_BG_VOICE:-false}"

# Verify a file against a pinned digest. Returns 1 on any mismatch so callers
# can re-download rather than trusting whatever is on disk.
piper_digest_ok() {
  local file="$1" want="$2" have
  [ -f "$file" ] || return 1
  have=$(sha256sum "$file" 2>/dev/null | cut -d" " -f1)
  [ "$have" = "$want" ]
}

# Download to a .part and only move it into place once the digest matches, so
# an interrupted or tampered fetch never leaves something the next run trusts.
piper_fetch() {
  local url="$1" dest="$2" want="$3"
  if piper_digest_ok "$dest" "$want"; then
    return 0
  fi
  rm -f "$dest" "$dest.part"
  # No timeouts here meant a stalled TCP connection blocked forever, and this
  # runs from step_post_update on every in-app update of a shipped device: one
  # dead transfer hung the whole update with no bound and no diagnostic.
  # --speed-limit/--speed-time abort a connection that has effectively stopped
  # without killing a slow-but-progressing download, which a flat --max-time
  # would; only then can --retry actually do anything.
  curl -fsSL --retry 3 --retry-delay 5 \
    --connect-timeout 20 --speed-limit 1024 --speed-time 60 \
    -o "$dest.part" "$url" || {
    echo "  ERROR: download failed: $url" >&2
    rm -f "$dest.part"
    return 1
  }
  if ! piper_digest_ok "$dest.part" "$want"; then
    echo "  ERROR: $(basename "$dest") sha256 does not match the pin — refusing it" >&2
    rm -f "$dest.part"
    return 1
  fi
  mv "$dest.part" "$dest"
}

piper_install_voice() {
  local voice="$1" repo_path="$2" onnx_sha="$3" json_sha="$4"
  piper_fetch "$PIPER_VOICES_BASE/$repo_path/$voice.onnx" "$PIPER_VOICE_DIR/$voice.onnx" "$onnx_sha" || return 1
  piper_fetch "$PIPER_VOICES_BASE/$repo_path/$voice.onnx.json" "$PIPER_VOICE_DIR/$voice.onnx.json" "$json_sha" || return 1
  echo "  Piper voice ready: $voice"
}

install_piper() {
  local arch
  arch=$(uname -m)
  if [ "$arch" != "aarch64" ]; then
    # Only the aarch64 artifact is pinned, and ClawBox is aarch64 hardware.
    # Guessing a digest for another arch would defeat the point of pinning.
    echo "  Skipping Piper: no pinned artifact for $arch (ClawBox ships aarch64)"
    return 0
  fi

  mkdir -p "$PIPER_DIR" "$PIPER_VOICE_DIR"

  if [ -x "$PIPER_DIR/piper" ]; then
    echo "  Piper binary already installed"
  else
    local tarball="$PIPER_DIR/piper_linux_aarch64.tar.gz"
    echo "  Downloading Piper $PIPER_VERSION..."
    piper_fetch \
      "https://github.com/rhasspy/piper/releases/download/$PIPER_VERSION/piper_linux_aarch64.tar.gz" \
      "$tarball" "$PIPER_TARBALL_SHA256" || return 1
    # The tarball unpacks a top-level piper/ directory, so extract one level up.
    tar -xzf "$tarball" -C "$(dirname "$PIPER_DIR")" || {
      echo "  ERROR: could not unpack Piper" >&2
      return 1
    }
    rm -f "$tarball"
    # A discarded chmod hid a missing binary: if the release layout ever
    # changes, tar still succeeds and this printed "installed" for a directory
    # with no piper in it. The failure then surfaced much later as
    # "piper: binary not found", at the moment a user expected speech.
    if [ ! -f "$PIPER_DIR/piper" ]; then
      echo "  ERROR: the Piper tarball did not contain piper at $PIPER_DIR/piper" >&2
      return 1
    fi
    if ! chmod +x "$PIPER_DIR/piper"; then
      echo "  ERROR: could not make $PIPER_DIR/piper executable" >&2
      return 1
    fi
    echo "  Piper binary installed at $PIPER_DIR/piper"
  fi

  piper_install_voice "en_US-lessac-medium" "en/en_US/lessac/medium" \
    "$PIPER_EN_ONNX_SHA256" "$PIPER_EN_JSON_SHA256" || return 1

  if [ "$INSTALL_BG_VOICE" = "true" ]; then
    piper_install_voice "bg_BG-dimitar-medium" "bg/bg_BG/dimitar/medium" \
      "$PIPER_BG_ONNX_SHA256" "$PIPER_BG_JSON_SHA256" || return 1
  fi

  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PIPER_DIR" 2>/dev/null || true
}

# Deploy the TTS entrypoint + engine scripts into the workspace the gateway
# runs from. Split out of the big install so --piper-only can call it too: the
# updater re-runs that cheap path on every update, and a box whose
# clawbox-tts.sh is stale is a box whose fallback chain is stale.
# Returns non-zero if ANY required piece did not land. A device that keeps a
# stale or half-copied speech install while the updater reports success is the
# same class of bug as a silent TTS failure, one layer further out.
deploy_voice_scripts() {
  local src dst f rc=0
  src="$(cd "$(dirname "$0")" && pwd)" || return 1
  dst="$WORKSPACE/scripts"
  if ! mkdir -p "$dst/openclaw"; then
    echo "  ERROR: could not create $dst/openclaw" >&2
    return 1
  fi
  for f in kokoro-server.py kokoro-client.sh kokoro-tts.sh whisper-server.py stt-client.py stt.py; do
    if [ -f "$src/$f" ]; then
      cp "$src/$f" "$dst/$f" || { echo "  ERROR: could not copy $f" >&2; rc=1; }
    fi
  done
  # The entrypoint is not optional — it is the command OpenClaw execs — so a
  # missing source file is an error rather than something to step over.
  if [ ! -f "$src/openclaw/clawbox-tts.sh" ]; then
    echo "  ERROR: $src/openclaw/clawbox-tts.sh is missing" >&2
    rc=1
  elif ! cp "$src/openclaw/clawbox-tts.sh" "$dst/openclaw/clawbox-tts.sh"; then
    echo "  ERROR: could not deploy clawbox-tts.sh to $dst/openclaw" >&2
    rc=1
  elif ! chmod +x "$dst/openclaw/clawbox-tts.sh"; then
    echo "  ERROR: could not make $dst/openclaw/clawbox-tts.sh executable" >&2
    rc=1
  fi
  chmod +x "$dst"/*.sh 2>/dev/null || true
  if ! chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$WORKSPACE"; then
    echo "  ERROR: could not chown $WORKSPACE to $CLAWBOX_USER" >&2
    rc=1
  fi
  return "$rc"
}

# --piper-only installs just the CPU fallback and refreshes the entrypoint.
# install.sh calls this on every install and update: it is a small pinned
# download, unlike the CUDA torch/CTranslate2 build below, so it is safe to
# run unattended on a box that already works.
if [ "${1:-}" = "--piper-only" ]; then
  echo "=== Voice fallback (Piper) ==="
  PIPER_ONLY_RC=0
  install_piper || PIPER_ONLY_RC=1
  deploy_voice_scripts || PIPER_ONLY_RC=1
  if [ "$PIPER_ONLY_RC" -ne 0 ]; then
    echo "=== Piper fallback INCOMPLETE — the box may answer speech with silence ===" >&2
    exit 1
  fi
  echo "=== Piper fallback ready ==="
  exit 0
fi

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
  echo "[1/8] Installing CUDA-enabled PyTorch for Jetson..."
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
  echo "[1/8] No CUDA detected, using CPU PyTorch..."
fi

# ── Step 2: Install faster-whisper ───────────────────────────────────────────

echo "[2/8] Installing faster-whisper (STT)..."
su - "$CLAWBOX_USER" -c "$PIP install --user faster-whisper" 2>&1 | tail -3

# ── Step 3: Build CTranslate2 with CUDA (if available) ──────────────────────

if $HAS_CUDA; then
  echo "[3/8] Building CTranslate2 with CUDA support..."
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
  echo "[3/8] Skipping CTranslate2 CUDA build (no CUDA)"
fi

# ── Step 4: Install Kokoro TTS ───────────────────────────────────────────────

echo "[4/8] Installing Kokoro TTS..."
# Install kokoro first, then force transformers<5 as a separate step.
# pip 22's resolver won't downgrade huggingface-hub (pulled in by faster-whisper)
# to satisfy transformers<5 in a single command, so it silently picks transformers 5.x.
su - "$CLAWBOX_USER" -c "$PIP install --user 'numpy<2' kokoro soundfile 'Pillow>=10'" 2>&1 | tail -3
su - "$CLAWBOX_USER" -c "$PIP install --user 'transformers<5'" 2>&1 | tail -3

# ── Step 5: Pre-download models ─────────────────────────────────────────────

echo "[5/8] Pre-downloading Whisper model (base)..."
# Clear corrupted cache (0-byte blobs from failed/rate-limited HF downloads)
WHISPER_CACHE="$CLAWBOX_HOME/.cache/huggingface/hub/models--Systran--faster-whisper-base"
if [ -d "$WHISPER_CACHE/blobs" ] && find "$WHISPER_CACHE/blobs" -maxdepth 1 -type f -empty | grep -q .; then
  echo "  Clearing corrupted Whisper model cache..."
  rm -rf "$WHISPER_CACHE"
fi
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

echo "[6/8] Pre-downloading Kokoro model..."
su - "$CLAWBOX_USER" -c "
  export LD_LIBRARY_PATH=$CLAWBOX_HOME/.local/lib:$CLAWBOX_HOME/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib:/usr/local/cuda/lib64:\$LD_LIBRARY_PATH
  python3 -c \"
from kokoro import KPipeline
pipeline = KPipeline(lang_code='a')
print('Kokoro model ready on', next(pipeline.model.parameters()).device)
\"" 2>&1 | tail -5

# ── Step 6: Deploy scripts ───────────────────────────────────────────────────

echo "[7/8] Installing Piper CPU fallback..."
install_piper

echo "[8/8] Deploying voice server scripts..."
SCRIPTS_DST="$WORKSPACE/scripts"
deploy_voice_scripts

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
echo "  TTS: Kokoro-82M via on-demand server (~2s), Piper CPU fallback"
echo "  TTS entrypoint: $WORKSPACE/scripts/openclaw/clawbox-tts.sh"
echo "  Services: kokoro-server, whisper-server (on-demand, auto-stop after idle)"
