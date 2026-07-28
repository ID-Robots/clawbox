import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";

// scripts/migrate-auth-profiles.js copies credentials out of the legacy
// <agentDir>/auth-profiles.json into the sqlite auth_profile_store that core
// 2026.7.x actually reads at runtime.
//
// Without it a box can show a provider as "connected" in the UI (the JSON file
// exists) while core resolves no auth profile at all — `profile=-` in the
// gateway log — and every turn fails with 401. Observed on a factory-fresh box
// on 2026-07-28: three profiles in JSON, zero rows in sqlite.

const SCRIPT = path.resolve(process.cwd(), "scripts/migrate-auth-profiles.js");

let home: string;
let openclawHome: string;
let agentDir: string;
let dbPath: string;

function createDb(seedProfiles?: Record<string, unknown>) {
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  );
  if (seedProfiles) {
    db.prepare(
      "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
    ).run("primary", JSON.stringify({ profiles: seedProfiles }), 1);
  }
  db.close();
}

function readStore(): Record<string, any> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db
    .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?")
    .get("primary") as { store_json?: string } | undefined;
  db.close();
  return row?.store_json ? JSON.parse(row.store_json).profiles ?? {} : {};
}

function seedLegacy(profiles: Record<string, unknown>) {
  writeFileSync(path.join(agentDir, "auth-profiles.json"), JSON.stringify({ profiles }));
}

function run(): string {
  return execFileSync("node", [SCRIPT, openclawHome], { encoding: "utf-8" });
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "migrate-auth-profiles-"));
  openclawHome = path.join(home, ".openclaw");
  agentDir = path.join(openclawHome, "agents", "main", "agent");
  mkdirSync(agentDir, { recursive: true });
  dbPath = path.join(agentDir, "openclaw-agent.sqlite");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("migrate-auth-profiles.js", () => {
  it("migrates legacy profiles into an empty sqlite store", () => {
    createDb();
    seedLegacy({
      "codex:default": { provider: "codex", access: "a", refresh: "r" },
      "deepseek:default": { provider: "deepseek", key: "k" },
    });

    const out = run();

    expect(Object.keys(readStore()).sort()).toEqual(["codex:default", "deepseek:default"]);
    expect(out).toContain("auth profiles migrated to sqlite");
  });

  it("creates the store row when the table is empty", () => {
    createDb(); // table exists, zero rows — exactly what the broken box had
    seedLegacy({ "codex:default": { provider: "codex", access: "a", refresh: "r" } });

    run();

    expect(readStore()["codex:default"]).toEqual({ provider: "codex", access: "a", refresh: "r" });
  });

  it("never clobbers a profile core already has", () => {
    createDb({ "codex:default": { provider: "codex", access: "LIVE", refresh: "LIVE" } });
    seedLegacy({ "codex:default": { provider: "codex", access: "STALE", refresh: "STALE" } });

    run();

    expect(readStore()["codex:default"].access).toBe("LIVE");
  });

  it("leaves the legacy file in place so a core downgrade still finds it", () => {
    createDb();
    seedLegacy({ "codex:default": { provider: "codex", access: "a", refresh: "r" } });

    run();

    const legacy = path.join(agentDir, "auth-profiles.json");
    expect(existsSync(legacy)).toBe(true);
    expect(JSON.parse(readFileSync(legacy, "utf-8")).profiles["codex:default"]).toBeDefined();
  });

  it("is idempotent", () => {
    createDb();
    seedLegacy({ "codex:default": { provider: "codex", access: "a", refresh: "r" } });
    run();

    const out = run();

    expect(out).toContain("sqlite store already current");
  });

  it("migrates every agent", () => {
    createDb();
    seedLegacy({ "codex:default": { provider: "codex", access: "a", refresh: "r" } });
    const second = path.join(openclawHome, "agents", "support", "agent");
    mkdirSync(second, { recursive: true });
    const secondDb = new DatabaseSync(path.join(second, "openclaw-agent.sqlite"));
    secondDb.exec(
      "CREATE TABLE auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    secondDb.close();
    writeFileSync(
      path.join(second, "auth-profiles.json"),
      JSON.stringify({ profiles: { "deepseek:default": { provider: "deepseek", key: "k" } } }),
    );

    const out = run();

    expect(out).toContain("(main)");
    expect(out).toContain("(support)");
  });

  it("exits cleanly with no legacy file at all", () => {
    createDb();
    const out = run();
    expect(out).toContain("sqlite store already current");
  });

  it("does not blow up when the database is missing", () => {
    seedLegacy({ "codex:default": { provider: "codex", access: "a", refresh: "r" } });
    expect(() => run()).not.toThrow();
  });
});

describe("gateway-pre-start.sh wiring", () => {
  it("runs the migration before the credential mirror", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "scripts/gateway-pre-start.sh"),
      "utf-8",
    );
    const migration = src.indexOf("scripts/migrate-auth-profiles.js");
    const mirror = src.indexOf("scripts/codex-auth-mirror.js");
    expect(migration).toBeGreaterThan(-1);
    // The mirror reads the profile store, so the migration has to populate it first.
    expect(migration).toBeLessThan(mirror);
  });
});
