#!/usr/bin/env bash
#
# The two things a multi-user ClawBox needs root for at the speed of a person
# — TASK-1256. Creating and removing an account are root STEPS (install.sh's
# step_user_add / step_user_remove, started through clawbox-run-root-step.sh
# like chpasswd); these two cannot wait for a systemd unit:
#
#   verify        Is this ClawBox user's Linux password right? Reads the
#                 username and the password as two lines on STDIN — never on
#                 the command line, where `ps` would show them — and runs
#                 unix_chkpwd as root. The web server runs as the owner, and
#                 unix_chkpwd lets an unprivileged caller check its OWN account
#                 only, which is how the owner's login has always worked.
#                 Exits 0 for a match and 7 (PAM_AUTH_ERR) for everything else.
#
#   shell <user>  The Terminal app for a signed-in ClawBox user: a login shell
#                 AS that user (runuser), in their home folder, with a clean
#                 environment. scripts/terminal-server.mjs runs this inside the
#                 PTY instead of spawning the owner's shell.
#
# Both answer ONLY for a ClawBox user: an ordinary account (uid >= 1000, not
# nobody) that is a member of `clawbox-users` — the group step_user_add puts
# every account it creates in, and nothing else does — and is not in an
# administrator group. So this is neither an oracle for root's or the owner's
# password nor a way to open a shell as anyone who could administer the box.
#
# The username is checked against the same rule as src/lib/username-rules.ts
# and is only ever passed as its own argv element — never through a shell
# string, never through eval.
#
# Usage (root, from the sudoers grant in config/clawbox-sudoers):
#   clawbox-user-helper.sh verify        < "user\npassword\n"
#   clawbox-user-helper.sh shell <user>
#
# Installed by install.sh::install_root_libexec to
# /usr/local/libexec/clawbox/clawbox-user-helper.sh, root:root 0755.

set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

readonly USERS_GROUP="clawbox-users"
readonly UNIX_CHKPWD=/usr/sbin/unix_chkpwd
readonly RUNUSER=/usr/sbin/runuser
readonly PAM_AUTH_ERR=7

if [ "$(id -u)" -ne 0 ]; then
  echo "clawbox-user-helper: must run as root" >&2
  exit 64
fi

# 1-32 characters: the length is tested with ${#…}, never as a `{0,31}` bound
# in the regex (glibc expands bounded repeats into one NFA state per repetition —
# src/tests/unit/shell-regex-hygiene.test.ts).
name_ok() {
  [ "${#1}" -ge 1 ] && [ "${#1}" -le 32 ] && [[ "$1" =~ ^[a-z_][a-z0-9_-]*$ ]]
}

# A short token of the given alphabet: 1-64 characters.
short_token_ok() {
  [ "${#1}" -ge 1 ] && [ "${#1}" -le 64 ] && [[ "$1" =~ $2 ]]
}

# 0 when "$1" names a ClawBox user this helper may act for.
is_clawbox_user() {
  local user="$1" entry uid groups
  name_ok "$user" || return 1
  entry="$(getent passwd "$user")" || return 1
  uid="$(printf '%s\n' "$entry" | cut -d: -f3)"
  [[ "$uid" =~ ^[0-9]+$ ]] || return 1
  [ "$uid" -ge 1000 ] || return 1
  [ "$uid" -ne 65534 ] || return 1
  groups=" $(id -nG "$user" 2>/dev/null || true) "
  case "$groups" in
    *" $USERS_GROUP "*) ;;
    *) return 1 ;;
  esac
  case "$groups" in
    *" sudo "*|*" admin "*|*" wheel "*|*" root "*|*" adm "*) return 1 ;;
  esac
  return 0
}

do_verify() {
  local user="" password=""
  IFS= read -r user || true
  IFS= read -r password || true
  if ! is_clawbox_user "$user" || [ -z "$password" ]; then
    exit "$PAM_AUTH_ERR"
  fi
  local rc=0
  printf '%s\0' "$password" | "$UNIX_CHKPWD" "$user" nonull || rc=$?
  if [ "$rc" -eq 0 ]; then
    exit 0
  fi
  exit "$PAM_AUTH_ERR"
}

do_shell() {
  if [ "$#" -ne 1 ]; then
    echo "usage: $0 shell <user>" >&2
    exit 64
  fi
  local user="$1"
  if ! is_clawbox_user "$user"; then
    echo "clawbox-user-helper: '$user' is not a ClawBox user" >&2
    exit 64
  fi
  local entry home login_shell term lang
  entry="$(getent passwd "$user")"
  home="$(printf '%s\n' "$entry" | cut -d: -f6)"
  login_shell="$(printf '%s\n' "$entry" | cut -d: -f7)"
  [ -n "$login_shell" ] || login_shell=/bin/sh
  # Values that came through sudo's environment are passed on only when they
  # look like what they claim to be.
  term="${TERM:-}"
  short_token_ok "$term" '^[A-Za-z0-9._+-]+$' || term="xterm-256color"
  lang="${LANG:-}"
  short_token_ok "$lang" '^[A-Za-z0-9._@-]+$' || lang="C.UTF-8"
  cd -- "$home" 2>/dev/null || cd /
  exec "$RUNUSER" -u "$user" -- /usr/bin/env -i \
    HOME="$home" USER="$user" LOGNAME="$user" SHELL="$login_shell" \
    TERM="$term" COLORTERM=truecolor LANG="$lang" \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$login_shell" -l
}

verb="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
case "$verb" in
  verify)
    if [ "$#" -ne 0 ]; then
      echo "usage: $0 verify" >&2
      exit 64
    fi
    do_verify
    ;;
  shell)
    do_shell "$@"
    ;;
  *)
    echo "usage: $0 verify | shell <user>" >&2
    exit 64
    ;;
esac
