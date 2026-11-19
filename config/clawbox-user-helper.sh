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
#   passwd        A ClawBox user changes their OWN password (Settings →
#                 Account): the username, the current password and the new
#                 one as three lines on STDIN. The current password is checked
#                 with unix_chkpwd exactly as `verify` checks it, and only then
#                 is ONE `user:password` record piped to chpasswd. Exits 0 for
#                 a change, 7 (PAM_AUTH_ERR) for a wrong current password or
#                 an account outside `clawbox-users`, 65 for a new password
#                 outside the rules, 66 when chpasswd itself failed.
#
#   setpasswd     The OWNER resets a ClawBox user's password (Settings → System
#                 → Users, TASK-2377): the username and the new password as
#                 two lines on STDIN. No current password — the owner is the
#                 administrator — but the same membership rule and the same
#                 password rule as `passwd`, and ONE record to chpasswd. Exits
#                 0 for a change, 7 for an account outside `clawbox-users`, 65
#                 for a new password outside the rules, 66 when chpasswd failed.
#
#   home_access   Lets the web server — which runs as the owner — reach a
#                 ClawBox user's home folder, so the Files app can serve a
#                 member of staff their OWN home on an organisation box
#                 (TASK-2377). The username on STDIN. Grants the account sudo
#                 was called from ($SUDO_USER, the owner) rwx through a POSIX
#                 ACL on the home and everything in it, and a default ACL so
#                 what either side creates later stays usable by both. Never
#                 follows a symlink (setfacl -P, find without -L), never leaves
#                 the home's filesystem. Exits 0 when done, 7 for an account
#                 outside `clawbox-users`, 64 when the caller is not an
#                 ordinary owner account, 69 when the filesystem or setfacl
#                 cannot carry the ACL.
#
#   shell <user>  The Terminal app for a signed-in ClawBox user: a login shell
#                 AS that user (runuser), in their home folder, with a clean
#                 environment. scripts/terminal-server.mjs runs this inside the
#                 PTY instead of spawning the owner's shell.
#
#   mail_send_auth get|set
#                 The auth header value ClawBox sends to the mail send backend
#                 (docs/email-draft-approval.md, TASK-2714), kept in
#                 /etc/clawbox/mail-send-auth: root-only, or root:ms365send 0640
#                 where that backend's account exists, so the backend can read
#                 it too. Never in data/config.json, which the assistant's shell
#                 reads as the same user as the web server. The record is two
#                 lines: the backend endpoint the value was saved for (the web
#                 server sends it only while config.json still names that
#                 endpoint) and the value. `get` prints it (nothing when none is
#                 saved); `set` reads it as two lines on STDIN, and an empty
#                 value removes it. Answers ONLY the web
#                 server itself — the process clawbox-setup.service started —
#                 never another process of the same account that runs sudo
#                 (the agent's shell): exit 77 for any other caller, 65 for an
#                 endpoint or value that is not visible ASCII (up to 300 and
#                 4096 characters).
#
# verify, passwd, setpasswd, home_access and shell answer ONLY for a ClawBox user: an ordinary account (uid >= 1000, not
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
#   clawbox-user-helper.sh passwd        < "user\ncurrent\nnew\n"
#   clawbox-user-helper.sh setpasswd     < "user\nnew\n"
#   clawbox-user-helper.sh home_access   < "user\n"
#   clawbox-user-helper.sh shell <user>
#   clawbox-user-helper.sh mail_send_auth get
#   clawbox-user-helper.sh mail_send_auth set < "endpoint\nvalue\n"
#
# Installed by install.sh::install_root_libexec to
# /usr/local/libexec/clawbox/clawbox-user-helper.sh, root:root 0755.

set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

readonly USERS_GROUP="clawbox-users"
readonly UNIX_CHKPWD=/usr/sbin/unix_chkpwd
readonly RUNUSER=/usr/sbin/runuser
readonly PAM_AUTH_ERR=7
readonly BAD_NEW_PASSWORD=65
readonly CHPASSWD_FAILED=66
readonly CHPASSWD=/usr/sbin/chpasswd
readonly ACL_UNAVAILABLE=69
readonly SETFACL=/usr/bin/setfacl
# The rules src/lib/username-rules.ts holds the web side to
# (USER_PASSWORD_MIN / USER_PASSWORD_MAX).
readonly NEW_PASSWORD_MIN=8
readonly NEW_PASSWORD_MAX=256
readonly MAIL_SEND_AUTH_FILE=/etc/clawbox/mail-send-auth
readonly MAIL_SEND_GROUP=ms365send
readonly NOT_THE_WEB_SERVER=77

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

# 0 when "$1" may become a password: the length rules above, and no control
# character (a newline cannot arrive — `read` ends at one — but a CR or a tab
# would reach chpasswd's record as part of the password).
new_password_ok() {
  [ "${#1}" -ge "$NEW_PASSWORD_MIN" ] && [ "${#1}" -le "$NEW_PASSWORD_MAX" ] && [[ "$1" != *[[:cntrl:]]* ]]
}

do_passwd() {
  local user="" current="" next=""
  IFS= read -r user || true
  IFS= read -r current || true
  IFS= read -r next || true
  if ! is_clawbox_user "$user" || [ -z "$current" ]; then
    exit "$PAM_AUTH_ERR"
  fi
  if ! new_password_ok "$next"; then
    exit "$BAD_NEW_PASSWORD"
  fi
  local rc=0
  printf '%s\0' "$current" | "$UNIX_CHKPWD" "$user" nonull || rc=$?
  if [ "$rc" -ne 0 ]; then
    exit "$PAM_AUTH_ERR"
  fi
  # ONE record, the name checked above and the password checked for control
  # characters — chpasswd splits on the FIRST colon, so a colon in the
  # password is the password's.
  if ! printf '%s:%s\n' "$user" "$next" | "$CHPASSWD"; then
    exit "$CHPASSWD_FAILED"
  fi
  exit 0
}

do_setpasswd() {
  local user="" next=""
  IFS= read -r user || true
  IFS= read -r next || true
  if ! is_clawbox_user "$user"; then
    exit "$PAM_AUTH_ERR"
  fi
  if ! new_password_ok "$next"; then
    exit "$BAD_NEW_PASSWORD"
  fi
  if ! printf '%s:%s\n' "$user" "$next" | "$CHPASSWD"; then
    exit "$CHPASSWD_FAILED"
  fi
  exit 0
}

# The account sudo was called from, when it is an ordinary account that may be
# handed a member's home: not root, not a ClawBox user itself, uid >= 1000.
owner_caller() {
  local caller="${SUDO_USER:-}" entry uid
  name_ok "$caller" || return 1
  [ "$caller" != "root" ] || return 1
  entry="$(getent passwd "$caller")" || return 1
  uid="$(printf '%s\n' "$entry" | cut -d: -f3)"
  [[ "$uid" =~ ^[0-9]+$ ]] || return 1
  [ "$uid" -ge 1000 ] || return 1
  if is_clawbox_user "$caller"; then return 1; fi
  printf '%s' "$caller"
}

do_home_access() {
  local user="" owner home
  IFS= read -r user || true
  if ! is_clawbox_user "$user"; then
    exit "$PAM_AUTH_ERR"
  fi
  owner="$(owner_caller)" || {
    echo "clawbox-user-helper: home_access must be asked by the box's owner account" >&2
    exit 64
  }
  home="$(getent passwd "$user" | cut -d: -f6)"
  # An absolute, real directory that is not the root of the tree and not a
  # link: the ACL is laid on exactly the folder useradd made.
  if [ -z "$home" ] || [ "${home#/}" = "$home" ] || [ "$home" = "/" ] || [ -L "$home" ] || [ ! -d "$home" ]; then
    echo "clawbox-user-helper: '$user' has no usable home folder" >&2
    exit "$ACL_UNAVAILABLE"
  fi
  if [ ! -x "$SETFACL" ]; then
    echo "clawbox-user-helper: setfacl is not installed (package acl)" >&2
    exit "$ACL_UNAVAILABLE"
  fi
  # The folder itself, then a default ACL on every directory (what is created
  # later inherits it), then rwX on what is already there. `find` without -L
  # and -xdev, and -P: a link inside the home is never followed, and a
  # filesystem mounted inside it is never entered.
  "$SETFACL" -m "u:${owner}:rwx" -- "$home" || exit "$ACL_UNAVAILABLE"
  find "$home" -xdev -type d -exec "$SETFACL" -P -d -m "u:${owner}:rwx,u:${user}:rwx" -- {} + || exit "$ACL_UNAVAILABLE"
  find "$home" -xdev \( -type d -o -type f \) -exec "$SETFACL" -P -m "u:${owner}:rwX" -- {} + || exit "$ACL_UNAVAILABLE"
  exit 0
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

# 0 when sudo was run by clawbox-setup.service's main process — the web
# server — and not by any other process of its account. Walks up from this
# helper through sudo itself (one process, or two under `use_pty`): only a
# process named sudo whose EFFECTIVE uid is root counts as sudo, which no
# process of the account can fake. The first process above them must be the
# unit's MainPID.
web_server_caller() {
  local main pid euid
  main="$(systemctl show -p MainPID --value clawbox-setup.service 2>/dev/null)" || return 1
  [[ "$main" =~ ^[0-9]+$ ]] && [ "$main" -gt 1 ] || return 1
  pid=$PPID
  for _ in 1 2 3; do
    [ "$(cat "/proc/$pid/comm" 2>/dev/null)" = sudo ] || break
    euid="$(awk '/^Uid:/ { print $3 }' "/proc/$pid/status" 2>/dev/null)"
    [ "$euid" = 0 ] || break
    pid="$(awk '/^PPid:/ { print $2 }' "/proc/$pid/status" 2>/dev/null)"
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  done
  [ "$pid" = "$main" ]
}

do_mail_send_auth() {
  local endpoint="" value="" tmp
  if ! web_server_caller; then
    echo "clawbox-user-helper: mail_send_auth answers the ClawBox web server only" >&2
    exit "$NOT_THE_WEB_SERVER"
  fi
  if [ "$1" = get ]; then
    [ ! -f "$MAIL_SEND_AUTH_FILE" ] || cat -- "$MAIL_SEND_AUTH_FILE"
    exit 0
  fi
  IFS= read -r endpoint || true
  IFS= read -r value || true
  if [ -z "$value" ]; then
    rm -f -- "$MAIL_SEND_AUTH_FILE"
    exit 0
  fi
  # The rule src/lib/mail-draft-approval-config.ts holds the value to.
  if [ "${#endpoint}" -gt 300 ] || [ "${#value}" -gt 4096 ] \
     || ! LC_ALL=C grep -qx '[ -~]*' <<<"$endpoint" || ! LC_ALL=C grep -qx '[ -~]*' <<<"$value"; then
    exit "$BAD_NEW_PASSWORD"
  fi
  install -d -o root -g root -m 0755 /etc/clawbox
  tmp="$(mktemp /etc/clawbox/.mail-send-auth.XXXXXX)"
  printf '%s\n%s' "$endpoint" "$value" > "$tmp"
  if getent group "$MAIL_SEND_GROUP" >/dev/null; then
    chgrp "$MAIL_SEND_GROUP" "$tmp"
    chmod 0640 "$tmp"
  fi
  mv -f -- "$tmp" "$MAIL_SEND_AUTH_FILE"
  exit 0
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
  passwd)
    if [ "$#" -ne 0 ]; then
      echo "usage: $0 passwd" >&2
      exit 64
    fi
    do_passwd
    ;;
  setpasswd)
    if [ "$#" -ne 0 ]; then
      echo "usage: $0 setpasswd" >&2
      exit 64
    fi
    do_setpasswd
    ;;
  home_access)
    if [ "$#" -ne 0 ]; then
      echo "usage: $0 home_access" >&2
      exit 64
    fi
    do_home_access
    ;;
  shell)
    do_shell "$@"
    ;;
  mail_send_auth)
    if [ "$#" -ne 1 ] || { [ "$1" != get ] && [ "$1" != set ]; }; then
      echo "usage: $0 mail_send_auth get|set" >&2
      exit 64
    fi
    do_mail_send_auth "$1"
    ;;
  *)
    echo "usage: $0 verify | passwd | setpasswd | home_access | shell <user> | mail_send_auth get|set" >&2
    exit 64
    ;;
esac
