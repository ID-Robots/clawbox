#!/usr/bin/env python3
"""Build a reviewed, host-specific Debian package; never installs it.

The package snapshots executable source at build time. Later update snapshots
are fetched independently into root-owned storage, never copied from the
desktop user's mutable checkout. Host adapters survive ordinary beta updates.
"""
import argparse
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def write(root, name, data, mode=0o644):
    p = root / name.lstrip('/')
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(data)
    p.chmod(mode)


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f'vendor helper changed; review required before adapting {old!r}')
    return text.replace(old, new)


def build(args):
    account = pwd.getpwnam(args.user)
    for value in [args.user, args.project, args.node_dir, args.npm_prefix, account.pw_dir]:
        if not re.fullmatch(r'[A-Za-z0-9_./-]+', value) or '..' in value:
            raise ValueError('host paths/user must contain only simple path characters')
    root = Path(args.staging).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if any(root.iterdir()):
        raise ValueError('staging directory must be empty')
    host = dict(INSTALL_USER=args.user, INSTALL_UID=str(account.pw_uid),
                INSTALL_HOME=account.pw_dir, PROJECT_DIR=args.project,
                NODE_DIR=args.node_dir, NPM_PREFIX=args.npm_prefix)
    write(root, '/etc/clawbox/x64-integration.env', ''.join(f'{k}={shlex.quote(v)}\n' for k,v in host.items()))
    lib = '/usr/local/libexec/clawbox/'
    for name in ['clawbox-x64-step.sh', 'clawbox-x64-gateway.sh']:
        write(root, lib+name, (HERE/name).read_text(), 0o755)
    write(root,lib+'openclaw-cli','''#!/usr/bin/env bash
set -euo pipefail
. /etc/clawbox/x64-integration.env
# The core package is owner-writable: this wrapper must never run it as root.
[ "$(/usr/bin/id -u)" = "$INSTALL_UID" ] || exit 77
exec "$NODE_DIR/node" "$NPM_PREFIX/lib/node_modules/openclaw/openclaw.mjs" "$@"
''',0o755)

    source='/var/lib/clawbox/x64-update-source'
    manifest=(REPO/'config/clawbox-root-manifest.sh').read_text()
    manifest=replace_once(manifest, 'PROJECT_DIR="/home/clawbox/clawbox"', f'PROJECT_DIR="{source}"')
    manifest=replace_once(manifest, 'COVERED_PATHS="install.sh scripts config"', 'COVERED_PATHS="install.sh install-x64.sh scripts config"')
    write(root, lib+'clawbox-root-manifest.sh', manifest, 0o755)
    dispatcher=(REPO/'config/clawbox-root-step.sh').read_text()
    dispatcher=replace_once(dispatcher, 'PROJECT_DIR="/home/clawbox/clawbox"', f'PROJECT_DIR="{source}"')
    dispatcher=replace_once(dispatcher, 'exec /bin/bash "$ENTRYPOINT" --step "$step"', f'exec /bin/bash {lib}clawbox-x64-step.sh "$step"')
    write(root, lib+'clawbox-root-step.sh', dispatcher, 0o755)
    launcher=(REPO/'config/clawbox-run-root-step.sh').read_text()
    # Grant only the capabilities the x64 worker actually implements.
    allowed='bootstrap_updater set_timezone chpasswd fix_git_perms apt_update nvidia_jetpack performance_mode chromium_install vnc_install vnc_refresh ffmpeg_install openclaw_install openclaw_setup openclaw_config openclaw_patch gateway_setup rebuild_reboot post_update llamacpp_install clawkeep_install cloudflared_install'
    launcher,count=re.subn(r'WEB_ROOT_STEPS="\n.*?\n"', f'WEB_ROOT_STEPS="\n{allowed}\n"', launcher, count=1, flags=re.S)
    if count!=1: raise ValueError('vendor launcher allow-list changed')
    write(root, lib+'clawbox-run-root-step.sh', launcher, 0o755)
    maintenance=(REPO/'config/clawbox-gateway-maintenance.sh').read_text()
    # An inherited fd 8 is the worker's existing flock/open-file description;
    # locking it again is reentrant. Independent enter/leave calls open their
    # own descriptor and wait until the active core writer has finished.
    maintenance=replace_once(maintenance, 'guard=/run/clawbox-gateway-maintenance', '''if [ "$(readlink /proc/$$/fd/8 2>/dev/null || true)" != /run/clawbox-x64-core.lock ]; then
  exec 8>>/run/clawbox-x64-core.lock
fi
/usr/bin/flock -w 600 8
guard=/run/clawbox-gateway-maintenance''')
    maintenance=replace_once(maintenance, '/usr/bin/systemctl daemon-reload',
        f'{lib}clawbox-x64-gateway.sh reload\n/usr/bin/systemctl daemon-reload')
    write(root, lib+'clawbox-gateway-maintenance.sh', maintenance, 0o755)

    # Build source is reviewed package input. Include only Git-tracked regular
    # executable inputs, not .env, data, caches, untracked files or symlinks.
    files=subprocess.check_output(['git','-C',str(REPO),'ls-files','-z','install.sh','install-x64.sh','scripts','config']).decode().split('\0')
    for rel in filter(None,files):
        src=REPO/rel
        if not src.is_file() or src.is_symlink(): continue
        dst=root/source.lstrip('/')/rel
        dst.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(src,dst)
        dst.chmod(0o755 if os.access(src,os.X_OK) else 0o644)
    commit=subprocess.check_output(['git','-C',str(REPO),'rev-parse','HEAD'],text=True).strip()
    write(root,'/usr/share/doc/clawbox-x64-integration/source-commit',commit+'\n')
    write(root,'/usr/share/doc/clawbox-x64-integration/README.md',(HERE/'README.md').read_text())

    write(root,'/etc/systemd/system/clawbox-gateway.service',f'''[Unit]
Description=ClawBox bridge to existing OpenClaw user gateway
After=network-online.target user@{account.pw_uid}.service
Requires=user@{account.pw_uid}.service
Wants=network-online.target
ConditionPathExists=!/run/clawbox-gateway-maintenance

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart={lib}clawbox-x64-gateway.sh start
ExecStop={lib}clawbox-x64-gateway.sh stop
TimeoutStartSec=600
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
''')
    write(root,'/etc/systemd/user/openclaw-gateway.service.d/90-clawbox-maintenance.conf',
          '[Unit]\nConditionPathExists=!/run/clawbox-gateway-maintenance\n')
    write(root,'/etc/systemd/system/clawbox-root-update@.service',(REPO/'config/clawbox-root-update@.service').read_text())
    embed=(REPO/'config/clawbox-embed.service').read_text()
    embed=embed.replace('User=clawbox',f'User={args.user}').replace('Group=clawbox',f'Group={args.user}')
    embed=embed.replace('/home/clawbox/clawbox',args.project).replace('/home/clawbox',account.pw_dir)
    embed=embed.replace(f'Environment=HOME={account.pw_dir}',f'Environment=HOME={account.pw_dir}\nEnvironment=CLAWBOX_ROOT={args.project}')
    write(root,'/etc/systemd/system/clawbox-embed.service',embed)
    write(root,'/etc/systemd/system/clawbox-embed.service.d/50-clawbox-memory.conf',
          '[Service]\nMemoryHigh=2560M\nMemoryMax=3072M\n')
    write(root,'/etc/systemd/system/clawbox-setup.service.d/90-x64-integration.conf',
          '[Service]\nUnsetEnvironment=OPENCLAW_HOME\n')
    write(root,lib+'cloudflared-quick','''#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = tunnel ]; then
  shift
  exec /usr/local/bin/cloudflared tunnel --config /dev/null "$@"
fi
exec /usr/local/bin/cloudflared "$@"
''',0o755)
    write(root,'/etc/systemd/system/clawbox-tunnel.service.d/90-x64-integration.conf',
          f'[Service]\nEnvironment=CLOUDFLARED_BIN={lib}cloudflared-quick\n')
    grants=[lib+'clawbox-run-root-step.sh',lib+'clawbox-gateway-maintenance.sh enter',lib+'clawbox-gateway-maintenance.sh leave',
            '/usr/bin/systemctl stop clawbox-gateway.service','/usr/bin/systemctl reset-failed clawbox-gateway.service',
            '/usr/bin/systemctl restart clawbox-gateway.service','/usr/bin/systemctl start clawbox-browser.service',
            '/usr/bin/systemctl stop clawbox-browser.service','/usr/bin/systemctl enable --now ollama.service',
            '/usr/bin/systemctl start ollama.service','/usr/bin/systemctl stop ollama.service',
            '/usr/bin/systemctl start clawbox-embed.service','/usr/bin/systemctl stop clawbox-embed.service']
    write(root,'/etc/sudoers.d/clawbox-x64-integration',f'{args.user} ALL=(root) NOPASSWD: '+', '.join(grants)+'\n',0o440)
    write(root,'/DEBIAN/control',f'''Package: clawbox-x64-integration
Version: {args.version}
Architecture: amd64
Maintainer: Local ClawBox operator
Depends: bash, coreutils, findutils, git, python3, sudo, systemd, util-linux
Description: Host integration for this existing ClawBox x64 desktop
 Root-owned updater, verified vendor source mirror, timezone support,
 and service bridge for an existing OpenClaw user gateway.
''')
    write(root,'/DEBIAN/postinst',f'''#!/bin/sh
set -eu
if [ "$1" = configure ]; then
  /usr/sbin/visudo -cf /etc/sudoers.d/clawbox-x64-integration
  install -d -o root -g root -m 0755 /var/lib/clawbox /etc/clawbox
  {lib}clawbox-root-manifest.sh --write
  {lib}clawbox-root-manifest.sh --mirror
  /usr/bin/systemctl daemon-reload
  {lib}clawbox-x64-gateway.sh reload
  /usr/sbin/runuser -u {args.user} -- /bin/sh -c '
    mkdir -p {account.pw_dir}/.npm-global/bin
    shim={account.pw_dir}/.npm-global/bin/openclaw
    if [ -f "$shim" ] && [ ! -L "$shim" ]; then
      cp -p "$shim" "$shim.before-clawbox-x64-integration"
    fi
    ln -sfn {lib}openclaw-cli "$shim"
  '
  /usr/bin/systemctl enable clawbox-gateway.service
  # Idempotent start, never restart: establish bridge state without replacing
  # the already-running user's gateway process or its sessions.
  /usr/bin/systemctl start clawbox-gateway.service
fi
''',0o755)
    # No implicit removals/service stops: the operator can inspect package
    # contents and coordinate UI/tunnel restarts independently.
    # Do not inherit the desktop's collaborative umask (commonly 0002) for
    # privileged directories. Every component containing executable code is
    # root-owned and closed to group/other writes after package installation.
    root.chmod(0o755)
    for path in root.rglob('*'):
        if path.is_dir(): path.chmod(0o755)
    subprocess.run(['dpkg-deb','--root-owner-group','--build',str(root),str(Path(args.output).resolve())],check=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--user',default='nexus0')
    parser.add_argument('--project',default='/home/nexus0/clawbox')
    parser.add_argument('--node-dir',default='/usr/bin')
    parser.add_argument('--npm-prefix',default='/home/nexus0/.nvm/versions/node/v24.0.0')
    parser.add_argument('--version',default='1.0.0')
    parser.add_argument('--staging',required=True)
    parser.add_argument('--output',required=True)
    build(parser.parse_args())
