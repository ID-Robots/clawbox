import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

// Starts real processes (python3, bash, sqlite through python) in a loop:
// vitest's 5 s test and 10 s hook defaults are not enough on a loaded CI
// runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });

/**
 * scripts/openclaw-db-maintenance.py `start-guard`: the gateway pre-start's
 * answer to a gateway that the core will not start over one of its databases.
 *
 * The incident: a single session row the core refused in the default agent's
 * database, the gateway exiting at every start, and `Restart=always` starting
 * it again a dozen times in eight minutes with nothing in between ever
 * changing. Here the loop is played out for real — the pre-start's guard, then
 * the gateway, again and again, as systemd would — over REAL SQLite files. Only
 * the core is a stub: its `gateway` refuses a database with a malformed session
 * row and says so in its rolling log the way the core does, and its `doctor
 * --fix` quarantines such rows (keeping them) only when the case says it can.
 */

// The web server's reader of the record, run over what the helper wrote: the
// two halves of the notice must agree on its shape.
vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: async () => "openclaw",
}));
import { readOpenclawStartRecovery } from "@/lib/openclaw-start-recovery";

const HELPER = path.resolve(process.cwd(), "scripts/openclaw-db-maintenance.py");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

let root: string;
let stateDir: string;
let dataDir: string;
let binDir: string;
let logDir: string;
let calls: string;
let journal: string;

const agentDb = (id: string) => path.join(stateDir, "agents", id, "agent", "openclaw-agent.sqlite");
const guardFile = () => JSON.parse(readFileSync(path.join(dataDir, "openclaw-start-guard.json"), "utf-8"));

function py(script: string, args: string[]): string {
  const r = spawnSync("python3", ["-c", script, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`fixture failed: ${r.stderr}`);
  return r.stdout;
}

/** An agent database of session rows; a body that is not JSON is the row the core refuses. */
function makeDb(file: string, rows: Array<[string, string]>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  rmSync(file, { force: true });
  py(
    [
      "import json, sqlite3, sys",
      "c = sqlite3.connect(sys.argv[1])",
      "c.execute('CREATE TABLE sessions(id TEXT PRIMARY KEY, body TEXT)')",
      "c.executemany('INSERT INTO sessions VALUES (?, ?)', json.loads(sys.argv[2]))",
      "c.execute('PRAGMA user_version=24')",
      "c.commit()",
      "c.close()",
    ].join("\n"),
    [file, JSON.stringify(rows)],
  );
}

/** Session ids in a database, and in its quarantine table when there is one. */
function sessionIds(file: string, table = "sessions"): string[] {
  return JSON.parse(py(
    [
      "import json, sqlite3, sys",
      "c = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)",
      "have = [r[0] for r in c.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")]",
      "print(json.dumps(sorted(r[0] for r in c.execute('SELECT id FROM ' + sys.argv[2])) if sys.argv[2] in have else []))",
    ].join("\n"),
    [file, table],
  ));
}

const good = (id: string): [string, string] => [id, JSON.stringify({ id, title: `chat ${id}` })];
const BAD: [string, string] = ["s-bad", "{\"id\":\"s-bad\",\"title\":"];

/**
 * The core. `gateway` admits every agent database or refuses the first one
 * with a row it cannot read — logged to its rolling log file (JSON lines, as
 * the core writes) and to the journal stand-in — and exits 1. `doctor --fix`
 * moves such rows into a quarantine table when OC_DOCTOR_REPAIRS=1.
 */
function writeCore(): void {
  const core = path.join(binDir, "core.py");
  writeFileSync(core, `
import datetime, glob, json, os, sqlite3, sys, time
state = os.environ["OPENCLAW_STATE_DIR"]
log_dir = os.environ["OC_LOG_DIR"]
offset = float(os.environ.get("OC_TIME_OFFSET", "0"))
def log(level, msg):
    now = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=offset)
    os.makedirs(log_dir, exist_ok=True)
    with open(os.path.join(log_dir, "openclaw-%s.log" % now.strftime("%Y-%m-%d")), "a") as fh:
        fh.write(json.dumps({"time": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"), "level": level, "msg": msg}) + "\\n")
    if os.environ.get("OC_JOURNAL"):
        with open(os.environ["OC_JOURNAL"], "a") as fh:
            fh.write(json.dumps({"__REALTIME_TIMESTAMP": str(int((time.time() + offset) * 1e6)), "SYSLOG_IDENTIFIER": "openclaw", "MESSAGE": msg}) + "\\n")
# The manual-start hint 2026.10.6 puts on its breaker lines.
def hint(params):
    return "Start a channel manually with: openclaw gateway call channels.start --params '%s'" % json.dumps(params, separators=(",", ":"))
def bad_rows(db):
    c = sqlite3.connect(db)
    try:
        out = []
        for sid, body in c.execute("SELECT id, body FROM sessions"):
            try:
                json.loads(body)
            except ValueError:
                out.append(sid)
        return out
    finally:
        c.close()
dbs = sorted(glob.glob(os.path.join(state, "agents", "*", "agent", "openclaw-agent.sqlite")))
cmd = sys.argv[1:]
if cmd[:1] == ["say"]:
    # A line from the running gateway, later on.
    log("info", cmd[1])
    sys.exit(0)
if cmd[:2] == ["channels", "status"]:
    print(os.environ.get("OC_CHANNELS_STATUS", "{}"))
    sys.exit(0)
if cmd[:3] == ["gateway", "call", "channels.start"]:
    if os.environ.get("OC_MANUAL_START_FAILS") == "1":
        print("gateway call failed: channels.start refused", file=sys.stderr)
        sys.exit(1)
    params = json.loads(cmd[cmd.index("--params") + 1])
    print(json.dumps({"channel": params["channel"], "accountId": params.get("accountId", "default"), "started": False, "outcome": {"status": "handed-off"}}))
    sys.exit(0)
if cmd[:1] == ["gateway"]:
    failure = os.environ.get("OC_GATEWAY_FAILS_WITH")
    if failure:
        log("error", failure)
        print("Gateway failed to start: " + failure, file=sys.stderr)
        sys.exit(1)
    for db in dbs:
        rows = bad_rows(db)
        if rows:
            agent = db.split(os.sep)[-3]
            if os.environ.get("OC_CORE_WORDING") == "2026.10.6":
                # Word for word what 2026.10.6 says on a box: the agent only in the session key.
                msg = "invalid persisted session row requires repair for agent:%s:%s; stop the Gateway and run openclaw doctor --fix" % (agent, rows[0])
            else:
                msg = "agent-database:%s refused admission: session row %s failed validation (%s)" % (agent, rows[0], db)
            log("error", msg)
            print("Gateway failed to start: " + msg, file=sys.stderr)
            sys.exit(1)
    if os.environ.get("OC_BREAKER") == "1":
        # Word for word what 2026.10.6 logs on a start after three unclean
        # boots, and for each channel it then holds back.
        log("error", "gateway restart-loop breaker tripped: 3 unclean boot(s) within %sms; suppressing channel/provider account auto-start. Inspect the stability bundle and fix the startup crash before restarting the service. %s"
            % (os.environ.get("OC_BREAKER_WINDOW_MS", "300000"), hint({"channel": "<id>"})))
        for channel in [c for c in os.environ.get("OC_HELD", "").split(",") if c]:
            log("warn", "channel autostart suppressed by crash-loop breaker; refusing automatic start for %s. %s" % (channel, hint({"channel": channel})))
    log("info", "[gateway] ready")
    sys.exit(0)
if cmd[:2] == ["doctor", "--fix"]:
    if os.environ.get("OC_DOCTOR_REPAIRS") == "1":
        for db in dbs:
            rows = bad_rows(db)
            if rows:
                c = sqlite3.connect(db)
                c.execute("CREATE TABLE IF NOT EXISTS sessions_quarantine(id TEXT, body TEXT)")
                for sid in rows:
                    c.execute("INSERT INTO sessions_quarantine SELECT id, body FROM sessions WHERE id = ?", (sid,))
                    c.execute("DELETE FROM sessions WHERE id = ?", (sid,))
                c.commit()
                c.close()
    log("info", "doctor: checking agent database main failed validation earlier; repairs applied")
    if os.environ.get("OC_DOCTOR_EXIT", "0") != "0":
        print("doctor: some repairs could not be applied", file=sys.stderr)
        sys.exit(int(os.environ["OC_DOCTOR_EXIT"]))
    print("Doctor complete.")
    sys.exit(0)
if cmd[:3] == ["doctor", "--session-sqlite", "recover"]:
    print(json.dumps({"issues": [], "recoveryIssues": []}))
    sys.exit(0)
print("unexpected: %s" % " ".join(cmd), file=sys.stderr)
sys.exit(64)
`);
  const stub = path.join(binDir, "openclaw");
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$OC_CALLS"\nexec python3 "${core}" "$@"\n`);
  chmodSync(stub, 0o755);
  // The journal: what the gateway printed when the case gives it one, nothing
  // otherwise — the web server's account is not always in a journal-reading group.
  const jctl = path.join(binDir, "journalctl");
  writeFileSync(jctl, `#!/usr/bin/env bash\n[ -n "\${OC_JOURNAL:-}" ] && [ -f "$OC_JOURNAL" ] && cat "$OC_JOURNAL"\nexit 0\n`);
  chmodSync(jctl, 0o755);
}

function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PATH: `${binDir}:/usr/bin:/bin`,
    HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OC_CALLS: calls,
    OC_LOG_DIR: logDir,
    ...extra,
  };
}

function guard(restarts: number, extra: Record<string, string> = {}) {
  const r = spawnSync("python3", [
    "-I", HELPER, "start-guard",
    "--state-dir", stateDir, "--config", path.join(stateDir, "openclaw.json"), "--data-dir", dataDir,
    "--openclaw-bin", path.join(binDir, "openclaw"), "--restarts", String(restarts),
    "--budget-seconds", "300", "--log-dir", logDir,
  ], { encoding: "utf-8", env: env(extra), timeout: 60_000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** ExecStart: 0 when the core admitted every database. */
function gateway(extra: Record<string, string> = {}): number {
  return spawnSync(path.join(binDir, "openclaw"), ["gateway"], { encoding: "utf-8", env: env(extra) }).status ?? 1;
}

/**
 * systemd with `Restart=always`: the pre-start's guard, then the gateway; on a
 * failed start, again with one more automatic restart counted.
 */
function bootLoop(extra: Record<string, string> = {}, maxStarts = 10, afterGuard?: () => void) {
  const said: string[] = [];
  for (let start = 1, restarts = 0; start <= maxStarts; start++, restarts++) {
    const g = guard(restarts, extra);
    expect(g.status).toBe(0);
    said.push(g.out);
    // The rest of the pre-start, between the guard and the gateway.
    afterGuard?.();
    if (gateway(extra) === 0) return { up: true, starts: start, said: said.join("") };
  }
  return { up: false, starts: maxStarts, said: said.join("") };
}

const doctorCalls = () => (existsSync(calls) ? readFileSync(calls, "utf-8").trim().split("\n") : []).filter((l) => l.startsWith("doctor"));

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "start-guard-"));
  stateDir = path.join(root, ".openclaw");
  dataDir = path.join(root, "data");
  binDir = path.join(root, "bin");
  logDir = path.join(root, "logs");
  calls = path.join(root, "calls.log");
  journal = path.join(root, "journal.jsonl");
  for (const d of [stateDir, dataDir, binDir, logDir]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(stateDir, "openclaw.json"), "{}");
  writeCore();
  // The default agent, with the one row the core refuses among good ones, and
  // a healthy second agent that nothing here may touch.
  makeDb(agentDb("main"), [good("s1"), good("s2"), good("s3"), BAD, good("s4")]);
  makeDb(agentDb("ops"), [good("o1"), good("o2")]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasPython3)("openclaw-db-maintenance.py start-guard", () => {
  it("repairs a bad-row start loop with the core's own doctor, and the gateway starts", () => {
    const opsBefore = readFileSync(agentDb("ops"));

    const run = bootLoop({ OC_DOCTOR_REPAIRS: "1" });

    // Three automatic restarts make a loop; the fourth start is repaired and comes up.
    expect(run.up).toBe(true);
    expect(run.starts).toBe(4);
    expect(doctorCalls()).toEqual([
      "doctor --fix --non-interactive --yes",
      "doctor --session-sqlite recover --session-sqlite-all-agents --non-interactive --json",
    ]);
    expect(run.said).toMatch(/restarted itself 3 times over a database it refused: .*agent-database:main/);
    // Every good session is still there, and the refused row was kept, not dropped.
    expect(sessionIds(agentDb("main"))).toEqual(["s1", "s2", "s3", "s4"]);
    expect(sessionIds(agentDb("main"), "sessions_quarantine")).toEqual(["s-bad"]);
    expect(readFileSync(agentDb("ops")).equals(opsBefore)).toBe(true);
    const g = guardFile();
    expect(g.episode).toMatchObject({ stage: "repaired", databases: ["agent main"] });
    expect(g.notice).toMatchObject({ outcome: "repaired", reason: null, databases: ["agent main"] });
    // The recovered start follows unclean boots: the breaker watch is asked for.
    expect(g.channels).toMatchObject({ watch: true, state: "watching" });

    // The next start (by hand, so no restarts counted) sees `gateway ready`
    // after the repair: the episode is over.
    guard(0, { OC_DOCTOR_REPAIRS: "1" });
    expect(guardFile().episode.settledAt).toBeGreaterThan(g.episode.actedTo);
  });

  it("puts back the database's pre-update copy when the repair does not help, setting the refused one aside", async () => {
    // What the update's migration kept: the database as it was before, two
    // sessions older than today's and without the row the core now refuses.
    const bak = `${agentDb("main")}.pre-startup-migration-20261020T101010Z-abc.bak`;
    makeDb(bak, [good("s1"), good("s2")]);
    writeFileSync(`${agentDb("main")}-shm`, "stale shared memory of the refused generation");
    const opsBefore = readFileSync(agentDb("ops"));

    const run = bootLoop({ OC_DOCTOR_REPAIRS: "0" });

    expect(run.up).toBe(true);
    // Repaired at the fourth start, still refused; the fifth runs on the copy.
    expect(run.starts).toBe(5);
    expect(doctorCalls()).toHaveLength(2);
    expect(sessionIds(agentDb("main"))).toEqual(["s1", "s2"]);
    // Nothing deleted: the refused generation, sessions and sidecar and all,
    // is beside it under one suffix, and the copy itself is still there.
    const dir = path.dirname(agentDb("main"));
    const aside = readdirSync(dir).filter((n) => n.includes(".clawbox-start-loop-"));
    const main = aside.find((n) => n.startsWith("openclaw-agent.sqlite.clawbox-start-loop-"));
    expect(main).toBeDefined();
    expect(aside).toContainEqual(main!.replace("openclaw-agent.sqlite.", "openclaw-agent.sqlite-shm."));
    expect(sessionIds(path.join(dir, main!))).toEqual(["s-bad", "s1", "s2", "s3", "s4"]);
    expect(existsSync(bak)).toBe(true);
    expect(existsSync(`${agentDb("main")}-shm`)).toBe(false);
    // The healthy agent is not the one the core refused, and is not touched.
    expect(readFileSync(agentDb("ops")).equals(opsBefore)).toBe(true);
    const g = guardFile();
    expect(g.episode).toMatchObject({ stage: "restored" });
    expect(g.notice).toMatchObject({ outcome: "restored", databases: ["agent main"], keptCopies: [main] });
    expect(g.restoredFrom).toEqual([bak]);

    // ...and what the owner is shown is read from that same record.
    const saved = process.env.CLAWBOX_ROOT;
    process.env.CLAWBOX_ROOT = root;
    try {
      expect(await readOpenclawStartRecovery()).toEqual({ outcome: "restored", reason: null, at: g.notice.at, channelsSuppressed: false });
    } finally {
      process.env.CLAWBOX_ROOT = saved;
    }
  });

  it("does not call a repair complete when doctor exited non-zero", () => {
    // Doctor fixed the row on its way, but said it could not finish.
    const run = bootLoop({ OC_DOCTOR_REPAIRS: "1", OC_DOCTOR_EXIT: "1" });

    expect(run.up).toBe(true);
    const g = guardFile();
    expect(g.episode).toMatchObject({ stage: "repairing", repairAttempts: 1 });
    expect(g.episode.steps[0]).toMatchObject({ command: "doctor --fix", exit: 1 });
    expect(g.notice).toMatchObject({ outcome: "repaired", reason: "repair-incomplete" });
  });

  it("knows the refused database from the session key 2026.10.6 names, and puts back its copy", () => {
    // The core's own words name no database and no agent id, only the key of
    // the row: "... requires repair for agent:main:s-bad".
    const bak = `${agentDb("main")}.pre-startup-migration-20261020T101010Z-abc.bak`;
    makeDb(bak, [good("s1"), good("s2")]);
    const opsBefore = readFileSync(agentDb("ops"));

    const run = bootLoop({ OC_DOCTOR_REPAIRS: "0", OC_CORE_WORDING: "2026.10.6" });

    expect(run.said).toMatch(/restarted itself 3 times over a database it refused: .*agent:main:s-bad/);
    expect(run.up).toBe(true);
    expect(run.starts).toBe(5);
    expect(sessionIds(agentDb("main"))).toEqual(["s1", "s2"]);
    expect(readFileSync(agentDb("ops")).equals(opsBefore)).toBe(true);
    const g = guardFile();
    expect(g.notice).toMatchObject({ outcome: "restored", reason: null, databases: ["agent main"] });
    expect(g.restoredFrom).toEqual([bak]);
  });

  it("gives up after the repair when there is no pre-update copy, says so once, and deletes nothing", () => {
    const run = bootLoop({ OC_DOCTOR_REPAIRS: "0" }, 8);

    expect(run.up).toBe(false);
    // One repair, then the restore leg finds nothing to put back; the starts
    // after that run no doctor again — they are left to the unit's start limit.
    expect(doctorCalls()).toHaveLength(2);
    expect(run.said).toMatch(/could not put back a pre-update copy \(no-backup\)/);
    expect(run.said).toMatch(/already gave up on this loop/);
    expect(sessionIds(agentDb("main"))).toEqual(["s-bad", "s1", "s2", "s3", "s4"]);
    expect(guardFile().notice).toMatchObject({ outcome: "failed", reason: "no-backup" });
    // A gateway that does not start has no breaker to watch.
    expect(guardFile().channels).toBeUndefined();
  });

  it("reads the gateway's words from the journal when the log file has none", () => {
    rmSync(logDir, { recursive: true, force: true });
    const extra = { OC_DOCTOR_REPAIRS: "1", OC_JOURNAL: journal, OC_LOG_DIR: path.join(root, "elsewhere") };

    const run = bootLoop(extra);

    expect(run.up).toBe(true);
    expect(run.starts).toBe(4);
    expect(guardFile().notice).toMatchObject({ outcome: "repaired" });
  });

  it("acts on the gateway's words only, never this pre-start's own", () => {
    // The pre-start's lines share the unit's journal under its own name.
    const extra = { OC_JOURNAL: journal, OC_GATEWAY_FAILS_WITH: "Plugin \"discord\": configured plugin payload verification failed" };
    const line = (msg: string) => JSON.stringify({ __REALTIME_TIMESTAMP: String(Date.now() * 1000), SYSLOG_IDENTIFIER: "gateway-pre-start.sh", MESSAGE: msg });
    appendFileSync(journal, `${line("  WARN: agent database main failed validation in a test line")}\n`);

    const run = bootLoop(extra, 6);

    expect(run.up).toBe(false);
    expect(doctorCalls()).toEqual([]);
    expect(run.said).toMatch(/not over a database it refused/);
    expect(guardFile().notice).toBeUndefined();
  });

  it("never touches a secondary agent's database: the core carries on without one, so it is not what stops a start", () => {
    makeDb(agentDb("main"), [good("s1")]);
    makeDb(agentDb("ops"), [good("o1"), BAD]);
    const bak = `${agentDb("ops")}.pre-startup-migration-20261020T101010Z-abc.bak`;
    makeDb(bak, [good("o1")]);

    const run = bootLoop({ OC_DOCTOR_REPAIRS: "0" }, 6);

    expect(run.up).toBe(false);
    expect(doctorCalls()).toEqual([]);
    expect(run.said).toMatch(/the database it names \(agent ops\) is not one that stops a start/);
    expect(sessionIds(agentDb("ops"))).toEqual(["o1", "s-bad"]);
    expect(readdirSync(path.dirname(agentDb("ops"))).some((n) => n.includes(".clawbox-start-loop-"))).toBe(false);
  });

  it("treats the agent the config marks as the default as the one that stops a start", () => {
    writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify({ agents: { entries: { ops: { default: true } } } }));
    makeDb(agentDb("main"), [good("s1")]);
    makeDb(agentDb("ops"), [good("o1"), BAD]);

    const run = bootLoop({ OC_DOCTOR_REPAIRS: "1" });

    expect(run.up).toBe(true);
    expect(run.starts).toBe(4);
    expect(sessionIds(agentDb("ops"))).toEqual(["o1"]);
    expect(guardFile().notice).toMatchObject({ outcome: "repaired", databases: ["agent ops"] });
  });

  it("leaves a loop over something else alone", () => {
    const run = bootLoop({ OC_GATEWAY_FAILS_WITH: "Plugin \"discord\": configured plugin payload verification failed" }, 6);

    expect(run.up).toBe(false);
    expect(doctorCalls()).toEqual([]);
    expect(guardFile().episode).toBeUndefined();
  });

  it("removes a half-written restore copy a killed start left behind, and nothing else", () => {
    // A copy of a few GB on a slow card, stopped by the pre-start's own
    // `timeout` or a power cut: left there, every later attempt added another.
    const bak = `${agentDb("main")}.pre-startup-migration-20261020T101010Z-abc.bak`;
    makeDb(bak, [good("s1")]);
    const partial = `${agentDb("main")}.clawbox-restoring-4242`;
    writeFileSync(partial, "half a database");
    const before = readFileSync(agentDb("main"));

    const g = guard(0);

    expect(g.status).toBe(0);
    expect(g.out).toMatch(/removed a half-written restore copy beside agent main/);
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(bak)).toBe(true);
    expect(readFileSync(agentDb("main")).equals(before)).toBe(true);
  });

  it("does nothing at an ordinary start but record it, and what the last run proved", () => {
    makeDb(agentDb("main"), [good("s1")]);
    expect(guard(0).status).toBe(0);
    expect(gateway()).toBe(0);
    expect(guard(0).status).toBe(0);

    expect(doctorCalls()).toEqual([]);
    const g = guardFile();
    expect(g.starts).toHaveLength(2);
    expect(g.provenAt).toBeGreaterThan(g.starts[0].at);
    expect(g.episode).toBeUndefined();
  });
});

/**
 * `breaker-watch`: after the recovery, the core's restart-loop breaker. The
 * failed starts before it were unclean boots, so the recovered start comes up
 * with channel auto-start held back. The core lifts that itself; the watch
 * follows the gateway's own words until it does, tells the owner meanwhile,
 * and starts the held channels with the core's own override only when the
 * core has not lifted it in time.
 */
describe.skipIf(!hasPython3)("openclaw-db-maintenance.py breaker-watch (after a start-guard recovery)", () => {
  let server: http.Server;
  let port: number;
  let startupz: number;
  let watcher: ChildProcess | null;

  beforeEach(async () => {
    startupz = 200;
    watcher = null;
    server = http.createServer((req, res) => {
      res.writeHead(req.url === "/startupz" ? startupz : 404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    watcher?.kill("SIGKILL");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const TRIP = (windowMs: number) =>
    `gateway restart-loop breaker tripped: 3 unclean boot(s) within ${windowMs}ms; suppressing channel/provider account auto-start.`;
  const RECOVERED = "gateway restart-loop breaker recovered; channel auto-start restored";

  /** The watch as the pre-start detaches it; resolves when it exits. */
  function watch(extra: Record<string, string> = {}, args: string[] = []) {
    const child = spawn("python3", [
      "-I", HELPER, "breaker-watch",
      "--data-dir", dataDir, "--config", path.join(stateDir, "openclaw.json"),
      "--openclaw-bin", path.join(binDir, "openclaw"), "--log-dir", logDir, "--gateway-port", String(port),
      "--poll-seconds", "0.1", "--wait-seconds", "10", "--read-grace-seconds", "5",
      // The core lifts it at most a health-monitor check after the window:
      // far off here, unless the case brings it near.
      "--health-check-seconds", "600",
      ...args,
    ], { env: env(extra) });
    watcher = child;
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const done = new Promise<{ code: number | null; out: string }>((resolve) => child.on("exit", (code) => resolve({ code, out })));
    return { done };
  }

  /** The repaired start loop, the watch detached by the pre-start that follows the repair. */
  function recoveredStart(extra: Record<string, string>, args: string[] = [], watchEnv: Record<string, string> = extra) {
    let w: ReturnType<typeof watch> | null = null;
    const run = bootLoop({ OC_DOCTOR_REPAIRS: "1", ...extra }, 10, () => {
      if (!w && guardFile().channels?.watch === true) w = watch(watchEnv, args);
    });
    expect(run.up).toBe(true);
    expect(w).not.toBeNull();
    return w!;
  }

  /** A line from the running gateway. */
  function coreSays(msg: string, extra: Record<string, string> = {}) {
    expect(spawnSync("python3", [path.join(binDir, "core.py"), "say", msg], { env: env(extra) }).status).toBe(0);
  }

  async function until(check: () => boolean, ms = 20_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (check()) return true;
      } catch {
        // the record between two writes
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  async function ownerSees() {
    const saved = process.env.CLAWBOX_ROOT;
    process.env.CLAWBOX_ROOT = root;
    try {
      return await readOpenclawStartRecovery();
    } finally {
      process.env.CLAWBOX_ROOT = saved;
    }
  }

  const manualStarts = () => (existsSync(calls) ? readFileSync(calls, "utf-8").trim().split("\n") : []).filter((l) => l.startsWith("gateway call") || l.startsWith("channels status"));

  it("tells the owner which channels the breaker holds back after the repair, until the core lifts it itself", async () => {
    // Journal and log file both: two copies of every line, one channel each.
    const extra = { OC_BREAKER: "1", OC_HELD: "telegram,discord", OC_JOURNAL: journal };
    const w = recoveredStart(extra);

    expect(await until(() => guardFile().channels.state === "suppressed")).toBe(true);
    expect(guardFile().channels).toMatchObject({ watch: true, held: [{ channel: "discord" }, { channel: "telegram" }] });
    expect(await ownerSees()).toMatchObject({ outcome: "repaired", channelsSuppressed: true });

    // The core's health monitor, once the window has drained.
    coreSays(RECOVERED, extra);
    const r = await w.done;

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/holds back discord, telegram/);
    expect(r.out).toMatch(/lifted its restart-loop breaker; channel auto-start is back/);
    expect(guardFile().channels).toMatchObject({ watch: false, state: "restored" });
    expect(await ownerSees()).toMatchObject({ outcome: "repaired", channelsSuppressed: false });
    // The core lifted it: nothing was started by hand.
    expect(manualStarts()).toEqual([]);
  });

  it("starts each held account with the core's own override when the core has not lifted it in time", async () => {
    const trip = TRIP(1000);
    const status = {
      channelAccounts: {
        telegram: [{ accountId: "default", running: false, lastError: trip }],
        // The account the breaker held back, and one the owner started since.
        discord: [{ accountId: "default", running: false, lastError: { message: trip } }, { accountId: "ops", running: true, lastError: null }],
      },
    };
    const extra = { OC_BREAKER: "1", OC_BREAKER_WINDOW_MS: "1000", OC_HELD: "telegram,discord", OC_CHANNELS_STATUS: JSON.stringify(status) };
    const w = recoveredStart(extra, ["--health-check-seconds", "0.5", "--health-grace-seconds", "0", "--margin-seconds", "0.5"]);

    const r = await w.done;

    expect(r.code).toBe(0);
    expect(manualStarts()).toEqual([
      "channels status --json --timeout 10000",
      "gateway call channels.start --params {\"accountId\": \"default\", \"channel\": \"discord\"} --json --timeout 30000",
      "gateway call channels.start --params {\"accountId\": \"default\", \"channel\": \"telegram\"} --json --timeout 30000",
    ]);
    expect(r.out).toMatch(/had not lifted its restart-loop breaker; started discord \(default\), telegram \(default\) by hand/);
    expect(guardFile().channels).toMatchObject({
      watch: false,
      state: "started",
      manualStarts: [
        { channel: "discord", accountId: "default", ok: true, exit: 0 },
        { channel: "telegram", accountId: "default", ok: true, exit: 0 },
      ],
    });
    expect(await ownerSees()).toMatchObject({ channelsSuppressed: false });
  });

  it("keeps telling the owner when the override fails too, and the next start looks again", async () => {
    const extra = { OC_BREAKER: "1", OC_BREAKER_WINDOW_MS: "1000", OC_HELD: "telegram", OC_MANUAL_START_FAILS: "1" };
    const w = recoveredStart(extra, ["--health-check-seconds", "0.5", "--health-grace-seconds", "0", "--margin-seconds", "0.5"]);

    const r = await w.done;

    expect(r.code).toBe(0);
    // The gateway's status answered nothing usable: the channel the log named.
    expect(manualStarts()).toContain("gateway call channels.start --params {\"channel\": \"telegram\"} --json --timeout 30000");
    expect(r.out).toMatch(/channels\.start did not start telegram; the owner is told/);
    expect(guardFile().channels).toMatchObject({ watch: true, state: "suppressed", manualStarts: [{ channel: "telegram", ok: false, exit: 1 }] });
    expect(await ownerSees()).toMatchObject({ channelsSuppressed: true });

    // The next start, past the window: the core lifts it as it boots.
    const next = watch();
    coreSays(RECOVERED);
    expect((await next.done).code).toBe(0);
    expect(guardFile().channels).toMatchObject({ watch: false, state: "restored" });
    expect(await ownerSees()).toMatchObject({ channelsSuppressed: false });
  });

  it("says nothing about channels when the recovered start did not trip the breaker, whatever an earlier start said", async () => {
    // A trip from an earlier start, before this one's pre-start.
    coreSays(TRIP(300000), { OC_TIME_OFFSET: "-120" });
    const w = recoveredStart({});

    const r = await w.done;

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/did not trip the core's restart-loop breaker/);
    expect(guardFile().channels).toMatchObject({ watch: false, state: "clear" });
    expect(manualStarts()).toEqual([]);
    expect(await ownerSees()).toMatchObject({ channelsSuppressed: false });
  });

  it("claims nothing when the gateway's own output cannot be read", async () => {
    // The guard read the loop from the journal; the watch's account cannot,
    // and the core's log file is somewhere it does not look.
    const elsewhere = path.join(root, "elsewhere");
    const w = recoveredStart({ OC_JOURNAL: journal, OC_LOG_DIR: elsewhere }, ["--read-grace-seconds", "1"], { OC_LOG_DIR: elsewhere });

    const r = await w.done;

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/cannot be read/);
    expect(guardFile().channels).toMatchObject({ watch: false, state: "unknown" });
    expect(await ownerSees()).toMatchObject({ channelsSuppressed: false });
  });

  it("leaves the watch to the next start when the gateway does not start", async () => {
    startupz = 503;
    writeFileSync(path.join(dataDir, "openclaw-start-guard.json"), JSON.stringify({ channels: { watch: true, state: "watching", since: Date.now() / 1000 } }));

    const r = await watch({}, ["--wait-seconds", "1"]).done;

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/waits for the next gateway start/);
    expect(guardFile().channels).toMatchObject({ watch: true, state: "watching" });
  });

  it("does nothing when no recovery asked for it, and lets a day-old watch go", async () => {
    writeFileSync(path.join(dataDir, "openclaw-start-guard.json"), JSON.stringify({ starts: [] }));
    expect((await watch().done).code).toBe(0);
    expect(guardFile()).toEqual({ starts: [] });

    writeFileSync(path.join(dataDir, "openclaw-start-guard.json"), JSON.stringify({ channels: { watch: true, state: "suppressed", since: Date.now() / 1000 - 2 * 86400 } }));
    expect((await watch().done).code).toBe(0);
    expect(guardFile().channels).toMatchObject({ watch: false, state: "expired" });
    expect(manualStarts()).toEqual([]);
  });
});
