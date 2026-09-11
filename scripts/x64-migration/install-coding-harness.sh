#!/usr/bin/env bash
# Run as the desktop owner. The root adapter supplies the verified wrapper;
# Claude's installer and all writes into HOME run without root privileges.
set -euo pipefail
[ "$(/usr/bin/id -u)" -ne 0 ] || { echo 'Run the coding harness installer as the desktop owner, not root.' >&2; exit 77; }
[ "$#" -eq 2 ] || { echo 'Usage: install-coding-harness.sh WRAPPER_SOURCE PROJECT_DIR' >&2; exit 64; }
wrapper_source=$1
project_dir=$2
test -s "$wrapper_source"
[[ "$project_dir" = /* ]] && test -d "$project_dir"
export PATH="$HOME/.bun/bin:$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/snap/bin"

if ! command -v claude >/dev/null 2>&1; then
  installer=$(mktemp)
  trap 'rm -f "$installer"' EXIT
  curl -fsSL --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 300 https://claude.ai/install.sh -o "$installer"
  if [ ! -s "$installer" ] || head -c 512 "$installer" | grep -qiE '<!doctype|<html|unavailable in region'; then
    echo 'Claude Code installer unavailable or region-blocked; coding harness installation failed.' >&2
    exit 1
  fi
  /bin/bash -n "$installer"
  /bin/bash "$installer" </dev/null
  command -v claude >/dev/null 2>&1 || { echo 'Claude Code is still missing after installation.' >&2; exit 1; }
fi

# Keep a standalone copy, with this desktop's checkout as its default. The
# app can still override CLAWBOX_ROOT. Atomic replacement also replaces an old
# symlink without writing through it into a checkout or an unrelated file.
python3 - "$wrapper_source" "$project_dir" "$HOME/.local/bin/claude-ds" <<'PY'
import os, pathlib, shlex, sys, tempfile
source, project, destination = sys.argv[1:]
text = pathlib.Path(source).read_text()
original = 'CLAWBOX_ROOT="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"'
if text.count(original) != 1:
    raise ValueError('claude-ds default root changed; review the desktop installer')
replacement = '_CLAWBOX_DEFAULT_ROOT=' + shlex.quote(project) + '\nCLAWBOX_ROOT="${CLAWBOX_ROOT:-$_CLAWBOX_DEFAULT_ROOT}"\nunset _CLAWBOX_DEFAULT_ROOT'
dest = pathlib.Path(destination)
dest.parent.mkdir(parents=True, exist_ok=True)
fd, staged = tempfile.mkstemp(prefix='.claude-ds-', dir=dest.parent)
try:
    with os.fdopen(fd, 'w') as f:
        f.write(text.replace(original, replacement))
        os.fchmod(f.fileno(), 0o755)
    os.replace(staged, dest)
finally:
    if os.path.exists(staged): os.unlink(staged)
PY
test -x "$HOME/.local/bin/claude-ds"
echo "Coding harness installed: $HOME/.local/bin/claude-ds"
