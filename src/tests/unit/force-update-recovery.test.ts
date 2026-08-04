import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = process.cwd();
const FORCE_UPDATE = fs.readFileSync(path.join(REPO, "scripts/force-update.sh"), "utf-8");
const CONTINUATION = fs.readFileSync(path.join(REPO, "scripts/update-continuation.sh"), "utf-8");
const SETUP_UNIT = fs.readFileSync(path.join(REPO, "config/clawbox-setup.service"), "utf-8");

describe("force-update recovery contract", () => {
  it("warns about the exact destructive and preserved boundaries before cleanup", () => {
    const warning = FORCE_UPDATE.indexOf("DESTRUCTIVE RECOVERY");
    const cleanup = FORCE_UPDATE.indexOf("reset --hard HEAD");
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(warning).toBeLessThan(cleanup);
    expect(FORCE_UPDATE).toContain("untracked, non-ignored files and directories will be deleted");
    expect(FORCE_UPDATE).toContain("no supported backup/restore hook");
    expect(FORCE_UPDATE).toContain("Git-ignored device state");
    expect(FORCE_UPDATE.slice(warning, cleanup)).toContain("sleep 5");
  });

  it("restores updater code before using the existing authenticated full-update route", () => {
    expect(FORCE_UPDATE.indexOf("bun run build")).toBeLessThan(
      FORCE_UPDATE.indexOf("/setup-api/update/run"),
    );
    expect(FORCE_UPDATE).toContain("Authorization: Bearer %s");
    expect(FORCE_UPDATE).toContain('-H "@$AUTH_HEADER_FILE"');
    expect(FORCE_UPDATE).not.toContain('-H "Authorization: Bearer $MCP_TOKEN"');
    expect(FORCE_UPDATE).toContain("--data-binary '{\"force\":true}'");
    expect(FORCE_UPDATE).toContain("Update already in progress");
    expect(FORCE_UPDATE).toContain('"phase"[[:space:]]*:[[:space:]]*"running"');
    expect(FORCE_UPDATE).toContain("Full update is complete ONLY when the System Update UI reports completion");
    expect(FORCE_UPDATE).toContain("OpenClaw has not yet been verified");
    expect(FORCE_UPDATE).not.toContain("recovery-handoff");
  });

  it("forces the normal updater even when the checkout is already current", () => {
    // The handoff is unconditional after a successful rebuild; it does not
    // use git HEAD equality or the stale update_completed flag as a shortcut.
    const rebuilt = FORCE_UPDATE.indexOf("Updater UI restored");
    const handoff = FORCE_UPDATE.indexOf("/setup-api/update/run");
    expect(rebuilt).toBeGreaterThanOrEqual(0);
    expect(handoff).toBeGreaterThan(rebuilt);
    expect(FORCE_UPDATE.slice(rebuilt, handoff)).toContain("--data-binary '{\"force\":true}'");
  });

  it("requires an exact setup-status 200 before handoff", () => {
    expect(FORCE_UPDATE).toContain("-w '%{http_code}'");
    expect(FORCE_UPDATE).toContain('[ "$SETUP_STATUS" = "200" ]');
  });

  it("wires a headless authenticated continuation after reboot", () => {
    expect(SETUP_UNIT).toContain("ExecStartPost=-/bin/bash /home/clawbox/clawbox/scripts/update-continuation.sh");
    expect(CONTINUATION).toContain("update_needs_continuation");
    expect(CONTINUATION).toContain("Authorization: Bearer %s");
    expect(CONTINUATION).toContain('-H "@$AUTH_HEADER_FILE"');
    expect(CONTINUATION).not.toContain('-H "Authorization: Bearer $TOKEN"');
    expect(CONTINUATION).toContain("/setup-api/update/status");
    expect(CONTINUATION).not.toContain("/setup-api/update/run");
  });

  it("keeps the startup helper dormant when no continuation is pending", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-continuation-"));
    const data = path.join(root, "data");
    const bin = path.join(root, "bin");
    const curlLog = path.join(root, "curl.log");
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ setup_complete: true }));
    fs.writeFileSync(path.join(data, ".mcp-token"), "secret-token-that-must-not-leak");
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh\necho "$@" >> "${curlLog}"\nexit 0\n`, { mode: 0o755 });

    const result = spawnSync("/bin/bash", [path.join(REPO, "scripts/update-continuation.sh")], {
      env: { ...process.env, CLAWBOX_ROOT: root, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(curlLog)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("authenticates one headless status request without placing the bearer in curl argv", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-continuation-"));
    const data = path.join(root, "data");
    const bin = path.join(root, "bin");
    const curlLog = path.join(root, "curl.log");
    const token = "secret-token-that-must-not-leak";
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ update_needs_continuation: "old-build" }));
    fs.writeFileSync(path.join(data, ".mcp-token"), token);
    fs.writeFileSync(
      path.join(bin, "curl"),
      `#!/bin/sh\nprintf 'ARGS=%s\\n' "$*" >> "${curlLog}"\nfor arg in "$@"; do case "$arg" in @*) printf 'HEADER=' >> "${curlLog}"; cat "\${arg#@}" >> "${curlLog}";; esac; done\nexit 0\n`,
      { mode: 0o755 },
    );

    const result = spawnSync("/bin/bash", [path.join(REPO, "scripts/update-continuation.sh")], {
      env: { ...process.env, CLAWBOX_ROOT: root, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    const log = fs.readFileSync(curlLog, "utf-8");
    expect(log).toContain("/setup-api/update/status");
    expect(log).toContain(`HEADER=Authorization: Bearer ${token}`);
    expect(log.match(/^ARGS=.*$/m)?.[0]).not.toContain(token);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
