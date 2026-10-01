#!/usr/bin/env bash
# timeout: 600
#
# The media tools a coding run is given, on the real box: when the coding
# agent's status reports generateImages on, one run is asked to draw a picture
# with its generate_image tool and must leave a non-trivial PNG on disk; when
# only generateAudio is on, the same with generate_audio and a clip. The run
# record's mediaGenerated counter must show the tool was actually used — a PNG
# drawn by a script the run wrote would pass the file checks and prove nothing.
# SKIP when both switches are off. Same route pattern as 40-coding-agent-run.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

board_api GET /setup-api/coding-agent/status
if [ "$API_STATUS" != 200 ]; then
  not_ok "coding-agent status did not answer: $(api_error)"
  finish
fi
IMAGES=$(api_json '.generateImages')
AUDIO=$(api_json '.generateAudio')
note "status: $(api_json -c '{enabled, ready, generateImages, generateAudio}')"
if [ "$IMAGES" = true ]; then
  KIND=images
  FILE=nano-ci.png
  TASK="Use your generate_image tool to draw a simple picture of a red circle on a white background, size 256, and save it as $FILE in the current working folder. Do not draw it any other way (no script, no SVG, no image library): if the tool is not available or refuses, say so and stop. Do not create any other file."
elif [ "$AUDIO" = true ]; then
  KIND=audio
  FILE=nano-ci.wav
  TASK="Use your generate_audio tool to speak the sentence \"Nano CI audio check.\" and save it as $FILE in the current working folder (if the tool answers in another format, keep the extension it gives). Do not make the clip any other way: if the tool is not available or refuses, say so and stop. Do not create any other file."
else
  skip "the coding agent's generateImages and generateAudio are both off on this board"
  finish
fi
if [ "$(api_json '.ready')" != true ]; then
  not_ok "generate${KIND^} is on but the coding agent cannot start a run (enabled=$(api_json '.enabled'), ready=false)"
  finish
fi

if ! fresh_project_dir "-media"; then
  not_ok "could not create $PROJECT_DIR on the board"
  finish
fi

if ! start_coding_run "$TASK"; then
  not_ok "the $KIND run did not start: $(api_error)"
  remove_project_dir
  finish
fi
ok "$KIND run $RUN_ID started in $PROJECT_DIR"

wait_coding_run 540
expect_completed
USED=$(api_json ".run.mediaGenerated.$KIND // 0")
if [ "${USED:-0}" -ge 1 ] 2>/dev/null; then
  ok "the run used the $KIND tool ($USED generated)"
else
  not_ok "the run's mediaGenerated.$KIND is ${USED:-missing}: the tool was never used"
fi

# The file: magic bytes, size, and for a PNG its IHDR dimensions.
# Answer: "<name> <bytes> <magic hex> <width> <height>", or "none".
# shellcheck disable=SC2016  # expanded on the board
FOUND=$(board '
  ls -la "$1" >&2
  f=$(ls -1 "$1" 2>/dev/null | grep -m 1 "^${2%.*}\.") || { echo "none"; exit 0; }
  p=$1/$f
  magic=$(head -c 8 "$p" | od -An -tx1 | tr -d " \n")
  w=$(od -An -tu4 --endian=big -j 16 -N 4 "$p" 2>/dev/null | tr -d " ")
  h=$(od -An -tu4 --endian=big -j 20 -N 4 "$p" 2>/dev/null | tr -d " ")
  echo "$f $(stat -c %s "$p") $magic ${w:-0} ${h:-0}"
' "$PROJECT_DIR" "$FILE")
read -r NAME BYTES MAGIC WIDTH HEIGHT <<<"$FOUND"

if [ "${NAME:-none}" = none ]; then
  not_ok "no ${FILE%.*}.* was written to $PROJECT_DIR"
elif [ "$KIND" = images ]; then
  if [ "$MAGIC" != 89504e470d0a1a0a ]; then
    not_ok "$NAME is not a PNG (starts with $MAGIC)"
  elif [ "$BYTES" -lt 4096 ] || [ "$WIDTH" -lt 64 ] || [ "$HEIGHT" -lt 64 ]; then
    not_ok "$NAME is a trivial PNG: $BYTES bytes, ${WIDTH}x$HEIGHT"
  else
    ok "$NAME is a ${WIDTH}x$HEIGHT PNG of $BYTES bytes"
  fi
else
  case "$MAGIC" in
    52494646*|494433*|fff*|4f676753*) is_audio=yes ;; # RIFF, ID3, an MPEG frame, OggS
    *) is_audio=no ;;
  esac
  if [ "$is_audio" != yes ]; then
    not_ok "$NAME is not a WAV, MP3 or Ogg clip (starts with $MAGIC)"
  elif [ "$BYTES" -lt 8192 ]; then
    not_ok "$NAME is a trivial clip: $BYTES bytes"
  else
    ok "$NAME is an audio clip of $BYTES bytes"
  fi
fi

remove_project_dir
finish
