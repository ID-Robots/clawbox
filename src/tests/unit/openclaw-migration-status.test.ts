import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The web server's reader of data/openclaw-migration-status.json, the file
// scripts/openclaw-db-maintenance.py writes at every gateway pre-start. It
// answers only what the owner can act on, and nothing it cannot vouch for.

const harness = vi.hoisted(() => ({ active: "openclaw" as string }));
vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: async () => harness.active,
}));

import { openclawMigrationStatusPath, readOpenclawMigrationStatus } from "@/lib/openclaw-migration-status";

let root: string;
const saved = process.env.CLAWBOX_ROOT;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "migration-status-"));
  mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.CLAWBOX_ROOT = root;
  harness.active = "openclaw";
});
afterEach(() => {
  process.env.CLAWBOX_ROOT = saved;
  rmSync(root, { recursive: true, force: true });
});

const write = (body: unknown) =>
  writeFileSync(path.join(root, "data", "openclaw-migration-status.json"), typeof body === "string" ? body : JSON.stringify(body));

describe("readOpenclawMigrationStatus", () => {
  it("reads the file the pre-start writes, under CLAWBOX_ROOT", () => {
    expect(openclawMigrationStatusPath()).toBe(path.join(root, "data", "openclaw-migration-status.json"));
  });

  it("answers a degraded migration with what it needs", async () => {
    write({ state: "degraded", reason: "insufficient-disk", requiredBytes: 61_000_000_000, freeBytes: 12_500_000_000, updatedAt: "2026-10-21T08:00:00Z", databases: { behind: 2 } });
    expect(await readOpenclawMigrationStatus()).toEqual({
      state: "degraded", reason: "insufficient-disk", requiredBytes: 61_000_000_000, freeBytes: 12_500_000_000, updatedAt: "2026-10-21T08:00:00Z",
    });
  });

  it("answers a refused update as blocked", async () => {
    write({ state: "blocked", reason: "insufficient-disk", requiredBytes: 10, freeBytes: 1 });
    expect(await readOpenclawMigrationStatus()).toMatchObject({ state: "blocked", reason: "insufficient-disk" });
  });

  it.each([
    ["no file", null],
    ["a torn file", "{\"state\": \"degr"],
    ["an array", []],
    ["ok", { state: "ok", reason: null }],
    ["unknown", { state: "unknown", reason: "core-schema-unknown" }],
    ["a reason it does not know", { state: "degraded", reason: "cosmic-rays" }],
    ["a state it does not know", { state: "panicking", reason: "schema-behind" }],
  ])("answers null for %s", async (_what, body) => {
    if (body !== null) write(body);
    expect(await readOpenclawMigrationStatus()).toBeNull();
  });

  it("drops byte counts that are not counts", async () => {
    write({ state: "degraded", reason: "schema-behind", requiredBytes: "lots", freeBytes: -4 });
    expect(await readOpenclawMigrationStatus()).toMatchObject({ requiredBytes: null, freeBytes: null });
  });

  it("says nothing while Hermes is the harness running on a dual box", async () => {
    write({ state: "degraded", reason: "schema-behind" });
    harness.active = "hermes";
    expect(await readOpenclawMigrationStatus()).toBeNull();
  });
});
