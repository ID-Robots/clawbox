# Existing x64 desktop integration

This package completes service and updater integration for an existing x64
ClawBox installation without replacing its OpenClaw user service, channels,
database, network configuration, desktop, or selected providers. Build it from
reviewed source, inspect the package, then install it with the normal Debian
package manager.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/x64-migration -p 'test_*.py'
python3 scripts/x64-migration/build-package.py \
  --staging /tmp/clawbox-x64-integration-stage \
  --output /tmp/clawbox-x64-integration_1.0.4_amd64.deb
dpkg-deb --info /tmp/clawbox-x64-integration_1.0.4_amd64.deb
dpkg-deb --contents /tmp/clawbox-x64-integration_1.0.4_amd64.deb
sudo -n dpkg -i /tmp/clawbox-x64-integration_1.0.4_amd64.deb
```

The default host is `nexus0`, project `/home/nexus0/clawbox`, interpreter
`/usr/bin/node`, and package prefix
`/home/nexus0/.nvm/versions/node/v24.0.0`. Override the builder arguments for
another desktop. These non-secret paths live in root-owned
`/etc/clawbox/x64-integration.env`. The CLI wrapper checks that it runs as the
configured desktop owner before loading the owner-writable OpenClaw package.

The package installs a system `clawbox-gateway.service` bridge to the existing
user `openclaw-gateway.service`. Initial activation uses **start**, preserving
the PID of an already-running gateway. It installs a maintenance condition in
the actual user service, so updater maintenance prevents independent restarts.
All privileged core writers and guard release operations share a lock.

The package snapshots reviewed installer inputs into root-owned storage and
uses the existing SHA-256 manifest/mirror mechanism. Future updater bootstrap
fetches the fixed vendor repository into a separate root-owned Git checkout;
it never trusts the owner's checkout as root-executable source. The host
adapter remains installed across beta resets. Git fetches/builds in the live
desktop checkout run as its owner. UI rebuilds preserve the previous build,
restore it on failure, and restart only the UI to resume the existing updater.

Both **Update** and **Force full update** use this desktop contract when the
dashboard checkout matches `PROJECT_DIR` in the root-owned integration file.
The adapter owns the maintenance guard for each core step and restores an
already-running gateway before returning, even when the step refuses a new
core pin or fails validation. A later UI rebuild failure therefore cannot
strand Telegram waiting for a verification step that will never run.
Post-update checks leave a healthy gateway running. If it is unavailable,
verification tries its existing service once and reports failure if it stays
unavailable; it does not run the appliance pre-start/doctor repair chain.
The UI is unavailable during its rebuild; this desktop does not reboot.
Install integration package **1.0.4** as well as this dashboard update. Older
packages retain their installed adapter and do not gain coding-harness delivery
merely by fetching beta.

Bootstrap and post-update install the `claude-ds` wrapper from the verified
mirror as the desktop owner, preserving an existing Claude Code installation.
If Claude is missing, download the pinned Linux x64 native release over HTTPS,
verify its pinned SHA-256, then run its native installer as the owner. A checksum
mismatch or installation failure fails the update visibly. The copied wrapper defaults to this desktop's
checkout, so the Coding app and an interactive shell use the same ClawBox AI
configuration. Bootstrap delivers it before the core step restarts the gateway,
allowing the agent's MCP server to discover the coding tools on that start.
Neither the Codex CLI nor the appliance's network/service setup is installed
by this step.

The first-install pin is Claude Code **2.1.268**, with the `linux-x64` checksum
from its [release manifest](https://downloads.claude.ai/claude-code-releases/2.1.268/manifest.json).
Before changing the pin, verify that manifest's detached signature using the
[vendor's verification procedure](https://code.claude.com/docs/en/installation#verify-the-manifest-signature)
and key fingerprint `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`.
Both the version and digest are committed in the installer; runtime environment
variables cannot override them. Existing Claude installations keep their own
version and update policy.

For a wrapper repair without a full update, run the owner-only helper from the
reviewed checkout (without sudo):

```sh
bash scripts/x64-migration/install-coding-harness.sh scripts/claude-ds "$PWD"
```

The Coding app checks readiness on its next status request. A running agent's
MCP server discovers newly installed tools on its next restart.

The already-installed OpenClaw version is validated without running migrations.
The owner's idempotent backup compatibility patch is reapplied as that owner.
A changed core pin is deliberately refused before package/database modification:
a new core version requires a reviewed state snapshot and rollback workflow.
This package does not promise safe downgrades of a migrated SQLite schema.

The package also installs timezone support, the existing owner-password update
capability with root-side account validation, a tunnel wrapper that ignores
unrelated named-tunnel configuration, and an on-demand embedding service with
memory limits. It does not start the embedding service or change memory
providers. Jetson-specific update steps are skipped on this desktop.

After installation, coordinate a UI restart for its environment drop-in and a
tunnel restart for its wrapper. Neither is restarted by the package. The
existing gateway is not restarted. Check its user-service PID before and after
installation to verify this. The embedder remains stopped until requested.

Useful verification:

```sh
systemctl is-active clawbox-gateway.service
systemctl --user show openclaw-gateway.service -p MainPID -p ActiveState
/usr/local/libexec/clawbox/clawbox-root-manifest.sh --verify
sudo -n /usr/local/libexec/clawbox/clawbox-run-root-step.sh set_timezone
sudo -n /usr/local/libexec/clawbox/clawbox-run-root-step.sh fix_git_perms
```

Gateway process logs remain in the user journal:
`journalctl --user -u openclaw-gateway.service`. The system bridge's journal
records lifecycle commands; its oneshot state is not a substitute for the real
gateway's port or user-service health. Unsupported appliance-only root steps
fail explicitly rather than running the Jetson installer on this workstation.

Removing the package should be coordinated manually: the maintained user
gateway is independent of it. Do not stop or remove the bridge in the middle
of an update. Back up the replaced root template and service drop-ins before
initial installation if a complete package-level rollback is required.
