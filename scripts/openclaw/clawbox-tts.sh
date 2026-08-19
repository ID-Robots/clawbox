#!/usr/bin/env bash
# ClawBox on-device text-to-speech — the single entrypoint OpenClaw calls.
#
# Wired in as the `tts-local-cli` provider command by step_openclaw_tts in
# install.sh, so every spoken reply on the box runs through here: no network
# round-trip, no per-character cost.
#
#   clawbox-tts.sh [--voice <voice>] <text> <output-path>
#   clawbox-tts.sh --set-voice <voice>     # persist this user's voice
#   clawbox-tts.sh --get-voice
#
# Engine chain, in order:
#   1. Kokoro on CUDA — the default voice. Talks to the persistent
#      kokoro-server unix socket when it is up (model already resident on the
#      GPU), cold-starts the `kokoro` CLI when it is not.
#   2. Piper on CPU — small, no GPU, always available once installed.
#   3. Non-zero exit, with every reason it got there on stderr.
#
# Degrading rather than dying is the whole point of this file. Until TASK-383
# the box called kokoro-tts.sh, which printed "Kokoro TTS failed" and exited 1:
# a missing model, a busy GPU, or a language Kokoro cannot speak all reached
# the user as silence with no explanation of which one it was.
#
# Why the memory guard (CLAWBOX_TTS_MIN_FREE_MB): TASK-382 measured
# kokoro-torch on CUDA peaking at 2259-2636 MB on an Orin Nano whose 7607 MB is
# SHARED between CPU and GPU. Those numbers came off an idle board; in service
# the agent and faster-whisper are resident too. Trying the allocation anyway
# does not fail politely — it OOM-kills whatever the kernel picks, which on
# this hardware has been the user's own session. So we read MemAvailable first
# and go straight to Piper (136-243 MB) when the headroom is not there.
# The default 3000 MB is the measured 2636 MB peak rounded up, plus room for
# the CUDA context and allocator fragmentation.
#
# NOT `set -e`: this script's job is to keep going when an engine fails.
set -uo pipefail

CLAWBOX_TTS_DEFAULT_VOICE="${CLAWBOX_TTS_DEFAULT_VOICE:-af_heart}"
CLAWBOX_TTS_VOICE_FILE="${CLAWBOX_TTS_VOICE_FILE:-${HOME:-/home/clawbox}/.openclaw/clawbox-tts-voice}"
CLAWBOX_TTS_MIN_FREE_MB="${CLAWBOX_TTS_MIN_FREE_MB:-3000}"
CLAWBOX_TTS_MEMINFO="${CLAWBOX_TTS_MEMINFO:-/proc/meminfo}"
# A WAV that is only a header is "no audio", not audio. 1 KiB is ~20 ms at
# 24 kHz mono 16-bit — below anything a real utterance can be.
CLAWBOX_TTS_MIN_AUDIO_BYTES="${CLAWBOX_TTS_MIN_AUDIO_BYTES:-1024}"

KOKORO_BIN="${KOKORO_BIN:-kokoro}"
KOKORO_SOCKET="${KOKORO_SOCKET:-/tmp/kokoro-server.sock}"
KOKORO_TIMEOUT="${KOKORO_TIMEOUT:-120}"

PIPER_BIN="${PIPER_BIN:-/home/clawbox/.local/share/piper/piper}"
PIPER_VOICE_DIR="${PIPER_VOICE_DIR:-/home/clawbox/.local/share/piper/voices}"
PIPER_TIMEOUT="${PIPER_TIMEOUT:-120}"

FFMPEG_BIN="${FFMPEG_BIN:-ffmpeg}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

REASONS=()
note() { REASONS+=("$1"); }

# ── Voice catalogue ─────────────────────────────────────────────────────────
# One name per voice the box offers, mapped onto whatever each engine calls it.
# An empty Kokoro mapping is not an error — it is the documented way a voice
# says "I cannot be spoken on the GPU path, use the fallback". Bulgarian is
# deferred for this release precisely because Kokoro has no Bulgarian voice
# (TASK-382), and this table is where that fact lives.

kokoro_voice_for() {
  case "$1" in
    af_heart|alloy|echo|fable|nova|shimmer) printf 'af_heart' ;;
    am_michael|onyx) printf 'am_michael' ;;
    af_bella) printf 'af_bella' ;;
    am_adam) printf 'am_adam' ;;
    bf_emma) printf 'bf_emma' ;;
    bm_george) printf 'bm_george' ;;
    bg_dimitar) printf '' ;;
    *) printf '' ;;
  esac
}

piper_voice_for() {
  case "$1" in
    bg_dimitar) printf 'bg_BG-dimitar-medium' ;;
    bf_emma|bm_george) printf 'en_GB-alba-medium' ;;
    *) printf 'en_US-lessac-medium' ;;
  esac
}

# Piper model ids are <lang>_<REGION>-<name>-<quality>, so the language falls
# out of the id and no second table has to be kept in sync with the first. A
# voice added to piper_voice_for above inherits the substitution behaviour
# below for free.
piper_language_of() { printf '%s' "${1%%_*}"; }

# Any installed model for this language, in a deterministic order. Used only
# when the voice's own model is absent.
piper_model_for_language() {
  local lang="$1" f
  for f in "$PIPER_VOICE_DIR/${lang}_"*.onnx; do
    [ -f "$f" ] || continue
    basename "$f" .onnx
    return 0
  done
  return 1
}

is_known_voice() {
  case "$1" in
    af_heart|alloy|echo|fable|nova|shimmer|am_michael|onyx|af_bella|am_adam|bf_emma|bm_george|bg_dimitar) return 0 ;;
    *) return 1 ;;
  esac
}

list_voices() {
  echo "af_heart am_michael af_bella am_adam bf_emma bm_george bg_dimitar"
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
# Both engines produce WAV natively, so the default configured outputFormat is
# wav and the common path needs no ffmpeg at all. Only a non-WAV destination
# pulls ffmpeg in, and if it is missing that counts as this engine failing —
# writing WAV bytes into a file called .mp3 is exactly the "broken audio"
# outcome the fallback chain exists to avoid.

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
      if ! "$FFMPEG_BIN" -y -i "$src" -codec:a libmp3lame -b:a 128k -ar 24000 "$dst" >/dev/null 2>&1; then
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
      if ! "$FFMPEG_BIN" -y -i "$src" -codec:a libopus -b:a 64k -ar 48000 -ac 1 "$dst" >/dev/null 2>&1; then
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
    KOKORO_TIMEOUT="$KOKORO_TIMEOUT" \
    "$PYTHON_BIN" -c '
import json, os, socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(float(os.environ.get("KOKORO_TIMEOUT", "120")))
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
  timeout "$KOKORO_TIMEOUT" "$KOKORO_BIN" -t "$text" -o "$wav" -m "$voice" -l "$lang" >/dev/null 2>&1 || return 1
  return 0
}

try_kokoro() {
  local text="$1" wav="$2" voice="$3" kvoice avail
  kvoice="$(kokoro_voice_for "$voice")"
  if [ -z "$kvoice" ]; then
    note "kokoro: no Kokoro voice for '$voice' (Bulgarian is deferred this release)"
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
  else
    note "kokoro: '$KOKORO_BIN' is not installed"
  fi
  return 1
}

# ── Piper (CPU) ─────────────────────────────────────────────────────────────

try_piper() {
  local text="$1" wav="$2" voice="$3" pvoice model
  pvoice="$(piper_voice_for "$voice")"
  model="$PIPER_VOICE_DIR/$pvoice.onnx"

  if [ ! -x "$PIPER_BIN" ]; then
    note "piper: binary not found at $PIPER_BIN"
    return 1
  fi
  # A voice whose own model is not on disk must not become silence — that is
  # the bug this whole file exists to fix, and it would come back through the
  # voice table rather than through the engines. Two different substitutions,
  # and the difference between them is the whole point:
  #
  #   same language  -> acceptable. en_GB-alba-medium missing, en_US-lessac
  #                     installed: the user hears the right words in a
  #                     slightly different accent, and is told so.
  #   cross language -> refused. Bulgarian read aloud by an English model is
  #                     broken audio, which is worse than no audio.
  if [ ! -f "$model" ]; then
    local lang substitute
    lang="$(piper_language_of "$pvoice")"
    substitute="$(piper_model_for_language "$lang")"
    if [ -z "$substitute" ]; then
      note "piper: no voice model for language '$lang' at $PIPER_VOICE_DIR (wanted $pvoice)"
      return 1
    fi
    echo "clawbox-tts: voice model $pvoice is not installed, speaking '$voice' with $substitute instead" >&2
    pvoice="$substitute"
    model="$PIPER_VOICE_DIR/$pvoice.onnx"
  fi

  local piper_dir
  piper_dir="$(dirname "$PIPER_BIN")"
  # The release tarball ships its own onnxruntime and espeak-ng data next to
  # the binary. An empty entry in LD_LIBRARY_PATH means "the current
  # directory" to the loader, which is not somewhere to resolve .so files.
  local ld="$piper_dir"
  [ -n "${LD_LIBRARY_PATH:-}" ] && ld="$piper_dir:$LD_LIBRARY_PATH"

  if ! printf '%s' "$text" | LD_LIBRARY_PATH="$ld" \
      timeout "$PIPER_TIMEOUT" "$PIPER_BIN" -m "$model" -f "$wav" >/dev/null 2>&1; then
    note "piper: $PIPER_BIN exited non-zero using $pvoice"
    return 1
  fi
  if ! audio_ok "$wav"; then
    note "piper: produced no audio using $pvoice"
    rm -f "$wav"
    return 1
  fi
  ENGINE_USED="piper"
  return 0
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
       clawbox-tts.sh --set-voice <voice>
       clawbox-tts.sh --get-voice
       clawbox-tts.sh --list-voices
Voices: $(list_voices)
USAGE
}

REQUESTED_VOICE=""
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
    --set-voice)
      need_value "--set-voice" "$#"
      save_voice "$2"; exit $? ;;
    --get-voice)
      resolve_voice ""; echo; exit 0 ;;
    --list-voices)
      list_voices; exit 0 ;;
    -h|--help)
      usage; exit 0 ;;
    --)
      shift; while [ $# -gt 0 ]; do ARGS+=("$1"); shift; done ;;
    *)
      ARGS+=("$1"); shift ;;
  esac
done

if [ "${#ARGS[@]}" -lt 2 ]; then
  usage
  exit 2
fi

TEXT="${ARGS[0]}"
OUTPUT="${ARGS[1]}"

if [ -z "$TEXT" ]; then
  echo "clawbox-tts: empty text" >&2
  exit 2
fi

VOICE="$(resolve_voice "$REQUESTED_VOICE")"

TMPWAV="$(mktemp "${TMPDIR:-/tmp}/clawbox-tts_XXXXXX.wav")"
trap 'rm -f "$TMPWAV"' EXIT

if try_kokoro "$TEXT" "$TMPWAV" "$VOICE" || try_piper "$TEXT" "$TMPWAV" "$VOICE"; then
  if emit "$TMPWAV" "$OUTPUT"; then
    # A fallback that leaves no trace is indistinguishable from a healthy GPU
    # path. Say so once, on stderr, so a box quietly living on the CPU engine
    # is visible in the gateway log instead of only in the audio.
    if [ "$ENGINE_USED" = "piper" ] && [ "${#REASONS[@]}" -gt 0 ]; then
      echo "clawbox-tts: fell back to Piper — ${REASONS[*]}" >&2
    fi
    echo "$OUTPUT"
    exit 0
  fi
  note "output: could not write $OUTPUT from $ENGINE_USED audio"
fi

# Never exit 0 without audio: a silent success is indistinguishable from a
# working TTS to everything upstream, which is the bug this file replaces.
{
  echo "clawbox-tts: no engine could speak this text (voice '$VOICE')."
  for r in "${REASONS[@]}"; do
    echo "  - $r"
  done
  echo "  Install Piper with: sudo bash scripts/install-voice.sh --piper-only"
} >&2
exit 1
