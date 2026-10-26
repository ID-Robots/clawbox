import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Starts real processes (python3, bash, sqlite through python): vitest's 5 s
// test and 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

// `openclaw-db-maintenance.py maintain` and `status` — the scheduled and
// on-demand compaction that holds the gateway down — over REAL SQLite files.
// The core's CLI, sudo, systemctl and the gateway guard are stubs that log
// every call to ONE file, so the order the gateway is suspended, held,
// stopped, compacted and started again is what the tests read back; the
// stub `openclaw` really VACUUMs, so the sizes before and after are measured.

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
let gatewayState: string;
let cgroupFile: string;
let deviceStore: string;

function sh(script: string, args: string[] = []): void {
  const r = spawnSync("python3", ["-c", script, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`fixture failed: ${r.stderr}`);
}

/** `rows` 3 KB rows with the first `deleted` deleted: deleted/rows of it is free pages. */
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

function writeExecutable(name: string, body: string): string {
  const file = path.join(binDir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

function writeStubs(): void {
  // The core: the idle check (`gateway suspend`), its release, and compaction.
  writeExecutable(
    "openclaw",
    `#!/usr/bin/env bash
printf 'openclaw %s\\n' "$*" >> "$OC_CALLS"
vacuum() { python3 -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("VACUUM"); c.close()' "$1"; }
case "$1 $2" in
  # The answers below are the shapes OpenClaw 2026.10.6 gives, captured from
  # the real core: ready, a refusal (on stdout, exit 1), and work still running.
  "gateway suspend")
    case "\${OC_BUSY:-0}" in
      conflict) echo '{"ok":false,"error":{"type":"gateway_request_error","code":"UNAVAILABLE","message":"another gateway suspension is already prepared","details":{"reason":"gateway-suspension-conflict"},"retryable":true}}'; exit 1 ;;
      active) echo '{"status":"busy","activeCount":1,"blockers":[{"kind":"root-request","runId":"r-1"}]}'; exit 1 ;;
    esac
    echo '{"status":"ready","suspensionId":"susp-1","expiresAtMs":1,"activeCount":0,"blockers":[],"writeCustody":[],"requestId":"x"}' ;;
  "gateway resume") echo '{"ok":true,"status":"running","resumed":true}' ;;
  "doctor --session-sqlite")
    if [ -n "\${OC_SLEEP:-}" ]; then echo $$ > "$OC_PIDFILE"; sleep "$OC_SLEEP"; fi
    if [ "\${OC_COMPACT_EXIT:-0}" != 0 ]; then echo "compaction refused" >&2; exit "$OC_COMPACT_EXIT"; fi
    vacuum "$OPENCLAW_STATE_DIR/agents/$5/agent/openclaw-agent.sqlite"
    printf '{"agentId":"%s","quick_check":"ok","integrity_check":"ok"}\\n' "$5" ;;
  "doctor --state-sqlite")
    vacuum "$OPENCLAW_STATE_DIR/state/openclaw.sqlite"
    echo '{"quickCheck":"ok","integrityCheck":"ok"}' ;;
  *) echo "unexpected: $*" >&2; exit 64 ;;
esac
`,
  );
  // sudo -n: log, then run what it was asked to.
  writeExecutable(
    "sudo",
    `#!/usr/bin/env bash
[ "$1" = "-n" ] || { echo "sudo without -n" >&2; exit 1; }
shift
printf 'sudo %s\\n' "$(basename "$1") \${*:2}" >> "$OC_CALLS"
exec "$@"
`,
  );
  // systemctl over one state file; is-active is a read and is not logged.
  writeExecutable(
    "systemctl",
    `#!/usr/bin/env bash
state=$(cat "$SC_STATE" 2>/dev/null || echo inactive)
case "$1" in
  is-active) echo "$state"; [ "$state" = active ] ;;
  stop) if [ "\${SC_STOP_FAIL:-0}" != 0 ]; then echo "Job for $2 failed" >&2; exit 1; fi; echo inactive > "$SC_STATE" ;;
  restart)
    if [ "\${SC_RESTART_FAIL:-0}" != 0 ]; then echo "Job for $2 failed because the control process exited with error code." >&2; exit 1; fi
    if [ -e "$GUARD_DIR" ]; then echo "condition failed: guard held" >&2; exit 0; fi
    echo active > "$SC_STATE" ;;
  *) echo "unexpected systemctl $*" >&2; exit 64 ;;
esac
`,
  );
  // clawbox-gateway-maintenance.sh enter|leave.
  writeExecutable(
    "guard",
    `#!/usr/bin/env bash
if [ "$1" = enter ]; then
  if [ "\${GUARD_FAIL:-0}" != 0 ]; then echo "daemon-reload failed" >&2; exit 1; fi
  mkdir -p "$GUARD_DIR"
else
  rmdir "$GUARD_DIR" 2>/dev/null || true
fi
`,
  );
}

function calledWith(): string[] {
  return existsSync(calls) ? readFileSync(calls, "utf-8").trim().split("\n").filter(Boolean) : [];
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PATH: `${binDir}:/usr/bin:/bin`,
    OC_CALLS: calls,
    OPENCLAW_STATE_DIR: stateDir,
    HOME: root,
    SC_STATE: gatewayState,
    GUARD_DIR: path.join(root, "guard"),
    ...extra,
  };
}

function paths(): string[] {
  return [
    "--state-dir", stateDir, "--config", configPath, "--data-dir", dataDir,
    "--openclaw-bin", path.join(binDir, "openclaw"), "--core-pkg", corePkg,
    "--device-store", deviceStore, "--cli-overhead-seconds", "1",
  ];
}

function seams(): string[] {
  return [
    "--sudo", path.join(binDir, "sudo"), "--systemctl", path.join(binDir, "systemctl"),
    "--guard-helper", path.join(binDir, "guard"), "--cgroup-file", cgroupFile,
  ];
}

function maintainArgs(extraArgs: string[] = []): string[] {
  return ["-I", HELPER, "maintain", ...paths(), ...seams(), "--idle-wait-seconds", "1", ...extraArgs];
}

function maintain(extraArgs: string[] = [], extra: Record<string, string> = {}) {
  const r = spawnSync("python3", maintainArgs(extraArgs), { encoding: "utf-8", env: env(extra), timeout: 50_000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function statusJson(extraArgs: string[] = []) {
  const r = spawnSync("python3", ["-I", HELPER, "status", ...paths(), "--json", ...extraArgs], { encoding: "utf-8", env: env(), timeout: 50_000 });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout);
}

const record = () => JSON.parse(readFileSync(path.join(dataDir, "openclaw-db-maintenance.json"), "utf-8"));
const logFile = () => readFileSync(path.join(dataDir, "openclaw-db-maintenance.log"), "utf-8");
const gateway = () => readFileSync(gatewayState, "utf-8").trim();

const COMPACT_MAIN = "openclaw doctor --session-sqlite compact --session-sqlite-agent main --json";
const SUSPEND = /^openclaw gateway suspend --wait 1 --request-id clawbox-db-maintenance-\d+ --json$/;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "db-maintain-"));
  stateDir = path.join(root, ".openclaw");
  dataDir = path.join(root, "data");
  binDir = path.join(root, "bin");
  calls = path.join(root, "calls.log");
  corePkg = path.join(root, "openclaw-package.json");
  configPath = path.join(stateDir, "openclaw.json");
  gatewayState = path.join(root, "gateway.state");
  cgroupFile = path.join(root, "cgroup");
  deviceStore = path.join(dataDir, "config.json");
  for (const d of [stateDir, dataDir, binDir]) mkdirSync(d, { recursive: true });
  writeFileSync(configPath, "{}");
  writeFileSync(corePkg, JSON.stringify({ name: "openclaw", version: "2026.10.6", openclaw: { schemaVersions: { state: STATE_SCHEMA, agent: AGENT_SCHEMA } } }));
  writeFileSync(gatewayState, "active\n");
  writeFileSync(cgroupFile, "0::/system.slice/clawbox-setup.service\n");
  writeFileSync(deviceStore, "{}");
  writeStubs();
  makeDb(stateDb(), { userVersion: STATE_SCHEMA, rows: 20 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasPython3)("openclaw-db-maintenance.py maintain — the gateway held for a compaction", () => {
  it("asks the core whether the gateway is idle, holds it, stops it, compacts, and starts it again — logging the sizes", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const before = statSync(agentDb("main")).size;

    const r = maintain(["--trigger", "scheduled"]);

    expect(r.status).toBe(0);
    const log = calledWith();
    expect(log[0]).toMatch(SUSPEND);
    expect(log.slice(1)).toEqual([
      "sudo guard enter",
      "sudo systemctl stop clawbox-gateway.service",
      COMPACT_MAIN,
      "sudo guard leave",
      "sudo systemctl restart clawbox-gateway.service",
    ]);
    expect(statSync(agentDb("main")).size).toBeLessThan(before / 2);
    expect(gateway()).toBe("active");
    expect(existsSync(path.join(root, "guard"))).toBe(false);

    const last = record().lastRun;
    expect(last).toMatchObject({ trigger: "scheduled", outcome: "compacted", gatewayStopped: true, gatewayRestarted: true });
    expect(last.afterBytes).toBeLessThan(last.beforeBytes);
    expect(last.databases).toEqual([expect.objectContaining({ key: "agent:main", ok: true, why: "75% free pages" })]);
    expect(record().run).toBeUndefined();
    expect(record().hold).toBeUndefined();
    expect(record().databases["agent:main"].lastCompact).toMatchObject({ ok: true, integrity: "ok" });

    // Size before and after, in the run's own log as well as the record.
    const text = logFile();
    expect(text).toMatch(/agent main: [\d.]+ [KM]B \(database .*\), 75% free pages, auto_vacuum none/);
    expect(text).toMatch(/before: [\d.]+ [KM]B in 2 database\(s\)/);
    expect(text).toMatch(/compacted agent main: [\d.]+ [KM]B -> [\d.]+ [KM]B in \d+ s \(integrity ok\)/);
    expect(text).toMatch(/compacted 1 database\(s\): [\d.]+ [KM]B -> [\d.]+ [KM]B \([\d.]+ [KM]B reclaimed\)/);
    expect(text).toMatch(/the gateway is running again after \d+ s/);
  });

  it("measures and leaves the gateway alone when every database is compact", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 10 });
    const r = maintain();
    expect(r.status).toBe(0);
    expect(calledWith()).toEqual([]);
    expect(record().lastRun).toMatchObject({ trigger: "cli", outcome: "nothing_to_do", gatewayStopped: false });
    expect(logFile()).toMatch(/every database is compact; the gateway was not touched/);
  });

  it("does nothing while the core says the gateway has work running", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = maintain([], { OC_BUSY: "active" });
    expect(r.status).toBe(0);
    expect(calledWith()).toHaveLength(1);
    expect(calledWith()[0]).toMatch(SUSPEND);
    expect(gateway()).toBe("active");
    expect(record().lastRun).toMatchObject({ outcome: "gateway_busy", gatewayStopped: false });
    expect(record().lastRun.message).toBe("the gateway is not idle (busy, 1 active); nothing done");
  });

  it("says why in the core's own words when it refuses to suspend", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = maintain([], { OC_BUSY: "conflict" });
    expect(r.status).toBe(0);
    expect(calledWith()).toHaveLength(1);
    expect(record().lastRun.message).toBe("the gateway is not idle (another gateway suspension is already prepared); nothing done");
  });

  it("compacts a gateway that is already stopped without starting it", () => {
    writeFileSync(gatewayState, "inactive\n");
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = maintain(["--trigger", "manual"]);
    expect(r.status).toBe(0);
    expect(calledWith()).toEqual(["sudo guard enter", COMPACT_MAIN, "sudo guard leave"]);
    expect(gateway()).toBe("inactive");
    expect(record().lastRun).toMatchObject({ outcome: "compacted", gatewayStopped: false });
    expect(record().lastRun.gatewayRestarted).toBeUndefined();
  });

  it("starts the gateway again when the compaction fails, and says it failed", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = maintain([], { OC_COMPACT_EXIT: "1" });
    expect(r.status).toBe(1);
    expect(calledWith().slice(-2)).toEqual(["sudo guard leave", "sudo systemctl restart clawbox-gateway.service"]);
    expect(gateway()).toBe("active");
    expect(record().lastRun).toMatchObject({ outcome: "failed", gatewayRestarted: true });
    expect(record().databases["agent:main"].lastCompact).toMatchObject({ ok: false, exit: 1 });
  });

  it("compacts nothing and releases the suspension when the guard cannot be taken", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = maintain([], { GUARD_FAIL: "1" });
    expect(r.status).toBe(1);
    expect(calledWith().slice(1)).toEqual(["sudo guard enter", "sudo guard leave", "openclaw gateway resume susp-1 --json"]);
    expect(gateway()).toBe("active");
    expect(record().lastRun.outcome).toBe("hold_failed");
  });

  it("compacts nothing when the gateway will not stop, and lifts its guard and suspension", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = maintain([], { SC_STOP_FAIL: "1" });
    expect(r.status).toBe(1);
    expect(calledWith()).not.toContain(COMPACT_MAIN);
    expect(calledWith().slice(-2)).toEqual(["sudo guard leave", "openclaw gateway resume susp-1 --json"]);
    expect(record().lastRun.outcome).toBe("stop_failed");
  });

  it("refuses to run inside the gateway's own service, which stopping the gateway would kill", () => {
    writeFileSync(cgroupFile, "0::/system.slice/clawbox-gateway.service\n");
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = maintain();
    expect(r.status).toBe(4);
    expect(r.out).toMatch(/refusing to run inside clawbox-gateway.service/);
    expect(calledWith()).toEqual([]);
  });

  it("does nothing while an update owns the box", () => {
    writeFileSync(deviceStore, JSON.stringify({ update_in_progress: true }));
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = maintain();
    expect(r.status).toBe(0);
    expect(calledWith()).toEqual([]);
    expect(record().lastRun.outcome).toBe("update_in_progress");
  });

  it("does nothing on a core older than 2026.10, whose compaction ClawBox has not verified", () => {
    writeFileSync(corePkg, JSON.stringify({ name: "openclaw", version: "2026.9.4", openclaw: { schemaVersions: { state: STATE_SCHEMA, agent: AGENT_SCHEMA } } }));
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = maintain();
    expect(r.status).toBe(0);
    expect(calledWith()).toEqual([]);
    expect(record().lastRun.outcome).toBe("unsupported_core");
  });

  it("leaves the gateway alone when the disk cannot hold the copy", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = maintain(["--free-bytes-override", "1000"]);
    expect(r.status).toBe(0);
    expect(calledWith()).toEqual([]);
    expect(record().lastRun).toMatchObject({ outcome: "skipped" });
    expect(record().lastRun.message).toMatch(/agent main — low disk: needs .* free, 1 KB is free/);
  });

  it("leaves the gateway alone when the work would outrun the run's budget", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = maintain(["--budget-seconds", "60", "--live-rate-bps", "100"]);
    expect(r.status).toBe(0);
    expect(calledWith()).toEqual([]);
    expect(record().lastRun.message).toMatch(/about \d+ s of work, more than this run's 60 s budget/);
  });

  it("says what it would do on --dry-run and touches nothing", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = maintain(["--dry-run"]);
    expect(r.status).toBe(0);
    expect(calledWith()).toEqual([]);
    expect(r.out).toMatch(/would compact agent main \(75% free pages\)/);
  });

  it("compacts a database still on auto_vacuum NONE, so the core's incremental reclamation works from then on", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 0 });
    const r = maintain(["--autovacuum-min-bytes", "1"]);
    expect(r.status).toBe(0);
    expect(calledWith()).toContain(COMPACT_MAIN);
    expect(record().lastRun.databases[0].why).toMatch(/auto_vacuum is off/);
  });

  it("compacts a big database's free pages as an amount, under the 30 % share", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 80 });
    const r = maintain(["--free-trigger-bytes", "100000"]);
    expect(r.status).toBe(0);
    expect(record().lastRun.databases[0].why).toMatch(/[\d.]+ KB of free pages/);
  });

  it("keeps its hold when the gateway does not come back, and the next run starts it", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const r = maintain([], { SC_RESTART_FAIL: "1" });
    expect(r.status).toBe(1);
    expect(gateway()).toBe("inactive");
    expect(record().lastRun).toMatchObject({ outcome: "compacted", gatewayRestarted: false });
    expect(record().hold).toMatchObject({ stopped: true });

    const next = maintain();
    expect(next.status).toBe(0);
    expect(next.out).toMatch(/ended while holding the gateway; releasing it/);
    expect(gateway()).toBe("active");
    expect(record().hold).toBeUndefined();
    expect(record().lastRun.outcome).toBe("nothing_to_do");
  });

  it("releases a gateway an earlier run left held, before anything else", () => {
    writeFileSync(gatewayState, "inactive\n");
    mkdirSync(path.join(root, "guard"));
    writeFileSync(
      path.join(dataDir, "openclaw-db-maintenance.json"),
      JSON.stringify({ hold: { pid: 999999, at: "2026-10-20T03:30:00Z", stopped: true } }),
    );
    const r = maintain();
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/ended while holding the gateway; releasing it/);
    expect(calledWith()).toEqual(["sudo guard leave", "sudo systemctl restart clawbox-gateway.service"]);
    expect(gateway()).toBe("active");
    expect(record().hold).toBeUndefined();
  });

  it("answers 75 and does nothing while another run holds the lock", async () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const ready = path.join(root, "locked");
    const holder = spawn("python3", [
      "-c",
      "import fcntl,os,sys,time; fd=os.open(sys.argv[1], os.O_RDWR|os.O_CREAT); fcntl.flock(fd, fcntl.LOCK_EX); open(sys.argv[2],'w').close(); time.sleep(60)",
      path.join(dataDir, "openclaw-db-maintenance.lock"),
      ready,
    ]);
    try {
      for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 100));
      const r = maintain();
      expect(r.status).toBe(75);
      expect(r.out).toMatch(/another database maintenance run is in progress/);
      expect(calledWith()).toEqual([]);
      expect(statusJson().running).toEqual({ phase: "starting" });
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("starts the gateway again when it is stopped mid-compaction, and records why it ended", async () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    const pidFile = path.join(root, "pid");
    const child = spawn("python3", maintainArgs(["--cli-overhead-seconds", "100"]), {
      env: env({ OC_SLEEP: "60", OC_PIDFILE: pidFile }),
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
    expect(gateway()).toBe("inactive");
    expect(statusJson().running).toMatchObject({ phase: "compacting", trigger: "cli" });
    const stubPid = Number(readFileSync(pidFile, "utf-8").trim());
    child.kill("SIGTERM");
    expect(await exited).toBe(128 + 15);
    const alive = (() => { try { process.kill(stubPid, 0); return true; } catch { return false; } })();
    expect(alive).toBe(false);
    expect(gateway()).toBe("active");
    expect(existsSync(path.join(root, "guard"))).toBe(false);
    expect(record().lastRun).toMatchObject({ outcome: "failed", message: "stopped by a signal before it finished", gatewayRestarted: true });
    expect(record().hold).toBeUndefined();
  });
});

describe.skipIf(!hasPython3)("openclaw-db-maintenance.py status", () => {
  it("reports every database's size, what a run would compact and why, and the last run — read-only", () => {
    makeDb(agentDb("main"), { userVersion: AGENT_SCHEMA, rows: 400, deleted: 300 });
    makeDb(agentDb("ops"), { userVersion: AGENT_SCHEMA, rows: 100, deleted: 0 });
    const mtime = statSync(agentDb("main")).mtimeMs;

    const s = statusJson();

    expect(s).toMatchObject({ core: "2026.10.6", supported: true, running: null, lastRun: null });
    expect(s.totalBytes).toBeGreaterThan(0);
    const byKey = Object.fromEntries(s.databases.map((d: { key: string }) => [d.key, d]));
    expect(byKey["agent:main"]).toMatchObject({ label: "agent main", needs: "75% free pages", autoVacuum: 0 });
    expect(byKey["agent:main"].bytes).toBe(statSync(agentDb("main")).size);
    expect(byKey["agent:ops"].needs).toBeNull();
    expect(byKey.state).toMatchObject({ kind: "state", needs: null });
    expect(statSync(agentDb("main")).mtimeMs).toBe(mtime);
    expect(calledWith()).toEqual([]);

    maintain();
    expect(statusJson().lastRun).toMatchObject({ outcome: "compacted" });
  });
});
