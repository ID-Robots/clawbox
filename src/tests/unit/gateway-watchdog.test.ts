import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

/**
 * TASK-2490. A customer gateway stayed alive and silent for seven hours: the
 * process never exited, so `Restart=always` had nothing to catch, and Settings >
 * Harness said "OpenClaw is not running" until somebody rebooted the box.
 * scripts/gateway-watchdog.sh is the root oneshot clawbox-gateway-watchdog.timer
 * runs once a minute to restart such a gateway, and these EXECUTE it, against
 * stubbed systemctl / curl / logger and a fake data/config.json, moving its
 * monotonic clock run by run. What is asserted is what it asked systemd to do
 * and what it wrote to the journal — never its source text.
 */

// Real bash per run, several runs per case: see src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const REPO = path.resolve(__dirname, "../../..");
const WATCHDOG = path.join(REPO, "scripts", "gateway-watchdog.sh");
const GUARD = path.join(REPO, "scripts", "gateway-unit-guard.sh");
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

beforeAll(() => {
  // Unconditional: a runner without them would report green while proving nothing.
  if (!hasBash || !hasPython) throw new Error("bash and python3 are required: these tests execute the shipped script");
});

let box: string;
let libexec: string;
let runDir: string;
let root: string;

/** The unit as `systemctl show` reports it. */
interface Unit {
  active?: string;
  sub?: string;
  pid?: number;
  invocation?: string;
  /** Seconds since boot at which the unit became active. */
  enteredAt?: number;
  freezer?: string;
}

function setUnit(u: Unit = {}): void {
  const lines = [
    `ActiveState=${u.active ?? "active"}`,
    `SubState=${u.sub ?? "running"}`,
    `MainPID=${u.pid ?? 4242}`,
    `InvocationID=${u.invocation ?? "inv-a"}`,
    `ActiveEnterTimestampMonotonic=${(u.enteredAt ?? 100) * 1_000_000}`,
    `FreezerState=${u.freezer ?? "running"}`,
  ];
  fs.writeFileSync(path.join(box, "props"), `${lines.join("\n")}\n`);
}

function setConfig(cfg: Record<string, unknown> | null): void {
  const file = path.join(root, "data", "config.json");
  if (cfg === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, JSON.stringify(cfg));
}

/** One curl exit code per call, the last one repeating. 0 is any HTTP answer. */
function setCurl(...codes: number[]): void {
  fs.writeFileSync(path.join(box, "curl-rcs"), codes.join("\n") + "\n");
  fs.rmSync(path.join(box, "curl-calls"), { force: true });
}

function write(name: string, body: string, mode = 0o755): void {
  fs.writeFileSync(path.join(box, "bin", name), body, { mode });
}

beforeEach(() => {
  box = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-gw-watchdog-"));
  libexec = path.join(box, "libexec");
  runDir = path.join(box, "run");
  root = path.join(box, "clawbox");
  for (const d of [libexec, runDir, path.join(root, "data"), path.join(box, "bin")]) fs.mkdirSync(d, { recursive: true });
  // The installed shape: the script and its guard side by side, the guard
  // found from the script's own directory.
  fs.copyFileSync(WATCHDOG, path.join(libexec, "gateway-watchdog.sh"));
  fs.copyFileSync(GUARD, path.join(libexec, "gateway-unit-guard.sh"));
  fs.writeFileSync(path.join(box, "load-state"), "loaded\n");
  fs.writeFileSync(path.join(box, "try-restart-rc"), "0\n");
  setUnit();
  setConfig({ setup_complete: true });
  setCurl(0);

  write(
    "systemctl",
    `#!/usr/bin/env bash
B=${JSON.stringify(box)}
echo "$*" >> "$B/systemctl.log"
case " $* " in
  *" LoadState "*) [ -f "$B/load-state" ] && cat "$B/load-state"; exit 0 ;;
  *" list-units "*) [ -f "$B/root-steps" ] && cat "$B/root-steps"; exit 0 ;;
  *" list-jobs "*) [ -f "$B/jobs" ] && cat "$B/jobs"; exit 0 ;;
  *" try-restart "*) exit "$(cat "$B/try-restart-rc")" ;;
  *" show "*) cat "$B/props"; exit 0 ;;
esac
exit 0
`,
  );
  write(
    "curl",
    `#!/usr/bin/env bash
B=${JSON.stringify(box)}
echo "$*" >> "$B/curl.log"
n=$(( $(cat "$B/curl-calls" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$B/curl-calls"
total=$(grep -c . "$B/curl-rcs")
[ "$n" -le "$total" ] || n=$total
[ -f "$B/curl-sleep" ] && sleep "$(cat "$B/curl-sleep")"
exit "$(sed -n "\${n}p" "$B/curl-rcs")"
`,
  );
  write(
    "logger",
    `#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in -t) shift 2 ;; --) shift; break ;; *) break ;; esac; done
echo "$*" >> ${JSON.stringify(path.join(box, "journal"))}
`,
  );
});

afterEach(() => {
  fs.rmSync(box, { recursive: true, force: true });
});

function journal(): string {
  try {
    return fs.readFileSync(path.join(box, "journal"), "utf-8");
  } catch {
    return "";
  }
}

function restarts(): string[] {
  try {
    return fs
      .readFileSync(path.join(box, "systemctl.log"), "utf-8")
      .split("\n")
      .filter((l) => l.includes("try-restart"));
  } catch {
    return [];
  }
}

function curlCalls(): number {
  try {
    return fs.readFileSync(path.join(box, "curl.log"), "utf-8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** One timer run, `now` seconds after boot. */
function runAt(now: number, env: Record<string, string> = {}) {
  const r = spawnSync("bash", [path.join(libexec, "gateway-watchdog.sh")], {
    encoding: "utf-8",
    timeout: 30_000,
    env: testEnv({
      PATH: `${path.join(box, "bin")}:${process.env.PATH ?? ""}`,
      CLAWBOX_ROOT: root,
      CLAWBOX_RUN_DIR: runDir,
      CLAWBOX_GATEWAY_MAINTENANCE_GUARD: path.join(box, "maintenance"),
      CLAWBOX_WATCHDOG_CLOCK: String(now),
      // One attempt per run unless a case is about the retries: each retry
      // sleeps a quarter of a second.
      CLAWBOX_WATCHDOG_PROBE_ATTEMPTS: "1",
      ...env,
    }),
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  return r;
}

/** Timer runs a minute apart from `start`, the gateway silent throughout. */
function silentFor(start: number, runs: number): number {
  let t = start;
  for (let i = 0; i < runs; i++) {
    runAt(t);
    t += 60;
  }
  return t;
}

const T0 = 1_000; // well past the default 300 s start-up grace of a unit up since 100 s

describe("gateway liveness watchdog — when it restarts", () => {
  it("does nothing and writes nothing while the gateway answers", () => {
    setCurl(0);
    for (let t = T0; t < T0 + 600; t += 60) runAt(t);
    expect(restarts()).toEqual([]);
    expect(journal()).toBe("");
    expect(fs.existsSync(path.join(runDir, "gateway-watchdog.state"))).toBe(false);
  });

  it("probes the gateway's base URL the way harnessHealthy does: any HTTP answer is alive", () => {
    runAt(T0);
    const call = fs.readFileSync(path.join(box, "curl.log"), "utf-8").trim();
    expect(call).toContain("http://127.0.0.1:18789/");
    // No -f / --fail: a 401, 404 or 500 is a server that is up.
    expect(call.split(/\s+/)).not.toContain("-f");
    expect(call).not.toMatch(/--fail\b/);
    expect(call).toContain("--max-time 5");
  });

  it("honours GATEWAY_PORT like src/lib/harness.ts", () => {
    runAt(T0, { GATEWAY_PORT: "18800" });
    expect(fs.readFileSync(path.join(box, "curl.log"), "utf-8")).toContain("http://127.0.0.1:18800/");
  });

  it("restarts only after five consecutive failed probes spanning four minutes, and logs each one", () => {
    setCurl(28);
    silentFor(T0, 4); // T0 .. T0+180
    expect(restarts()).toEqual([]);
    const counted = journal().split("\n").filter((l) => l.includes("did not answer HTTP"));
    expect(counted).toHaveLength(4);
    expect(counted[0]).toMatch(/no answer within 5s, main process 4242/);
    expect(counted[3]).toMatch(/failed probe 4, unresponsive for 180s/);

    runAt(T0 + 240);
    expect(restarts()).toHaveLength(1);
    // try-restart: never starts a stopped unit; --job-mode=fail: never replaces
    // a stop someone else queued; --no-block: never waits on the gateway.
    expect(restarts()[0]).toMatch(/--no-block/);
    expect(restarts()[0]).toMatch(/--job-mode=fail/);
    expect(restarts()[0]).toMatch(/try-restart clawbox-gateway\.service/);
    expect(journal()).toMatch(/RESTARTING clawbox-gateway\.service: no HTTP answer on port 18789 for 240s across 5 consecutive probes/);
    // The record is cleared with the request: the new gateway starts at zero.
    expect(fs.existsSync(path.join(runDir, "gateway-watchdog.state"))).toBe(false);
  });

  it("five failures inside two minutes are not yet a sustained outage", () => {
    setCurl(7);
    for (let t = T0; t <= T0 + 120; t += 30) runAt(t); // 5 runs, 120 s
    expect(restarts()).toEqual([]);
    expect(journal()).toMatch(/connection refused/);
    runAt(T0 + 240);
    expect(restarts()).toHaveLength(1);
  });

  it("one answered probe clears the count, and says so", () => {
    setCurl(28);
    silentFor(T0, 4);
    setCurl(0);
    runAt(T0 + 240);
    expect(journal()).toMatch(/answers HTTP again on port 18789 after 4 failed probe\(s\) over 240s — not restarting/);
    setCurl(28);
    silentFor(T0 + 300, 4); // a fresh run of failures: four is not five
    expect(restarts()).toEqual([]);
  });

  it("a gateway that answers slowly but answers is never restarted", () => {
    // The incident's 48 s DeepSeek 500s and the llama.cpp fallback live behind
    // the gateway's HTTP server, not in front of it: the probe still answers,
    // just not instantly.
    fs.writeFileSync(path.join(box, "curl-sleep"), "0.3");
    setCurl(0);
    for (let t = T0; t < T0 + 900; t += 60) runAt(t);
    expect(restarts()).toEqual([]);
    expect(journal()).toBe("");
  });

  it("retries within one run, so a single slow attempt is not a failed probe", () => {
    setCurl(28, 28, 0);
    runAt(T0, { CLAWBOX_WATCHDOG_PROBE_ATTEMPTS: "3" });
    expect(curlCalls()).toBe(3);
    expect(journal()).toBe("");
  });

  it("a restarted gateway (new invocation) starts the count again", () => {
    setCurl(28);
    silentFor(T0, 4);
    setUnit({ invocation: "inv-b", enteredAt: T0 + 200 });
    // Past the new invocation's grace: T0+200+300.
    silentFor(T0 + 520, 4);
    expect(restarts()).toEqual([]);
  });

  it("failures with a long gap between them are not consecutive", () => {
    setCurl(28);
    silentFor(T0, 4);
    // The timer did not run for ten minutes (an update held it, a stop came and went).
    silentFor(T0 + 780, 4);
    expect(restarts()).toEqual([]);
  });

  it("gives a freshly started gateway its start-up grace before it probes it", () => {
    setUnit({ enteredAt: T0 - 60 });
    setCurl(7);
    for (let t = T0; t < T0 + 240; t += 60) runAt(t);
    expect(curlCalls()).toBe(0);
    expect(journal()).toBe("");
  });

  it("caps restarts at two an hour, says so once, and restarts again once the hour has passed", () => {
    setCurl(28);
    let t = silentFor(T0, 5);
    expect(restarts()).toHaveLength(1);
    // The restarted gateway hangs again straight after its grace.
    setUnit({ invocation: "inv-b", enteredAt: t });
    t = silentFor(t + 300, 5);
    expect(restarts()).toHaveLength(2);
    setUnit({ invocation: "inv-c", enteredAt: t });
    t = silentFor(t + 300, 10);
    expect(restarts()).toHaveLength(2);
    const refusals = journal().split("\n").filter((l) => l.startsWith("NOT restarting"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/already restarted 2 time\(s\) in the last 3600s/);
    // Still silent, a minute at a time: the cap lets one more through once the
    // first restart is an hour old, and not a run before.
    let at = t;
    while (restarts().length < 3 && at < T0 + 5_000) {
      runAt(at);
      at += 60;
    }
    expect(restarts()).toHaveLength(3);
    expect(at - 60).toBeGreaterThanOrEqual(T0 + 240 + 3600);
    expect(at - 60).toBeLessThan(T0 + 240 + 3600 + 60);
  });

  it("withdraws the restart from the cap when systemd refuses it", () => {
    fs.writeFileSync(path.join(box, "try-restart-rc"), "1\n");
    setCurl(28);
    silentFor(T0, 5);
    expect(journal()).toMatch(/systemd refused the request/);
    expect(fs.readFileSync(path.join(runDir, "gateway-watchdog.restarts"), "utf-8").trim()).toBe("");
    fs.writeFileSync(path.join(box, "try-restart-rc"), "0\n");
    runAt(T0 + 300);
    expect(journal()).toMatch(/RESTARTING/);
  });
});

describe("gateway liveness watchdog — when it stands down", () => {
  /** Four failed probes on record, then the condition, then two more runs. */
  function interruptedBy(setup: () => void): void {
    setCurl(28);
    silentFor(T0, 4);
    setup();
    runAt(T0 + 240);
    runAt(T0 + 300);
  }

  it.each(["masked", "not-found"])("does nothing at all on a %s gateway unit (Hermes, no gateway)", (state) => {
    fs.writeFileSync(path.join(box, "load-state"), `${state}\n`);
    setCurl(7);
    for (let t = T0; t < T0 + 600; t += 60) runAt(t);
    expect(curlCalls()).toBe(0);
    expect(restarts()).toEqual([]);
    expect(journal()).toBe("");
  });

  it("stands down when systemctl cannot say whether the unit is loaded", () => {
    interruptedBy(() => fs.rmSync(path.join(box, "load-state")));
    expect(restarts()).toEqual([]);
    expect(journal()).toMatch(/systemctl did not answer for its load state — cleared 4 failed probe\(s\)/);
  });

  it.each([
    ["inactive", "dead"],
    ["deactivating", "stop-sigterm"],
    ["activating", "start-pre"],
    ["activating", "auto-restart"],
    ["failed", "failed"],
  ])("never touches a unit that is %s/%s — stopped on purpose, starting or restarting", (active, sub) => {
    interruptedBy(() => setUnit({ active, sub }));
    expect(restarts()).toEqual([]);
    expect(journal()).toMatch(new RegExp(`it is ${active}/${sub}, not running`));
  });

  it("never touches a frozen gateway", () => {
    interruptedBy(() => setUnit({ freezer: "frozen" }));
    expect(restarts()).toEqual([]);
    expect(journal()).toMatch(/its cgroup is frozen/);
  });

  it("steps aside for a job already queued on the unit", () => {
    interruptedBy(() => fs.writeFileSync(path.join(box, "jobs"), "123 clawbox-gateway.service stop running\n"));
    expect(restarts()).toEqual([]);
    expect(journal()).toMatch(/a job is already queued/);
  });

  it("stands down while setup is not complete", () => {
    interruptedBy(() => setConfig({ setup_complete: false }));
    expect(restarts()).toEqual([]);
    expect(journal()).toMatch(/setup is not complete/);
  });

  it("stands down when data/config.json is missing, unparsable or not a plain file", () => {
    interruptedBy(() => setConfig(null));
    expect(journal()).toMatch(/data\/config\.json could not be read/);
    fs.writeFileSync(path.join(root, "data", "config.json"), "{not json");
    silentFor(T0 + 360, 6);
    const elsewhere = path.join(box, "elsewhere.json");
    fs.writeFileSync(elsewhere, JSON.stringify({ setup_complete: true }));
    fs.rmSync(path.join(root, "data", "config.json"));
    fs.symlinkSync(elsewhere, path.join(root, "data", "config.json"));
    silentFor(T0 + 800, 6);
    expect(restarts()).toEqual([]);
  });

  it("stands down while an update holds its lock, and judges again once the lock is hours stale", () => {
    const at = (ago: number) => new Date(Date.now() - ago * 1000).toISOString();
    interruptedBy(() =>
      setConfig({ setup_complete: true, update_in_progress: true, update_lock_holder: { pid: 1, at: at(60) } }),
    );
    expect(restarts()).toEqual([]);
    expect(journal()).toMatch(/an update is in progress \(lock refreshed \d+s ago\)/);

    // An older build's lock with no holder record still counts as an update.
    setConfig({ setup_complete: true, update_in_progress: true });
    silentFor(T0 + 360, 6);
    expect(restarts()).toEqual([]);

    // A lock last refreshed three hours ago belongs to a run that died.
    setConfig({ setup_complete: true, update_in_progress: true, update_lock_holder: { pid: 1, at: at(3 * 3600) } });
    silentFor(T0 + 800, 5);
    expect(restarts()).toHaveLength(1);
    expect(journal()).toMatch(/a run that died; judging clawbox-gateway\.service anyway/);
  });

  it("stands down while any root step runs (post_update, harness_swap, edition_select…)", () => {
    interruptedBy(() =>
      fs.writeFileSync(path.join(box, "root-steps"), "clawbox-root-update@harness_swap.service loaded activating start start ClawBox Root Update Step\n"),
    );
    expect(restarts()).toEqual([]);
    expect(journal()).toMatch(/a root step is running \(clawbox-root-update@harness_swap\.service\)/);
    // The root-step query is the template's instances, by state.
    const query = fs
      .readFileSync(path.join(box, "systemctl.log"), "utf-8")
      .split("\n")
      .find((l) => l.includes("list-units"));
    expect(query).toMatch(/clawbox-root-update@\*/);
    expect(query).toMatch(/--state=activating/);
  });

  it.each(["harness-swap.env", "edition-select.env"])("stands down for a fresh %s request, not a stale one", (file) => {
    const now = Math.floor(Date.now() / 1000);
    interruptedBy(() =>
      fs.writeFileSync(path.join(root, "data", file), `TARGET_EDITION=hermes\nREQUESTED_AT=${now - 30}\n`),
    );
    expect(restarts()).toEqual([]);
    expect(journal()).toMatch(new RegExp(`a harness change was requested \\(data/${file.replace(".", "\\.")}\\)`));
    fs.writeFileSync(path.join(root, "data", file), `TARGET_EDITION=hermes\nREQUESTED_AT=${now - 7200}\n`);
    silentFor(T0 + 360, 5);
    expect(restarts()).toHaveLength(1);
  });

  it("stands down under the gateway maintenance guard", () => {
    interruptedBy(() => fs.mkdirSync(path.join(box, "maintenance")));
    expect(restarts()).toEqual([]);
    expect(journal()).toMatch(/maintenance guard is up/);
  });

  it("refuses to run without its guard rather than judge the unit some other way", () => {
    fs.rmSync(path.join(libexec, "gateway-unit-guard.sh"));
    setCurl(28);
    silentFor(T0, 6);
    expect(curlCalls()).toBe(0);
    expect(restarts()).toEqual([]);
    expect(journal()).toMatch(/gateway-unit-guard\.sh missing or unreadable/);
  });
});
