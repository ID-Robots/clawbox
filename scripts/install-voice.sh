#!/bin/bash
# Install local voice pipeline: faster-whisper (STT) + Kokoro (TTS)
# With CUDA GPU acceleration and persistent model servers for fast inference.
# Runs as clawbox user. It needs NO system speech package: `kokoro` pulls in
# `misaki[en]`, and misaki/espeak.py calls
# `EspeakWrapper.set_library(espeakng_loader.get_library_path())` at import, so
# both the espeak-ng shared library and its data come out of the bundled
# `espeakng-loader` wheel. Measured 2026-09-04 on a shipped openclaw box and a
# shipped hermes box: no espeak-ng package, no espeak-ng binary, and
# `KPipeline(lang_code='a').g2p.fallback` is still an EspeakFallback that
# phonemises out-of-vocabulary words. The header used to claim the apt package
# was required and install.sh has never installed it (TASK-686); what the claim
# was standing in for is now CHECKED, in kokoro_predownload_model below.
#
# Usage:
#   install-voice.sh              full STT+TTS install (CTranslate2 source
#                                 build, Whisper model, Kokoro; ~1 h on an Orin)
#   install-voice.sh --tts-only   the workspace TTS scripts and the Kokoro GPU
#                                 stack only (what install.sh runs on every
#                                 install and every in-app update)
#
# Exit status, in BOTH modes. The published Kokoro VERDICT decides it, never a
# return code on its own:
#   0   Kokoro verdict `ready`.
#   13  Kokoro verdict `skipped:<reason>`: the board declines the only engine,
#       so NO on-device engine can speak. The engine and the concrete reason it
#       is absent are printed. install.sh records this as a provision failure
#       (non-fatal) — every shipped ClawBox is a Jetson with a Kokoro build, so
#       a skip on real hardware means something is wrong.
#   12  Kokoro verdict `failed:<reason>`, or no verdict at all, an unparseable
#       verdict, a truncated reason, or a status outside the vocabulary.
#   1   the voice scripts did not deploy (Kokoro's own verdict stands).
#   2   unknown option.
# The verdict vocabulary is closed: `ready`, `skipped:<reason>`,
# `failed:<reason>` — anything else is 12. The verdict is published to
# $TTS_STATUS_FILE for readers that are not tailing stdout.
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
# Kokoro on CUDA is the box's only on-device voice. There used to be a second,
# CPU-only engine installed here, pinned by sha256 and run by clawbox-tts.sh
# whenever Kokoro failed; the owner removed it (2026-08). What speaks at speech
# time is the gateway's business (scripts/openclaw/clawbox-tts.sh); this file's
# business is that a Kokoro that is missing or broken is REPORTED — a verdict
# in $TTS_STATUS_FILE and a non-zero exit install.sh records — instead of being
# papered over by an engine that quietly kept the box talking while the GPU
# install was broken for a whole release (TASK-420). Nothing in this file
# downloads an artifact by hand any more; pip is the only fetch left.

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
# kokoro builds the espeak phonemiser fallback inside a try/except and degrades
# to logger.warning('EspeakFallback not Enabled: OOD words will be skipped')
# plus fallback=None. Nothing downstream reads that warning, so a box in that
# arm published KOKORO=ready and then silently dropped every out-of-vocabulary
# word -- a name, a brand, 'ClawBox' itself -- from every spoken reply. Fail the
# warm-up instead, so the verdict says the engine is not usable.
if getattr(pipeline.g2p, 'fallback', None) is None:
    raise SystemExit('espeak phonemiser fallback unavailable: out-of-vocabulary words would be dropped from speech (the espeakng-loader wheel that kokoro pulls in is missing or broken)')
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
#               architecture). This engine is absent by the board's own
#               design — and it is the ONLY engine, so such a box has no
#               on-device voice at all. That is a mute box, graded 13 below
#               and recorded by install.sh as a provision failure, never a
#               clean run: the installer cannot know whether a cloud voice
#               will ever be linked, and every shipped ClawBox is a Jetson
#               with a Kokoro build, so a skip on real hardware means
#               something is wrong. It is not `ready`, and nothing below may
#               read it as an engine.
#   failed:*    requested and NOT delivered. The owner asked for GPU TTS, the
#               box has no on-device voice until it is fixed, and something is
#               broken that a human has to fix (12 below).
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

# Nothing in this file reads $TTS_STATUS_FILE back. Every mode that publishes
# produces the one engine's verdict in-process, so there is no other engine's
# answer to preserve across runs — and seeding from an earlier run's file is
# exactly how a stale PIPER= line would be carried forward as if an engine
# still stood behind it. (The `tr -d '\r'` hardening for a tarball-restored,
# hand-edited file lives in install.sh's readers, the only readers left.)
#
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

# The engine's verdict, spelled out for a human reading a flash log.
#
# Every place that reports "this box has no on-device voice" has to say WHY
# the engine is not there, or the operator is left to go and read
# $TTS_STATUS_FILE to learn what the run already knew. Kept in one function so
# the reporting sites below (--tts-only, the full pipeline's summary and its
# final guard) cannot drift into three vocabularies.
#
# `ready` is the only verdict that means "this engine can speak". `skipped:?*`
# is a board that was never going to run it and `failed:?*` is one that was
# asked and could not — neither of those is an engine, and neither may be read
# as one. Both leave the box with no on-device voice, and both fail the run;
# they are told apart so the operator knows what to do about it: a skip is a
# board that declines the only engine (exit 13 below), a failure is an install
# a human has to repair (exit 12). On this one-engine box the reason is both
# the operator's sentence and the grade.
#
# `skipped:?*` / `failed:?*`, never `skipped:*`: a bare `skipped:` carries no
# reason, and a truncated write is exactly how one appears. A claim with its
# reason cut off is not evidence for it — it belongs with the unreadable
# values, which every caller below treats as "no engine".
#
# Always returns 0: it is called inside `echo "$(...)"` under `set -e`, and a
# verdict this cannot classify is still something to print, not something to
# die on.
tts_verdict_explain() {
  case "${1:-}" in
    ready)      printf 'ready' ;;
    skipped:?*) printf 'SKIPPED (%s) - this board does not run it' "${1#skipped:}" ;;
    failed:?*)  printf 'FAILED (%s) - it was asked for and did not install' "${1#failed:}" ;;
    "")         printf 'no verdict published - the install left no record of it' ;;
    *)          printf 'unreadable verdict "%s" - not evidence of an engine' "$1" ;;
  esac
}

# The report every caller prints for a Kokoro that did not arrive: one wording,
# the verdict's reason named, and the file the verdict lives in. The caller
# supplies the exit — 12 everywhere, the code install.sh records as "the
# engine you asked for did not arrive". A report that sends someone to
# $TTS_STATUS_FILE to find out what happened is not a report.
tts_missing_engine_report() {
  echo "=== Kokoro GPU TTS was requested and did NOT install — this box has no on-device voice ===" >&2
  echo "===   Kokoro (GPU): $(tts_verdict_explain "$TTS_KOKORO_VERDICT")" >&2
  echo "===   Verdict recorded in $TTS_STATUS_FILE" >&2
}

# The report for a board that DECLINED the only engine (`skipped:?*`): the
# same shape, and the caller supplies the exit — 13 everywhere, the code
# install.sh records as "no working on-device TTS engine". The board is not
# defective the way a `failed:*` box is, but the outcome is the same silence,
# and a run that graded it clean was the defect this exit exists to end: the
# two-engine release exited 10/11 here, install.sh scored that as a healthy
# provision, and the box answered every spoken request with nothing. The
# engine is named with the concrete reason it is not here, because a report
# that sends someone to $TTS_STATUS_FILE to learn why is not a report.
tts_mute_box_report() {
  echo "=== NO WORKING TTS ENGINE - this box will answer every spoken request with SILENCE ===" >&2
  echo "===   Kokoro (GPU): $(tts_verdict_explain "$TTS_KOKORO_VERDICT")" >&2
  echo "===   Verdict recorded in $TTS_STATUS_FILE" >&2
}

# Install the GPU Kokoro stack. NEVER fatal: every exit path leaves the
# deployed scripts untouched and publishes a verdict, because the failure has
# to reach install.sh's summary and health check rather than abort the install
# half-way with the box unreachable. The return code is the contract with
# install.sh's step_openclaw_tts, which uses it to decide whether it may claim
# Kokoro in its summary — the same three codes the script itself exits with,
# so the function and the mode cannot tell two stories:
#   0   Kokoro ready
#   13  skipped: the board declines the only engine (no CUDA toolkit, or no
#       Jetson build for this architecture) — the box has no on-device voice
#   12  attempted and failed
install_kokoro_tts() {
  local arch
  arch=$(uname -m)
  if [ "$arch" != "aarch64" ]; then
    # $JETSON_TORCH_URL is an aarch64 wheel. Installing "something" here and
    # reporting Kokoro is the exact lie TASK-420 removes.
    echo "  Skipping Kokoro: no Jetson CUDA build for $arch (ClawBox ships aarch64)"
    kokoro_report "skipped:arch-$arch"
    return 13
  fi
  if ! detect_cuda; then
    echo "  Skipping Kokoro: no CUDA toolkit (no nvcc on PATH, none at $CUDA_HOME_DIR/bin/nvcc)"
    kokoro_report "skipped:no-cuda"
    return 13
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
# gateway can act on, instead of a missing command.
if [ "${1:-}" = "--tts-only" ]; then
  echo "=== On-device TTS (Kokoro GPU) ==="

  DEPLOY_RC=0
  deploy_voice_scripts || DEPLOY_RC=$?

  KOKORO_RC=0
  install_kokoro_tts || KOKORO_RC=$?

  # The exit status is the contract with install.sh's step_openclaw_tts (the
  # table in the header of this file):
  #
  #   0    Kokoro is ready.
  #   13   Kokoro does not apply to this board (no CUDA, no Jetson build). It
  #        is the only engine, so this box has NO on-device voice: a mute box,
  #        reported with the engine and its reason, recorded by install.sh.
  #   12   Kokoro was REQUESTED and did not install — or published no verdict
  #        this dispatch can read. Same silence for the listener, but this one
  #        is a defect a human has to fix.
  #   1    the voice scripts did not deploy behind a READY Kokoro; Kokoro's own
  #        verdict stands in $TTS_STATUS_FILE.
  #
  # The two-engine release exited 10/11 for a skipped Kokoro because the CPU
  # engine behind it still spoke. There is no engine behind it now, so a
  # skipped Kokoro is not a box that talks, and 10 and 11 are not emitted any
  # more: grading a board with no `ready` engine clean is precisely the defect
  # 13 was landed to end (#544) — install.sh scored it a healthy provision and
  # the box answered every spoken request with silence.
  #
  # "No engine" outranks a deploy failure, and so does a hard Kokoro failure:
  # 12 and 13 are the codes install.sh RECORDS, and nothing may overwrite them
  # with the warning-only 1 — the lesson of the bare `exit 1` that once sat
  # before `exit "$KOKORO_RC"` and laundered a mute box into a warning.
  #
  # Whether the engine ARRIVED is read from the published VERDICT, not from the
  # return code. install_kokoro_tts sets both in the same breath, so today they
  # cannot disagree — but a future early return that forgets kokoro_report, or
  # a verdict outside the vocabulary, must land on the failure arm and not on
  # `exit "$KOKORO_RC"`. Nothing to read is not evidence of an engine. Nor is
  # `skipped:?*` bundled with `ready`: that alternation is exactly what let a
  # declined engine fall through as one that exists.
  case "$TTS_KOKORO_VERDICT" in
    ready) ;;
    skipped:?*)
      tts_mute_box_report
      exit 13
      ;;
    *)
      tts_missing_engine_report
      exit 12
      ;;
  esac
  if [ "$DEPLOY_RC" -ne 0 ]; then
    echo "=== Voice scripts INCOMPLETE — the workspace copy of the TTS scripts did not deploy (Kokoro: ${TTS_KOKORO_VERDICT:-unreported}) ===" >&2
    exit 1
  fi
  # Only a `ready` verdict reaches this line, and install_kokoro_tts returns 0
  # in the same breath as publishing it.
  echo "=== On-device TTS ready (Kokoro GPU) ==="
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
  # Clears the flag for the same reason install_cuda_torch and
  # install_kokoro_packages do: without the model there is no engine, and this
  # arm is the one that skips kokoro_mark_installed. Leaving the flag true left
  # the only in-memory record of the failure at a Warning line.
  KOKORO_FULL_OK=false
  echo "  Warning: Kokoro model pre-download reported an error"
fi

# ── Step 7: Deploy scripts ───────────────────────────────────────────────────

echo "[7/7] Deploying voice server scripts..."
SCRIPTS_DST="$WORKSPACE/scripts"
deploy_voice_scripts

# Install systemd user services for persistent model servers. The Kokoro unit
# comes from the shared writer so this path and --tts-only cannot disagree
# about it; the Whisper unit is STT and only exists on this path.
# Still fatal, as the bare call was under `set -e` — but graded by its VERDICT,
# the same way --tts-only grades this same fact: `failed:unit` is a Kokoro that
# was asked for and did not install, and the header's table gives that 12 in
# BOTH modes. A bare `exit 1` here once said "the scripts did not deploy" about
# a box whose scripts had just deployed fine, and left the two modes disagreeing
# about one verdict. The record is written first so the box keeps a RECORD of
# why, instead of dying with its verdict file unwritten.
if ! write_kokoro_unit; then
  kokoro_report "failed:unit"
  echo "  ERROR: could not write $SYSTEMD_USER/kokoro-server.service" >&2
  echo "" >&2
  tts_missing_engine_report
  exit 12
fi

# PUBLISH the Kokoro verdict on this path too. This file installs the GPU stack
# inline rather than through install_kokoro_tts, which is the only other writer
# of KOKORO=, so a full-pipeline run left the verdict file UNWRITTEN — or,
# worse, stale from an earlier run — and install.sh's step_validate_services
# then reported "no on-device TTS verdict for Kokoro" on a box that had just
# built one. The summary below reads it back, so the run states a fact about
# the engine instead of asserting one.
if ! $HAS_CUDA; then
  kokoro_report "skipped:no-cuda"
elif $KOKORO_FULL_OK; then
  kokoro_report "ready"
else
  # One of install_cuda_torch / install_kokoro_packages / the model pre-download
  # reported an error above. Each printed a Warning and the pipeline carried on,
  # which is how "TTS: Kokoro-82M via on-demand server" ended up on the summary
  # of a run whose GPU stack never finished.
  kokoro_report "failed:install"
fi

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
# The engine is named from its PUBLISHED verdict, not from the fact that the
# Kokoro steps were called a few lines up. Every arm of this summary used to
# open with "TTS: Kokoro-82M via on-demand server (~2s)", printed identically
# on the runs where install_cuda_torch, the Kokoro packages or the model
# pre-download had reported an error a few dozen lines above and the pipeline
# carried on. Same class as the CPU-fallback line this summary once asserted on
# every run, same fix: state the verdict.
case "$TTS_KOKORO_VERDICT" in
  ready)      echo "  TTS engine: Kokoro-82M via on-demand server (~2s) — the only on-device engine; a Kokoro failure is reported to the gateway, not hidden" ;;
  skipped:?*) echo "  TTS engine: no Kokoro GPU engine applies to this board ($TTS_KOKORO_VERDICT) — this box has no on-device voice" >&2 ;;
  *)          echo "  TTS engine: the Kokoro GPU engine did NOT install (${TTS_KOKORO_VERDICT:-unreported})" >&2 ;;
esac
echo "  TTS entrypoint: $WORKSPACE/scripts/openclaw/clawbox-tts.sh"
echo "  Services: kokoro-server, whisper-server (on-demand, auto-stop after idle)"

# ── The other caller, and the other route to a false pass ───────────────────
# The summary above got its engine NAME from the verdict, and the script then
# fell off its last `echo` — so a run that had just printed "the Kokoro GPU
# engine did NOT install" (or "no Kokoro GPU engine applies to this board")
# exited 0. This is the manual voice-pipeline install an operator runs by
# hand; reporting a box with no working engine as a clean run is the same
# defect --tts-only carried, one caller further out. Same rule, same exit
# codes (13 for a board that declines the only engine, 12 for one that asked
# and did not get it — what --tts-only hands install.sh for the same facts),
# same named reason.
case "$TTS_KOKORO_VERDICT" in
  ready) ;;
  skipped:?*)
    echo "" >&2
    tts_mute_box_report
    exit 13
    ;;
  *)
    echo "" >&2
    tts_missing_engine_report
    exit 12
    ;;
esac
