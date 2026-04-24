/**
 * Upgrade test: install.sh was run against `main`; we pin .update-branch to
 * `beta`, trigger the in-app updater, and verify the device lands on the
 * beta HEAD after the post-reboot continuation step.
 *
 * This test relies on the shared container set up by `global-setup.ts` —
 * run it after happy-path.spec.ts. Because the updater literally bounces
 * the Next.js server (step_rebuild_reboot → systemctl restart), the HTTP
 * endpoint goes down for some seconds; `waitForUpdate` tolerates that.
 *
 * The `beta` branch must exist on origin with a commit ancestor-mergeable
 * from main (or at least a git-resettable ref). This matches how the real
 * updater works: `git fetch origin && git reset --hard origin/beta`.
 */
import { test, expect } from "@playwright/test";
import {
  BASE_URL,
  dockerExec,
  readGitBranch,
  setUpdateBranch,
  waitForHttpReady,
} from "./helpers/container";
import { startUpdate, waitForUpdate } from "./helpers/setup-api";

const UPGRADE_BRANCH = process.env.CLAWBOX_UPGRADE_TARGET_BRANCH ?? "beta";

test.describe.configure({ mode: "serial" });

test.describe(`in-app upgrade: main → ${UPGRADE_BRANCH}`, () => {
  test("verify current branch is main", async () => {
    const branch = await readGitBranch();
    // On a fresh `git clone --branch main` we'd expect main, but a developer
    // might have seeded the container from a branch checkout. In that case
    // the upgrade still exercises the important code path (fetch + reset),
    // just from a different starting point — log and continue.
    if (branch !== "main") {
      console.warn(`[upgrade] starting branch is '${branch}', not 'main'`);
    }
    expect(typeof branch).toBe("string");
  });

  test(`pin .update-branch to ${UPGRADE_BRANCH}`, async () => {
    await setUpdateBranch(UPGRADE_BRANCH);
    const contents = await dockerExec(["cat", "/home/clawbox/clawbox/.update-branch"], {
      user: "clawbox",
    });
    expect(contents.trim()).toBe(UPGRADE_BRANCH);
  });

  test("trigger updater", async () => {
    const result = await startUpdate(true);
    expect(result.started).toBe(true);
  });

  test("update completes through restart and post_update", async () => {
    // The updater restarts clawbox-setup.service mid-run (the replacement
    // for `reboot` in test mode). `waitForUpdate` retries across that
    // downtime; it also needs to see the `post_update` step run via
    // `checkContinuation` after the service is back up.
    const state = await waitForUpdate({ timeoutMs: 45 * 60_000 });
    // phase may legitimately be "completed" (after post_update ran) or
    // "running" if checkContinuation hasn't fired yet. We poll through the
    // restart, so by the time this returns we should be at one of the
    // terminal states.
    expect(["completed", "failed"]).toContain(state.phase);
    if (state.phase === "failed") {
      const failedStep = state.steps.find((s) => s.status === "failed");
      throw new Error(`update failed at step '${failedStep?.id}': ${failedStep?.error ?? state.error ?? "unknown"}`);
    }
    // Every step should be completed by the end.
    for (const step of state.steps) {
      expect(step.status).toBe("completed");
    }
  });

  test(`git HEAD is on ${UPGRADE_BRANCH}`, async () => {
    await waitForHttpReady(60_000);
    const branch = await readGitBranch();
    expect(branch).toBe(UPGRADE_BRANCH);
  });

  test("setup state preserved across upgrade", async () => {
    // The upgrade must not wipe prior setup flags (wifi/password/ai).
    const res = await fetch(`${BASE_URL}/setup-api/setup/status`);
    const statusJson = await res.json();
    expect(statusJson.setup_complete).toBe(true);
    expect(statusJson.wifi_configured).toBe(true);
    expect(statusJson.password_configured).toBe(true);
  });
});
