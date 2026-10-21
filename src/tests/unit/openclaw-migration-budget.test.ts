import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeOpenclawMigration, migrationBudgetMs, openclawDatabaseBytes } from "@/lib/openclaw-migration-status";

// The updater's half of the agent-database work: how long it waits for the
// core's migration, and what it says when the gateway answers over agents the
// migration did not reach.

const GiB = 1024 ** 3;
const BUDGET = { baseMs: 300_000, perGibMs: 300_000, capMs: 6_600_000 };
const UPDATER = readFileSync(path.resolve(process.cwd(), "src/lib/updater.ts"), "utf-8");

describe("migrationBudgetMs", () => {
  it("keeps the flat five minutes for a box with no databases to migrate", () => {
    expect(migrationBudgetMs(0, BUDGET)).toBe(300_000);
  });

  it("gives a ~10 GB box the time its 40-minute migration takes, and more", () => {
    // 9.8 GB is 9.13 GiB: ten started GiB at five minutes each, on top of the five.
    expect(migrationBudgetMs(9.8e9, BUDGET)).toBe(3_300_000);
    expect(migrationBudgetMs(9.8e9, BUDGET)).toBeGreaterThan(40 * 60_000);
  });

  it("never passes the cap under the root unit's own ceiling", () => {
    expect(migrationBudgetMs(500 * GiB, BUDGET)).toBe(6_600_000);
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])("reads %s as no databases", (bytes) => {
    expect(migrationBudgetMs(bytes, BUDGET)).toBe(300_000);
  });
});

describe("the updater wiring", () => {
  it("waits for the appliance's openclaw_install by the databases it migrates", () => {
    expect(UPDATER).toMatch(/: step\.id === "openclaw_install"\n\s+\? await applianceOpenclawInstallTimeoutMs\(\)/);
    expect(UPDATER).toMatch(/baseMs: OPENCLAW_INSTALL_TIMEOUT_MS,\n\s+perGibMs: OPENCLAW_MIGRATION_MS_PER_GIB,\n\s+capMs: X64_DESKTOP_CORE_STEP_TIMEOUT_MS,/);
  });

  it("says so on the update's result when the gateway answers over degraded agents", () => {
    // Both steps that end an update on a running gateway.
    const verify = UPDATER.slice(UPDATER.indexOf('id: "gateway_verify"'), UPDATER.indexOf('id: "gateway_verify"') + 600);
    const restart = UPDATER.slice(UPDATER.indexOf('id: "gateway_restart"'), UPDATER.indexOf('id: "gateway_restart"') + 600);
    expect(verify).toContain("await warnIfOpenclawDatabasesDegraded();");
    expect(restart).toContain("await warnIfOpenclawDatabasesDegraded();");
    expect(UPDATER).toContain('warnUpdate("openclaw-migration-degraded", describeOpenclawMigration(status))');
  });
});

describe("describeOpenclawMigration", () => {
  it("names both sizes when the disk is the problem", () => {
    expect(describeOpenclawMigration({ state: "degraded", reason: "insufficient-disk", requiredBytes: 61 * GiB, freeBytes: 12.5 * GiB, updatedAt: null }))
      .toBe("OpenClaw's agent data could not be migrated: the migration needs about 61.0 GB of free disk and 12.5 GB is free. Free up space, then run the update again.");
  });

  it.each([
    ["schema-behind", /has not finished migrating the agents' data/],
    ["migration-incomplete", /reported its migration of the agents' data as incomplete/],
    ["schema-newer", /written by a newer OpenClaw than the one installed/],
  ] as const)("explains %s", (reason, text) => {
    expect(describeOpenclawMigration({ state: "degraded", reason, requiredBytes: null, freeBytes: null, updatedAt: null })).toMatch(text);
  });
});

describe("openclawDatabaseBytes", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "oc-db-bytes-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("adds every agent database, the shared state database and their WALs", async () => {
    for (const id of ["main", "ops"]) {
      mkdirSync(path.join(dir, "agents", id, "agent"), { recursive: true });
      writeFileSync(path.join(dir, "agents", id, "agent", "openclaw-agent.sqlite"), Buffer.alloc(1000));
    }
    writeFileSync(path.join(dir, "agents", "main", "agent", "openclaw-agent.sqlite-wal"), Buffer.alloc(50));
    mkdirSync(path.join(dir, "state"));
    writeFileSync(path.join(dir, "state", "openclaw.sqlite"), Buffer.alloc(300));
    // Not a database the migration rewrites.
    writeFileSync(path.join(dir, "agents", "main", "agent", "notes.txt"), Buffer.alloc(9999));
    expect(await openclawDatabaseBytes(dir)).toBe(2350);
  });

  it("answers 0 for a tree with nothing in it", async () => {
    expect(await openclawDatabaseBytes(path.join(dir, "missing"))).toBe(0);
  });
});
