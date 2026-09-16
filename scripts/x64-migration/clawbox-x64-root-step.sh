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

# The steps the x64 installer implements. Everything else is refused loudly: a
# step that silently does nothing is worse than one that fails.
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
    exec /usr/bin/bash "$ROOT_INSTALLER" --step "$step"
    ;;
esac
