#!/bin/bash
# Install local voice pipeline: faster-whisper (STT) + Kokoro (TTS)
# With CUDA GPU acceleration and persistent model servers for fast inference.
# Runs as clawbox user. Requires espeak-ng to be installed (system package).
set -euo pipefail

# Overridable because the tests run the real script end-to-end so they fail
# when the shipped artifact drifts, and they cannot write into a real
# /home/clawbox. install.sh does not export either name, so a device always
# takes these defaults.
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
# 2: the numpy floor. A box stamped "1" installed `numpy<2`, which was a no-op
#    against the board's apt numpy 1.21.5 — and it passes BOTH halves of the
#    gate below, because `import kokoro, torch` succeeds on such a box (torch
#    only raises "Numpy is not available" later, at the tensor conversion). So
#    without this bump the fix reaches every box except the ones that have the
#    defect. The cost of the bump is one repeat of a ~4 minute install.
KOKORO_STAMP_VERSION="2"

# Where this script publishes its Kokoro verdict for readers that are NOT
# tailing its stdout: install.sh's health check, the flash host, an operator,
# the next update. Overridable so tests — and any run that is not root — can
# point it somewhere writable instead of /etc.
TTS_STATUS_FILE="${CLAWBOX_TTS_STATUS_FILE:-/etc/clawbox/tts-status}"

# ── The CUDA loader path ────────────────────────────────────────────────────
# libcusparseLt.so.0 ships INSIDE the nvidia-cusparselt-cu12 wheel, under the
# clawbox user's site-packages, where no loader looks by default, so without
# these directories `import torch` dies with
#   ImportError: libcusparseLt.so.0: cannot open shared object file
# which is the exact failure TASK-420 exists to remove. The systemd user units,
# the ~/.bashrc export and every python invocation below need them.
#
# DERIVED from $CLAWBOX_HOME and $CUDA_HOME_DIR, never pinned. The literal this
# replaced said /home/clawbox and python3.10, and it was baked verbatim into
# kokoro-server.service; a box with another CLAWBOX_HOME, or the same Jetson
# after a python minor-version bump, got a unit and a clawbox_python pointing
# at a directory that does not exist — that ImportError again, with the install
# still reporting success. scripts/openclaw/clawbox-tts.sh resolves the same
# three directories the same way in its own kokoro_ld_path(); this is
# deliberately the same shape rather than a third spelling of it.
#
# The callers need DIFFERENT semantics, so the mode is explicit:
#
#   present   keep only directories that are on disk right now. For commands
#             this script runs itself, where naming a directory that does not
#             exist yet adds nothing. It is what clawbox-tts.sh does, because
#             it runs at speech time when the wheels are installed by
#             definition.
#
#   expected  keep the site-packages entry even when nothing is unpacked there
#             yet, resolving the python version from the interpreter that will
#             run pip. The unit and ~/.bashrc are written ONCE and then read
#             for the LIFE of the box, and they are written before (or despite)
#             a failed wheel install — so a strict "skip what is missing"
#             filter there would silently produce a unit with no cusparselt
#             entry at all, which is the same broken import arrived at more
#             quietly.
#
# Both modes join with ${out:+$out:} because an EMPTY entry in LD_LIBRARY_PATH
# means "the current directory" to the loader, which is not somewhere to
# resolve .so files from.
kokoro_ld_path() {
  local mode="${1:-present}" out="" d cusparselt=""
  # A python* glob, not a pinned python3.10: the minor version is a property of
  # the box. A directory that really exists always outranks a predicted one.
  for d in "$CLAWBOX_HOME"/.local/lib/python*/site-packages/nvidia/cusparselt/lib; do
    if [ -d "$d" ]; then cusparselt="$d"; fi
  done
  if [ -z "$cusparselt" ] && [ "$mode" = "expected" ]; then
    cusparselt=$(kokoro_expected_cusparselt_dir)
  fi
  local dirs=("$CLAWBOX_HOME/.local/lib")
  if [ -n "$cusparselt" ]; then dirs+=("$cusparselt"); fi
  dirs+=("$CUDA_HOME_DIR/lib64")
  for d in "${dirs[@]}"; do
    if [ "$mode" = "present" ] && [ ! -d "$d" ]; then continue; fi
    out="${out:+$out:}$d"
  done
  printf '%s' "$out"
}

# Where pip --user is going to unpack that wheel on THIS box. Asked of the
# interpreter that will run pip, so the answer carries the python minor version
# the box actually has instead of the one this file was written against. Prints
# nothing if the interpreter cannot be reached or answers something
# unrecognisable — leaving the entry out is honest, inventing a version is not.
kokoro_expected_cusparselt_dir() {
  local ver
  ver=$(su - "$CLAWBOX_USER" -c \
    'python3 -c "import sys; print(\"python%d.%d\" % sys.version_info[:2])"' 2>/dev/null | tail -1) || ver=""
  case "$ver" in
    python[0-9]*.[0-9]*) printf '%s' "$CLAWBOX_HOME/.local/lib/$ver/site-packages/nvidia/cusparselt/lib" ;;
  esac
}

# ── One engine, on purpose ──────────────────────────────────────────────────
# Kokoro on CUDA is the box's only on-device voice. There used to be a Piper
# CPU fallback installed here, pinned by sha256 and run by clawbox-tts.sh
# whenever Kokoro failed; the owner removed it (2026-08). The voice chain is
# cloud → Kokoro with no second CPU engine in between: a Kokoro that is
# missing or broken is REPORTED — as a verdict in $TTS_STATUS_FILE here, and as
# an exit-1 failure the gateway hands to its cloud voice at speech time —
# instead of being papered over by an engine that quietly kept the box
# talking while the GPU install was broken for a whole release (TASK-420).
# Nothing in this file downloads an artifact by hand any more; pip is the only
# fetch left.

# Deploy the TTS entrypoint + engine scripts into the workspace the gateway
# runs from. Split out of the big install so --tts-only can call it too: the
# updater re-runs that path on every update, and a box whose clawbox-tts.sh is
# stale is a box whose speech path is stale.
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
# Kokoro is the box's ONLY voice (TASK-382 benchmarked it on real Orin
# hardware, TASK-383 shipped it as the default, and the CPU fallback that used
# to sit behind it is gone — see above). Until TASK-420 nothing on the install
# path actually installed it: install.sh called this script with a
# fallback-only flag and then printed "Kokoro GPU". Every shipped box spoke
# through the CPU fallback. The pieces below are functions, not inline steps,
# because both the full pipeline install and --tts-only run them and neither
# may drift.

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
#
# The snippet travels on STDIN (`python3 -`) and never inside the -c string, and
# the -c string itself is assembled from single-quoted literals with $ld spliced
# in as its own word — no backslash escapes, and no ${...} nested inside another
# ${...}. Both rules exist because breaking either one broke every call:
#
#   su - "$CLAWBOX_USER" -c "
#     ${ld:+export LD_LIBRARY_PATH=\"$ld\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}\"}
#     python3 -c \"$1\""
#
# The trap is the ESCAPED `\${`. Genuine nesting is fine — bash matches braces
# through it, which is why `${CLAWBOX_HOME:-/home/${CLAWBOX_USER}}` above is
# correct and must not be "fixed". But `\$` is an escaped dollar, so bash never
# saw a nested expansion there at all: it saw a literal `$` followed by a plain
# `{`. Its `}` was left unescaped, so THAT brace closed the OUTER ${ld:+...},
# and the trailing `\"}` was emitted as literal text after the expansion. The
# quote and the brace came out in the wrong order —
#   LD_LIBRARY_PATH="…:$LD_LIBRARY_PATH"}   instead of   "…:$LD_LIBRARY_PATH}"
# — and the stray quote swallowed the rest of the line. Every payload this
# function produced was then a syntax error:
#   -bash: -c: line 7: unexpected EOF while looking for matching `"'
#   -bash: -c: line 8: syntax error: unexpected end of file
# on every box where $ld resolved, which is every box that has CUDA. The model
# pre-download was charged with the failure, the CPU fallback of the time
# absorbed it, and the flash still reported success — so shipped hardware ran
# CPU TTS while the install said "Kokoro GPU". `import torch` on such a box
# fails with `ImportError: libcusparseLt.so.0`, the exact library this export
# exists to find, which is how the missing export was confirmed on device.
# (That fallback is gone now for exactly this reason: a failure Kokoro cannot
# hide behind is a failure that gets fixed.)
clawbox_python() {
  local ld payload='exec python3 -'
  ld=$(kokoro_ld_path present)
  # "present": these commands run here and now, and the export is skipped
  # entirely when nothing resolved — `LD_LIBRARY_PATH=:$LD_LIBRARY_PATH` hands
  # the loader an empty leading entry, which means the current directory.
  #
  # Built by concatenating a single-quoted literal, "$ld", and another
  # single-quoted literal. Nothing is escaped and nothing nests, so $ld cannot
  # end a quote and the ${LD_LIBRARY_PATH:+...} reaches the remote shell intact.
  if [ -n "$ld" ]; then
    payload='export LD_LIBRARY_PATH="'"$ld"'${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; exec python3 -'
  fi
  printf '%s\n' "$1" | su - "$CLAWBOX_USER" -c "$payload"
}

install_cuda_torch() {
  echo "  Installing CUDA-enabled PyTorch for Jetson (~300 MB)..."
  pip_as_clawbox "nvidia-cusparselt-cu12" || return 1
  pip_as_clawbox "--no-cache-dir '$JETSON_TORCH_URL'" || return 1
  # Interactive shells need the same loader path the units get. "expected":
  # this line is appended once and sourced for the life of the box.
  local bashrc="$CLAWBOX_HOME/.bashrc" ld
  ld=$(kokoro_ld_path expected)
  if ! grep -q "cusparselt" "$bashrc" 2>/dev/null; then
    echo "export LD_LIBRARY_PATH=$ld\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}" >> "$bashrc"
    echo "export CUDA_HOME=$CUDA_HOME_DIR" >> "$bashrc"
    # `>>` CREATES the file when it is missing, and this runs as root: a box
    # whose clawbox user had no .bashrc would get a root-owned one it can never
    # edit again. Best-effort, like every other chown here — the exports still
    # work if it fails, and failing the GPU install over file ownership would
    # cost the box its voice for nothing.
    chown "$CLAWBOX_USER:$CLAWBOX_USER" "$bashrc" 2>/dev/null || true
  fi
}

install_kokoro_packages() {
  echo "  Installing Kokoro TTS..."
  # Install kokoro first, then force transformers<5 as a separate step.
  # pip 22's resolver won't downgrade huggingface-hub (pulled in by
  # faster-whisper) to satisfy transformers<5 in a single command, so it
  # silently picks transformers 5.x. Keep these two as two pip invocations.
  #
  # The numpy FLOOR is what makes this pip step do anything at all. JetPack
  # ships numpy 1.21.5 as an apt package in /usr/lib/python3/dist-packages,
  # which already satisfies a bare `numpy<2` — so pip installed nothing, and
  # the Jetson torch wheel could not use 1.21.5:
  #   $ kokoro -t "..." -o /tmp/k1.wav -m af_heart -l a
  #   RuntimeError: Numpy is not available          (a 44-byte output file)
  # With `numpy>=1.24,<2`, 1.26.4 lands in user-site and the same command
  # produced 105,644 bytes of audio in 12.2 s (measured on a JetPack 6.2 Orin).
  # The <2 ceiling stays: torch 2.5.0a0+872d972e41.nv24.8 is a numpy-1.x build.
  # This defect was inherited from the pre-existing full path, which calls this
  # same function, so both paths are fixed here.
  pip_as_clawbox "'numpy>=1.24,<2' kokoro soundfile 'Pillow>=10'" || return 1
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
  local ld
  # "expected": this file is written once and read for the life of the box, and
  # it is refreshed even on a run whose wheel install failed.
  ld=$(kokoro_ld_path expected)
  mkdir -p "$SYSTEMD_USER" || return 1
  cat > "$SYSTEMD_USER/kokoro-server.service" << EOF
[Unit]
Description=Kokoro TTS Server (GPU)
After=default.target

[Service]
Type=simple
Environment=LD_LIBRARY_PATH=$ld
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

# Publish the Kokoro verdict — on stdout, as before, AND to $TTS_STATUS_FILE so
# it outlives the run.
#
# The three states are a contract, and two of them used to be indistinguishable
# to every reader downstream:
#
#   ready       requested, installed, usable.
#   skipped:*   NOT applicable to this board (no CUDA, no Jetson build for this
#               architecture). Nothing was asked for and nothing is missing.
#   failed:*    requested and NOT delivered. The owner asked for GPU TTS, the
#               box has no on-device voice until it is fixed (spoken replies
#               fall back to the gateway's cloud voice), and something is
#               broken that a human has to fix.
#
# `failed:*` reaching only stdout is precisely how a hard failure shipped as a
# soft fallback: the step logged an ERROR line, returned, and the flash printed
# success. A verdict nobody can read after the fact is not a report.
#
# Kokoro is the only engine, so KOKORO= is the only engine key this file
# writes. A release that still shipped the CPU fallback also wrote PIPER=; that
# line is neither read nor carried forward now — there is no engine behind it
# — so an old file is simply overwritten with the one verdict that means
# something. The verdict also decides the exit status below, so a run that
# cannot WRITE the file still tells its caller the truth about the box.
TTS_KOKORO_VERDICT=""

# Rewrite $TTS_STATUS_FILE from the verdict known so far. A key with no verdict
# is OMITTED rather than written as a placeholder: install.sh's health check
# treats an ABSENT verdict as a failed check, and inventing a value would
# launder that silence into an answer.
tts_status_publish() {
  local dir
  dir=$(dirname "$TTS_STATUS_FILE")
  # Best-effort on the WRITE, never on the SILENCE: a verdict that cannot be
  # published is itself something install.sh has to hear about, because its
  # health check treats a missing verdict as a failed check rather than as a
  # pass.
  if { mkdir -p "$dir" \
      && { [ -z "$TTS_KOKORO_VERDICT" ] || printf 'KOKORO=%s\n' "$TTS_KOKORO_VERDICT"
           printf 'TIMESTAMP=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"; } \
           > "$TTS_STATUS_FILE"; } 2>/dev/null; then
    chmod 644 "$TTS_STATUS_FILE" 2>/dev/null || true
  else
    echo "  Warning: could not publish the TTS verdict to $TTS_STATUS_FILE -" >&2
    echo "           install.sh cannot health-check a result it cannot read" >&2
  fi
}

kokoro_report() {
  TTS_KOKORO_VERDICT="$1"
  echo "CLAWBOX_TTS_KOKORO=$1"
  tts_status_publish
}

# Install the GPU Kokoro stack. NEVER fatal: every exit path leaves the
# deployed scripts untouched and publishes a verdict, because the failure has
# to reach install.sh's summary and health check rather than abort the install
# half-way with the box unreachable. The return code is the contract with
# install.sh's step_openclaw_tts, which uses it to decide whether it may claim
# Kokoro in its summary:
#   0   Kokoro ready
#   10  skipped, no CUDA toolkit
#   11  skipped, no Jetson build for this architecture
#   12  attempted and failed
install_kokoro_tts() {
  local arch
  arch=$(uname -m)
  if [ "$arch" != "aarch64" ]; then
    # $JETSON_TORCH_URL is an aarch64 wheel. Installing "something" here and
    # reporting Kokoro is the exact lie TASK-420 removes.
    echo "  Skipping Kokoro: no Jetson CUDA build for $arch (ClawBox ships aarch64)"
    kokoro_report "skipped:arch-$arch"
    return 11
  fi
  if ! detect_cuda; then
    echo "  Skipping Kokoro: no CUDA toolkit (no nvcc on PATH, none at $CUDA_HOME_DIR/bin/nvcc)"
    kokoro_report "skipped:no-cuda"
    return 10
  fi
  echo "  CUDA detected: $("$NVCC" --version 2>/dev/null | tail -1)"

  if kokoro_stack_present; then
    echo "  Kokoro already installed by a previous run — skipping the GPU install"
  else
    if ! install_cuda_torch; then
      echo "  ERROR: CUDA PyTorch install failed — this box has no on-device voice until it is fixed" >&2
      kokoro_report "failed:torch"
      return 12
    fi
    if ! install_kokoro_packages; then
      echo "  ERROR: Kokoro package install failed — this box has no on-device voice until it is fixed" >&2
      kokoro_report "failed:packages"
      return 12
    fi
    if ! kokoro_predownload_model; then
      echo "  ERROR: Kokoro model pre-download failed — this box has no on-device voice until it is fixed" >&2
      kokoro_report "failed:model"
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
    kokoro_report "failed:unit"
    return 12
  fi
  activate_user_units
  kokoro_report "ready"
}

# --tts-only installs exactly what on-device TTS needs: the workspace scripts
# OpenClaw execs, and the CUDA Kokoro stack with its on-demand server unit.
# There is no second engine to install — Kokoro is the box's only voice, and a
# Kokoro that is missing is reported (verdict file, exit status) rather than
# papered over by a CPU fallback.
#
# It deliberately does NOT run the STT half of this file — faster-whisper, the
# CTranslate2 CUDA source build, the Whisper model download — which is roughly
# an hour on an Orin. install.sh runs this from step_openclaw_tts on every
# install AND every in-app update; an hour of source builds per update is not
# something a shipped device can absorb.
#
# The scripts go first so a Kokoro failure can never take the entrypoint with
# it: clawbox-tts.sh is what turns "Kokoro is down" into an exit-1 report the
# gateway can hand to its cloud voice, instead of a missing command.
if [ "${1:-}" = "--tts-only" ]; then
  echo "=== On-device TTS (Kokoro GPU) ==="

  DEPLOY_RC=0
  deploy_voice_scripts || DEPLOY_RC=$?

  KOKORO_RC=0
  install_kokoro_tts || KOKORO_RC=$?

  # The exit status is the contract with install.sh's step_openclaw_tts:
  #
  #   0        Kokoro is ready.
  #   10 / 11  Kokoro does not apply to this board (no CUDA, no Jetson build).
  #            The box has no on-device voice by design; the cloud voice speaks.
  #   12       Kokoro was REQUESTED and did not install. Same outcome for the
  #            listener, but this one is a defect a human has to fix.
  #   1        the voice scripts did not deploy; Kokoro's own verdict stands in
  #            $TTS_STATUS_FILE.
  #
  # There is no 13 ("no engine at all") any more. It existed to tell "the CPU
  # fallback is gone too" apart from "Kokoro failed but the fallback survives";
  # with one engine those are the same fact, and 12 carries it. A hard Kokoro
  # failure outranks a deploy failure, because 12 is the code install.sh
  # records as "the engine you asked for did not arrive" and nothing may
  # overwrite it — the lesson of the bare `exit 1` that once sat before
  # `exit "$KOKORO_RC"` and laundered a mute box into a warning.
  if [ "$KOKORO_RC" -eq 12 ]; then
    echo "=== Kokoro GPU TTS was requested and did NOT install — this box has no on-device voice ===" >&2
    exit 12
  fi
  if [ "$DEPLOY_RC" -ne 0 ]; then
    echo "=== Voice scripts INCOMPLETE — the workspace copy of the TTS scripts did not deploy (Kokoro: ${TTS_KOKORO_VERDICT:-unreported}) ===" >&2
    exit 1
  fi
  if [ "$KOKORO_RC" -eq 0 ]; then
    echo "=== On-device TTS ready (Kokoro GPU) ==="
  else
    echo "=== No on-device TTS engine applies to this board (Kokoro: $TTS_KOKORO_VERDICT) — spoken replies use the gateway's cloud voice ==="
  fi
  exit "$KOKORO_RC"
fi

# Any other option is refused rather than silently taken as "run the full
# pipeline install": that path builds CTranslate2 from source and takes about
# an hour, and the fallback-only flag an earlier release accepted here used to
# land on it. There is no such mode any more, and a caller that still asks for
# one should hear that instead of getting an hour of builds.
case "${1:-}" in
  --*)
    echo "install-voice.sh: unknown option '$1' (the only mode flag is --tts-only; no flag runs the full STT+TTS install)" >&2
    exit 2 ;;
esac

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
  echo "[1/7] Installing CUDA-enabled PyTorch for Jetson..."
  install_cuda_torch || { KOKORO_FULL_OK=false; echo "  Warning: CUDA PyTorch install reported an error"; }
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
install_kokoro_packages || { KOKORO_FULL_OK=false; echo "  Warning: Kokoro package install reported an error"; }

# ── Step 5: Pre-download models ─────────────────────────────────────────────

echo "[5/7] Pre-downloading Whisper model (base)..."
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
# Through the shared helper: this was the third copy of the same pinned
# python3.10 path, and STT needs that loader path for exactly the reason TTS
# does — the CUDA libraries live under user-site.
clawbox_python "
from faster_whisper import WhisperModel
model = WhisperModel('base', device='$DEVICE', compute_type='$COMPUTE')
print('Whisper base model ready on $DEVICE')
" 2>&1 | tail -3

echo "[6/7] Pre-downloading Kokoro model..."
if kokoro_predownload_model; then
  if $KOKORO_FULL_OK; then
    kokoro_mark_installed
  fi
else
  echo "  Warning: Kokoro model pre-download reported an error"
fi

# ── Step 7: Deploy scripts ───────────────────────────────────────────────────

echo "[7/7] Deploying voice server scripts..."
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
Environment=LD_LIBRARY_PATH=$(kokoro_ld_path expected)
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
echo "  TTS: Kokoro-82M via on-demand server (~2s) — the only on-device engine; a Kokoro failure is reported to the gateway, not hidden"
echo "  TTS entrypoint: $WORKSPACE/scripts/openclaw/clawbox-tts.sh"
echo "  Services: kokoro-server, whisper-server (on-demand, auto-stop after idle)"
