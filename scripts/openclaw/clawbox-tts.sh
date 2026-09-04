#!/usr/bin/env bash
# ClawBox on-device text-to-speech — the single entrypoint OpenClaw calls.
#
# Wired in as the `tts-local-cli` provider command by step_openclaw_tts in
# install.sh, so every spoken reply the box makes for itself runs through
# here: no network round-trip, no per-character cost.
#
#   clawbox-tts.sh [--voice <voice>] <text> <output-path>
#   clawbox-tts.sh --set-voice <voice>     # persist this user's voice
#   clawbox-tts.sh --get-voice
#
# The engine is Kokoro on CUDA, and only Kokoro. The chain, in order:
#   1. The persistent kokoro-server unix socket when it is up — the model is
#      already resident on the GPU and a healthy answer is ~2s.
#   2. A cold start of the `kokoro` CLI when it is not — torch CUDA init plus
#      the Kokoro-82M load, tens of seconds on an Orin Nano.
#   3. Non-zero exit, with every reason it got there on stderr.
#
# There is deliberately no second engine behind Kokoro. Until 2026-08 this
# file fell through to Piper on the CPU, and the owner removed it: the voice
# chain is cloud → Kokoro, with no CPU engine in between. A fallback that
# silently took over on every Kokoro failure is what hid a broken GPU install
# for a whole release (TASK-420) — speech kept working, on the wrong engine,
# and nobody noticed. So a Kokoro failure is now REPORTED upstream rather
# than absorbed here: this script exits 1 with the reasons, OpenClaw surfaces
# them in the gateway log as `CLI TTS exit 1: <stderr>`, and the gateway's own
# fallback — the cloud voice — takes over from there. That report is the
# fix's whole value, which is why the one thing this script must never do is
# exit 0 without audio: a silent success is indistinguishable from a working
# TTS to everything upstream, and it is the bug this file replaced (the old
# kokoro-tts.sh printed "Kokoro TTS failed" for every cause alike).
#
# Why the memory guard (CLAWBOX_TTS_MIN_FREE_MB): TASK-382 measured
# kokoro-torch on CUDA peaking at 2259-2636 MB on an Orin Nano whose 7607 MB is
# SHARED between CPU and GPU. Those numbers came off an idle board; in service
# the agent and faster-whisper are resident too. Trying the allocation anyway
# does not fail politely — it OOM-kills whatever the kernel picks, which on
# this hardware has been the user's own session. So we read MemAvailable first
# and refuse, with a reason, when the headroom is not there — that refusal
# reaches the gateway like any other Kokoro failure. The default 3000 MB is
# the measured 2636 MB peak rounded up, plus room for the CUDA context and
# allocator fragmentation.
#
# NOT `set -e`: a failed engine call has to reach the reasons list and the
# exit-1 report at the bottom, not kill the script mid-way with nothing said.
set -uo pipefail

CLAWBOX_TTS_DEFAULT_VOICE="${CLAWBOX_TTS_DEFAULT_VOICE:-af_heart}"
CLAWBOX_TTS_VOICE_FILE="${CLAWBOX_TTS_VOICE_FILE:-${HOME:-/home/clawbox}/.openclaw/clawbox-tts-voice}"
CLAWBOX_TTS_MIN_FREE_MB="${CLAWBOX_TTS_MIN_FREE_MB:-3000}"
CLAWBOX_TTS_MEMINFO="${CLAWBOX_TTS_MEMINFO:-/proc/meminfo}"
# A WAV that is only a header is "no audio", not audio. 1 KiB is ~20 ms at
# 24 kHz mono 16-bit — below anything a real utterance can be.
CLAWBOX_TTS_MIN_AUDIO_BYTES="${CLAWBOX_TTS_MIN_AUDIO_BYTES:-1024}"

KOKORO_SOCKET="${KOKORO_SOCKET:-/tmp/kokoro-server.sock}"

# ── Finding the Kokoro CLI ──────────────────────────────────────────────────
# `pip install --user kokoro` puts the CLI at ~/.local/bin/kokoro, and that
# directory is not on the PATH a non-interactive exec inherits — on a shipped
# box that is /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin and
# nothing else. OpenClaw execs this script directly, with no login shell and no
# profile, so `command -v kokoro` failed on a box where Kokoro was fully
# installed and spoke correctly from an interactive shell: every reply came out
# of the CPU fallback of the time with "kokoro: 'kokoro' is not installed"
# (TASK-420, measured on a real Orin). Installing the engine was not enough;
# it also has to be findable from the environment the gateway hands us.
#
# An explicit KOKORO_BIN still wins. It is how a per-channel provider `env` can
# point at another build, and how the tests aim this at a stub.
KOKORO_USER_BIN="${KOKORO_USER_BIN:-${HOME:-/home/clawbox}/.local/bin/kokoro}"
KOKORO_UNRESOLVED=""
resolve_kokoro_bin() {
  [ -n "${KOKORO_BIN:-}" ] && return 0
  if command -v kokoro >/dev/null 2>&1; then
    KOKORO_BIN="kokoro"
    return 0
  fi
  if [ -x "$KOKORO_USER_BIN" ]; then
    KOKORO_BIN="$KOKORO_USER_BIN"
    return 0
  fi
  # Nothing to run. The diagnostic keeps the name a person would type, and
  # remembers that both places were searched so it can say where it looked.
  KOKORO_BIN="kokoro"
  KOKORO_UNRESOLVED=1
}
resolve_kokoro_bin

# ── The CUDA loader path ────────────────────────────────────────────────────
# Without it torch cannot be imported at all:
#   ImportError: libcusparseLt.so.0: cannot open shared object file
# That library ships inside the nvidia-cusparselt-cu12 wheel, under user-site,
# where no loader looks by default. install-voice.sh appends the export to
# ~/.bashrc and writes it into kokoro-server.service — neither of which reaches
# here, for the same reason the PATH above does not. And because the engine's
# own output is discarded, that ImportError arrived as nothing more than
# "kokoro failed", with the CPU fallback of the time quietly taking over.
#
# Derived from $HOME and whichever python user-site is actually on the box
# rather than pinned to /home/clawbox and python3.10, and only directories that
# exist are added: an EMPTY entry means "the current directory" to the loader,
# which is not somewhere to resolve .so files from. Whatever the caller already
# set is appended to, never replaced.
kokoro_ld_path() {
  local out="" d
  for d in "${HOME:-/home/clawbox}/.local/lib" \
           "${HOME:-/home/clawbox}"/.local/lib/python*/site-packages/nvidia/cusparselt/lib \
           "${KOKORO_CUDA_LIB_DIR:-/usr/local/cuda/lib64}"; do
    [ -d "$d" ] || continue
    out="${out:+$out:}$d"
  done
  [ -n "${LD_LIBRARY_PATH:-}" ] && out="${out:+$out:}$LD_LIBRARY_PATH"
  printf '%s' "$out"
}
KOKORO_LD_PATH="${KOKORO_LD_PATH:-$(kokoro_ld_path)}"

# ── The time budget ─────────────────────────────────────────────────────────
# Every step gets its own slice, and the caller's timeout has to be larger
# than all of them added together. It was not, once: KOKORO_TIMEOUT and the
# provider's timeoutMs were both 120s, two constants that happened to be
# equal, so OpenClaw killed this process at the exact moment Kokoro gave up —
# and nothing after that point, not even the reasons, ever reached the
# gateway. A hung GPU was silence with no diagnostic.
#
# The slices are small on purpose. A spoken reply that takes even half a
# minute has already failed as an interaction, so the budget is sized to give
# up quickly and hand the failure upstream (where the cloud voice is waiting)
# rather than to let a wedged engine use its full rope:
#
#   KOKORO_SERVER_TIMEOUT  10s  the model is already resident on the GPU and a
#                               healthy answer is ~2s; 10s means wedged.
#   KOKORO_TIMEOUT         40s  cold start, so it pays torch CUDA init plus the
#                               Kokoro-82M load on an Orin Nano.
#   CONVERT_TIMEOUT        10s  ffmpeg on a few seconds of audio. It had no
#                               bound at all before, which was its own hang.
#
# Worst case walks all three: server wedged, cold start wedged, then
# conversion. tts_provider_timeout_ms() adds a margin on top of that sum, and
# install.sh asks this script for the number instead of keeping its own copy —
# so changing a slice here moves the caller's timeout with it and this cannot
# quietly come back. The budget is the sum of the slices that are actually
# handed to `timeout` below and nothing else; a slice for an engine that no
# longer runs would only be rope the caller pays for and nobody uses.
KOKORO_SERVER_TIMEOUT="${KOKORO_SERVER_TIMEOUT:-10}"
KOKORO_TIMEOUT="${KOKORO_TIMEOUT:-40}"
CONVERT_TIMEOUT="${CONVERT_TIMEOUT:-10}"
TTS_BUDGET_MARGIN_SECONDS="${TTS_BUDGET_MARGIN_SECONDS:-25}"

tts_budget_seconds() {
  printf '%s' "$((KOKORO_SERVER_TIMEOUT + KOKORO_TIMEOUT + CONVERT_TIMEOUT))"
}
tts_provider_timeout_ms() {
  printf '%s' "$(( ($(tts_budget_seconds) + TTS_BUDGET_MARGIN_SECONDS) * 1000 ))"
}

FFMPEG_BIN="${FFMPEG_BIN:-ffmpeg}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

REASONS=()
note() { REASONS+=("$1"); }

# ── Voice catalogue ─────────────────────────────────────────────────────────
# One name per voice the box offers, mapped onto what Kokoro calls it. The
# OpenAI-style aliases (alloy, onyx, ...) are here so a caller configured for
# the cloud voice keeps working when the box speaks for itself.
#
# Every voice in this table has a Kokoro voice behind it. There is no
# Bulgarian entry: Kokoro has no Bulgarian voice (TASK-382), the Piper voice
# that used to stand in for it went with Piper, and listing a voice no engine
# can speak would only turn `--set-voice` into a way of muting the box. The
# empty mapping in kokoro_voice_for is kept as a guard for exactly that shape
# of mistake, and try_kokoro turns it into a stated reason rather than a
# mispronounced English rendering.

kokoro_voice_for() {
  case "$1" in
    af_heart|alloy|echo|fable|nova|shimmer) printf 'af_heart' ;;
    am_michael|onyx) printf 'am_michael' ;;
    af_bella) printf 'af_bella' ;;
    am_adam) printf 'am_adam' ;;
    bf_emma) printf 'bf_emma' ;;
    bm_george) printf 'bm_george' ;;
    *) printf '' ;;
  esac
}

is_known_voice() {
  case "$1" in
    af_heart|alloy|echo|fable|nova|shimmer|am_michael|onyx|af_bella|am_adam|bf_emma|bm_george) return 0 ;;
    *) return 1 ;;
  esac
}

list_voices() {
  echo "af_heart am_michael af_bella am_adam bf_emma bm_george"
}

# ── Voice selection ─────────────────────────────────────────────────────────
# Resolution order: --voice > $CLAWBOX_TTS_VOICE > saved file > built-in.
#
# Why it is shaped like this. OpenClaw's tts-local-cli provider passes the
# command exactly four placeholders — {{Text}}, {{OutputPath}}, {{OutputDir}},
# {{OutputBase}} — and there is no {{Voice}} among them, so choosing the voice
# is this script's job and not the caller's. OpenClaw also has no per-sender
# config layer: resolveEffectiveTtsConfig merges messages.tts with, in
# increasing precedence, agents.list[].tts, channels.<id>.tts and
# channels.<id>.accounts.<acct>.tts. Those account/channel scopes ARE the
# per-user identity the platform exposes, and both of the levers they can set
# reach us here:
#
#   channels.<id>.accounts.<acct>.tts.providers["tts-local-cli"].args
#     -> [..., "--voice", "bm_george", ...]
#   ...same path... .env -> { "CLAWBOX_TTS_VOICE": "bm_george" }
#
# The saved file is therefore the DEVICE default (this command always runs as
# the gateway's own user, so $HOME is not a per-person boundary here) and
# `--set-voice` is how the owner changes it without editing JSON.

read_saved_voice() {
  [ -r "$CLAWBOX_TTS_VOICE_FILE" ] || return 0
  tr -d '[:space:]' < "$CLAWBOX_TTS_VOICE_FILE" 2>/dev/null | head -c 64
}

save_voice() {
  local voice="$1"
  if ! is_known_voice "$voice"; then
    echo "clawbox-tts: unknown voice '$voice'. Known voices: $(list_voices)" >&2
    return 1
  fi
  mkdir -p "$(dirname "$CLAWBOX_TTS_VOICE_FILE")" 2>/dev/null || true
  printf '%s\n' "$voice" > "$CLAWBOX_TTS_VOICE_FILE" || {
    echo "clawbox-tts: could not write $CLAWBOX_TTS_VOICE_FILE" >&2
    return 1
  }
  echo "$voice"
}

# An unknown or unreadable preference must never be the reason a box goes
# silent, so it degrades to the default with a note rather than failing.
resolve_voice() {
  local requested="$1"
  if [ -z "$requested" ]; then
    requested="${CLAWBOX_TTS_VOICE:-}"
  fi
  if [ -z "$requested" ]; then
    requested="$(read_saved_voice)"
  fi
  if [ -z "$requested" ]; then
    printf '%s' "$CLAWBOX_TTS_DEFAULT_VOICE"
    return 0
  fi
  if ! is_known_voice "$requested"; then
    echo "clawbox-tts: unknown voice '$requested', using default '$CLAWBOX_TTS_DEFAULT_VOICE'" >&2
    printf '%s' "$CLAWBOX_TTS_DEFAULT_VOICE"
    return 0
  fi
  printf '%s' "$requested"
}

# ── Memory guard ────────────────────────────────────────────────────────────

available_mb() {
  local kb
  kb=$(awk '/^MemAvailable:/ {print $2; exit}' "$CLAWBOX_TTS_MEMINFO" 2>/dev/null)
  if [ -z "$kb" ]; then
    # No MemAvailable to read: on a Jetson that means something is wrong with
    # /proc, and guessing "plenty" is how the OOM killer gets invited in.
    printf '0'
    return 0
  fi
  printf '%s' "$((kb / 1024))"
}

# ── Output encoding ─────────────────────────────────────────────────────────
# Kokoro produces WAV natively, so the default configured outputFormat is wav
# and the common path needs no ffmpeg at all. Only a non-WAV destination pulls
# ffmpeg in, and if it is missing that counts as the run failing — writing WAV
# bytes into a file called .mp3 is exactly the "broken audio" outcome this
# script exists to avoid, and a stated failure lets the cloud voice answer.

# Reasons go through note(), never through stdout: this script's stdout is the
# output path and nothing else.
emit() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")" 2>/dev/null || true
  case "${dst,,}" in
    *.mp3)
      if ! command -v "$FFMPEG_BIN" >/dev/null 2>&1; then
        note "output: ffmpeg not available to encode .mp3 (audio was synthesised, but writing WAV bytes into an .mp3 would be broken audio)"
        return 1
      fi
      if ! timeout "$CONVERT_TIMEOUT" "$FFMPEG_BIN" -y -i "$src" -codec:a libmp3lame -b:a 128k -ar 24000 "$dst" >/dev/null 2>&1; then
        # ffmpeg -y can leave a truncated file at $dst when it dies partway.
        # Handing a consumer corrupt audio is the failure this script exists
        # to prevent, so the partial file goes with the error.
        rm -f "$dst"
        note "output: ffmpeg failed to encode .mp3"
        return 1
      fi
      ;;
    *.ogg|*.opus)
      if ! command -v "$FFMPEG_BIN" >/dev/null 2>&1; then
        note "output: ffmpeg not available to encode Opus"
        return 1
      fi
      if ! timeout "$CONVERT_TIMEOUT" "$FFMPEG_BIN" -y -i "$src" -codec:a libopus -b:a 64k -ar 48000 -ac 1 "$dst" >/dev/null 2>&1; then
        rm -f "$dst"
        note "output: ffmpeg failed to encode Opus"
        return 1
      fi
      ;;
    *)
      cp -f "$src" "$dst" || {
        note "output: could not write $dst"
        return 1
      }
      ;;
  esac
  if [ ! -s "$dst" ]; then
    note "output: $dst was written empty"
    rm -f "$dst"
    return 1
  fi
  return 0
}

audio_ok() {
  local f="$1" size
  [ -f "$f" ] || return 1
  size=$(wc -c < "$f" 2>/dev/null || echo 0)
  [ "$size" -ge "$CLAWBOX_TTS_MIN_AUDIO_BYTES" ]
}

# ── Kokoro (CUDA) ───────────────────────────────────────────────────────────

kokoro_via_server() {
  local text="$1" wav="$2" voice="$3"
  [ -S "$KOKORO_SOCKET" ] || return 1
  command -v "$PYTHON_BIN" >/dev/null 2>&1 || return 1
  # Text goes through the environment, never through the shell or the argv of
  # an interpreter, so an utterance containing quotes cannot become code.
  KOKORO_TEXT="$text" KOKORO_OUTPUT="$wav" KOKORO_SOCKET="$KOKORO_SOCKET" KOKORO_VOICE="$voice" \
    KOKORO_SERVER_TIMEOUT="$KOKORO_SERVER_TIMEOUT" LD_LIBRARY_PATH="$KOKORO_LD_PATH" \
    timeout "$KOKORO_SERVER_TIMEOUT" "$PYTHON_BIN" -c '
import json, os, socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(float(os.environ.get("KOKORO_SERVER_TIMEOUT", "10")))
try:
    s.connect(os.environ["KOKORO_SOCKET"])
    s.sendall(json.dumps({
        "text": os.environ["KOKORO_TEXT"],
        "output": os.environ["KOKORO_OUTPUT"],
        "voice": os.environ["KOKORO_VOICE"],
    }).encode())
    s.shutdown(socket.SHUT_WR)
    resp = s.recv(4096).decode("utf-8", "replace")
finally:
    s.close()
if not resp.startswith("OK"):
    sys.stderr.write(resp[:300])
    sys.exit(1)
' 2>/dev/null || return 1
  return 0
}

# Kokoro voice ids are <lang><gender>_<name>: af_heart and am_michael are
# American ("a"), bf_emma and bm_george are British ("b"). Passing -l a for a
# British voice does not fail — kokoro warns "Language mismatch, loading
# <voice> into <language> pipeline" and carries on — so the only symptom is
# the wrong G2P and mispronounced output. Derive it instead of hardcoding it,
# so a voice added to the table above cannot silently inherit "a".
kokoro_lang_of() { printf '%s' "${1:0:1}"; }

kokoro_cold_start() {
  local text="$1" wav="$2" voice="$3" lang
  command -v "$KOKORO_BIN" >/dev/null 2>&1 || return 1
  lang="$(kokoro_lang_of "$voice")"
  LD_LIBRARY_PATH="$KOKORO_LD_PATH" \
    timeout "$KOKORO_TIMEOUT" "$KOKORO_BIN" -t "$text" -o "$wav" -m "$voice" -l "$lang" >/dev/null 2>&1 || return 1
  return 0
}

try_kokoro() {
  local text="$1" wav="$2" voice="$3" kvoice avail
  kvoice="$(kokoro_voice_for "$voice")"
  if [ -z "$kvoice" ]; then
    note "kokoro: no Kokoro voice is mapped for '$voice'"
    return 1
  fi

  avail="$(available_mb)"
  if [ "$avail" -lt "$CLAWBOX_TTS_MIN_FREE_MB" ]; then
    note "kokoro: skipped, ${avail}MB available and the CUDA path peaks at ~2.6GB (need >=${CLAWBOX_TTS_MIN_FREE_MB}MB)"
    return 1
  fi

  if kokoro_via_server "$text" "$wav" "$kvoice"; then
    if audio_ok "$wav"; then
      ENGINE_USED="kokoro-server"
      return 0
    fi
    note "kokoro: server returned OK but produced no audio"
    rm -f "$wav"
  elif [ -S "$KOKORO_SOCKET" ]; then
    note "kokoro: persistent server at $KOKORO_SOCKET refused the request"
  fi

  if kokoro_cold_start "$text" "$wav" "$kvoice"; then
    if audio_ok "$wav"; then
      ENGINE_USED="kokoro-cold"
      return 0
    fi
    note "kokoro: cold start produced no audio"
    rm -f "$wav"
    return 1
  fi

  if command -v "$KOKORO_BIN" >/dev/null 2>&1; then
    note "kokoro: '$KOKORO_BIN' failed (CUDA unavailable, allocation refused, or model missing)"
  elif [ -n "$KOKORO_UNRESOLVED" ]; then
    # Says where it looked, because "not installed" was the message a box
    # printed while the engine was installed and working two directories away.
    note "kokoro: '$KOKORO_BIN' is not installed (not on PATH, and nothing executable at $KOKORO_USER_BIN)"
  else
    note "kokoro: '$KOKORO_BIN' is not installed"
  fi
  return 1
}

# ── EMAIL: directives are for a chat, not for a voice ───────────────────────
# `EMAIL:4471` is how the agent tells a ClawBox CHAT that its reply refers to a
# message the owner can open: chat-email-refs.ts lifts the line out and the
# bubble shows a card instead of the id. Speech has no cards. Both editions hand
# this script the reply text with the directive still in it — OpenClaw as
# `{{Text}}` in argv (install.sh step_openclaw_tts), Hermes through
# --text-file — so without this the box says "EMAIL four four seven one" after
# the summary. That is TASK-697's local-voice half.
#
# NOT A SECOND GRAMMAR. The rule lives in the plugin module the Hermes hook
# already uses, and this calls it: one file, two consumers, and the parity test
# pins it to the chat's own parser. python3 is not a new dependency here —
# `kokoro` IS a Python entry point, so a box where this cannot run is a box that
# cannot speak anyway.
#
# FAILS OPEN, LOUDLY. A missing parser or a failed call speaks the reply as it
# arrived and says so on stderr: a directive read aloud is a blemish, a silent
# box is the failure this whole script exists to prevent.
# TWO PLACES TO LOOK, because there are two copies of THIS file. Both harnesses
# register the CHECKOUT's copy as the provider command
# ("$PROJECT_DIR/scripts/openclaw/clawbox-tts.sh" — install.sh step_openclaw_tts,
# and the Hermes `clawbox-local` provider defined beside it), while
# install-voice.sh's deploy_voice_scripts ALSO drops a copy into the agent's
# workspace at $WORKSPACE/scripts/openclaw/. Resolving only against this file's
# own directory would leave that second copy speaking the id — and, because the
# strip fails open, it would do so silently.
resolve_email_directives_dir() {
  local d
  for d in "$(dirname "${BASH_SOURCE[0]}")/../hermes-plugins/clawbox_email_directives" \
           "${CLAWBOX_ROOT:-/home/clawbox/clawbox}/scripts/hermes-plugins/clawbox_email_directives"; do
    if [ -r "$d/email_directives.py" ]; then
      (cd "$d" && pwd) && return 0
    fi
  done
  printf ''
}
EMAIL_DIRECTIVES_DIR="${EMAIL_DIRECTIVES_DIR:-$(resolve_email_directives_dir)}"
EMAIL_DIRECTIVES_TIMEOUT="${EMAIL_DIRECTIVES_TIMEOUT:-10}"
# Validated for the same reason register-mcp.sh validates HERMES_CLI_TIMEOUT,
# and with a worse consequence here. `${:-10}` substitutes on unset and empty
# and on nothing else, so a value already in the environment is used as given:
# `timeout 0` (and "00") means NO timeout, and a non-numeric duration makes
# `timeout` exit 125 WITHOUT ever running python — the strip then fails open and
# the box READS THE UID ALOUD, which is the whole defect this file was changed
# to remove. The glob rejects a non-digit value; the arithmetic test rejects
# every spelling of zero and a value too large for an integer.
case "$EMAIL_DIRECTIVES_TIMEOUT" in
  ''|*[!0-9]*) EMAIL_DIRECTIVES_TIMEOUT=10 ;;
esac
[ "$EMAIL_DIRECTIVES_TIMEOUT" -gt 0 ] 2>/dev/null || EMAIL_DIRECTIVES_TIMEOUT=10

strip_email_directives() {
  local text="$1" out
  if [ -z "$EMAIL_DIRECTIVES_DIR" ] || [ ! -r "$EMAIL_DIRECTIVES_DIR/email_directives.py" ]; then
    echo "clawbox-tts: no EMAIL: directive parser at '${EMAIL_DIRECTIVES_DIR:-<unresolved>}' — speaking the reply as it arrived" >&2
    printf '%s' "$text"
    return 0
  fi
  # The reply travels in the environment, never in argv or a shell string: it is
  # model output, it can be long, and this is the same rule kokoro_via_server
  # already follows.
  # `-k 5` for the same reason as the two `hermes` calls in register-mcp.sh:
  # plain `timeout` sends SIGTERM only, and this is a command substitution, so a
  # child that ignores it keeps the pipe open and bash blocks reading it until
  # the survivor dies — the ceiling would not be one. A `python3` started here
  # dies on SIGTERM, so the grace is a guard against the interpreter wedging
  # rather than a path anything takes today.
  if ! out=$(CLAWBOX_TTS_RAW_TEXT="$text" timeout -k 5 "$EMAIL_DIRECTIVES_TIMEOUT" "$PYTHON_BIN" -c '
import os, sys
sys.path.insert(0, sys.argv[1])
from email_directives import strip_email_directives
sys.stdout.write(strip_email_directives(os.environ["CLAWBOX_TTS_RAW_TEXT"]))
# The sentinel is what survives `$(…)`, which strips every trailing newline
# from what it captures. Removing exactly one trailing X is safe even when
# the reply itself ends in one, because exactly one was added.
sys.stdout.write("X")
' "$EMAIL_DIRECTIVES_DIR" 2>/dev/null); then
    echo "clawbox-tts: could not strip EMAIL: directives — speaking the reply as it arrived" >&2
    printf '%s' "$text"
    return 0
  fi
  printf '%s' "${out%X}"
}

# ── Entry ───────────────────────────────────────────────────────────────────

# Refuse an option that was handed no value, rather than looping on it.
need_value() {
  if [ "$2" -lt 2 ]; then
    echo "clawbox-tts: $1 requires a value" >&2
    usage
    exit 2
  fi
}

usage() {
  cat >&2 <<USAGE
Usage: clawbox-tts.sh [--voice <voice>] <text> <output-path>
       clawbox-tts.sh [--voice <voice>] --text-file <path> -- <output-path>
       clawbox-tts.sh --set-voice <voice>
       clawbox-tts.sh --get-voice
       clawbox-tts.sh --list-voices
       clawbox-tts.sh --budget-seconds       # worst-case engine-chain seconds
       clawbox-tts.sh --provider-timeout-ms  # what the caller's timeout must be
Voices: $(list_voices)
USAGE
}

REQUESTED_VOICE=""
TEXT_FILE=""
ENGINE_USED=""
ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --voice)
      # `shift 2` with only one argument left does NOT shift — it returns
      # non-zero and leaves $@ untouched. Swallowing that with `|| true` left
      # $1 as --voice forever and span this loop on a core until the caller's
      # timeout killed it. Every option that takes a value checks for it.
      need_value "--voice" "$#"
      REQUESTED_VOICE="$2"; shift 2 ;;
    --voice=*)
      REQUESTED_VOICE="${1#--voice=}"; shift ;;
    --text-file)
      # Same guard as --voice, for the same reason: a `shift 2` with one
      # argument left does not shift, and swallowing that spins this loop.
      need_value "--text-file" "$#"
      TEXT_FILE="$2"; shift 2 ;;
    --text-file=*)
      TEXT_FILE="${1#--text-file=}"; shift ;;
    --set-voice)
      need_value "--set-voice" "$#"
      save_voice "$2"; exit $? ;;
    --get-voice)
      resolve_voice ""; echo; exit 0 ;;
    --list-voices)
      list_voices; exit 0 ;;
    --budget-seconds)
      tts_budget_seconds; echo; exit 0 ;;
    --provider-timeout-ms)
      tts_provider_timeout_ms; echo; exit 0 ;;
    -h|--help)
      usage; exit 0 ;;
    --)
      shift; while [ $# -gt 0 ]; do ARGS+=("$1"); shift; done ;;
    *)
      ARGS+=("$1"); shift ;;
  esac
done

# ── Where the text comes from ───────────────────────────────────────────────
# Two forms, and never both at once:
#
#   [--voice <v>] <text> <output-path>                the OpenClaw provider's
#                                                     form, unchanged.
#   [--voice <v>] --text-file <path> -- <output-path> the Hermes form.
#
# Hermes' native TTS block (`tts.providers.<name>` with `type: command`)
# substitutes {input_path} with a FILE HOLDING THE TEXT — not with the text —
# and the command string it builds is then interpreted by a shell. Reading that
# file HERE is what keeps both of those from becoming a problem: routing it back
# through `"$(cat …)"` inside the provider command string would re-expand a
# model-controlled string inside a shell, and would hand a long reply to
# execve() until it hit ARG_MAX. The file is read once, by this script, and its
# contents are never re-parsed by anything.
#
# Purely additive: with no --text-file, everything below this block behaves
# exactly as it did, because the OpenClaw edition's provider depends on it.
if [ -n "$TEXT_FILE" ]; then
  # Refused rather than silently resolved: a caller that passed both a file and
  # positional text does not agree with itself about what the box should say,
  # and guessing is how the wrong sentence gets spoken.
  if [ "${#ARGS[@]}" -ne 1 ]; then
    echo "clawbox-tts: --text-file takes the output path as its only positional argument (got ${#ARGS[@]}) — pass the text in the file or as an argument, never both" >&2
    usage
    exit 2
  fi
  # A missing or unreadable file must never fall through to an empty string: a
  # run that exits 0 with no audio is indistinguishable from a working TTS to
  # everything upstream, and that silent success is the failure this whole
  # script exists to prevent.
  if [ ! -r "$TEXT_FILE" ]; then
    echo "clawbox-tts: --text-file $TEXT_FILE is missing or unreadable — refusing to speak an empty string" >&2
    exit 2
  fi
  if ! TEXT="$(cat -- "$TEXT_FILE")"; then
    echo "clawbox-tts: --text-file $TEXT_FILE could not be read — refusing to speak an empty string" >&2
    exit 2
  fi
  OUTPUT="${ARGS[0]}"
else
  if [ "${#ARGS[@]}" -lt 2 ]; then
    usage
    exit 2
  fi
  TEXT="${ARGS[0]}"
  OUTPUT="${ARGS[1]}"
fi

# Only a reply that carries the marker pays for the strip, so the ordinary
# reply's bytes reach the engine exactly as they did before this existed —
# `$(…)` would otherwise eat a trailing newline off every utterance on the box.
#
# The sentinel extends that to a reply which merely MENTIONS an address: the
# parser now returns such a reply untouched (it removed no line), and this is
# what stops `$(…)` reshaping it anyway. Same rule in all four places that
# understand the grammar — a reply is changed only when a directive was taken
# out of it.
case "$TEXT" in
  *[Ee][Mm][Aa][Ii][Ll]:*)
    TEXT_BEFORE_STRIP="$TEXT"
    TEXT="$(strip_email_directives "$TEXT"; printf X)"
    TEXT="${TEXT%X}"
    ;;
esac

if [ -z "$TEXT" ]; then
  # Named by its source: "empty text" over a --text-file that exists and is
  # empty sends the operator looking at the wrong end of the call.
  if [ -n "${TEXT_BEFORE_STRIP:-}" ]; then
    # A reply that was NOTHING but directives. Exiting non-zero rather than
    # synthesising silence, for the reason at the bottom of this file: a run
    # that exits 0 with no audio is indistinguishable from a working TTS to
    # everything upstream. The gateway's cloud voice answers instead, and it
    # gets the same nothing to say.
    echo "clawbox-tts: the reply was only EMAIL: card directives — nothing left to speak" >&2
  elif [ -n "$TEXT_FILE" ]; then
    echo "clawbox-tts: --text-file $TEXT_FILE is empty — refusing to speak nothing" >&2
  else
    echo "clawbox-tts: empty text" >&2
  fi
  exit 2
fi

VOICE="$(resolve_voice "$REQUESTED_VOICE")"

TMPWAV="$(mktemp "${TMPDIR:-/tmp}/clawbox-tts_XXXXXX.wav")"
trap 'rm -f "$TMPWAV"' EXIT

if try_kokoro "$TEXT" "$TMPWAV" "$VOICE"; then
  if emit "$TMPWAV" "$OUTPUT"; then
    echo "$OUTPUT"
    exit 0
  fi
  note "output: could not write $OUTPUT from $ENGINE_USED audio"
fi

# Never exit 0 without audio: a silent success is indistinguishable from a
# working TTS to everything upstream, which is the bug this file replaced.
# There is no engine to try after Kokoro, on purpose (see the header): the
# reasons go to stderr, OpenClaw logs them as `CLI TTS exit 1: <stderr>`, and
# its fallback provider — the cloud voice — answers the reply instead.
{
  echo "clawbox-tts: Kokoro could not speak this text (voice '$VOICE') — no on-device fallback, the gateway's cloud voice takes over."
  for r in "${REASONS[@]}"; do
    echo "  - $r"
  done
  echo "  Check the Kokoro install with: sudo bash ${CLAWBOX_ROOT:-/home/clawbox/clawbox}/install.sh --step openclaw_tts"
} >&2
exit 1
