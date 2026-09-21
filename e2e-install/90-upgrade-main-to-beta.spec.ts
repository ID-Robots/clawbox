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

  test("the update leaves a root-owned mirror, and root runs out of it", async () => {
    // TASK-733. This is the one test that exercises the ROLLOUT rather than the
    // mechanism: the container has just come across the transition described in
    // docs/root-exec-mirror.md — an old build, whose dispatcher runs the tree,
    // updating to a build whose dispatcher will not. If the mirror were staged
    // after the new dispatcher rather than before it, every root step here would
    // already be failing; if it lived on /run it would be gone, because
    // rebuild_reboot restarts the box between the two halves of the update.
    const mirror = (await dockerExec(
      ["/usr/local/libexec/clawbox/clawbox-root-manifest.sh", "--mirror-path"],
      { user: "root" },
    )).trim();
    expect(mirror).toBe("/var/lib/clawbox/root-exec-mirror");

    const listing = await dockerExec([
      "bash", "-lc",
      `stat -c '%U %G %a' ${mirror} && ls ${mirror} | sort | tr '\\n' ' '`,
    ], { user: "root" });
    const [ownership, contents] = listing.trim().split("\n");
    expect(ownership, "the mirror must be root-owned or it is decorative").toBe("root root 755");
    expect(contents.trim()).toBe("config install.sh scripts");

    // The account the web server runs as must not be able to write it — that IS
    // the property, and it is worth asserting rather than inferring from a mode.
    const writable = await dockerExec([
      "bash", "-lc",
      `if echo x > ${mirror}/install.sh 2>/dev/null; then echo WRITABLE; else echo refused; fi`,
    ], { user: "clawbox" });
    expect(writable.trim()).toBe("refused");

    // ...and the record still describes the tree, which is what lets the next
    // dispatch restage the mirror at all.
    const verified = await dockerExec([
      "bash", "-lc",
      "/usr/local/libexec/clawbox/clawbox-root-manifest.sh --verify && echo recorded",
    ], { user: "root" });
    expect(verified.trim()).toBe("recorded");

    // Nothing root ran during the update came out of the clawbox-writable tree.
    // post_update is an EXEMPT step and the last one this update dispatched, so
    // its own journal is the honest place to look.
    const journal = await dockerExec([
      "bash", "-lc",
      "journalctl -u 'clawbox-root-update@post_update.service' --no-pager -o cat | tail -n 400 || true",
    ], { user: "root" });
    // Anchored so an EMPTY journal cannot pass it. The assertion below is an
    // absence, and `|| true` above means a renamed unit, a rotated journal or a
    // container without a persistent one yields "" — which satisfies any
    // absence check and proves nothing. That is the false-success class this PR
    // is about, in the test that guards it.
    //
    // The positive form is deliberately NOT asserted here: measured on a real
    // box, the clawbox-root-update@ units log no exec path at all, mirror or
    // tree, so requiring the mirror path would fail for the wrong reason. What
    // proves root ran the mirror is the case below, which drives the real
    // `sudo clawbox-run-root-step.sh` grant and watches the copy follow.
    expect(journal.trim(), "no journal for post_update — the absence check below would pass vacuously").not.toBe("");
    expect(journal).not.toMatch(/Starting.*\/home\/clawbox\/clawbox\/install\.sh/);
  });

  test("the mirror follows the tree on every dispatch, not once at install time", async () => {
    // Probe-once is one of the three defects this codebase keeps producing, and
    // a mirror staged at install time and trusted for ever would be exactly
    // that: the box would keep running the build before the update. So: change
    // a covered file, re-record it as root the way an update does, then take the
    // REAL granted path from the account the web server runs as — `sudo
    // clawbox-run-root-step.sh` — and see whether the copy root holds followed.
    //
    // `fix_git_perms` is the cheap step for this (one chown) and is on
    // WEB_ROOT_STEPS, so it goes through the same sudoers grant, launcher and
    // dispatcher an in-app update uses.
    const covered = "/home/clawbox/clawbox/config/clawbox-resource-limits.env";
    const mirrored = "/var/lib/clawbox/root-exec-mirror/config/clawbox-resource-limits.env";
    const marker = "# e2e-733-mirror-follows-the-tree";

    const before = await dockerExec([
      "bash", "-lc", `grep -c '${marker}' ${mirrored} || true`,
    ], { user: "root" });
    expect(before.trim(), "the marker must not be there before the test writes it").toBe("0");

    // The backup is taken on its own, BEFORE anything is mutated: a failure
    // here leaves the checkout untouched and there is nothing to restore. Every
    // mutation is inside the try, so a throw from the record write — which
    // happens after the file has already changed — still runs the finally. This
    // suite is `mode: "serial"`, so a checkout left modified poisons the cases
    // after it rather than failing this one.
    await dockerExec([
      "bash", "-lc", `cp ${covered} /tmp/e2e-733-covered.bak`,
    ], { user: "root" });

    try {
      await dockerExec([
        "bash", "-lc",
        `printf '\\n${marker}\\n' >> ${covered}`
        + " && /usr/local/libexec/clawbox/clawbox-root-manifest.sh --write",
      ], { user: "root" });

      const dispatched = await dockerExec([
        "bash", "-lc",
        "sudo -n /usr/local/libexec/clawbox/clawbox-run-root-step.sh fix_git_perms 2>&1"
        + " && echo DISPATCHED",
      ], { user: "clawbox" });
      expect(dispatched, dispatched).toContain("DISPATCHED");

      const after = await dockerExec([
        "bash", "-lc", `grep -c '${marker}' ${mirrored} || true`,
      ], { user: "root" });
      expect(after.trim(), "the mirror still holds the previous build's copy").toBe("1");
    } finally {
      await dockerExec([
        "bash", "-lc",
        `cp /tmp/e2e-733-covered.bak ${covered} && rm -f /tmp/e2e-733-covered.bak`
        + " && chown clawbox:clawbox " + covered
        + " && /usr/local/libexec/clawbox/clawbox-root-manifest.sh --write"
        + " && /usr/local/libexec/clawbox/clawbox-root-manifest.sh --mirror",
      ], { user: "root" });
    }
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
