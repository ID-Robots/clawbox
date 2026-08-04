import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = process.cwd();
const FORCE_UPDATE = fs.readFileSync(path.join(REPO, "scripts/force-update.sh"), "utf-8");

describe("force-update recovery contract", () => {
  it("warns about the exact destructive and preserved boundaries before cleanup", () => {
    const warning = FORCE_UPDATE.indexOf("DESTRUCTIVE RECOVERY");
    const cleanup = FORCE_UPDATE.indexOf("reset --hard HEAD");
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(warning).toBeLessThan(cleanup);
    expect(FORCE_UPDATE).toContain("untracked, non-ignored files and directories will be deleted");
    expect(FORCE_UPDATE).toContain("no supported backup/restore hook");
    expect(FORCE_UPDATE).toContain("Git-ignored device state");
    expect(FORCE_UPDATE.slice(warning, cleanup)).toContain("sleep 10");
  });

  it("restores updater code and the UI without starting the full updater", () => {
    const build = FORCE_UPDATE.indexOf("$BUN_BIN run build");
    const restart = FORCE_UPDATE.indexOf("systemctl restart clawbox-setup");
    const restored = FORCE_UPDATE.indexOf("Updater UI restored");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(restart).toBeGreaterThan(build);
    expect(restored).toBeGreaterThan(restart);
    expect(FORCE_UPDATE).not.toContain("/setup-api/update/run");
    expect(FORCE_UPDATE).not.toContain("Full updater handoff accepted");
  });

  it("does not skip UI recovery when the checkout is already current", () => {
    expect(FORCE_UPDATE).toContain("reset --hard $UPSTREAM");
    expect(FORCE_UPDATE).toContain("$BUN_BIN run build");
    expect(FORCE_UPDATE).not.toContain("HEAD_SHA_BEFORE");
    expect(FORCE_UPDATE).not.toContain("Already up to date");
  });

  it("states the incomplete boundary and gives the exact normal UI action", () => {
    expect(FORCE_UPDATE).toContain("RECOVERY IS INCOMPLETE");
    expect(FORCE_UPDATE).toContain("full ClawBox updater has NOT run");
    expect(FORCE_UPDATE).toContain("OpenClaw has NOT been updated");
    expect(FORCE_UPDATE).toContain("Post-update gateway verification has NOT run");
    expect(FORCE_UPDATE).toContain("Reload http://clawbox.local and sign in");
    expect(FORCE_UPDATE).toContain("Open Settings, then System Update");
    expect(FORCE_UPDATE).toContain('Click "Update everything"');
    expect(FORCE_UPDATE).toContain('UI to report "Update complete"');
    expect(FORCE_UPDATE).not.toContain("[force-update] Done.");
  });
});
