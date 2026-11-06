#!/usr/bin/env bash
#
# Root dispatcher for clawbox-root-update@<step>.service on an x64 install.
#
# Installed by install-x64.sh::step_root_step_contract to
# /usr/local/libexec/clawbox/clawbox-root-step.sh, root:root 0755.
#
# Two things the appliance learned the hard way and this keeps (TASK-445,
# TASK-733): the step name is attacker-influenced input on the root side of the
# boundary, so it is validated here as well as in the launcher; and root never
# executes a file the clawbox user can write. The installer therefore keeps a
# root-owned copy of itself at $ROOT_INSTALLER and this dispatcher execs THAT —
# never $PROJECT_DIR/install-x64.sh, which the install user owns.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "clawbox-root-step: must run as root" >&2; exit 77; }
[ "$#" -eq 1 ] || { echo "usage: $0 <step>" >&2; exit 64; }
step="$1"

case "$step" in
  *[!a-z0-9_]*|"")
    echo "clawbox-root-step: refusing malformed step name: $step" >&2
    exit 64
    ;;
esac

# Root-owned configuration written by install-x64.sh. Parsed, never sourced:
# a `.` on a file any other tool might one day place here is how the appliance's
# own dispatcher lost its boundary once.
ROOT_CONF="/etc/clawbox/x64.env"
read_root_conf() {
  local key="$1" line
  [ -f "$ROOT_CONF" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key="*) printf '%s' "${line#"$key="}"; return 0 ;;
    esac
  done < "$ROOT_CONF"
}

CLAWBOX_USER="${CLAWBOX_USER:-$(read_root_conf CLAWBOX_USER)}"
PROJECT_DIR="${PROJECT_DIR:-$(read_root_conf PROJECT_DIR)}"
ROOT_INSTALLER="${ROOT_INSTALLER:-$(read_root_conf ROOT_INSTALLER)}"
[ -n "$ROOT_INSTALLER" ] || ROOT_INSTALLER="/usr/local/libexec/clawbox/clawbox-x64-install.sh"
[ -n "$PROJECT_DIR" ] || PROJECT_DIR="/home/${CLAWBOX_USER:-clawbox}/clawbox"

# Read one KEY=value out of a user-writable .env WITHOUT sourcing it.
read_untrusted_env_value() {
  local file="$1" key="$2" line
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key="*) printf '%s' "${line#"$key="}"; return 0 ;;
    esac
  done < "$file"
}

validate_hostname() {
  local n="$1"
  [ -n "$n" ] || return 1
  [ "${#n}" -le 63 ] || return 1
  case "$n" in
    [a-z0-9]*) : ;;
    *) return 1 ;;
  esac
  case "$n" in
    *[!a-z0-9-]*) return 1 ;;
    -*|*-) return 1 ;;
  esac
  printf '%s' "$n"
}

run_chpasswd() {
  local INPUT_FILE="$PROJECT_DIR/data/.chpasswd-input"
  # -f follows symlinks; -L rejects the link itself. A symlink here would be a
  # way to make root read a file the user could not otherwise feed in.
  if [ -L "$INPUT_FILE" ]; then
    rm -f "$INPUT_FILE"
    echo "Error: password input file is a symlink; refusing" >&2
    exit 64
  fi
  if [ ! -f "$INPUT_FILE" ]; then
    echo "Error: password input file not found" >&2
    exit 1
  fi

  # Read ONCE and validate the value actually used: re-reading after the checks
  # would leave a window to swap the contents.
  local record user
  record="$(cat "$INPUT_FILE")"
  rm -f "$INPUT_FILE"

  case "$record" in
    *$'\n'*) echo "Error: password input must be exactly one record" >&2; exit 64 ;;
    *$'\r'*) echo "Error: password input contains a carriage return" >&2; exit 64 ;;
  esac
  user="${record%%:*}"
  if [ "$user" != "$CLAWBOX_USER" ]; then
    echo "Error: password input names '$user'; only $CLAWBOX_USER may be changed here" >&2
    exit 64
  fi
  if [ "$record" = "$user" ] || [ -z "${record#*:}" ]; then
    echo "Error: password input has no password" >&2
    exit 64
  fi

  printf '%s\n' "$record" | /usr/sbin/chpasswd
  echo "clawbox-root-step: password set for $user"
}

run_set_hostname() {
  local name
  name="$(read_untrusted_env_value "$PROJECT_DIR/data/hostname.env" HOSTNAME)"
  [ -n "$name" ] || name="clawbox"
  name="$(validate_hostname "$name")" || name=""
  if [ -z "$name" ]; then
    echo "clawbox-root-step: invalid hostname configured, skipping" >&2
    exit 64
  fi
  # Best-effort, like the appliance: a container or a host without
  # systemd-hostnamed must not fail the whole step.
  if ! /usr/bin/hostnamectl set-hostname "$name" 2>/dev/null; then
    echo "clawbox-root-step: hostnamectl set-hostname failed, continuing" >&2
  fi
  echo "clawbox-root-step: hostname set to $name"
}

# There is no WiFi AP and no Jetson power/performance stack on x64. The wizard
# asks for both anyway, so answer them as documented no-ops rather than failing
# a step the user cannot act on.
run_noop() {
  echo "clawbox-root-step: $1 is a no-op on the x64 install"
}

# The install user as a value root may hand to runuser: a plain account name,
# never root. x64.env is root-owned, so this is a sanity check, not a boundary.
require_install_user() {
  case "$CLAWBOX_USER" in
    ""|root|-*|*[!A-Za-z0-9._-]*)
      echo "Error: no valid install user is recorded in $ROOT_CONF - run install-x64.sh --step root_step_contract" >&2
      exit 78
      ;;
  esac
}

# The zone the owner asked for (Settings, or the desktop adopting its browser's
# zone), from data/timezone.env. That file is owner-writable and this runs as
# root, so it is read AS THE OWNER, through O_NOFOLLOW|O_NONBLOCK and an inode
# type check: a symlink or FIFO planted there can neither make root read another
# file nor hang the step. Prints the zone, nothing when none is recorded, and
# fails (with the reason on stderr) on anything but the plain file the route
# writes.
read_requested_timezone() {
  /usr/sbin/runuser -u "$CLAWBOX_USER" -- /usr/bin/python3 -I - "$PROJECT_DIR/data/timezone.env" <<'PY'
import os, stat, sys
path = sys.argv[1]
try:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
except FileNotFoundError:
    sys.exit(0)
except OSError as err:
    sys.exit(f"Error: {path} is not the plain file the timezone route writes ({err.strerror}) - refusing to read it.")
with os.fdopen(fd, "rb") as f:
    if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
        sys.exit(f"Error: {path} is not the plain file the timezone route writes - refusing to read it.")
    raw = f.read(513)
if len(raw) > 512:
    sys.exit("Error: the timezone request is larger than the route ever writes - refusing to read it.")
for line in raw.decode("utf-8", "replace").splitlines():
    line = line.strip()
    if line.startswith("export "):
        line = line[len("export "):].lstrip()
    if line.startswith("TIMEZONE="):
        value = line[len("TIMEZONE="):]
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        print(value)
        break
PY
}

# install.sh's step_set_timezone, for this PC: the same shape rule as
# read_configured_timezone, then systemd's own list as the authority for "is
# this a zone", then timedatectl. No zone recorded is a no-op, never an error.
run_set_timezone() {
  local tz zones current
  require_install_user
  if ! tz="$(read_requested_timezone)"; then
    echo "Error: the timezone request was refused - leaving the system zone alone." >&2
    return 1
  fi
  if [ -z "$tz" ]; then
    echo "clawbox-root-step: no timezone recorded, leaving the system zone alone"
    return 0
  fi
  case "$tz" in
    /*|-*|*..*|*[!A-Za-z0-9._/+-]*)
      echo "Error: the recorded timezone is not a zone name - leaving the system zone alone." >&2
      return 1
      ;;
  esac
  # Captured, then searched: a pipe into `grep -q` under pipefail can report
  # the writer's SIGPIPE as "not found".
  zones="$(/usr/bin/timedatectl list-timezones 2>/dev/null)" || zones=""
  if ! /usr/bin/grep -qxF -- "$tz" <<<"$zones"; then
    echo "Error: the recorded timezone is not one this PC carries - leaving the system zone alone." >&2
    return 1
  fi
  current="$(/usr/bin/timedatectl show -p Timezone --value 2>/dev/null)" || current=""
  if [ "$current" = "$tz" ]; then
    echo "clawbox-root-step: system timezone already $tz"
    return 0
  fi
  if ! /usr/bin/timedatectl set-timezone "$tz"; then
    echo "Error: timedatectl refused to set the timezone to $tz" >&2
    return 1
  fi
  echo "clawbox-root-step: system timezone set to $tz"
}

# The updater's "Configuring gateway service". install-x64.sh::
# step_systemd_services writes this PC's gateway unit with the ports chosen at
# install time; re-rendering it from a root step that cannot know those choices
# would reset them. So: confirm the unit is there, reload, and clear a
# start-limit latch so the updater's own restart can bring the gateway up.
run_gateway_setup() {
  if [ ! -f /etc/systemd/system/clawbox-gateway.service ]; then
    echo "Error: clawbox-gateway.service is not installed - run install-x64.sh --step systemd_services" >&2
    return 1
  fi
  /usr/bin/systemctl daemon-reload
  /usr/bin/systemctl reset-failed clawbox-gateway.service >/dev/null 2>&1 || true
  echo "clawbox-root-step: gateway unit present (written by install-x64.sh systemd_services)"
}

# The updater's "Applying system fixups", after the dashboard restarted. The
# appliance's post_update redeploys root files out of the new checkout; here
# every root file comes from install-x64.sh --step root_step_contract, which
# only the owner runs, so what is left is the owner's timezone. Never fatal: a
# clock that could not be moved is reported on the update's own card.
run_post_update() {
  # In a subshell: require_install_user ends its shell with `exit 78`, and an
  # exit inside a function would end this whole step, not just the timezone.
  if ! ( run_set_timezone ); then
    echo "CLAWBOX-WARN[x64-timezone]: The recorded timezone could not be applied to this PC's clock; set it again in Settings."
  fi
  echo "clawbox-root-step: x64 post-update done"
}

# ── Settings → Users ─────────────────────────────────────────────────────────
#
# install.sh's step_user_add / step_user_remove, for this PC. The appliance
# runs them out of install.sh; here root never runs the checkout, so they live
# in this root-owned dispatcher beside run_chpasswd, under the same rules:
# ONE record from a 0600 file under data/, read once and deleted; a name held
# to src/lib/username-rules.ts's USERNAME_RE and never root or the install
# user; a new account in exactly one supplementary group, clawbox-users (never
# sudo, never adm); and a removal only of a member of that group with
# uid >= 1000 that administers nothing. config/clawbox-user-helper.sh (sign-in
# and the Terminal) holds itself to the same membership rule.
#
# Exit codes the web side reads from the unit (src/lib/clawbox-users.ts):
# 64 = the record was refused, 65 = the name is taken, 1 = the system tools
# failed; the "Error:" line says which.
readonly CLAWBOX_USERS_GROUP="clawbox-users"

# 1-32 characters, carried by a length test rather than a `{0,31}` bound in
# the regex (shell-regex-hygiene.test.ts).
clawbox_user_name_ok() {
  [ "${#1}" -ge 1 ] && [ "${#1}" -le 32 ] && [[ "$1" =~ ^[a-z_][a-z0-9_-]*$ ]]
}

# The one record a user step was handed, refusing a symlink, a missing file and
# a second record. Prints the record; exits on refusal.
read_user_step_input() {
  local input_file="$1" record
  if [ -L "$input_file" ]; then
    rm -f "$input_file"
    echo "Error: user input file is a symlink; refusing" >&2
    exit 64
  fi
  if [ ! -f "$input_file" ]; then
    echo "Error: user input file not found" >&2
    exit 1
  fi
  record="$(cat "$input_file")"
  rm -f "$input_file"
  case "$record" in
    *$'\n'*) echo "Error: user input must be exactly one record" >&2; exit 64 ;;
    *$'\r'*) echo "Error: user input contains a carriage return" >&2; exit 64 ;;
  esac
  printf '%s' "$record"
}

run_user_add() {
  local record user password home owner_home
  require_install_user
  record="$(read_user_step_input "$PROJECT_DIR/data/.user-add-input")" || exit $?
  user="${record%%:*}"
  password="${record#*:}"
  if ! clawbox_user_name_ok "$user"; then
    echo "Error: '$user' is not a valid username" >&2
    exit 64
  fi
  if [ "$user" = "root" ] || [ "$user" = "$CLAWBOX_USER" ]; then
    echo "Error: '$user' cannot be created here" >&2
    exit 64
  fi
  if [ "$record" = "$user" ] || [ -z "$password" ]; then
    echo "Error: user input has no password" >&2
    exit 64
  fi
  if /usr/bin/getent passwd "$user" >/dev/null 2>&1 || /usr/bin/getent group "$user" >/dev/null 2>&1; then
    echo "Error: an account or group named '$user' already exists" >&2
    exit 65
  fi

  if ! /usr/bin/getent group "$CLAWBOX_USERS_GROUP" >/dev/null 2>&1; then
    /usr/sbin/groupadd --system "$CLAWBOX_USERS_GROUP" || {
      echo "Error: could not create the $CLAWBOX_USERS_GROUP group" >&2
      exit 1
    }
  fi
  /usr/sbin/useradd --create-home --shell /bin/bash --user-group \
    --groups "$CLAWBOX_USERS_GROUP" "$user" || {
    echo "Error: useradd could not create '$user'" >&2
    exit 1
  }
  if ! printf '%s:%s\n' "$user" "$password" | /usr/sbin/chpasswd; then
    /usr/sbin/userdel --remove "$user" >/dev/null 2>&1 || true
    echo "Error: could not set the password for '$user'; the account was removed again" >&2
    exit 1
  fi

  # The new home is theirs alone, and the install user's stops being readable
  # by the accounts this step creates: it holds the checkout, data/ and every
  # credential store, and nothing that runs as another user reads from it.
  # Only the "other" bits go, so the install user's own group access stays.
  home="$(/usr/bin/getent passwd "$user" | /usr/bin/cut -d: -f6)"
  if [ -n "$home" ] && [ -d "$home" ]; then
    /usr/bin/chmod 0750 "$home" || true
  fi
  owner_home="$(/usr/bin/getent passwd "$CLAWBOX_USER" | /usr/bin/cut -d: -f6)"
  if [ -n "$owner_home" ] && [ -d "$owner_home" ] && [ "$owner_home" != "/" ]; then
    /usr/bin/chmod o-rwx "$owner_home" || echo "  Warning: could not restrict $owner_home" >&2
  fi
  echo "clawbox-root-step: created ClawBox user '$user'"
}

run_user_remove() {
  local user uid groups rc=0
  require_install_user
  user="$(read_user_step_input "$PROJECT_DIR/data/.user-remove-input")" || exit $?
  if ! clawbox_user_name_ok "$user"; then
    echo "Error: '$user' is not a valid username" >&2
    exit 64
  fi
  if [ "$user" = "root" ] || [ "$user" = "$CLAWBOX_USER" ]; then
    echo "Error: '$user' cannot be removed here" >&2
    exit 64
  fi
  if ! /usr/bin/getent passwd "$user" >/dev/null 2>&1; then
    # Already gone (removed by hand, or a retry after a partial run): the
    # registry entry is what the owner is asking to clear, and it has been.
    echo "clawbox-root-step: ClawBox user '$user' has no account; nothing to remove"
    return 0
  fi
  uid="$(/usr/bin/getent passwd "$user" | /usr/bin/cut -d: -f3)"
  groups=" $(/usr/bin/id -nG "$user" 2>/dev/null || true) "
  case "$groups" in
    *" $CLAWBOX_USERS_GROUP "*) ;;
    *)
      echo "Error: '$user' is not a ClawBox user (not in $CLAWBOX_USERS_GROUP); refusing" >&2
      exit 64
      ;;
  esac
  case "$groups" in
    *" sudo "*|*" admin "*|*" wheel "*|*" root "*|*" adm "*)
      echo "Error: '$user' is an administrator account; refusing" >&2
      exit 64
      ;;
  esac
  if ! [[ "$uid" =~ ^[0-9]+$ ]] || [ "$uid" -lt 1000 ] || [ "$uid" -eq 65534 ]; then
    echo "Error: '$user' is a system account; refusing" >&2
    exit 64
  fi

  # End everything the user is running first — a Terminal session is a login
  # shell under their uid — or userdel refuses with "user is currently used".
  /usr/bin/pkill -KILL -u "$uid" >/dev/null 2>&1 || true
  sleep 1
  /usr/sbin/userdel --remove "$user" || rc=$?
  # 12: the account is gone but its home or mail spool could not be removed.
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 12 ]; then
    echo "Error: userdel could not remove '$user' (exit $rc)" >&2
    exit 1
  fi
  echo "clawbox-root-step: removed ClawBox user '$user'"
}

# The steps the x64 installer implements. Everything else is refused loudly: a
# step that silently does nothing is worse than one that fails.
#
# bootstrap_updater and rebuild_reboot are deliberately absent. Both run the
# CHECKOUT on the appliance, which root must never do here; the updater runs
# them as the desktop owner instead (src/lib/x64-install-update.ts), and an
# update on this PC never reboots it.
INSTALLER_STEPS="
apt_update chromium_install clawkeep_install cloudflared_install ffmpeg_install fix_git_perms
google_chrome_install llamacpp_install ollama_install openclaw_config openclaw_install openclaw_patch
openclaw_setup vnc_install
"

case "$step" in
  chpasswd)
    run_chpasswd
    ;;
  set_hostname)
    run_set_hostname
    ;;
  set_timezone)
    run_set_timezone
    ;;
  gateway_setup)
    run_gateway_setup
    ;;
  post_update)
    run_post_update
    ;;
  user_add)
    run_user_add
    ;;
  user_remove)
    run_user_remove
    ;;
  restart_ap|performance_mode)
    run_noop "$step"
    ;;
  *)
    if [ ! -f "$ROOT_INSTALLER" ]; then
      echo "clawbox-root-step: $ROOT_INSTALLER not found" >&2
      exit 69
    fi
    permitted=1
    for allowed in $INSTALLER_STEPS; do
      if [ "$allowed" = "$step" ]; then
        permitted=0
        break
      fi
    done
    if [ "$permitted" -ne 0 ]; then
      echo "clawbox-root-step: step '$step' has no implementation on the x64 install" >&2
      exit 64
    fi
    # The installer resolves its user from `logname`/SUDO_USER, and a unit
    # systemd started has neither — every installer-backed step from the web
    # server failed "could not resolve an unprivileged install user" until the
    # values this dispatcher reads out of $ROOT_CONF were handed over (seen on
    # the owner's laptop, 2026-10-12). CLAWBOX_DIR is the installer's own name
    # for the project folder. require_install_user refuses an empty, root or
    # malformed name before root hands it to the installer.
    require_install_user
    exec /usr/bin/env CLAWBOX_USER="$CLAWBOX_USER" CLAWBOX_DIR="$PROJECT_DIR" /usr/bin/bash "$ROOT_INSTALLER" --step "$step"
    ;;
esac
