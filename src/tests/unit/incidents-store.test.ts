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
