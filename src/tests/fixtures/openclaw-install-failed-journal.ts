/**
 * A failed `openclaw_install` root step, as `journalctl -o cat` prints it: 67
 * of the 317 entries a box wrote for this step on 2026-11-23, during an update
 * from an older beta to the 2026.11.5 pin. They are kept in order, word for
 * word; only the timestamp/host/process prefix of `-o short-iso` is gone, and
 * the entries that carried run ids were left out.
 *
 * Kept: entries 1-50 (the pin, the npm install with npm's five-line "new major
 * version" banner at 30-34, then six sudo/PAM lines, the preflight and the
 * start of doctor), five of doctor's progress lines (54, 196, 206-207, 210,
 * 274), and the last eleven (307-317): doctor's verdict, the installer's own
 * `Error:` line and systemd's epilogue.
 *
 * What the System Update page showed for it was "npm notice": entry 34, the
 * last line a reader of the window's FIRST 40 entries keeps once the sudo/PAM
 * lines are dropped. The installer's reason is entry 313.
 */
export const OPENCLAW_INSTALL_FAILED_JOURNAL: readonly string[] = [
  "Starting ClawBox Root Update Step (openclaw_install)...",
  "  Pinned OpenClaw target from /var/lib/clawbox/root-exec-mirror/config/openclaw-target.txt: 2026.11.5",
  "  Node.js v24.22.2 satisfies OpenClaw engine requirements",
  "pam_unix(runuser:session): session opened for user clawbox(uid=1000) by (uid=0)",
  "pam_unix(runuser:session): session closed for user clawbox",
  "  Installed: OpenClaw 2026.10.9 (8b18b55), Target: 2026.11.5",
  "  OpenClaw refresh: full path (the core on the box answers 2026.10.9, not 2026.11.5)",
  "    root : PWD=/ ; USER=clawbox ; COMMAND=/usr/bin/env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user show openclaw-gateway.service -p LoadState -p ActiveState",
  "pam_unix(sudo:session): session opened for user clawbox(uid=1000) by (uid=0)",
  "pam_unix(sudo:session): session closed for user clawbox",
  "    root : PWD=/ ; USER=clawbox ; COMMAND=/usr/bin/rm -rf -- /home/clawbox/.npm-global/.openclaw-stage",
  "pam_unix(sudo:session): session opened for user clawbox(uid=1000) by (uid=0)",
  "pam_unix(sudo:session): session closed for user clawbox",
  "    root : PWD=/ ; USER=clawbox ; COMMAND=/usr/bin/mkdir -p -- /home/clawbox/.npm-global/.openclaw-stage",
  "pam_unix(sudo:session): session opened for user clawbox(uid=1000) by (uid=0)",
  "pam_unix(sudo:session): session closed for user clawbox",
  "    root : PWD=/ ; USER=clawbox ; COMMAND=/usr/bin/npm install -g openclaw@2026.11.5 --prefix /home/clawbox/.npm-global/.openclaw-stage",
  "pam_unix(sudo:session): session opened for user clawbox(uid=1000) by (uid=0)",
  "npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead",
  "added 361 packages in 47s",
  "113 packages are looking for funding",
  "  run `npm fund` for details",
  "npm warn install-scripts 4 packages have install scripts not yet covered by allowScripts:",
  "npm warn install-scripts   @google/genai@2.30.0 (preinstall: echo 'preinstall: no-op')",
  "npm warn install-scripts   esbuild@0.28.2 (postinstall: node install.js)",
  "npm warn install-scripts   protobufjs@7.6.6 (postinstall: node scripts/postinstall)",
  "npm warn install-scripts   openclaw@2026.11.5 (preinstall: node scripts/preinstall-package-manager-warning.mjs; postinstall: node scripts/postinstall-bundled-plugins.mjs)",
  "npm warn install-scripts",
  "npm warn install-scripts Run `npm install -g --allow-scripts=@google/genai,esbuild,protobufjs,openclaw` to allow these scripts once, or `npm config set allow-scripts=@google/genai,esbuild,protobufjs,openclaw --location=user` to allow them for all global installs.",
  "npm notice",
  "npm notice New major version of npm available! 11.19.1 -> 12.2.3",
  "npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.3",
  "npm notice To update run: npm install -g npm@12.2.3",
  "npm notice",
  "pam_unix(sudo:session): session closed for user clawbox",
  "pam_unix(runuser:session): session opened for user clawbox(uid=1000) by (uid=0)",
  "pam_unix(runuser:session): session closed for user clawbox",
  "    root : PWD=/ ; USER=clawbox ; COMMAND=/usr/bin/python3 -I - preflight --core-pkg /home/clawbox/.npm-global/.openclaw-stage/lib/node_modules/openclaw/package.json --state-dir /home/clawbox/.openclaw --config /home/clawbox/.openclaw/openclaw.json --data-dir /home/clawbox/clawbox/data",
  "pam_unix(sudo:session): session opened for user clawbox(uid=1000) by (uid=0)",
  "pam_unix(sudo:session): session closed for user clawbox",
  "  [db-maintenance] OpenClaw 2026.11.5 migrates 3 database(s), 112.1 MB in all; it needs about 1.7 GB free and 331.6 GB is free",
  "  OpenClaw installed: OpenClaw 2026.11.5 (e13cf15)",
  "  Running openclaw doctor --fix (OpenClaw 2 config + session migrations)...",
  "    root : PWD=/ ; USER=clawbox ; COMMAND=/usr/bin/env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user show openclaw-gateway.service -p LoadState -p ActiveState",
  "pam_unix(sudo:session): session opened for user clawbox(uid=1000) by (uid=0)",
  "pam_unix(sudo:session): session closed for user clawbox",
  "    root : PWD=/ ; USER=clawbox ; COMMAND=/usr/bin/env OPENCLAW_STATE_DIR=/home/clawbox/.openclaw OPENCLAW_CONFIG_PATH=/home/clawbox/.openclaw/openclaw.json OPENCLAW_SERVICE_REPAIR_POLICY=external /home/clawbox/.npm-global/bin/openclaw doctor --fix --non-interactive",
  "pam_unix(sudo:session): session opened for user clawbox(uid=1000) by (uid=0)",
  "pam_unix(sudo:session): session closed for user clawbox",
  "Doctor: startup",
  "Doctor: maintenance begin",
  "Doctor: plugin convergence",
  "│  - Refreshed stale configured plugin \"codex\" from  │",
  "│    @openclaw/codex@2026.11.5.                      │",
  "[state-migrations] Plugin \"codex\" data/settings upgrade is unfinished: The configured plugin package is missing or has not converged. Your existing data and settings have been kept. Run \"openclaw update repair\", then \"openclaw doctor --fix\" to retry the upgrade. pluginId=codex reason=\"The configured plugin package is missing or has not converged.\" action=\"openclaw update repair\" status=pending",
  "[state-migrations] Plugin \"codex\" data/settings upgrade is unfinished: The installed plugin has not confirmed that its saved data and settings are ready for this version. If Doctor cannot finish the upgrade, report this warning to the plugin maintainer. Your existing data and settings have been kept. Run \"openclaw doctor --fix\" to retry the upgrade. pluginId=codex reason=\"The installed plugin has not confirmed that its saved data and settings are ready for this version. If Doctor cannot finish the upgrade, report this warning to the plugin maintainer.\" action=\"openclaw doctor --fix\" status=pending",
  "Doctor: maintenance finish",
  "Doctor could not complete maintenance. Check the reported service state and resolve the failure.",
  "Doctor: maintenance release",
  "Plugin migration obligations changed during migration input publication. expected=[codex], current=[codex], changed=[codex:command, codex:reason]. Retained inputs remain protected; run \"openclaw doctor --fix\" after the other repair finishes.",
  "  [db-maintenance] recorded the migration as incomplete (degraded)",
  "pam_unix(sudo:session): session closed for user clawbox",
  "Error: OpenClaw migration did not complete; leaving the gateway stopped. Resolve the reported blocker and Retry before rebuilding.",
  "clawbox-root-update@openclaw_install.service: Main process exited, code=exited, status=1/FAILURE",
  "clawbox-root-update@openclaw_install.service: Failed with result 'exit-code'.",
  "Failed to start ClawBox Root Update Step (openclaw_install).",
  "clawbox-root-update@openclaw_install.service: Consumed 3min 27.984s CPU time.",
];

/** The installer's own reason in that journal (entry 313). */
export const OPENCLAW_INSTALL_FAILED_REASON =
  "Error: OpenClaw migration did not complete; leaving the gateway stopped. Resolve the reported blocker and Retry before rebuilding.";
