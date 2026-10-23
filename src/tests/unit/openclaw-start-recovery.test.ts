import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The web server's reader of the notice scripts/openclaw-db-maintenance.py
// (`start-guard`) leaves in data/openclaw-start-guard.json when the gateway
// pre-start repaired a database the core refused, or put back its pre-update
// copy. It answers only a notice the page can word, and only for a few days.

const harness = vi.hoisted(() => ({ active: "openclaw" as string }));
vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: async () => harness.active,
}));

import { openclawStartGuardPath, readOpenclawStartRecovery, START_RECOVERY_NOTICE_MS } from "@/lib/openclaw-start-recovery";

let root: string;
const saved = process.env.CLAWBOX_ROOT;
const NOW = Date.parse("2026-10-23T12:00:00Z");
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "start-recovery-"));
  mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.CLAWBOX_ROOT = root;
  harness.active = "openclaw";
});
afterEach(() => {
  process.env.CLAWBOX_ROOT = saved;
  rmSync(root, { recursive: true, force: true });
});

const write = (body: unknown) =>
  writeFileSync(path.join(root, "data", "openclaw-start-guard.json"), typeof body === "string" ? body : JSON.stringify(body));

/** The record as the helper writes it: its ledger, and the notice beside it. */
const record = (notice: Record<string, unknown>) => ({
  version: 1,
  starts: [{ at: NOW / 1000 - 60, restarts: 3 }],
  episode: { stage: notice.outcome, databases: ["agent main"] },
  notice: { databases: ["agent main"], keptCopies: [], ...notice },
});

describe("readOpenclawStartRecovery", () => {
  it("reads the file the pre-start writes, under CLAWBOX_ROOT", () => {
    expect(openclawStartGuardPath()).toBe(path.join(root, "data", "openclaw-start-guard.json"));
  });

  it.each(["repaired", "restored", "failed"] as const)("answers a %s start loop with its outcome and time", async (outcome) => {
    write(record({ outcome, reason: null, at: "2026-10-23T11:00:00Z" }));
    expect(await readOpenclawStartRecovery(NOW)).toEqual({ outcome, reason: null, at: "2026-10-23T11:00:00Z" });
  });

  it("carries a reason the page can word, and drops one it cannot", async () => {
    write(record({ outcome: "failed", reason: "no-backup", at: "2026-10-23T11:00:00Z" }));
    expect(await readOpenclawStartRecovery(NOW)).toMatchObject({ reason: "no-backup" });
    write(record({ outcome: "failed", reason: "something-new", at: "2026-10-23T11:00:00Z" }));
    expect(await readOpenclawStartRecovery(NOW)).toMatchObject({ outcome: "failed", reason: null });
  });

  it("stops showing a notice a few days after the guard acted", async () => {
    const at = new Date(NOW - START_RECOVERY_NOTICE_MS - 1000).toISOString();
    write(record({ outcome: "restored", reason: null, at }));
    expect(await readOpenclawStartRecovery(NOW)).toBeNull();
  });

  it.each([
    ["no file", null],
    ["an unreadable one", "{not json"],
    ["a record with no notice (an ordinary start)", { version: 1, starts: [{ at: 1, restarts: 0 }], provenAt: 2 }],
    ["an outcome it does not know", { notice: { outcome: "deleted", at: "2026-10-23T11:00:00Z" } }],
    ["a notice with no time", { notice: { outcome: "repaired" } }],
  ])("answers null for %s", async (_what, body) => {
    if (body !== null) write(body);
    expect(await readOpenclawStartRecovery(NOW)).toBeNull();
  });

  it("says nothing on a box whose active harness is Hermes", async () => {
    write(record({ outcome: "restored", reason: null, at: "2026-10-23T11:00:00Z" }));
    harness.active = "hermes";
    expect(await readOpenclawStartRecovery(NOW)).toBeNull();
  });
});
