#!/bin/bash
# Install local voice pipeline: faster-whisper (STT) + Kokoro (TTS)
# With CUDA GPU acceleration and persistent model servers for fast inference.
# Runs as clawbox user. Requires espeak-ng to be installed (system package).
set -euo pipefail

# Overridable for the same reason PIPER_DIR is: the tests run the real script
# end-to-end so they fail when the shipped artifact drifts, and they cannot
# write into a real /home/clawbox. install.sh does not export either name, so a
# device always takes these defaults.
CLAWBOX_USER="${CLAWBOX_USER:-clawbox}"
CLAWBOX_HOME="${CLAWBOX_HOME:-/home/${CLAWBOX_USER}}"
WORKSPACE="$CLAWBOX_HOME/.openclaw/workspace"
PIP="pip3"

# ── Shared Kokoro (GPU TTS) constants ───────────────────────────────────────
# Named once because two paths through this file install Kokoro — the full
# voice-pipeline run at the bottom and the --tts-only run install.sh uses — and
# a second copy of any of these is a drift waiting to happen.

# JP v61 wheel works on JetPack 6.1+ (including 6.2.x).
JETSON_TORCH_URL="https://developer.download.nvidia.com/compute/redist/jp/v61/pytorch/torch-2.5.0a0+872d972e41.nv24.08.17622132-cp310-cp310-linux_aarch64.whl"
# libcusparseLt (shipped by the nvidia-cusparselt-cu12 wheel) is not on the
# default loader path, so `import torch` fails without this. The systemd user
# units and every python invocation below need it.
KOKORO_LD_PATH="/home/clawbox/.local/lib:/home/clawbox/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib:/usr/local/cuda/lib64"
SYSTEMD_USER="$CLAWBOX_HOME/.config/systemd/user"
CUDA_HOME_DIR="${CLAWBOX_CUDA_HOME:-/usr/local/cuda}"
# Written only after a COMPLETE Kokoro install, and read as the idempotence
# gate. Importability alone must not be the gate: the packages land before the
# transformers pin and before the model download, so a run that failed at
# either leaves `import kokoro` working with the job half done — and gating on
# the import would latch that half-done box in as "ready" on every subsequent
# update, while the first spoken reply still paid for the 300 MB the warm-up
# was supposed to have fetched. Derived state under .cache: losing it costs one
# repeated install, never correctness.
KOKORO_STAMP="$CLAWBOX_HOME/.cache/clawbox/kokoro-installed"
# Bump when a step below changes in a way an already-stamped box must redo.
KOKORO_STAMP_VERSION="1"

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

# ── Kokoro (GPU TTS) ────────────────────────────────────────────────────────
# Kokoro is the DEFAULT voice (TASK-382 benchmarked it on real Orin hardware,
# TASK-383 shipped it), but until TASK-420 nothing on the install path actually
# installed it: install.sh called this script with --piper-only and then printed
# "Kokoro GPU, Piper fallback". Every shipped box spoke through the CPU
# fallback. The pieces below are functions, not inline steps, because both the
# full pipeline install and --tts-only run them and neither may drift.

# CUDA detection: nvcc on PATH, else the standard Jetson location (exported so
# later steps find it). Returns 0 only when CUDA is genuinely usable — the
# torch wheel and the whole Kokoro stack are pointless without it.
NVCC=""
detect_cuda() {
  NVCC=$(command -v nvcc 2>/dev/null || echo "")
  if [ -z "$NVCC" ] && [ -x "$CUDA_HOME_DIR/bin/nvcc" ]; then
    export PATH="$CUDA_HOME_DIR/bin:$PATH"
    NVCC="$CUDA_HOME_DIR/bin/nvcc"
  fi
  [ -n "$NVCC" ]
}

# pip as the clawbox user. The `| tail -3` the inline steps used swallowed the
# exit status (pipefail reports the RIGHTMOST failure, and tail always
# succeeds), which is how a failed install could still look like one that
# worked. Capture, trim for the log, and return the real status.
pip_as_clawbox() {
  local out rc=0
  out=$(su - "$CLAWBOX_USER" -c "$PIP install --user $1" 2>&1) || rc=$?
  printf '%s\n' "$out" | tail -3
  return "$rc"
}

# Run a python3 snippet as the clawbox user with the CUDA library path set.
clawbox_python() {
  su - "$CLAWBOX_USER" -c "
    export LD_LIBRARY_PATH=$KOKORO_LD_PATH:\$LD_LIBRARY_PATH
    python3 -c \"$1\""
}

install_cuda_torch() {
  echo "  Installing CUDA-enabled PyTorch for Jetson (~300 MB)..."
  pip_as_clawbox "nvidia-cusparselt-cu12" || return 1
  pip_as_clawbox "--no-cache-dir '$JETSON_TORCH_URL'" || return 1
  # Interactive shells need the same loader path the units get.
  local bashrc="$CLAWBOX_HOME/.bashrc"
  if ! grep -q "cusparselt" "$bashrc" 2>/dev/null; then
    echo "export LD_LIBRARY_PATH=$KOKORO_LD_PATH:\${LD_LIBRARY_PATH}" >> "$bashrc"
    echo "export CUDA_HOME=$CUDA_HOME_DIR" >> "$bashrc"
  fi
}

install_kokoro_packages() {
  echo "  Installing Kokoro TTS..."
  # Install kokoro first, then force transformers<5 as a separate step.
  # pip 22's resolver won't downgrade huggingface-hub (pulled in by
  # faster-whisper) to satisfy transformers<5 in a single command, so it
  # silently picks transformers 5.x. Keep these two as two pip invocations.
  pip_as_clawbox "'numpy<2' kokoro soundfile 'Pillow>=10'" || return 1
  pip_as_clawbox "'transformers<5'" || return 1
}

# Warm the model cache so the FIRST spoken reply is not a 300 MB download the
# user waits through with no explanation.
kokoro_predownload_model() {
  local out rc=0
  echo "  Pre-downloading Kokoro model..."
  out=$(clawbox_python "
from kokoro import KPipeline
pipeline = KPipeline(lang_code='a')
print('Kokoro model ready on', next(pipeline.model.parameters()).device)
" 2>&1) || rc=$?
  printf '%s\n' "$out" | tail -5
  return "$rc"
}

# Does the box already have a COMPLETE Kokoro stack? This is the idempotence
# gate: --tts-only runs on EVERY in-app update of a shipped device, and
# re-fetching the torch wheel each time would make every update a ~300 MB
# download for nothing.
#
# Both halves are load-bearing. The stamp says "a previous run of this script
# finished every step"; the import says "and it is still true" (a pip
# uninstall, a python upgrade or a wiped ~/.local invalidates it). Gating on
# the import alone would report a box that died at the model download as ready
# forever — see $KOKORO_STAMP above.
kokoro_stack_present() {
  [ "$(cat "$KOKORO_STAMP" 2>/dev/null || true)" = "$KOKORO_STAMP_VERSION" ] || return 1
  clawbox_python "import kokoro, torch" >/dev/null 2>&1
}

# Record a finished install. Best-effort: if the stamp cannot be written the
# only cost is redoing this work on the next update, so it must not fail the
# install — but it is said out loud, because silently paying for a 300 MB
# download on every update is exactly the kind of thing nobody notices.
kokoro_mark_installed() {
  local dir
  dir=$(dirname "$KOKORO_STAMP")
  if ! (mkdir -p "$dir" && printf '%s\n' "$KOKORO_STAMP_VERSION" > "$KOKORO_STAMP"); then
    echo "  Warning: could not write $KOKORO_STAMP — the next update will reinstall Kokoro" >&2
    return 0
  fi
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$dir" 2>/dev/null || true
}

# The kokoro-server.service heredoc lives here, once, so the full path and
# --tts-only cannot ship two different units.
write_kokoro_unit() {
  mkdir -p "$SYSTEMD_USER" || return 1
  cat > "$SYSTEMD_USER/kokoro-server.service" << EOF
[Unit]
Description=Kokoro TTS Server (GPU)
After=default.target

[Service]
Type=simple
Environment=LD_LIBRARY_PATH=$KOKORO_LD_PATH
ExecStart=/usr/bin/python3 $WORKSPACE/scripts/kokoro-server.py
Restart=no

[Install]
WantedBy=default.target
EOF
}

# Make freshly written user units usable: owned by the user that runs them,
# lingering enabled so they can start without a login session, and reloaded.
# All three are best-effort — none of them can cost the box its voice, because
# clawbox-tts.sh starts the server on demand if the unit is not running.
activate_user_units() {
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$SYSTEMD_USER" 2>/dev/null || true
  loginctl enable-linger "$CLAWBOX_USER" 2>/dev/null || true
  su - "$CLAWBOX_USER" -c "
    export XDG_RUNTIME_DIR=/run/user/\$(id -u)
    systemctl --user daemon-reload
  " 2>/dev/null || true
}

# Install the GPU Kokoro stack. NEVER fatal: every exit path leaves Piper and
# the deployed scripts untouched, because a box that lost its voice to a failed
# GPU install is strictly worse than a box on the CPU fallback. The return code
# is the contract with install.sh's step_openclaw_tts, which uses it to decide
# whether it may claim Kokoro in its summary:
#   0   Kokoro ready
#   10  skipped, no CUDA toolkit
#   11  skipped, no Jetson build for this architecture
#   12  attempted and failed
install_kokoro_tts() {
  local arch
  arch=$(uname -m)
  if [ "$arch" != "aarch64" ]; then
    # $JETSON_TORCH_URL is an aarch64 wheel and install_piper already refuses
    # to guess for other arches. Installing "something" here and reporting
    # Kokoro is the exact lie TASK-420 removes.
    echo "  Skipping Kokoro: no Jetson CUDA build for $arch (ClawBox ships aarch64)"
    echo "CLAWBOX_TTS_KOKORO=skipped:arch-$arch"
    return 11
  fi
  if ! detect_cuda; then
    echo "  Skipping Kokoro: no CUDA toolkit (no nvcc on PATH, none at $CUDA_HOME_DIR/bin/nvcc)"
    echo "CLAWBOX_TTS_KOKORO=skipped:no-cuda"
    return 10
  fi
  echo "  CUDA detected: $("$NVCC" --version 2>/dev/null | tail -1)"

  if kokoro_stack_present; then
    echo "  Kokoro already installed by a previous run — skipping the GPU install"
  else
    if ! install_cuda_torch; then
      echo "  ERROR: CUDA PyTorch install failed — leaving TTS on the Piper fallback" >&2
      echo "CLAWBOX_TTS_KOKORO=failed:torch"
      return 12
    fi
    if ! install_kokoro_packages; then
      echo "  ERROR: Kokoro package install failed — leaving TTS on the Piper fallback" >&2
      echo "CLAWBOX_TTS_KOKORO=failed:packages"
      return 12
    fi
    if ! kokoro_predownload_model; then
      echo "  ERROR: Kokoro model pre-download failed — leaving TTS on the Piper fallback" >&2
      echo "CLAWBOX_TTS_KOKORO=failed:model"
      return 12
    fi
    # Only now: every step above landed. Stamping earlier is what would turn a
    # partial install into a permanent false "ready".
    kokoro_mark_installed
  fi

  # Refreshed on every run, present or not: the unit points at a script
  # deploy_voice_scripts just re-copied, and a stale unit is how a working box
  # stops working after an update.
  if ! write_kokoro_unit; then
    echo "  ERROR: could not write $SYSTEMD_USER/kokoro-server.service" >&2
    echo "CLAWBOX_TTS_KOKORO=failed:unit"
    return 12
  fi
  activate_user_units
  echo "CLAWBOX_TTS_KOKORO=ready"
}

# --tts-only installs exactly what on-device TTS needs: the Piper CPU fallback,
# the workspace scripts OpenClaw execs, and the CUDA Kokoro stack with its
# on-demand server unit.
#
# It deliberately does NOT run the STT half of this file — faster-whisper, the
# CTranslate2 CUDA source build, the Whisper model download — which is roughly
# an hour on an Orin. install.sh runs this from step_openclaw_tts on every
# install AND every in-app update; an hour of source builds per update is not
# something a shipped device can absorb.
#
# Piper goes first so a Kokoro failure can never take the fallback with it.
if [ "${1:-}" = "--tts-only" ]; then
  echo "=== On-device TTS (Kokoro GPU + Piper fallback) ==="
  TTS_ONLY_RC=0
  install_piper || TTS_ONLY_RC=1
  deploy_voice_scripts || TTS_ONLY_RC=1

  KOKORO_RC=0
  install_kokoro_tts || KOKORO_RC=$?

  if [ "$TTS_ONLY_RC" -ne 0 ]; then
    # The loud one: without Piper AND without Kokoro the box answers speech
    # with silence, so this outranks whatever the GPU path reported.
    echo "=== Piper fallback INCOMPLETE — the box may answer speech with silence ===" >&2
    exit 1
  fi
  if [ "$KOKORO_RC" -eq 0 ]; then
    echo "=== On-device TTS ready (Kokoro GPU, Piper fallback) ==="
  else
    echo "=== On-device TTS ready on Piper CPU only (Kokoro unavailable) ==="
  fi
  exit "$KOKORO_RC"
fi

# --piper-only installs just the CPU fallback and refreshes the entrypoint. It
# is a small pinned download, unlike the CUDA torch/CTranslate2 build below, so
# it is safe to run unattended on a box that already works. install.sh moved to
# --tts-only above, but this stays: clawbox-tts.sh names it in its
# "Piper not installed" hint, and older devices' scripts call it.
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
if detect_cuda; then
  HAS_CUDA=true
  echo "  CUDA detected: $("$NVCC" --version | tail -1)"
fi

# ── Step 1: Install CUDA PyTorch (if available) ─────────────────────────────

# Tracked across the Kokoro steps so this path can write the same completion
# stamp --tts-only reads, and write it only when every one of them worked. A
# box installed the long way must not then redo the whole GPU stack on its
# first in-app update — nor be stamped as complete when it is not.
KOKORO_FULL_OK=$HAS_CUDA

if $HAS_CUDA; then
  echo "[1/8] Installing CUDA-enabled PyTorch for Jetson..."
  install_cuda_torch || { KOKORO_FULL_OK=false; echo "  Warning: CUDA PyTorch install reported an error"; }
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
install_kokoro_packages || { KOKORO_FULL_OK=false; echo "  Warning: Kokoro package install reported an error"; }

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
if kokoro_predownload_model; then
  if $KOKORO_FULL_OK; then
    kokoro_mark_installed
  fi
else
  echo "  Warning: Kokoro model pre-download reported an error"
fi

# ── Step 6: Deploy scripts ───────────────────────────────────────────────────

echo "[7/8] Installing Piper CPU fallback..."
install_piper

echo "[8/8] Deploying voice server scripts..."
SCRIPTS_DST="$WORKSPACE/scripts"
deploy_voice_scripts

# Install systemd user services for persistent model servers. The Kokoro unit
# comes from the shared writer so this path and --tts-only cannot disagree
# about it; the Whisper unit is STT and only exists on this path.
write_kokoro_unit

cat > "$SYSTEMD_USER/whisper-server.service" << EOF
[Unit]
Description=Whisper STT Server (GPU)
After=default.target

[Service]
Type=simple
Environment=LD_LIBRARY_PATH=$KOKORO_LD_PATH
Environment=WHISPER_MODEL=base
ExecStart=/usr/bin/python3 $SCRIPTS_DST/whisper-server.py
Restart=no

[Install]
WantedBy=default.target
EOF

# Owner, lingering and daemon-reload (servers start on demand via stt-client.py)
activate_user_units

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
