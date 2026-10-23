import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

// Starts real processes (python3, bash, sqlite through python): vitest's 5 s
// test and 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

// scripts/openclaw-db-maintenance.py, run as the gateway pre-start and
// install.sh run it, over REAL SQLite files: page counts, free pages and
// schema versions are what SQLite says about databases built here, and the
// stub `openclaw` really VACUUMs them, so "after" sizes are measured, not
// assumed. Only the core's CLI is a stub — the commands it is asked for, and
// what it answers, are the contract under test.

const HELPER = path.resolve(process.cwd(), "scripts/openclaw-db-maintenance.py");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

const AGENT_SCHEMA = 24;
const STATE_SCHEMA = 20;

let root: string;
let stateDir: string;
let dataDir: string;
let binDir: string;
let calls: string;
let corePkg: string;
let configPath: string;

function sh(script: string, args: string[] = []): void {
  const r = spawnSync("python3", ["-c", script, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`fixture failed: ${r.stderr}`);
}

/**
 * A database of `rows` 3 KB rows with the first `deleted` deleted: on 4 KB
 * pages and no auto_vacuum, deleted/rows of it is free pages.
 */
function makeDb(file: string, opts: { userVersion: number; rows?: number; deleted?: number }): void {
  mkdirSync(path.dirname(file), { recursive: true });
  rmSync(file, { force: true });
  sh(
    [
      "import sqlite3, sys",
      "path, uv, rows, deleted = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])",
      "c = sqlite3.connect(path)",
      "c.execute('PRAGMA page_size=4096')",
      "c.execute('PRAGMA auto_vacuum=NONE')",
      "c.execute('CREATE TABLE t(id INTEGER PRIMARY KEY, b BLOB)')",
      "c.executemany('INSERT INTO t(b) VALUES (?)', [(b'x' * 3000,) for _ in range(rows)])",
      "c.commit()",
      "c.execute('DELETE FROM t WHERE id <= ?', (deleted,))",
      "c.commit()",
      "c.execute('PRAGMA user_version=%d' % uv)",
      "c.commit()",
      "c.close()",
    ].join("\n"),
    [file, String(opts.userVersion), String(opts.rows ?? 400), String(opts.deleted ?? 0)],
  );
}

const agentDb = (id: string) => path.join(stateDir, "agents", id, "agent", "openclaw-agent.sqlite");
const stateDb = () => path.join(stateDir, "state", "openclaw.sqlite");

/** The core's CLI: logs every argv, compacts for real, answers in JSON. */
function writeStub(): void {
  const stub = path.join(binDir, "openclaw");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$OC_CALLS"
vacuum() { python3 -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("VACUUM"); c.close()' "$1"; }
case "$1 $2" in
  "doctor --session-sqlite")
    if [ -n "\${OC_SLEEP:-}" ]; then echo $$ > "$OC_PIDFILE"; sleep "$OC_SLEEP"; fi
    if [ "\${OC_COMPACT_EXIT:-0}" != 0 ]; then echo "compaction refused" >&2; exit "$OC_COMPACT_EXIT"; fi
    vacuum "$OPENCLAW_STATE_DIR/agents/$5/agent/openclaw-agent.sqlite"
    echo "(node) ExperimentalWarning: SQLite is an experimental feature" >&2
    printf '{"agentId":"%s","before":{"bytes":1},"after":{"bytes":1},"quick_check":"%s","integrity_check":"ok"}\\n' "$5" "\${OC_QUICK:-ok}"
    ;;
  "doctor --state-sqlite")
    vacuum "$OPENCLAW_STATE_DIR/state/openclaw.sqlite"
    echo '{"quickCheck":"ok","integrityCheck":"ok","reclaimedBytes":0}'
    ;;
  "update cleanup") echo '{"status":"ok","totals":{"removedBytes":0}}' ;;
  "memory reset") if [ "\${OC_RESET_EXIT:-0}" != 0 ]; then exit "$OC_RESET_EXIT"; fi; echo reset ;;
  "memory index") echo indexed ;;
  *) echo "unexpected: $*" >&2; exit 64 ;;
esac
`,
  );
  chmodSync(stub, 0o755);
}

function calledWith(): string[] {
  return existsSync(calls) ? readFileSync(calls, "utf-8").trim().split("\n").filter(Boolean) : [];
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", PATH: `${binDir}:/usr/bin:/bin`, OC_CALLS: calls, OPENCLAW_STATE_DIR: stateDir, HOME: root, ...extra };
}

function run(cmd: string, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync("python3", ["-I", HELPER, cmd, ...args], { encoding: "utf-8", env: env(extra), timeout: 50_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function prestart(extraArgs: string[] = [], extra: Record<string, string> = {}) {
  return run(
    "prestart",
    [
      "--state-dir", stateDir, "--config", configPath, "--data-dir", dataDir,
      "--openclaw-bin", path.join(binDir, "openclaw"), "--core-pkg", corePkg,
      "--budget-seconds", "300", "--cli-overhead-seconds", "1",
      ...extraArgs,
    ],
    extra,
  );
}

const status = () => JSON.parse(readFileSync(path.join(dataDir, "openclaw-migration-status.json"), "utf-8"));
const record = () => JSON.parse(readFileSync(path.join(dataDir, "openclaw-db-maintenance.json"), "utf-8"));

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "db-maint-"));
  stateDir = path.join(root, ".openclaw");
  dataDir = path.join(root, "data");
  binDir = path.join(root, "bin");
  calls = path.join(root, "calls.log");
  corePkg = path.join(root, "openclaw-package.json");
  configPath = path.join(stateDir, "openclaw.json");
  for (const d of [stateDir, dataDir, binDir]) mkdirSync(d, { recursive: true });
  writeFileSync(configPath, "{}");
  writeFileSync(corePkg, JSON.stringify({ name: "openclaw", version: "2026.10.3", openclaw: { schemaVersions: { state: STATE_SCHEMA, agent: AGENT_SCHEMA } } }));
  writeStub();
  makeDb(stateDb(), { userVersion: STATE_SCHEMA, rows: 20 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasPython3)("openclaw-db-maintenance.py prestart — compaction", () => {
  it("compacts an agent database over 30 % free pages with the core's own command, and leaves one under it", async () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    makeDb(agentDb("ops"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 40 });
    const before = statSync(agentDb("main")).size;

    const r = prestart();

    expect(r.status).toBe(0);
    expect(calledWith()).toEqual(["doctor --session-sqlite compact --session-sqlite-agent main --json"]);
    expect(statSync(agentDb("main")).size).toBeLessThan(before / 2);
    expect(r.out).toMatch(/compacted agent main: .* -> .* \(integrity ok\)/);
    const entry = record().databases["agent:main"].lastCompact;
    expect(entry).toMatchObject({ ok: true, exit: 0, integrity: "ok", userVersion: AGENT_SCHEMA });
    expect(entry.afterBytes).toBeLessThan(entry.beforeBytes);
    expect(record().databases["agent:ops"]).toBeUndefined();
    expect(status()).toMatchObject({ state: "ok", reason: null, core: "2026.10.3", databases: { total: 3, behind: 0 } });
  });

  it("compacts the shared state database through --state-sqlite", () => {
    makeDb(stateDb(), { userVersion: STATE_SCHEMA, rows: 300, deleted: 200 });
    prestart();
    expect(calledWith()).toEqual(["doctor --state-sqlite compact --json"]);
    expect(record().databases.state.lastCompact).toMatchObject({ ok: true, integrity: "ok" });
  });

  it("skips a database the disk cannot hold a copy of, and says what it needs", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = prestart(["--free-bytes-override", "1000"]);
    expect(r.status).toBe(0);
    expect(calledWith()).toEqual([]);
    expect(r.out).toMatch(/agent main not compacted: low disk: needs .* free, 1 KB is free/);
    expect(record().databases["agent:main"].lastSkip.reason).toMatch(/^low disk/);
  });

  it("skips what does not fit this start's time budget and leaves it for a later start", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = prestart(["--budget-seconds", "60", "--live-rate-bps", "100"]);
    expect(calledWith()).toEqual([]);
    expect(r.out).toMatch(/agent main not compacted: about \d+ s of work, \d+ s of this start's budget left — next gateway start/);
  });

  it("compacts nothing at all with no budget, but still records the migration status", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = prestart(["--budget-seconds", "0"]);
    expect(r.status).toBe(0);
    expect(calledWith()).toEqual([]);
    expect(status().state).toBe("ok");
  });

  it("stops a compaction that outruns its deadline, records it, and keeps going", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const started = Date.now();
    // estimate 1 s -> allowed at most 2 s; the stub would take 30.
    const r = prestart(["--live-rate-bps", "1e12"], { OC_SLEEP: "30", OC_PIDFILE: path.join(root, "pid") });
    expect(r.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(r.out).toMatch(/compacting agent main ran out of its 2 s and was stopped/);
    expect(record().databases["agent:main"].lastCompact).toMatchObject({ ok: false, exit: null });
  });

  it("records a refused compaction as failed, never as verified", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = prestart([], { OC_COMPACT_EXIT: "1" });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/compacting agent main failed \(exit 1, integrity unreported\): compaction refused/);
    expect(record().databases["agent:main"].lastCompact.ok).toBe(false);
  });

  it("does not count an integrity check the core reports as failed", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    prestart([], { OC_QUICK: "row 12 missing from index" });
    expect(record().databases["agent:main"].lastCompact).toMatchObject({ ok: false, exit: 0, integrity: "failed" });
  });

  it("never compacts a database that is not on the schema the core declares", () => {
    makeDb(agentDb("main"), { userVersion: 21, rows: 400, deleted: 300 });
    const r = prestart();
    expect(calledWith()).toEqual([]);
    expect(r.out).toMatch(/agent main not compacted: on schema 21, the core declares 24/);
  });

  it("finds an agent the config keeps outside the default tree", () => {
    const elsewhere = path.join(root, "elsewhere", "agent");
    makeDb(path.join(elsewhere, "openclaw-agent.sqlite"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    writeFileSync(configPath, JSON.stringify({ agents: { entries: { ops: { agentDir: elsewhere } } } }));
    prestart();
    expect(calledWith()).toEqual(["doctor --session-sqlite compact --session-sqlite-agent ops --json"]);
  });

  it("answers 0 and a WARN over a database that is not one, and an unreadable record", () => {
    mkdirSync(path.dirname(agentDb("main")), { recursive: true });
    writeFileSync(agentDb("main"), "not sqlite at all, but long enough to be read as a header ".repeat(4));
    writeFileSync(path.join(dataDir, "openclaw-db-maintenance.json"), "{torn");
    const r = prestart();
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/agent main not compacted: unreadable/);
    expect(r.out).toMatch(/openclaw-db-maintenance.json is unreadable; starting a new record/);
  });

  it("stops the compaction it started when it is itself stopped, so no doctor outlives the pre-start", async () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const pidFile = path.join(root, "pid");
    const child = spawn(
      "python3",
      ["-I", HELPER, "prestart", "--state-dir", stateDir, "--data-dir", dataDir, "--openclaw-bin", path.join(binDir, "openclaw"),
        "--core-pkg", corePkg, "--budget-seconds", "300", "--cli-overhead-seconds", "100"],
      { env: env({ OC_SLEEP: "60", OC_PIDFILE: pidFile }), stdio: "ignore" },
    );
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
    const stubPid = Number(readFileSync(pidFile, "utf-8").trim());
    child.kill("SIGTERM");
    expect(await exited).toBe(128 + 15);
    const alive = (() => { try { process.kill(stubPid, 0); return true; } catch { return false; } })();
    expect(alive).toBe(false);
  });
});

describe.skipIf(!hasPython3)("openclaw-db-maintenance.py prestart — migration status", () => {
  it("reports agents a migration has not reached as degraded, with what the migration needs", () => {
    makeDb(agentDb("main"), { userVersion: 21 });
    makeDb(agentDb("ops"), { userVersion: AGENT_SCHEMA });
    const r = prestart();
    const s = status();
    expect(s).toMatchObject({ state: "degraded", reason: "schema-behind", databases: { total: 3, behind: 1 } });
    expect(s.requiredBytes).toBeGreaterThan(statSync(agentDb("main")).size * 6);
    expect(typeof s.freeBytes).toBe("number");
    expect(r.out).toMatch(/OpenClaw databases need attention: schema-behind \(1 of 3 behind/);
  });

  it("names a shortfall of disk as the reason when the free space cannot hold the migration", () => {
    makeDb(agentDb("main"), { userVersion: 21 });
    prestart(["--free-bytes-override", "1000"]);
    expect(status()).toMatchObject({ state: "degraded", reason: "insufficient-disk", freeBytes: 1000 });
  });

  it("reports a database on a NEWER schema than the core as degraded too", () => {
    makeDb(agentDb("main"), { userVersion: 25 });
    prestart();
    expect(status()).toMatchObject({ state: "degraded", reason: "schema-newer" });
  });

  it("keeps saying degraded after an incomplete doctor run until one completes", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA });
    run("record-doctor", ["--state-dir", stateDir, "--data-dir", dataDir, "--core-pkg", corePkg, "--verdict", "incomplete"]);
    expect(status()).toMatchObject({ state: "degraded", reason: "migration-incomplete", source: "install" });
    prestart();
    expect(status()).toMatchObject({ state: "degraded", reason: "migration-incomplete", source: "gateway-pre-start" });
    run("record-doctor", ["--state-dir", stateDir, "--data-dir", dataDir, "--core-pkg", corePkg, "--verdict", "complete"]);
    prestart();
    expect(status()).toMatchObject({ state: "ok", reason: null });
  });

  it("says unknown, never ok, when the installed core declares no schema", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA });
    writeFileSync(corePkg, JSON.stringify({ name: "openclaw", version: "2026.10.3" }));
    prestart();
    expect(status()).toMatchObject({ state: "unknown", reason: "core-schema-unknown" });
  });
});

describe.skipIf(!hasPython3)("openclaw-db-maintenance.py prestart — the migration's rollback copies", () => {
  function backup(db: string, id = "20261020T101010Z-abc"): string {
    const bak = `${db}.pre-startup-migration-${id}.bak`;
    writeFileSync(bak, "x".repeat(50_000));
    return bak;
  }

  /**
   * The gateway reached `gateway ready` after the copies were taken: what
   * `start-guard` records at the next start. Without it a copy is the way
   * back from a row the core refuses, and stays.
   */
  function gatewayStartedSince(): void {
    writeFileSync(path.join(dataDir, "openclaw-start-guard.json"), JSON.stringify({ version: 1, provenAt: Date.now() / 1000 + 1 }));
  }

  it("compacts a migrated database whatever its free pages, then retires its copy", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 100, deleted: 1 });
    const bak = backup(agentDb("main"));
    const stateBak = backup(stateDb());

    gatewayStartedSince();
    const r = prestart();

    expect(calledWith()).toEqual([
      "doctor --session-sqlite compact --session-sqlite-agent main --json",
      "doctor --state-sqlite compact --json",
      "update cleanup --yes --json",
    ]);
    expect(existsSync(bak)).toBe(false);
    expect(existsSync(stateBak)).toBe(false);
    expect(r.out).toMatch(/removed the pre-migration copy of agent main \(50 KB\): the migrated database passed its integrity check/);
    expect(record().cleanup.removedBytes).toBe(100_000);
  });

  it("keeps a verified copy until the gateway has started on the migrated database", () => {
    // Every SQLite check can pass over a row the core refuses at startup —
    // the start loop this copy is the way back from. The first start after an
    // update used to retire it before the new core had ever run.
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 100, deleted: 1 });
    const bak = backup(agentDb("main"));

    const r = prestart();

    expect(record().databases["agent:main"].lastCompact.ok).toBe(true);
    expect(existsSync(bak)).toBe(true);
    expect(r.out).toMatch(/rollback copy of agent main kept until the gateway has started on the migrated database/);
    expect(calledWith()).not.toContain("update cleanup --yes --json");
  });

  it("keeps every copy while a start-loop recovery has not settled", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 100, deleted: 1 });
    const bak = backup(agentDb("main"));
    const now = Date.now() / 1000;
    writeFileSync(path.join(dataDir, "openclaw-start-guard.json"), JSON.stringify({
      version: 1,
      // A ready line from before the recovery proves nothing about after it.
      provenAt: now + 1,
      episode: { stage: "repaired", actedFrom: now + 2, actedTo: now + 3 },
    }));

    const r = prestart();

    expect(existsSync(bak)).toBe(true);
    expect(r.out).toMatch(/migration rollback copies kept: the gateway's start-loop recovery has not settled/);
  });

  it("keeps every copy while any database is still behind the declared schema", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 100, deleted: 1 });
    makeDb(agentDb("ops"), { userVersion: 21 });
    const bak = backup(agentDb("main"));
    const r = prestart();
    expect(existsSync(bak)).toBe(true);
    expect(r.out).toMatch(/migration rollback copies kept: agent ops is not on the declared schema/);
    expect(calledWith()).not.toContain("update cleanup --yes --json");
  });

  it("keeps a copy whose compaction failed, and one still being captured", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 100, deleted: 1 });
    makeDb(agentDb("ops"), { userVersion: AGENT_SCHEMA, rows: 100, deleted: 1 });
    const failed = backup(agentDb("main"));
    const capturing = backup(agentDb("ops"));
    writeFileSync(`${agentDb("ops")}.pre-startup-migration-next.bak.capturing`, "");
    const r = prestart([], { OC_COMPACT_EXIT: "1" });
    expect(existsSync(failed)).toBe(true);
    expect(existsSync(capturing)).toBe(true);
    expect(r.out).toMatch(/rollback copy of agent main kept until a compaction has checked its integrity/);
    expect(r.out).toMatch(/rollback copy of agent ops kept: a copy is still being written/);
  });

  it("keeps the copies after an incomplete doctor run for this core", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 100, deleted: 1 });
    const bak = backup(agentDb("main"));
    run("record-doctor", ["--state-dir", stateDir, "--data-dir", dataDir, "--core-pkg", corePkg, "--verdict", "incomplete"]);
    const r = prestart();
    expect(existsSync(bak)).toBe(true);
    expect(r.out).toMatch(/kept: the last doctor --fix for this core did not complete/);
  });

  it("never counts a compaction from before the copy was taken", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    prestart();
    expect(record().databases["agent:main"].lastCompact.ok).toBe(true);
    // The copy arrives later — but carrying an OLD mtime, the way a copy that
    // preserves its source's times would. Its ctime still says when it landed.
    const bak = backup(agentDb("main"));
    const past = new Date(Date.now() - 86_400_000);
    utimesSync(bak, past, past);
    writeFileSync(calls, "");
    // No time for another compaction in this start: the copy must stay.
    const r = prestart(["--budget-seconds", "70", "--cli-overhead-seconds", "100"]);
    expect(existsSync(bak)).toBe(true);
    expect(r.out).toMatch(/rollback copy of agent main kept until a compaction has checked its integrity/);
  });

  it("checks every database after an update capture, and only then retires it — with no .bak anywhere", () => {
    // The capture holds the whole state; no rollback copy forces a compaction
    // here, so the capture itself must.
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 100, deleted: 1 });
    const captures = `${stateDir}.update-captures`;
    mkdirSync(path.join(captures, "run-1"), { recursive: true });
    writeFileSync(path.join(captures, ".openclaw-private-update-capture"), "openclaw-private-update-capture-v1\n");
    writeFileSync(path.join(captures, "run-1", "openclaw.sqlite"), "y".repeat(5_000));

    gatewayStartedSince();
    const r = prestart();

    expect(calledWith()).toEqual([
      "doctor --session-sqlite compact --session-sqlite-agent main --json",
      "doctor --state-sqlite compact --json",
    ]);
    expect(existsSync(path.join(captures, "run-1"))).toBe(false);
    expect(existsSync(captures)).toBe(false);
    expect(r.out).toMatch(/removed the update capture run-1/);
  });

  it("keeps an update capture while any database has not passed its check since", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 100, deleted: 1 });
    const captures = `${stateDir}.update-captures`;
    mkdirSync(path.join(captures, "run-1"), { recursive: true });
    writeFileSync(path.join(captures, "run-1", ".openclaw-private-update-capture"), "openclaw-private-update-capture-v1\n");
    const r = prestart([], { OC_COMPACT_EXIT: "1" });
    expect(existsSync(path.join(captures, "run-1"))).toBe(true);
    expect(r.out).toMatch(/update capture run-1 kept until agent main has passed a compaction's integrity check/);
  });

  it("never retires an update capture when there are no databases left — it may be the only copy", () => {
    rmSync(stateDb());
    const captures = `${stateDir}.update-captures`;
    mkdirSync(path.join(captures, "run-1"), { recursive: true });
    writeFileSync(path.join(captures, "run-1", ".openclaw-private-update-capture"), "openclaw-private-update-capture-v1\n");
    prestart();
    expect(existsSync(path.join(captures, "run-1"))).toBe(true);
  });

  it("retires the core's marked update captures once everything is verified, and nothing unmarked", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 100, deleted: 1 });
    backup(agentDb("main"));
    const captures = `${stateDir}.update-captures`;
    mkdirSync(path.join(captures, "run-1", "state"), { recursive: true });
    writeFileSync(path.join(captures, "run-1", ".openclaw-private-update-capture"), "openclaw-private-update-capture-v1\n");
    writeFileSync(path.join(captures, "run-1", "state", "openclaw.sqlite"), "y".repeat(20_000));
    mkdirSync(path.join(captures, "someone-elses"), { recursive: true });
    writeFileSync(path.join(captures, "someone-elses", "keep.txt"), "mine");

    gatewayStartedSince();
    const r = prestart();

    expect(existsSync(path.join(captures, "run-1"))).toBe(false);
    expect(existsSync(path.join(captures, "someone-elses", "keep.txt"))).toBe(true);
    expect(r.out).toMatch(/removed the update capture run-1 \(20 KB\)/);
  });
});

describe.skipIf(!hasPython3)("openclaw-db-maintenance.py preflight (install.sh, before the core is replaced)", () => {
  const preflight = (extra: string[] = []) =>
    run("preflight", ["--state-dir", stateDir, "--config", configPath, "--data-dir", dataDir, "--core-pkg", corePkg, ...extra]);

  it("refuses with exit 3 and a sentence naming both sizes when the disk cannot hold the migration", () => {
    makeDb(agentDb("main"), { userVersion: 21, rows: 400 });
    const r = preflight(["--free-bytes-override", "1000000"]);
    expect(r.status).toBe(3);
    const last = r.stdout.trim().split("\n").pop() ?? "";
    expect(last).toMatch(/^OpenClaw 2026\.10\.3 has to migrate .* of agent data and needs about .* free on the disk, but only 1\.0 MB is free\. Free up .* and run the update again; nothing was changed\.$/);
    expect(status()).toMatchObject({ state: "blocked", reason: "insufficient-disk", freeBytes: 1_000_000, preflight: { target: "2026.10.3" } });
  });

  it("passes when the disk has room for six copies and a gigabyte", () => {
    makeDb(agentDb("main"), { userVersion: 21, rows: 400 });
    // Only the agent database is behind; the state database is already current.
    const size = statSync(agentDb("main")).size;
    expect(preflight(["--free-bytes-override", String(size * 6 + 1024 ** 3 + 1)]).status).toBe(0);
    expect(preflight(["--free-bytes-override", String(size * 6 + 1024 ** 3 - 4096 * 10)]).status).toBe(3);
  });

  it("counts only the databases the core would migrate", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400 });
    const r = preflight(["--free-bytes-override", "1"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/no database needs a schema migration for OpenClaw 2026\.10\.3/);
  });

  it("stands down rather than refusing when the core's schema cannot be read", () => {
    makeDb(agentDb("main"), { userVersion: 21 });
    writeFileSync(corePkg, "{}");
    expect(preflight(["--free-bytes-override", "1"]).status).toBe(0);
  });

  it("clears its own refusal once the disk has room", () => {
    makeDb(agentDb("main"), { userVersion: 21, rows: 400 });
    preflight(["--free-bytes-override", "1"]);
    expect(status().preflight).toBeTruthy();
    expect(preflight(["--free-bytes-override", String(1024 ** 4)]).status).toBe(0);
    expect(status().preflight).toBeNull();
  });
});

describe.skipIf(!hasPython3)("openclaw-db-maintenance.py memory-rebuild (after the gateway starts)", () => {
  let server: http.Server;
  let port: number;
  let startupz = 200;

  beforeEach(async () => {
    startupz = 200;
    server = http.createServer((req, res) => {
      res.writeHead(req.url === "/startupz" ? startupz : 404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const rebuildRecord = () => path.join(dataDir, "openclaw-memory-rebuild.json");
  function rebuild(extra: Record<string, string> = {}, args: string[] = []): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(
        "python3",
        ["-I", HELPER, "memory-rebuild", "--data-dir", dataDir, "--openclaw-bin", path.join(binDir, "openclaw"),
          "--gateway-port", String(port), "--poll-seconds", "0.1", "--wait-seconds", "2", ...args],
        { env: env(extra) },
      );
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("exit", (code) => resolve({ code, out }));
    });
  }

  it("for a new model: resets, then rebuilds, once — and records it done", async () => {
    writeFileSync(rebuildRecord(), JSON.stringify({ pending: true, reasons: ["model", "sources"] }));
    const r = await rebuild();
    expect(r.code).toBe(0);
    expect(calledWith()).toEqual(["memory reset --yes", "memory index --force"]);
    const rec = JSON.parse(readFileSync(rebuildRecord(), "utf-8"));
    expect(rec).toMatchObject({ pending: false, attempts: 1 });
    expect(rec.doneAt).toBeTruthy();
    await rebuild();
    expect(calledWith()).toHaveLength(2);
  });

  it("for a change of sources alone keeps the embedding cache: no reset, so nothing it has seen is embedded again", async () => {
    // A box embedding with its own model would otherwise re-embed every memory
    // file and Memory Shard folder on the device itself.
    writeFileSync(rebuildRecord(), JSON.stringify({ pending: true, reasons: ["rememberAcrossConversations", "sources"] }));
    const r = await rebuild();
    expect(r.code).toBe(0);
    expect(calledWith()).toEqual(["memory index --force"]);
    expect(JSON.parse(readFileSync(rebuildRecord(), "utf-8"))).toMatchObject({ pending: false, attempts: 1 });
  });

  it("stops trying after three attempts, rather than at every gateway start for ever", async () => {
    writeFileSync(rebuildRecord(), JSON.stringify({ pending: true, reasons: ["model"], attempts: 3, lastError: "memory index: timed out" }));
    const r = await rebuild();
    expect(r.code).toBe(0);
    expect(calledWith()).toEqual([]);
    expect(r.out).toMatch(/memory index rebuild stopped after 3 attempts \(memory index: timed out\); a full reindex from Memory Shard finishes it/);
  });

  it("does nothing while an update owns the box, and leaves the rebuild pending", async () => {
    writeFileSync(rebuildRecord(), JSON.stringify({ pending: true }));
    writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ update_in_progress: true }));
    const r = await rebuild();
    expect(r.code).toBe(0);
    expect(calledWith()).toEqual([]);
    expect(r.out).toMatch(/waits for the next gateway start/);
    expect(JSON.parse(readFileSync(rebuildRecord(), "utf-8")).pending).toBe(true);
  });

  it("waits for the gateway to have started", async () => {
    startupz = 503;
    writeFileSync(rebuildRecord(), JSON.stringify({ pending: true }));
    await rebuild();
    expect(calledWith()).toEqual([]);
  });

  it("keeps the rebuild pending, with the reason, when the reset fails — and does not index over it", async () => {
    writeFileSync(rebuildRecord(), JSON.stringify({ pending: true, reasons: ["model"] }));
    await rebuild({ OC_RESET_EXIT: "3" });
    expect(calledWith()).toEqual(["memory reset --yes"]);
    const rec = JSON.parse(readFileSync(rebuildRecord(), "utf-8"));
    expect(rec).toMatchObject({ pending: true, lastError: "memory reset: exit 3" });
  });

  it("never runs beside the embeddings check's own forced reindex", async () => {
    writeFileSync(rebuildRecord(), JSON.stringify({ pending: true }));
    const holder = spawn("python3", ["-c", [
      "import fcntl, sys, time",
      "f = open(sys.argv[1], 'a'); fcntl.flock(f, fcntl.LOCK_EX); print('held', flush=True); time.sleep(20)",
    ].join("\n"), path.join(dataDir, "local-embeddings.state.lock")]);
    await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
    try {
      const r = await rebuild({}, ["--lock-wait-seconds", "1"]);
      expect(calledWith()).toEqual([]);
      expect(r.out).toMatch(/another memory index run holds/);
    } finally {
      holder.kill("SIGKILL");
    }
  });
});
