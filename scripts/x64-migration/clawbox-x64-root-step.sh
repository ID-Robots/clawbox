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
  if ! run_set_timezone; then
    echo "CLAWBOX-WARN[x64-timezone]: The recorded timezone could not be applied to this PC's clock; set it again in Settings."
  fi
  echo "clawbox-root-step: x64 post-update done"
}

# The steps the x64 installer implements. Everything else is refused loudly: a
# step that silently does nothing is worse than one that fails.
#
# bootstrap_updater and rebuild_reboot are deliberately absent. Both run the
# CHECKOUT on the appliance, which root must never do here; the updater runs
# them as the desktop owner instead (src/lib/x64-install-update.ts), and an
# update on this PC never reboots it.
INSTALLER_STEPS="
apt_update chromium_install clawkeep_install ffmpeg_install fix_git_perms
llamacpp_install ollama_install openclaw_config openclaw_install openclaw_patch
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
    # The installer names its user from `logname` or SUDO_USER, and a unit
    # systemd starts has neither — so every forwarded step used to stop at
    # "could not resolve an unprivileged install user". Hand it the user and
    # the checkout this PC was installed for, from the root-owned record.
    require_install_user
    export CLAWBOX_USER
    export CLAWBOX_DIR="$PROJECT_DIR"
    exec /usr/bin/bash "$ROOT_INSTALLER" --step "$step"
    ;;
esac
