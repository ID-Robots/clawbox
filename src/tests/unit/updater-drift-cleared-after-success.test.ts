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
 * other about which sha is the code on disk: `captureDriftBaseline()` sampled
 * before step 1 and `updateClawBoxAndReboot` sampled again after it, and
 * `warnUpdate` de-duplicates by code with the first observation winning. So the
 * list the owner read mixed two samples of a tree that moved between them, and
 * neither was re-asked when the run succeeded.
 *
 * The fix keeps #737's rule — the pre-run diagnosis is the customer's real
 * state and must not be thrown away — and settles both ends: the second sample
 * is gone (it only ever described the sync), and a successful run re-measures,
 * keeps every code the box is STILL drifted by, and retires the rest into one
 * past-tense history line with no imperative. A run that failed realigned
 * nothing, so it keeps its warnings exactly as captured.
 *
 * The retirement needs a POSITIVE verdict, per axis. `collectBuildIdentity`
 * never throws: a `git rev-parse origin/<branch>` that timed out comes back as
 * `checkoutVsPin: "unknown"` with no code at all — and "no code was emitted"
 * read as "the run fixed it" would be the false-success class, over the very
 * warning that says the box is broken.
 */

import { computeDrift, type DriftInputs, type DriftReport } from "@/lib/build-identity";
import { DRIFT_RESOLVED_CODE } from "@/lib/drift-codes";
import {
  reconcileDriftWarnings,
  type DriftMeasurement,
  type UpdateWarning,
} from "@/lib/updater";

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
  const dirty: UpdateWarning = {
    code: "checkout-dirty",
    message: "The code on disk has uncommitted changes, so it no longer matches any commit.",
  };
  const repinned: UpdateWarning = {
    code: "repinned",
    message: 'This box carried no update pin — pinned to the tested branch "beta" so future updates are repeatable.',
  };

  /** A box measured healthy on every axis — what a finished update leaves behind. */
  function measuredClean(over: Partial<DriftMeasurement> = {}): DriftMeasurement {
    return {
      drift: computeDrift(driftInputs({
        build: { ...driftInputs().build!, commit: DISK_SHA, shortCommit: DISK_SHA.slice(0, 7) },
        pin: { branch: "beta", source: "pin-file", commit: DISK_SHA, pinned: true },
      })),
      pinned: true,
      dirty: false,
      ...over,
    };
  }

  /** A report with the given axes and no codes — what an unreadable box produces. */
  function measuredUnknown(over: Partial<DriftMeasurement> = {}): DriftMeasurement {
    const drift: DriftReport = {
      buildVsCheckout: "unknown",
      buildIsCheckout: "unknown",
      checkoutVsPin: "unknown",
      detected: false,
      reasons: [],
      codes: [],
    };
    return { drift, pinned: true, dirty: null, ...over };
  }

  it("retires the drift the run resolved into one past-tense line", () => {
    const after = reconcileDriftWarnings([behindPin, otherCommit], measuredClean());

    expect(after.map((w) => w.code)).toEqual([DRIFT_RESOLVED_CODE]);
    const line = after[0].message;
    // The exact sentence the owner acted on, gone.
    expect(line).not.toContain("run Update");
    expect(line).toMatch(/^When this update started: /);
    expect(line).toContain("nothing further is needed");
  });

  it("keeps the shas the box was actually on, so support can still read them", () => {
    // #737's rule is that the customer's REAL pre-run state reaches a human; a
    // generic phrase cannot tell a box one commit behind from one 71 behind.
    const line = reconcileDriftWarnings([behindPin, otherCommit], measuredClean())[0].message;

    expect(line).toContain(BUILD_SHA.slice(0, 7));
    expect(line).toContain(DISK_SHA.slice(0, 7));
    expect(line).toContain("is not the tested commit for beta");
    // …with the call to action taken off the sentence that carried one.
    expect(line).toContain(`the code on disk is ${DISK_SHA.slice(0, 7)}.`);
  });

  it("keeps a code the box is STILL drifted by, with the sha measured now", () => {
    // The false-success half: a run that did not realign the box must not be
    // allowed to clear the warning that says so.
    const stillDrifted = computeDrift(driftInputs({
      build: { ...driftInputs().build!, commit: PIN_SHA, shortCommit: PIN_SHA.slice(0, 7) },
      pin: { branch: "beta", source: "pin-file", commit: DISK_SHA, pinned: true },
    }));
    const measured: DriftMeasurement = { drift: stillDrifted, pinned: true, dirty: false };

    const after = reconcileDriftWarnings([behindPin, otherCommit], measured);

    expect(after.map((w) => w.code)).toEqual(["build-from-other-commit", DRIFT_RESOLVED_CODE]);
    // Measured after the run, not the pre-run text.
    expect(after[0].message).toContain(`build made from ${PIN_SHA.slice(0, 7)}`);
    // And the history line does not claim the box is finished with.
    expect(after[1].message).not.toContain("nothing further is needed");
    expect(after[1].message).toContain("That much the update resolved.");
  });

  it("keeps checkout-behind-pin when the PIN could not be resolved", () => {
    // `collectBuildIdentity` never throws: a `git rev-parse origin/<branch>`
    // that failed or timed out comes back as `checkoutVsPin: "unknown"` with no
    // code — and an absent code is not evidence that the run fixed anything.
    const after = reconcileDriftWarnings([behindPin], measuredUnknown());

    expect(after.map((w) => w.code)).toEqual(["checkout-behind-pin"]);
    expect(after[0].message, "the pre-run sentence, unchanged").toBe(behindPin.message);
  });

  it("keeps checkout-dirty when git status could not be read", () => {
    // `dirty: null` is "we could not look", and it is falsy — so a test for the
    // absence of the code would have retired this one too.
    const after = reconcileDriftWarnings([dirty], measuredUnknown({ dirty: null }));

    expect(after.map((w) => w.code)).toEqual(["checkout-dirty"]);
  });

  it("retires no-pin once the box carries a pin, whatever the pin axis says", () => {
    // The repin is what resolves it, and `pin.pinned` is the exact negation of
    // the condition — the axis stays "unknown" on a box whose origin ref this
    // checkout cannot resolve, and that must not keep the warning alive.
    const noPin: UpdateWarning = {
      code: "no-pin",
      message: "This box records no tested branch to update to — the next update will pin it automatically.",
    };

    const after = reconcileDriftWarnings([noPin], measuredUnknown({ pinned: true }));

    expect(after.map((w) => w.code)).toEqual([DRIFT_RESOLVED_CODE]);
  });

  it("retires a build code the rebuild fixed even when the tree came back dirty", () => {
    // `computeDrift` downgrades the AGGREGATE buildVsCheckout to "drift" for an
    // uncommitted change — right for the banner, and unusable here: a stray
    // untracked file after post_update would otherwise keep "run Update to
    // realign" on the card of a box whose build IS the code on disk.
    const measured: DriftMeasurement = {
      drift: computeDrift(driftInputs({
        build: { ...driftInputs().build!, commit: DISK_SHA, shortCommit: DISK_SHA.slice(0, 7) },
        pin: { branch: "beta", source: "pin-file", commit: DISK_SHA, pinned: true },
        checkout: { ...driftInputs().checkout, dirty: true },
      })),
      pinned: true,
      dirty: true,
    };
    expect(measured.drift.buildVsCheckout, "the aggregate is dragged down by the dirty tree").toBe("drift");
    expect(measured.drift.buildIsCheckout, "the comparison itself still matches").toBe("match");

    const after = reconcileDriftWarnings([otherCommit], measured);

    expect(after.map((w) => w.code)).toEqual([DRIFT_RESOLVED_CODE]);
  });

  it("does NOT retire a build code when the comparison was never made", () => {
    // The same override promotes an UNMEASURABLE comparison out of "unknown":
    // a dirty tree sets the aggregate to "drift" whatever the build said. Only
    // `buildIsCheckout` can tell "the build matches" from "we could not look".
    const measured: DriftMeasurement = {
      drift: computeDrift(driftInputs({
        build: null,
        deployedBuildId: null,
        buildTimestampMs: null,
        stamperInCheckout: false,
        checkout: { ...driftInputs().checkout, commit: null, shortCommit: null, dirty: true },
      })),
      pinned: true,
      dirty: true,
    };
    expect(measured.drift.buildIsCheckout).toBe("unknown");

    const after = reconcileDriftWarnings([otherCommit], measured);

    expect(after.map((w) => w.code)).toEqual(["build-from-other-commit"]);
    expect(after[0].message).toBe(otherCommit.message);
  });

  it("restates a build code that moved to another build code, rather than repeating the old text", () => {
    // The four are alternatives in one if/else chain, so one condition can
    // surface under a different code after the run. Neither retiring it nor
    // showing the pre-run sentence would be true of the box.
    const measured: DriftMeasurement = {
      drift: computeDrift(driftInputs({
        build: null,
        deployedBuildId: "the-deployed-build",
        stamperInCheckout: true,
      })),
      pinned: true,
      dirty: false,
    };
    expect(measured.drift.codes).toContain("build-unstamped");

    const after = reconcileDriftWarnings([otherCommit], measured);

    expect(after.map((w) => w.code)).toEqual(["build-unstamped"]);
    expect(after[0].message).toContain("carries no build record");
  });

  it("retires nothing when the read itself threw", () => {
    expect(reconcileDriftWarnings([behindPin, otherCommit], null)).toEqual([behindPin, otherCommit]);
  });

  it("leaves warnings that are not about drift exactly where they were", () => {
    const after = reconcileDriftWarnings([repinned, behindPin], measuredClean());
    expect(after.map((w) => w.code)).toEqual(["repinned", DRIFT_RESOLVED_CODE]);
    expect(after[0]).toEqual(repinned);
  });

  it("does not invent a history line when there was no drift to resolve", () => {
    expect(reconcileDriftWarnings([repinned], measuredClean())).toEqual([repinned]);
  });
});
