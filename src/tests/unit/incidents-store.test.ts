/**
 * The Improvement Program's local record: fingerprinting, the upsert, the
 * throttle, the cap and the mode.
 *
 * `CLAWBOX_ROOT` is re-pointed per test at a fresh temp tree and the modules
 * are re-imported behind `vi.resetModules()`, because `config-store` resolves
 * `DATA_DIR` at import time — a suite that set the root after the first import
 * would be writing into whatever root the previous file left behind.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

let root: string;
let restore: () => void;
let store: typeof import("@/lib/incidents");

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_ROOT");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-incidents-"));
  process.env.CLAWBOX_ROOT = root;
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  vi.resetModules();
  store = await import("@/lib/incidents");
});

afterEach(() => {
  restore();
  fs.rmSync(root, { recursive: true, force: true });
});

const incidentsPath = () => path.join(root, "data", "incidents.json");

describe("the owner's mode", () => {
  it("is off until it is set — nothing leaves a box nobody asked", async () => {
    expect(await store.getImprovementMode()).toBe("off");
  });

  it("round-trips the three values", async () => {
    for (const mode of ["ask", "auto", "off"] as const) {
      await store.setImprovementMode(mode);
      expect(await store.getImprovementMode()).toBe(mode);
    }
  });

  it("reads a nonsense value as off rather than guessing", async () => {
    const config = await import("@/lib/config-store");
    await config.set(store.IMPROVEMENT_MODE_KEY, "everything");
    expect(await store.getImprovementMode()).toBe("off");
  });

  it("refuses a value that is not a mode", () => {
    expect(store.isImprovementMode("auto")).toBe(true);
    expect(store.isImprovementMode("ON")).toBe(false);
    expect(store.isImprovementMode(1)).toBe(false);
  });
});

describe("recordIncident", () => {
  it("sanitizes before anything reaches the disk", async () => {
    await store.recordIncident({
      source: "coding-agent",
      message: "auth failed with claw_abcdef1234567890 for ada@example.org",
      stack: "Error: x\n    at run (/home/ada/clawbox/src/lib/a.ts:1:1)",
      context: { host: "adas-box.local", exitCode: 3 },
    });
    const raw = fs.readFileSync(incidentsPath(), "utf-8");
    expect(raw).not.toContain("claw_abcdef1234567890");
    expect(raw).not.toContain("ada@example.org");
    expect(raw).not.toContain("adas-box.local");
    expect(raw).not.toContain("/home/ada");
    // …and the diagnosis survives.
    expect(raw).toContain("~/clawbox/src/lib/a.ts");
    expect(raw).toContain('"exitCode": "3"');
  });

  it("writes the file 0600 — it is a log of what broke, not world-readable", async () => {
    await store.recordIncident({ source: "update", message: "step failed" });
    expect(fs.statSync(incidentsPath()).mode & 0o777).toBe(0o600);
  });

  it("folds a second occurrence into the first and counts it", async () => {
    const a = await store.recordIncident({ source: "update", message: "apt_update failed after 3 tries" });
    const b = await store.recordIncident({ source: "update", message: "apt_update failed after 9 tries" });
    expect(b!.id).toBe(a!.id);
    expect(b!.count).toBe(2);
    expect(store.listIncidents()).toHaveLength(1);
  });

  it("keeps two different faults apart", async () => {
    await store.recordIncident({ source: "update", message: "the disk is full" });
    await store.recordIncident({ source: "update", message: "the network is down" });
    expect(store.listIncidents()).toHaveLength(2);
  });

  it("separates the same words from different sources", async () => {
    await store.recordIncident({ source: "update", message: "it broke" });
    await store.recordIncident({ source: "coding-agent", message: "it broke" });
    expect(store.listIncidents()).toHaveLength(2);
  });

  it("honours the throttle, which is what makes a repeating warning batched", async () => {
    const t0 = 1_800_000_000_000;
    await store.recordIncident({ source: "coding-harness", message: "claude-ds is missing", now: t0 });
    const again = await store.recordIncident({
      source: "coding-harness", message: "claude-ds is missing", throttleMs: 30 * 60_000, now: t0 + 60_000,
    });
    expect(again!.count).toBe(1);
    const later = await store.recordIncident({
      source: "coding-harness", message: "claude-ds is missing", throttleMs: 30 * 60_000, now: t0 + 31 * 60_000,
    });
    expect(later!.count).toBe(2);
  });

  it("records nothing for an empty message or an unknown source", async () => {
    expect(await store.recordIncident({ source: "update", message: "   " })).toBeNull();
    expect(await store.recordIncident({ source: "nope" as never, message: "x" })).toBeNull();
    expect(store.listIncidents()).toEqual([]);
  });

  it("never throws when the store cannot be written", async () => {
    fs.rmSync(path.join(root, "data"), { recursive: true, force: true });
    fs.writeFileSync(path.join(root, "data"), "not a directory");
    await expect(store.recordIncident({ source: "update", message: "x" })).resolves.toBeNull();
  });

  it("reads a corrupt log as an empty one rather than taking the error path down", async () => {
    fs.writeFileSync(incidentsPath(), "{ not json");
    expect(store.listIncidents()).toEqual([]);
    const written = await store.recordIncident({ source: "update", message: "x" });
    expect(written).not.toBeNull();
  });
});

describe("concurrent captures", () => {
  /**
   * `readFile()` and `writeFile()` are synchronous, so everything between them
   * is one load-modify-store. An `await` inside it — the version read used to
   * sit there — is a window in which another capture's write is lost.
   */
  it("keeps every distinct fault when several are captured at once", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.recordIncident({ source: "clawbox", message: `concurrent fault ${"n".repeat(i)}` })),
    );
    expect(store.listIncidents()).toHaveLength(12);
  });

  it("keeps every occurrence of ONE fault when several are captured at once", async () => {
    await Promise.all(
      Array.from({ length: 12 }, () => store.recordIncident({ source: "clawbox", message: "one repeating fault" })),
    );
    const all = store.listIncidents();
    expect(all).toHaveLength(1);
    expect(all[0].count).toBe(12);
  });

  /**
   * The deterministic form of the test above, and the reason it is worth a
   * fixture: the first two cases interleave by luck of the scheduler, while
   * this one PARKS a capture at the one await it still has and writes to the
   * store underneath it.
   *
   * With the read hoisted above the load-modify-store, the capture has not yet
   * read the file when the other write lands, so it sees it. With the await
   * back between the read and the write, it read first and overwrites.
   */
  it("does not overwrite a write that lands while it is waiting on the version read", async () => {
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const parked = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { entered = r; });
    vi.doMock("@/lib/openclaw-core-generation", () => ({
      installedOpenclawCoreVersion: async () => { entered(); await parked; return "2026.8.1"; },
    }));
    vi.resetModules();
    const fresh = await import("@/lib/incidents");

    const capture = fresh.recordIncident({ source: "clawbox", message: "the captured fault" });
    await reached;

    // Another writer, while the capture is parked: a record already on disk
    // that this capture must not erase.
    fs.writeFileSync(incidentsPath(), JSON.stringify({
      version: 1,
      filed: { day: "", count: 0 },
      incidents: [{
        id: "inc-other", fingerprint: "f".repeat(16), source: "update", message: "written by somebody else",
        stack: null, context: {}, firstSeen: 1, lastSeen: 1, count: 1, edition: "openclaw",
        appVersion: "v1", coreVersion: null, issueNumber: 42, reportedAt: 1, lastCommentDay: null,
      }],
    }), { mode: 0o600 });

    release();
    await capture;

    const ids = fresh.listIncidents().map((i) => i.id);
    expect(ids, "the other writer's record survived the capture").toContain("inc-other");
    expect(fresh.getIncident("inc-other")?.issueNumber).toBe(42);
    expect(ids).toHaveLength(2);
    vi.doUnmock("@/lib/openclaw-core-generation");
  });
});

describe("the daily allowance is CLAIMED, not merely checked", () => {
  const t0 = Date.parse("2026-09-12T10:00:00Z");

  it("hands out exactly `max` slots, whoever asks", () => {
    const granted = Array.from({ length: 8 }, () => store.reserveIssueToday(5, t0));
    expect(granted.filter(Boolean)).toHaveLength(5);
    expect(store.remainingIssuesToday(5, t0)).toBe(0);
  });

  it("gives a slot back when the creation it was taken for failed", () => {
    expect(store.reserveIssueToday(5, t0)).toBe(true);
    expect(store.remainingIssuesToday(5, t0)).toBe(4);
    store.releaseIssueToday(t0);
    expect(store.remainingIssuesToday(5, t0)).toBe(5);
  });

  it("never hands back more than was taken, or across a day boundary", () => {
    store.releaseIssueToday(t0);
    expect(store.remainingIssuesToday(5, t0)).toBe(5);
    store.reserveIssueToday(5, t0);
    store.releaseIssueToday(t0 + 24 * 3_600_000);
    expect(store.remainingIssuesToday(5, t0)).toBe(4);
  });

  it("starts fresh the next UTC day", () => {
    for (let i = 0; i < 5; i++) store.reserveIssueToday(5, t0);
    expect(store.reserveIssueToday(5, t0)).toBe(false);
    expect(store.reserveIssueToday(5, t0 + 24 * 3_600_000)).toBe(true);
  });
});

describe("a record read back off disk", () => {
  function writeRaw(incident: Record<string, unknown>): void {
    fs.writeFileSync(incidentsPath(), JSON.stringify({
      version: 1, filed: { day: "", count: 0 }, incidents: [incident],
    }), { mode: 0o600 });
  }

  const BASE = {
    id: "inc-x", fingerprint: "a".repeat(16), source: "update", message: "m",
    stack: null, context: {}, firstSeen: 1, lastSeen: 1, count: 1, edition: "openclaw",
    appVersion: "v1", coreVersion: null, issueNumber: null, lastCommentDay: null,
  };

  it("is refused when its context is not all strings", () => {
    // `issueBodyFor` calls .replace() on every context value; a number there
    // made the report route throw instead of filing.
    writeRaw({ ...BASE, context: { note: 1 } });
    expect(store.listIncidents()).toEqual([]);
  });

  it("is refused when its context is an array or its stack is not text", () => {
    writeRaw({ ...BASE, context: ["a"] });
    expect(store.listIncidents()).toEqual([]);
    writeRaw({ ...BASE, stack: { frames: [] } });
    expect(store.listIncidents()).toEqual([]);
  });

  it("is kept, with an empty context, when the field predates it", () => {
    const noContext: Record<string, unknown> = { ...BASE };
    delete noContext.context;
    writeRaw(noContext);
    const [read] = store.listIncidents();
    expect(read.id).toBe("inc-x");
    expect(read.context).toEqual({});
    expect(read.stack).toBeNull();
  });
});

describe("the cap", () => {
  it("keeps MAX_INCIDENTS and drops the unreported oldest first", async () => {
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < store.MAX_INCIDENTS + 5; i++) {
      await store.recordIncident({ source: "clawbox", message: `fault number ${"x".repeat(i)}`, now: t0 + i });
    }
    const all = store.listIncidents();
    expect(all).toHaveLength(store.MAX_INCIDENTS);
    // The newest survived; the oldest did not.
    expect(all[0].message).toContain("x".repeat(store.MAX_INCIDENTS + 4));
  });

  it("keeps a REPORTED incident over an unreported older one — the record of what was filed is what stops a second issue", async () => {
    const t0 = 1_800_000_000_000;
    const first = await store.recordIncident({ source: "clawbox", message: "the very first fault", now: t0 });
    store.markReported(first!.id, 42);
    for (let i = 0; i < store.MAX_INCIDENTS + 3; i++) {
      await store.recordIncident({ source: "clawbox", message: `later fault ${"y".repeat(i)}`, now: t0 + 1_000 + i });
    }
    expect(store.getIncident(first!.id)?.issueNumber).toBe(42);
  });
});

describe("the daily allowance", () => {
  const t0 = Date.parse("2026-09-12T10:00:00Z");

  it("starts full and is charged only by a new issue", async () => {
    const a = await store.recordIncident({ source: "update", message: "one" });
    expect(store.remainingIssuesToday(5, t0)).toBe(5);
    store.markReported(a!.id, 1, { charge: true, now: t0 });
    expect(store.remainingIssuesToday(5, t0)).toBe(4);
  });

  it("is not charged when the issue already existed", async () => {
    const a = await store.recordIncident({ source: "update", message: "one" });
    store.markReported(a!.id, 7, { charge: false, now: t0 });
    expect(store.remainingIssuesToday(5, t0)).toBe(5);
    expect(store.getIncident(a!.id)?.issueNumber).toBe(7);
  });

  it("resets on the next UTC day", async () => {
    const a = await store.recordIncident({ source: "update", message: "one" });
    store.markReported(a!.id, 1, { charge: true, now: t0 });
    expect(store.remainingIssuesToday(5, t0 + 24 * 3_600_000)).toBe(5);
  });

  it("never goes below zero", async () => {
    for (let i = 0; i < 8; i++) {
      const inc = await store.recordIncident({ source: "clawbox", message: `fault ${"z".repeat(i)}` });
      store.markReported(inc!.id, i + 1, { charge: true, now: t0 });
    }
    expect(store.remainingIssuesToday(5, t0)).toBe(0);
  });
});

describe("the comment cadence", () => {
  it("records the UTC day a note went out", async () => {
    const now = Date.parse("2026-09-12T23:30:00Z");
    const inc = await store.recordIncident({ source: "update", message: "one" });
    store.markCommented(inc!.id, now);
    expect(store.getIncident(inc!.id)?.lastCommentDay).toBe("2026-09-12");
  });
});

describe("pendingIncidents", () => {
  it("is what has NOT been filed", async () => {
    const a = await store.recordIncident({ source: "update", message: "one" });
    await store.recordIncident({ source: "update", message: "two" });
    store.markReported(a!.id, 5);
    expect(store.pendingIncidents().map((i) => i.message)).toEqual(["two"]);
  });
});
