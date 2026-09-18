import { describe, expect, it } from "vitest";
import {
  SETUP_MAX_STEP,
  SETUP_UPDATE_STEP,
  parseSetupProgressStep,
  updateStepPassed,
} from "@/lib/setup-progress";

describe("parseSetupProgressStep", () => {
  it("reads a step the wizard persisted", () => {
    expect(parseSetupProgressStep(3)).toBe(3);
    expect(parseSetupProgressStep("3")).toBe(3);
  });

  it("refuses anything that is not a whole step", () => {
    expect(parseSetupProgressStep(undefined)).toBeNull();
    expect(parseSetupProgressStep(null)).toBeNull();
    expect(parseSetupProgressStep("later")).toBeNull();
    expect(parseSetupProgressStep(2.5)).toBeNull();
    expect(parseSetupProgressStep(0)).toBeNull();
    expect(parseSetupProgressStep(-1)).toBeNull();
  });

  it("reads a step from a build with more screens, and refuses one as a request", () => {
    // A box is read as it is; a caller is held to this wizard's own range.
    expect(parseSetupProgressStep(SETUP_MAX_STEP + 1)).toBe(SETUP_MAX_STEP + 1);
    expect(parseSetupProgressStep(SETUP_MAX_STEP + 1, true)).toBeNull();
    expect(parseSetupProgressStep(SETUP_MAX_STEP, true)).toBe(SETUP_MAX_STEP);
  });
});

describe("updateStepPassed", () => {
  it("is false before the wizard has recorded anything", () => {
    expect(updateStepPassed({})).toBe(false);
    expect(updateStepPassed({ setup_progress_step: null })).toBe(false);
  });

  it("is false while the wizard stands on the Update step or earlier", () => {
    expect(updateStepPassed({ setup_progress_step: 1 })).toBe(false);
    expect(updateStepPassed({ setup_progress_step: SETUP_UPDATE_STEP })).toBe(false);
  });

  it("is true once the wizard has moved past it", () => {
    expect(updateStepPassed({ setup_progress_step: SETUP_UPDATE_STEP + 1 })).toBe(true);
    expect(updateStepPassed({ setup_progress_step: SETUP_MAX_STEP })).toBe(true);
  });

  it("never reads the updater's own completion record", () => {
    // `update_completed` means "a full update run finished" — it is written
    // with `update_completed_at` and /setup-api/update/status synthesises a
    // completed phase from it. This helper answers a different question and
    // must not be satisfied by, or write, that key.
    expect(updateStepPassed({ update_completed: true })).toBe(false);
  });
});
