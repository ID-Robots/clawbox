import { describe, expect, it } from "vitest";

/**
 * TASK-757 — a box that had just updated itself correctly told its owner to
 * update again.
 *
 * Measured on the OpenClaw box, 2026-09-07, at beta `21539548`, after a clean
 * in-app update. `/setup-api/update/status` answered `phase: "completed"`,
 * `error: null`, and these two warnings:
 *
 *   checkout-behind-pin      "The code on disk (673817a) is not the tested
 *                             commit for beta (2153954)."
 *   build-from-other-commit  "This box is running a build made from 673817a
 *                             but the code on disk is 2153954 — run Update to
 *                             realign."
 *
 * Both are false about the box as it then was: `git reflog` puts the checkout
 * at `21539548` from 03:42:23, `.next/BUILD_ID` was written at 03:54:17 and
 * the running bundle carried code that exists only in that commit. The second
 * one ends in an imperative the owner would act on, over a run that had just
 * put the box exactly where it belongs.
 *
 * They are also stale in two DIFFERENT ways, which is why they contradict each
 * other about which sha is the code on disk: `captureDriftBaseline()` samples
 * before step 1 and `updateClawBoxAndReboot` samples again after it, and
 * `warnUpdate` de-duplicates by code with the first observation winning. So the
 * list the owner reads mixes two samples of a tree that moved between them,
 * and neither is re-asked when the run succeeds.
 *
 * The fix keeps #737's rule — the pre-run diagnosis is the customer's real
 * state and must not be thrown away — and settles what happens to it once the
 * run has finished: a successful run re-measures, keeps every code the box is
 * STILL drifted by (with the shas as they are now, not as they were), and
 * retires the rest into one past-tense history line with no imperative. A run
 * that failed realigned nothing, so it keeps its warnings exactly as captured.
 */

import { computeDrift, type DriftInputs } from "@/lib/build-identity";
import { reconcileDriftWarnings, type UpdateWarning } from "@/lib/updater";

const BUILD_SHA = "673817a8e0a1b2c3d4e5f60718293a4b5c6d7e8f";
const DISK_SHA = "21539548c554b30799ad6e19a94213e26eb23f2f";
const PIN_SHA = "3b4597f1aa0c9d8e7f6a5b4c3d2e1f00998877aa";

function driftInputs(over: Partial<DriftInputs> = {}): DriftInputs {
  return {
    build: {
      commit: BUILD_SHA,
      shortCommit: BUILD_SHA.slice(0, 7),
      branch: "beta",
      dirty: false,
      untracked: 0,
      committedAt: "2026-09-07T00:30:00Z",
      builtAt: "2026-09-07T00:39:00Z",
      buildId: "the-deployed-build",
      node: "v22.0.0",
      bun: "1.2.10",
      packageVersion: "3.10.0",
      hermesPin: null,
      openclawPin: null,
    },
    deployedBuildId: "the-deployed-build",
    buildTimestampMs: Date.parse("2026-09-07T00:39:00Z"),
    checkout: {
      commit: DISK_SHA,
      shortCommit: DISK_SHA.slice(0, 7),
      branch: "beta",
      dirty: false,
      committedAt: "2026-09-07T00:42:00Z",
    },
    pin: { branch: "beta", source: "pin-file", commit: PIN_SHA, pinned: true },
    stamperInCheckout: true,
    ...over,
  };
}

function reasonFor(code: string, input: DriftInputs): string {
  const drift = computeDrift(input);
  const at = drift.codes.indexOf(code as never);
  expect(at, `expected ${code} in ${JSON.stringify(drift.codes)}`).toBeGreaterThanOrEqual(0);
  return drift.reasons[at];
}

/**
 * Half one of the card: each warning must name its subjects correctly, tested
 * against a fixture where the build, the code on disk and the pin are three
 * DIFFERENT commits — the only shape in which a mislabelled subject is
 * visible at all.
 */
describe("drift warnings name the right sha for the right fact", () => {
  it("puts the build first and the checkout second, in every combination", () => {
    const combinations: Array<[string, DriftInputs]> = [
      ["build, disk and pin all different", driftInputs()],
      ["the build was made from the pinned commit", driftInputs({
        build: { ...driftInputs().build!, commit: PIN_SHA, shortCommit: PIN_SHA.slice(0, 7) },
      })],
      ["the disk is dirty as well", driftInputs({
        checkout: { ...driftInputs().checkout, dirty: true },
      })],
    ];

    for (const [name, input] of combinations) {
      const build = reasonFor("build-from-other-commit", input);
      expect(build, name).toContain(`build made from ${input.build!.commit!.slice(0, 7)}`);
      expect(build, name).toContain(`the code on disk is ${input.checkout.commit!.slice(0, 7)}`);
    }
  });

  it("names the checkout as the disk and the pin as the tested commit", () => {
    const input = driftInputs();
    const pin = reasonFor("checkout-behind-pin", input);
    expect(pin).toContain(`The code on disk (${DISK_SHA.slice(0, 7)})`);
    expect(pin).toContain(`not the tested commit for beta (${PIN_SHA.slice(0, 7)})`);
    // The one the box contradicted: the sha the OTHER warning calls the build
    // must never be introduced here as the code on disk.
    expect(pin).not.toContain(BUILD_SHA.slice(0, 7));
  });
});

/**
 * Half two: what a FINISHED run does with the diagnosis it took before step 1.
 */
describe("reconcileDriftWarnings", () => {
  const behindPin: UpdateWarning = {
    code: "checkout-behind-pin",
    message: `The code on disk (${BUILD_SHA.slice(0, 7)}) is not the tested commit for beta (${DISK_SHA.slice(0, 7)}).`,
  };
  const otherCommit: UpdateWarning = {
    code: "build-from-other-commit",
    message: `This box is running a build made from ${BUILD_SHA.slice(0, 7)} but the code on disk is ${DISK_SHA.slice(0, 7)} — run Update to realign.`,
  };
  const repinned: UpdateWarning = {
    code: "repinned",
    message: 'This box carried no update pin — pinned to the tested branch "beta" so future updates are repeatable.',
  };

  it("retires the drift the run resolved into one past-tense line", () => {
    const after = reconcileDriftWarnings([behindPin, otherCommit], []);

    expect(after.map((w) => w.code)).toEqual(["drift-resolved"]);
    const line = after[0].message;
    // The exact sentence the owner acted on, gone.
    expect(line).not.toContain("run Update");
    expect(line).toMatch(/^When this update started, /);
    expect(line).toContain("was not the tested commit");
    expect(line).toContain("a different commit than the code on disk");
  });

  it("keeps a code the box is STILL drifted by, with the sha measured now", () => {
    // The false-success half: a run that did not realign the box must not be
    // allowed to clear the warning that says so.
    const live: UpdateWarning = {
      code: "build-from-other-commit",
      message: `This box is running a build made from ${PIN_SHA.slice(0, 7)} but the code on disk is ${DISK_SHA.slice(0, 7)} — run Update to realign.`,
    };

    const after = reconcileDriftWarnings([behindPin, otherCommit], [live]);

    expect(after.map((w) => w.code)).toEqual(["build-from-other-commit", "drift-resolved"]);
    // Measured after the run, not the pre-run text.
    expect(after[0].message).toBe(live.message);
  });

  it("retires nothing when the box could not be measured", () => {
    // A git shell-out that timed out is not evidence that the box is healthy.
    expect(reconcileDriftWarnings([behindPin, otherCommit], null)).toEqual([behindPin, otherCommit]);
  });

  it("leaves warnings that are not about drift exactly where they were", () => {
    const after = reconcileDriftWarnings([repinned, behindPin], []);
    expect(after.map((w) => w.code)).toEqual(["repinned", "drift-resolved"]);
    expect(after[0]).toEqual(repinned);
  });

  it("does not invent a history line when there was no drift to resolve", () => {
    expect(reconcileDriftWarnings([repinned], [])).toEqual([repinned]);
  });
});
