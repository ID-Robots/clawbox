import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * The web side of the unified image's `unselected` lock (TASK-1149): what
 * every reader makes of a box that carries both agents and has not chosen
 * one, and the edition-select library the wizard's route is built on.
 */

let dir: string;
let lockPath: string;
let root: string;

function writeLock(body: string): void {
  fs.writeFileSync(lockPath, body);
}

function writePending(body: string): void {
  fs.writeFileSync(path.join(dir, "edition-select.pending"), body);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-unselected-"));
  lockPath = path.join(dir, "edition.env");
  root = path.join(dir, "clawbox");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.CLAWBOX_EDITION_FILE = lockPath;
  process.env.CLAWBOX_ROOT = root;
  delete process.env.CLAWBOX_EDITION;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CLAWBOX_EDITION_FILE;
  delete process.env.CLAWBOX_EDITION;
  delete process.env.CLAWBOX_ROOT;
  vi.unstubAllGlobals();
});

describe("readEditionSource on an unselected lock", () => {
  it("reports no SKU: the defaulted openclaw answer, flagged unselected", async () => {
    writeLock("CLAWBOX_EDITION=unselected\n");
    const { readEditionSource, readEdition, hasHermesHarness, isEditionUnselected } = await import("@/lib/edition-source");
    expect(readEditionSource()).toEqual({ edition: "openclaw", defaulted: true, unselected: true });
    expect(readEdition()).toBe("openclaw");
    expect(hasHermesHarness()).toBe(false);
    expect(isEditionUnselected()).toBe(true);
  });

  it("carries the order hint, normalised, and only while unselected", async () => {
    writeLock("CLAWBOX_EDITION=unselected\nCLAWBOX_EDITION_HINT=Hermes\n");
    const { readEditionSource } = await import("@/lib/edition-source");
    expect(readEditionSource()).toEqual({ edition: "openclaw", defaulted: true, unselected: true, hint: "hermes" });
  });

  it("ignores a hint that is not an agent", async () => {
    writeLock("CLAWBOX_EDITION=unselected\nCLAWBOX_EDITION_HINT=dual\n");
    const { readEditionSource } = await import("@/lib/edition-source");
    expect(readEditionSource().hint).toBeUndefined();
  });

  it("ignores a hint left in a lock that names an agent", async () => {
    writeLock("CLAWBOX_EDITION=hermes\nCLAWBOX_EDITION_HINT=openclaw\n");
    const { readEditionSource } = await import("@/lib/edition-source");
    expect(readEditionSource()).toEqual({ edition: "hermes", defaulted: false });
  });

  it("is honoured from the root-owned lock ONLY, never from the environment", async () => {
    // No lock file: a user-writable .env must not put a box in front of the step.
    process.env.CLAWBOX_EDITION = "unselected";
    const { readEditionSource } = await import("@/lib/edition-source");
    expect(readEditionSource()).toEqual({ edition: "openclaw", defaulted: true });
  });

  it("wins over a conflicting environment, like any lock value", async () => {
    writeLock("CLAWBOX_EDITION=unselected\n");
    process.env.CLAWBOX_EDITION = "hermes";
    const { readEditionSource } = await import("@/lib/edition-source");
    expect(readEditionSource().unselected).toBe(true);
  });

  it("follows the lock when the step re-bakes it", async () => {
    writeLock("CLAWBOX_EDITION=unselected\n");
    fs.utimesSync(lockPath, 1_700_000_000, 1_700_000_000);
    const { readEditionSource } = await import("@/lib/edition-source");
    expect(readEditionSource().unselected).toBe(true);
    writeLock("CLAWBOX_EDITION=hermes\n");
    fs.utimesSync(lockPath, 1_700_000_100, 1_700_000_100);
    expect(readEditionSource()).toEqual({ edition: "hermes", defaulted: false });
  });

  it("leaves the three shipped editions exactly as they were", async () => {
    const { readEditionSource } = await import("@/lib/edition-source");
    for (const edition of ["openclaw", "hermes", "dual"] as const) {
      writeLock(`CLAWBOX_EDITION=${edition}\n`);
      fs.utimesSync(lockPath, 1_700_000_000 + edition.length, 1_700_000_000 + edition.length);
      expect(readEditionSource()).toEqual({ edition, defaulted: false });
    }
  });
});

describe("the other readers on an unselected box", () => {
  it("the harness swap has nothing to swap from", async () => {
    writeLock("CLAWBOX_EDITION=unselected\n");
    const { readEditionSource } = await import("@/lib/edition-source");
    const { swapTargetFor } = await import("@/lib/harness-swap");
    expect(swapTargetFor(readEditionSource())).toBeNull();
  });

  it("the active harness is the unpinned default, never a known answer", async () => {
    writeLock("CLAWBOX_EDITION=unselected\n");
    const { getActiveHarnessSource } = await import("@/lib/harness");
    expect(await getActiveHarnessSource()).toMatchObject({ active: "openclaw", defaulted: true });
  });

  it("the MCP registers the smaller tool set and claims no app set", async () => {
    writeLock("CLAWBOX_EDITION=unselected\n");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { resolveEdition, resolveAppHarness } = await import("../../../mcp/lib/edition");
    expect(resolveEdition("openclaw")).toBe("hermes");
    expect(await resolveAppHarness("http://127.0.0.1", null)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("readEditionChoice", () => {
  it("needs the step while the lock reads unselected, with the hint", async () => {
    writeLock("CLAWBOX_EDITION=unselected\nCLAWBOX_EDITION_HINT=hermes\n");
    const { readEditionChoice } = await import("@/lib/edition-select");
    expect(readEditionChoice()).toEqual({ needed: true, unselected: true, pending: null, edition: null, hint: "hermes" });
  });

  it.each(["openclaw", "hermes", "dual"])("never needs it on a box locked to %s", async (edition) => {
    writeLock(`CLAWBOX_EDITION=${edition}\n`);
    const { readEditionChoice } = await import("@/lib/edition-select");
    expect(readEditionChoice()).toEqual({ needed: false, unselected: false, pending: null, edition, hint: null });
  });

  it("never needs it on a box with no lock at all (dev, CI, pre-3.x)", async () => {
    const { readEditionChoice } = await import("@/lib/edition-select");
    expect(readEditionChoice().needed).toBe(false);
  });

  it("needs it again for an activation cut short after the lock flipped", async () => {
    writeLock("CLAWBOX_EDITION=hermes\n");
    writePending("TARGET_EDITION=hermes\n");
    const { readEditionChoice } = await import("@/lib/edition-select");
    expect(readEditionChoice()).toEqual({ needed: true, unselected: false, pending: "hermes", edition: "hermes", hint: null });
  });

  it("treats a marker beside a lock naming something else as debris", async () => {
    writeLock("CLAWBOX_EDITION=openclaw\n");
    writePending("TARGET_EDITION=hermes\n");
    const { readEditionChoice } = await import("@/lib/edition-select");
    expect(readEditionChoice().needed).toBe(false);
  });

  it("never reads a marker on a dual box", async () => {
    writeLock("CLAWBOX_EDITION=dual\n");
    writePending("TARGET_EDITION=hermes\n");
    const { readEditionChoice } = await import("@/lib/edition-select");
    expect(readEditionChoice().needed).toBe(false);
  });

  it("refuses a planted symlink and an oversized file as the marker", async () => {
    writeLock("CLAWBOX_EDITION=hermes\n");
    const real = path.join(dir, "real");
    fs.writeFileSync(real, "TARGET_EDITION=hermes\n");
    fs.symlinkSync(real, path.join(dir, "edition-select.pending"));
    const { readSelectPending } = await import("@/lib/edition-select");
    expect(readSelectPending()).toBeNull();
    fs.rmSync(path.join(dir, "edition-select.pending"));
    writePending(`TARGET_EDITION=hermes\n${"#".repeat(400)}\n`);
    expect(readSelectPending()).toBeNull();
  });
});

describe("the request file", () => {
  it("round-trips through the swap's writer and reader", async () => {
    const { writeEditionSelectRequest, readEditionSelectRequest, removeEditionSelectRequest, editionSelectRequestPath } =
      await import("@/lib/edition-select");
    await writeEditionSelectRequest("hermes", 1_700_000_000_000);
    expect(editionSelectRequestPath()).toBe(path.join(root, "data", "edition-select.env"));
    expect(fs.readFileSync(editionSelectRequestPath(), "utf-8")).toBe("TARGET_EDITION=hermes\nREQUESTED_AT=1700000000\n");
    expect((fs.statSync(editionSelectRequestPath()).mode & 0o777).toString(8)).toBe("600");
    expect(await readEditionSelectRequest()).toEqual({ target: "hermes", requestedAt: 1_700_000_000 });
    await removeEditionSelectRequest();
    expect(fs.existsSync(editionSelectRequestPath())).toBe(false);
  });

  it("leaves the swap's own request file where it was", async () => {
    const { swapRequestPath, writeSwapRequest, readSwapRequest } = await import("@/lib/harness-swap");
    await writeSwapRequest("openclaw", 1_700_000_000_000);
    expect(swapRequestPath()).toBe(path.join(root, "data", "harness-swap.env"));
    expect(await readSwapRequest()).toEqual({ target: "openclaw", requestedAt: 1_700_000_000 });
  });
});

describe("phase markers", () => {
  it("parses exactly the step's own marker lines", async () => {
    const { parseSelectPhase } = await import("@/lib/edition-select");
    expect(parseSelectPhase("[edition-select] phase=check")).toBe("check");
    expect(parseSelectPhase("  [edition-select] phase=cleanup  ")).toBe("cleanup");
    expect(parseSelectPhase("[edition-select] phase=install")).toBeNull();
    expect(parseSelectPhase("[harness-swap] phase=lock")).toBeNull();
    expect(parseSelectPhase("Error: [edition-select] phase=lock")).toBeNull();
  });

  it("announces phases forward only, fills gaps, and leaves request/done to the route", async () => {
    const { selectPhaseFollower } = await import("@/lib/edition-select");
    const seen: string[] = [];
    let newest: "check" | "provision" | "done" | null = null;
    const follower = selectPhaseFollower((p) => seen.push(p), 1, async () => newest);

    follower.onLine("[edition-select] phase=check");
    newest = "provision";
    follower.onLine("  -> install.sh --step hermes_edition (as the Hermes edition)");
    await follower.settled();
    follower.onLine("[edition-select] phase=lock"); // behind: not repeated
    newest = "done";
    follower.onLine("  This box is now set up with Hermes");
    await follower.settled();

    expect(seen).toEqual(["check", "lock", "provision", "cleanup"]);
  });

  it("survives a journal scan that throws", async () => {
    const { selectPhaseFollower } = await import("@/lib/edition-select");
    const seen: string[] = [];
    let calls = 0;
    const follower = selectPhaseFollower((p) => seen.push(p), 1, async () => {
      calls += 1;
      if (calls === 1) throw new Error("journalctl went away");
      return "lock";
    });
    follower.onLine("plain line one");
    follower.onLine("plain line two");
    await follower.settled();
    expect(seen).toEqual(["check", "lock"]);
  });
});

describe("one activation at a time", () => {
  it("hands the slot out once, and not over a unit that is running or unknown", async () => {
    const { claimEditionSelect, releaseEditionSelect, selectInProgress, _resetEditionSelectForTests } =
      await import("@/lib/edition-select");
    _resetEditionSelectForTests();
    expect(await claimEditionSelect("hermes", async () => false)).toBe("claimed");
    expect(await claimEditionSelect("hermes", async () => false)).toBe("busy");
    expect(await selectInProgress(async () => false)).toEqual({ inProgress: true, target: "hermes" });
    releaseEditionSelect();
    expect(await claimEditionSelect("openclaw", async () => true)).toBe("busy");
    expect(await claimEditionSelect("openclaw", async () => null)).toBe("unknown");
    expect(await selectInProgress(async () => null)).toEqual({ inProgress: false, target: null, unknown: true });
    expect(await selectInProgress(async () => false)).toEqual({ inProgress: false, target: null });
  });

  it("reports the request's target for a unit this process did not start", async () => {
    const { selectInProgress, writeEditionSelectRequest, _resetEditionSelectForTests } = await import("@/lib/edition-select");
    _resetEditionSelectForTests();
    await writeEditionSelectRequest("openclaw");
    expect(await selectInProgress(async () => true)).toEqual({ inProgress: true, target: "openclaw" });
  });
});
