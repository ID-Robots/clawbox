/**
 * Upgrade test: the general suite first installs the checked-out PR head so
 * all preceding installer/UI assertions exercise the code under review. This
 * serial tail then uses that live updater to establish a real `main` baseline,
 * pins .update-branch to the target, and verifies main → target through the
 * post-reboot continuation step.
 *
 * This test relies on the shared container set up by `global-setup.ts` —
 * run it after happy-path.spec.ts.
 *
 * The HTTP endpoint goes down for MINUTES, not seconds, and by design. The
 * updater stops clawbox-setup.service for the whole rebuild
 * (`do_rebuild`) and starts it again at the end (`step_rebuild_reboot` →
 * `systemctl restart`, the test-mode stand-in for the reboot). Nothing brings
 * it back in between since TASK-728 removed `clawbox-gateway.service`'s
 * `Wants=clawbox-setup.service` — which is the point of that change, and which
 * used to be why `/setup-api/update/status` kept answering across a rebuild at
 * all (on the PRE-UPDATE build, which is the defect it fixes).
 *
 * So both `waitForUpdate` calls below pass an explicit downtime budget rather
 * than the helper's default of 60 consecutive failures (~183 s): `bun install`
 * plus `next build` on a qemu-x86 fallback runner is well past that, and the
 * default would report `update status unreachable` over an update that
 * completed. 420 × 3 s = 21 min, sized on the updater's own
 * REBUILD_TAKEOVER_TIMEOUT_MS (20 min) and still inside the 45-minute ceiling.
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

/**
 * How many consecutive unanswered status polls (3 s apart) are a rebuild rather
 * than a broken box — see the header. 21 minutes, sized on the updater's own
 * REBUILD_TAKEOVER_TIMEOUT_MS.
 */
const REBUILD_DOWNTIME_POLLS = 420;

test.describe.configure({ mode: "serial" });

test.describe(`in-app upgrade: main → ${UPGRADE_BRANCH}`, () => {
  test("establish a real main baseline through the in-app updater", async () => {
    // Do not make the whole suite install stale main just to create this one
    // precondition: security/UI tests before this file must run against the PR
    // head. Transition this already-configured device to main through the same
    // update path a field device uses, preserving its setup state.
    // This suite initially installs the PR head (OpenClaw 2 / schema 2026.8)
    // so every general assertion exercises the code under review. `main`
    // currently pins OpenClaw 2026.7, whose binary deliberately refuses to
    // touch config last written by 2026.8. A field device should never be
    // downgraded this way; this is only the ephemeral harness constructing a
    // clean historical baseline. Archive the future OpenClaw home while
    // leaving ClawBox's data/config.json (the setup state this test promises to
    // preserve) untouched, then let main create the store shape it understands.
    await dockerExec([
      "bash", "-lc",
      "set -e; systemctl stop clawbox-gateway.service || true; " +
      "test ! -e /home/clawbox/.openclaw-e2e-future; " +
      "if [ -e /home/clawbox/.openclaw ]; then mv /home/clawbox/.openclaw /home/clawbox/.openclaw-e2e-future; fi; " +
      "install -d -o clawbox -g clawbox -m 700 /home/clawbox/.openclaw",
    ], { user: "root" });

    await setUpdateBranch("main");
    const result = await startUpdate(true);
    expect(result.started).toBe(true);

    const state = await waitForUpdate({ timeoutMs: 45 * 60_000, maxConsecutiveFetchErrors: REBUILD_DOWNTIME_POLLS });
    expect(["completed", "failed"]).toContain(state.phase);
    if (state.phase === "failed") {
      const failedStep = state.steps.find((step) => step.status === "failed");
      throw new Error(
        `main baseline failed at step '${failedStep?.id}': ${failedStep?.error ?? state.error ?? "unknown"}`,
      );
    }
    for (const step of state.steps) {
      expect(step.status).toBe("completed");
    }
    await waitForHttpReady(60_000);
  });

  test("verify current branch is main", async () => {
    const branch = await readGitBranch();
    expect(branch, "the upgrade must exercise main → target, not target → itself").toBe("main");
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
    // `checkContinuation`, which the server's own boot hook fires a few
    // seconds after it is back up (our status polls are only the fallback).
    const state = await waitForUpdate({ timeoutMs: 45 * 60_000, maxConsecutiveFetchErrors: REBUILD_DOWNTIME_POLLS });
    // `waitForUpdate` returns only a terminal phase — "completed" once
    // post_update and the checks after it ran, or "failed" — polling through
    // the restart and the resumed second half to get there.
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
