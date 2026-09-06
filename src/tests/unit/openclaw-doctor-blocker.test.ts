import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  LEGACY_EXEC_APPROVALS_NAMES,
  LEGACY_EXEC_APPROVALS_RE,
  legacyExecApprovalsBlocker,
} from "@/lib/openclaw-doctor-blocker";

/**
 * TASK-754. The file the owner is asked to move aside by hand is named in
 * Settings → System Update, so getting it WRONG is worse than saying nothing:
 * an owner who moves a file that was not blocking anything has lost his
 * approvals and gained no gateway.
 */
describe("which exec-approvals file is blocking openclaw doctor", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "clawbox-doctor-blocker-"));
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("takes the path from the core's own sentence, whatever this box's layout is", () => {
    // The one source that cannot be wrong: the gate tripped over THAT file.
    const said = "Legacy exec approvals exist at /srv/openclaw-state/exec-approvals.json."
      + " Run `openclaw doctor --fix` with OPENCLAW_STATE_DIR set to /srv/openclaw-state"
      + " before using exec approvals.";

    expect(legacyExecApprovalsBlocker(said, home)).toBe("/srv/openclaw-state/exec-approvals.json");
  });

  it("falls back to the claim file a killed import left behind", () => {
    // A doctor killed before it printed anything says nothing, and the claim is
    // the name the blocker carries mid-import — refused exactly as the original.
    const claim = path.join(home, "exec-approvals.json.doctor-importing");
    writeFileSync(claim, "{}");

    expect(legacyExecApprovalsBlocker("", home)).toBe(claim);
  });

  it("names the canonical path rather than nothing when neither can be read", () => {
    // The owner is always given a file to look at: a sentence about a file with
    // no name is not a manual step.
    expect(legacyExecApprovalsBlocker("", home)).toBe(path.join(home, "exec-approvals.json"));
  });

  it("prefers the plain name over the claim when both are on disk", () => {
    writeFileSync(path.join(home, "exec-approvals.json"), "{}");
    writeFileSync(path.join(home, "exec-approvals.json.doctor-importing"), "{}");

    expect(legacyExecApprovalsBlocker("", home)).toBe(path.join(home, "exec-approvals.json"));
  });

  it("matches the core's sentence in either case, and nothing else", () => {
    // Fail-safe by construction: a reworded upstream sentence reverts every
    // reader to its old, stricter behaviour rather than to a wrong verdict.
    expect(LEGACY_EXEC_APPROVALS_RE.test("legacy EXEC approvals exist at /x")).toBe(true);
    expect(LEGACY_EXEC_APPROVALS_RE.test("Legacy exec approval records exist at /x")).toBe(false);
    expect(LEGACY_EXEC_APPROVALS_NAMES).toEqual([
      "exec-approvals.json",
      "exec-approvals.json.doctor-importing",
    ]);
  });

  it("keeps the shell's two names and this module's in step", () => {
    // `scripts/gateway-pre-start.sh` clears the same two names on every boot,
    // and the sentence this module builds tells the owner about the one it left
    // behind. Two lists for one fact is how they come to disagree.
    const script = readFileSync(path.resolve(process.cwd(), "scripts/gateway-pre-start.sh"), "utf-8");
    expect(script).toContain('CLAWBOX_EXEC_APPROVALS_FILE="$OPENCLAW_STATE_DIR/exec-approvals.json"');
    expect(script).toContain('CLAWBOX_EXEC_APPROVALS_CLAIM="$CLAWBOX_EXEC_APPROVALS_FILE.doctor-importing"');
  });
});
