#!/usr/bin/env bash
# timeout: 900
#
# GNOME's first-run assistant does not run for the clawbox user after boot.
# The GNOME session starts it for any user without
# ~/.config/gnome-initial-setup-done, and nothing on a ClawBox wrote that file,
# so every board kept it resident at 120-170 MB RSS. install.sh's
# step_gnome_initial_setup_done writes it on every full install and in-app
# update (step_post_update).
#
#   * No GNOME session for clawbox (the desktop is off on this board): skipped.
#   * The marker is missing, or newer than this boot (the session started
#     without it): the step is run from the board's own checkout, which is the
#     commit under test, as clawbox, the user it writes as. `nano-ci rebuild` is
#     force-update.sh, which runs no install.sh step, so this is how the change
#     reaches the board. The step must write "yes" and end the assistant the
#     running session started. Then the board reboots the way 75-full-reboot
#     does it.
#   * After a boot that started with the marker in place, once the clawbox
#     GNOME session has been up 90 s (its autostart has fired by then): the
#     marker is clawbox's and holds "yes", and pgrep finds no
#     gnome-initial-setup process for clawbox.
#
# The marker stays: it is the state the shipped step leaves on every box.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# Answer: "session <gnome-shell pid|none>", "marker <missing|before-boot|after-boot>",
# "boot <boot id>".
# shellcheck disable=SC2016  # expanded on the board
BEFORE=$(board '
  echo "session $(pgrep -u "$(id -u)" -x gnome-shell | head -n 1 | grep . || echo none)"
  m="$HOME/.config/gnome-initial-setup-done"
  btime=$(awk "\$1 == \"btime\" {print \$2}" /proc/stat)
  if [ ! -e "$m" ]; then
    echo "marker missing"
  elif [ "$(stat -c %Y "$m")" -lt "$btime" ]; then
    echo "marker before-boot"
  else
    echo "marker after-boot"
  fi
  echo "boot $(cat /proc/sys/kernel/random/boot_id)"
')
SESSION=$(sed -n 's/^session //p' <<<"$BEFORE" | tail -n 1)
MARKER=$(sed -n 's/^marker //p' <<<"$BEFORE" | tail -n 1)
BOOT0=$(sed -n 's/^boot //p' <<<"$BEFORE" | tail -n 1)
if [ -z "$SESSION" ] || [ -z "$MARKER" ] || [ -z "$BOOT0" ]; then
  not_ok "could not read the board's desktop session, marker and boot id"
  finish
fi
if [ "$SESSION" = none ]; then
  skip "no GNOME session for clawbox on this board (desktop off)"
  finish
fi
note "marker before this test: $MARKER"

if [ "$MARKER" != before-boot ]; then
  if [ "$MARKER" = missing ]; then
    # The step's own body, as install.sh ships it. `as_clawbox` is `sudo -u
    # clawbox` there; this already runs as clawbox. The assistant's process is
    # matched below with a bracket, so this script's own argv cannot match.
    # shellcheck disable=SC2016  # expanded on the board
    STEP=$(board '
      fn=$(sed -n "/^step_gnome_initial_setup_done() {\$/,/^}\$/p" "$REPO/install.sh")
      if [ -z "$fn" ]; then echo "result no-step"; exit 0; fi
      CLAWBOX_USER=$(id -un)
      CLAWBOX_HOME=$HOME
      as_clawbox() { "$@"; }
      eval "$fn"
      step_gnome_initial_setup_done >/dev/null 2>&1
      echo "result $?"
      printf "content %s\n" "$(cat "$HOME/.config/gnome-initial-setup-done" 2>/dev/null)"
      sleep 3
      echo "assistant $(pgrep -u "$(id -u)" -f "gnome-initial-[s]etup( |\$)" | tr "\n" " ")"
    ')
    RESULT=$(sed -n 's/^result //p' <<<"$STEP" | tail -n 1)
    CONTENT=$(sed -n 's/^content //p' <<<"$STEP" | tail -n 1)
    LEFT=$(sed -n 's/^assistant //p' <<<"$STEP" | tail -n 1 | tr -d '[:space:]')
    case "$RESULT" in
      0) ok "step_gnome_initial_setup_done ran from the checkout" ;;
      no-step) not_ok "the board's install.sh has no step_gnome_initial_setup_done"; finish ;;
      *) not_ok "step_gnome_initial_setup_done answered ${RESULT:-nothing}"; finish ;;
    esac
    if [ "$CONTENT" = yes ]; then ok "the step wrote the marker with \"yes\""; else not_ok "the marker holds \"$CONTENT\", not \"yes\""; fi
    if [ -z "$LEFT" ]; then
      ok "no first-run assistant left running in the current session"
    else
      not_ok "the first-run assistant still runs after the step (pid $LEFT)"
    fi
  fi

  START=$(date +%s)
  # Detached, so the ssh session returns before the box tears it down.
  # shellcheck disable=SC2016  # expanded on the board
  if board 'nohup bash -c "sleep 2; sudo -n /usr/bin/systemctl reboot" >/dev/null 2>&1 & echo dispatched' | grep -q dispatched; then
    note "reboot dispatched, so the next session starts with the marker in place"
  else
    not_ok "could not dispatch the reboot"
    finish
  fi
  BOOT1=""
  while [ $(( $(date +%s) - START )) -lt 360 ]; do
    sleep 10
    BOOT1=$(board 'cat /proc/sys/kernel/random/boot_id' 2>/dev/null | tail -n 1 | tr -d '[:space:]')
    [ -n "$BOOT1" ] && [ "$BOOT1" != "$BOOT0" ] && break
    BOOT1=""
  done
  if [ -z "$BOOT1" ]; then
    not_ok "the board did not come back with a new boot id within 6 min"
    finish
  fi
  ok "board back after a real reboot ($(( $(date +%s) - START ))s to answer ssh)"
fi

# Wait up to 2 min for the clawbox GNOME session, then until it is 90 s old:
# the autostart that starts the assistant runs as the session comes up.
# Answer: "session <none|seconds up>", "marker <owner> <content>" or
# "marker missing", "assistant <pid + command line; …>".
# shellcheck disable=SC2016  # expanded on the board
AFTER=$(board '
  uid=$(id -u)
  shell=""
  for _ in $(seq 1 24); do
    shell=$(pgrep -u "$uid" -x gnome-shell | head -n 1)
    [ -n "$shell" ] && break
    sleep 5
  done
  if [ -z "$shell" ]; then echo "session none"; exit 0; fi
  age=$(ps -o etimes= -p "$shell" | tr -d " ")
  [ "${age:-0}" -lt 90 ] && sleep $(( 90 - ${age:-0} ))
  echo "session $(ps -o etimes= -p "$shell" | tr -d " ")"
  m="$HOME/.config/gnome-initial-setup-done"
  if [ -f "$m" ]; then echo "marker $(stat -c %U "$m") $(cat "$m")"; else echo "marker missing"; fi
  echo "assistant $(pgrep -u "$uid" -af "gnome-initial-[s]etup( |\$)" | tr "\n" ";")"
')
# Both verdicts must be answered: a board that said nothing here (an ssh hop
# lost right after the reboot) would otherwise pass on the oks printed above.
SAW_MARKER=0
SAW_ASSISTANT=0
while read -r kind a b; do
  case "$kind" in
    session)
      if [ "$a" = none ]; then
        not_ok "no GNOME session for clawbox 2 min after boot (there was one before)"
        finish
      fi
      note "clawbox GNOME session up ${a}s" ;;
    marker)
      SAW_MARKER=1
      if [ "$a" = missing ]; then
        not_ok "~/.config/gnome-initial-setup-done is missing after boot"
      elif [ "$a" = clawbox ] && [ "$b" = yes ]; then
        ok "~/.config/gnome-initial-setup-done is clawbox's and holds \"yes\""
      else
        not_ok "~/.config/gnome-initial-setup-done is ${a}'s and holds \"$b\""
      fi ;;
    assistant)
      SAW_ASSISTANT=1
      if [ -z "$a" ]; then
        ok "no gnome-initial-setup process for clawbox after boot"
      else
        not_ok "gnome-initial-setup runs for clawbox after boot: $a $b"
      fi ;;
  esac
done <<<"$AFTER"
[ "$SAW_MARKER" = 1 ] || not_ok "the board did not report the marker after boot"
[ "$SAW_ASSISTANT" = 1 ] || not_ok "the board did not report its gnome-initial-setup processes after boot"

# Leave the board ready for the tests after this one; 75-full-reboot owns the
# boot-time readiness verdict, so this is a note, not a result.
if [ -n "${START:-}" ] && ! wait_gateway_settled 180; then
  note "gateway not settled 180 s after the session check: ${SETTLE_STATE:-unknown}"
fi
finish
