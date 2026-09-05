import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, copyFileSync, chmodSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * GH #529 / TASK-664. `scripts/nm-dispatcher-failover.sh` restarted the OpenClaw
 * gateway the moment Ethernet carrier dropped, before anything had proven a
 * replacement route existed.
 *
 * On a headless box with no other uplink the gateway came back into a dead
 * network: Telegram's startup hit ENETUNREACH, the release died three times on
 * the unhandled socket error, and OpenClaw's account supervisor gave up. The
 * gateway kept running with BOTH Telegram accounts stopped — and when Ethernet
 * and DHCP recovered they stayed stopped until someone started them by hand.
 *
 * The restart is both the cause and the cure, so it is deferred rather than
 * dropped: the suppression lives in the gateway PROCESS (a RetrySupervisor in a
 * Map; `openclaw channels` has no start/resume verb), so a fresh process is the
 * only way back, and it has to land after the route does.
 *
 * These EXECUTE the shipped scripts against stubbed nmcli / ip / ping /
 * systemctl and assert on what was actually invoked. Grepping the source would
 * pass on a rewrite that kept the words and dropped the deferral.
 */

// Starts real processes (bash, and a helper that sleeps between polls): vitest's
// 5 s test and 10 s hook defaults are not enough. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const DISPATCHER = path.join(REPO, "scripts", "nm-dispatcher-failover.sh");
const WAITER = path.join(REPO, "scripts", "gateway-restart-when-online.sh");
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

// Unconditional, not skipIf: a runner without bash would report green while
// proving nothing about the one script standing between a carrier blip and a
// box that stops answering on Telegram until somebody notices.
beforeAll(() => {
  if (!hasBash) {
    throw new Error("bash is required: these tests execute the shipped scripts rather than reading them");
  }
});

let root: string;
let bin: string;

interface BoxOptions {
  /** What `nmcli -t networking connectivity check` answers, in order. */
  connectivity?: string[];
  /** Whether `ip route show default` prints a route. */
  defaultRoute?: boolean;
  /** Whether `ping` succeeds. */
  pingWorks?: boolean;
  /** Whether the gateway unit is active. */
  gatewayActive?: boolean;
}

/** A fake CLAWBOX_ROOT plus a PATH of stubs, so nothing touches a real radio. */
function makeBox(opts: BoxOptions = {}): void {
  root = mkdtempSync(path.join(tmpdir(), "clawbox-failover-"));
  bin = path.join(root, "bin");
  mkdirSync(path.join(root, "data"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(bin, { recursive: true });

  // The shipped waiter, where the dispatcher looks for it.
  copyFileSync(WAITER, path.join(root, "scripts", "gateway-restart-when-online.sh"));
  chmodSync(path.join(root, "scripts", "gateway-restart-when-online.sh"), 0o755);

  const stub = (name: string, body: string) => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  };

  const calls = path.join(root, "calls.log");
  writeFileSync(calls, "");

  // A queue of connectivity answers, consumed one per call, last one repeating
  // — so a test can say "none, none, then full" and watch the waiter wait.
  writeFileSync(path.join(root, "connectivity"), (opts.connectivity ?? ["none"]).join("\n") + "\n");
  stub("nmcli", `
echo "nmcli $*" >> ${JSON.stringify(calls)}
case "$*" in
  *"networking connectivity check"*)
    q=${JSON.stringify(path.join(root, "connectivity"))}
    head -n 1 "$q"
    if [ "$(wc -l < "$q")" -gt 1 ]; then tail -n +2 "$q" > "$q.next" && mv "$q.next" "$q"; fi
    ;;
  *) exit 0 ;;
esac`);

  stub("ip", `
echo "ip $*" >> ${JSON.stringify(calls)}
${opts.defaultRoute ? 'echo "default via 192.0.2.1 dev eth0"' : "true"}`);

  stub("ping", `
echo "ping $*" >> ${JSON.stringify(calls)}
exit ${opts.pingWorks ? 0 : 1}`);

  stub("systemctl", `
echo "systemctl $*" >> ${JSON.stringify(calls)}
case "$1" in
  is-active) exit ${opts.gatewayActive === false ? 1 : 0} ;;
  *) exit 0 ;;
esac`);

  stub("logger", `
shift 2 2>/dev/null || true
echo "log $*" >> ${JSON.stringify(root + "/journal.log")}`);

  // Real `sleep` would make a 120 s wait a 120 s test.
  stub("sleep", "true");
  // The dispatcher launches the waiter DETACHED, so a test that let it run
  // would be racing it. Record the request instead: the dispatcher's contract
  // is that it asks and returns, and the waiter's own decisions are exercised
  // directly above.
  stub("setsid", `echo "detached $*" >> ${JSON.stringify(calls)}`);
}

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CLAWBOX_ROOT: root,
    CLAWBOX_ONLINE_TIMEOUT: "2",
    CLAWBOX_ONLINE_POLL: "1",
    NETWORK_INTERFACE: "wlan0",
    ...extra,
  };
}

function runDispatcher(iface: string, action: string): void {
  const r = spawnSync("bash", [DISPATCHER, iface, action], { env: env(), encoding: "utf-8", timeout: 25_000 });
  expect(r.status).toBe(0);
}

function runWaiter(reason = "test"): { stdout: string } {
  const r = spawnSync("bash", [path.join(root, "scripts", "gateway-restart-when-online.sh"), reason], {
    env: env(),
    encoding: "utf-8",
    timeout: 25_000,
  });
  expect(r.status).toBe(0);
  return { stdout: r.stdout };
}

function calls(): string {
  return existsSync(path.join(root, "calls.log")) ? readFileSync(path.join(root, "calls.log"), "utf-8") : "";
}

function journal(): string {
  const f = path.join(root, "journal.log");
  return existsSync(f) ? readFileSync(f, "utf-8") : "";
}

function restarts(): number {
  return calls().split("\n").filter((l) => l.startsWith("systemctl restart")).length;
}

/**
 * Detached waiter launches the dispatcher asked for, with their reasons.
 *
 * Polled: the dispatcher backgrounds the launch and returns without waiting for
 * it, which is the property under test — so the assertion has to allow for the
 * child landing a moment after the parent exits.
 */
async function deferredEventually(expected: number): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const seen = deferred();
    if (seen.length >= expected || Date.now() > deadline) return seen;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function deferred(): string[] {
  return calls()
    .split("\n")
    .filter((l) => l.startsWith("detached ") && l.includes("gateway-restart-when-online.sh"));
}

describe("Ethernet failover does not restart the gateway into a dead network", () => {
  it("does not restart while no public route exists", () => {
    // The whole defect: the restart landed here, and the accounts never came
    // back from it.
    makeBox({ connectivity: ["none"], defaultRoute: false });

    runWaiter("Ethernet 'eth0' down");

    expect(restarts()).toBe(0);
    expect(journal()).toContain("NOT restarting");
  });

  it("does not restart on a captive portal or a link with no internet", () => {
    // `portal` and `limited` are precisely "carrier is up, the internet is
    // not" — the state that makes a restart harmful rather than useless.
    for (const state of ["portal", "limited"]) {
      makeBox({ connectivity: [state], defaultRoute: true, pingWorks: true });
      runWaiter(`Ethernet 'eth0' down (${state})`);
      expect(restarts()).toBe(0);
      rmSync(root, { recursive: true, force: true });
      makeBox();
    }
  });

  it("restarts as soon as the route returns, which is what revives the suppressed accounts", () => {
    // The suppression lives in the gateway process — OpenClaw's channel
    // RetrySupervisor, with no CLI verb to start an account again — so the
    // restart IS the recovery, and it has to land after the route.
    makeBox({ connectivity: ["none", "none", "full"], defaultRoute: false });

    runWaiter("Ethernet 'eth0' down");

    expect(restarts()).toBe(1);
    expect(calls()).toContain("systemctl restart clawbox-gateway.service");
    expect(journal()).toContain("suppressed channel accounts start again");
  });

  it("accepts a route NetworkManager itself cannot judge, when the box can really reach out", () => {
    // Connectivity checking is often disabled on an appliance image, and
    // `unknown` must not be read as "offline" for ever.
    makeBox({ connectivity: ["unknown"], defaultRoute: true, pingWorks: true });

    runWaiter("Ethernet 'eth0' up");

    expect(restarts()).toBe(1);
  });

  it("does not start a gateway the owner stopped", () => {
    makeBox({ connectivity: ["full"], gatewayActive: false });

    runWaiter("Ethernet 'eth0' up");

    expect(restarts()).toBe(0);
    expect(journal()).toContain("is not running");
  });

  it("lets one waiter hold the wait, so a flapping carrier cannot stack restarts", async () => {
    // Overlapping NetworkManager events — a carrier that flaps, or eth down
    // then wifi up — would otherwise stack several waits and fire several
    // restarts the moment the route returned, which is its own way of tripping
    // the account supervisor.
    makeBox({ connectivity: ["full"] });
    const lock = path.join(root, "data", "gateway-online-restart.lock");
    const holder = spawn("flock", ["-n", lock, "-c", "sleep 20"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const r = spawnSync("bash", [path.join(root, "scripts", "gateway-restart-when-online.sh"), "second"], {
        env: env(),
        encoding: "utf-8",
        timeout: 25_000,
      });
      expect(r.status).toBe(0);
      expect(journal()).toContain("already pending");
      expect(restarts()).toBe(0);
    } finally {
      holder.kill();
    }
  });
});

describe("the dispatcher hands the restart to the waiter rather than firing it", () => {
  it("never restarts the gateway itself on an Ethernet down", async () => {
    makeBox({ connectivity: ["none"], defaultRoute: false });

    runDispatcher("eth0", "down");

    // It ASKS, and returns. Nothing it did itself touched the gateway.
    const asked = await deferredEventually(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("Ethernet 'eth0' down");
    expect(restarts()).toBe(0);
  });

  it("never restarts the gateway itself on an Ethernet up either", async () => {
    // Carrier is not a route: at `up` the interface may still be on DHCP.
    makeBox({ connectivity: ["none"], defaultRoute: false });

    runDispatcher("eth0", "up");

    const asked = await deferredEventually(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("Ethernet 'eth0' up");
    expect(restarts()).toBe(0);
  });

  it("asks for the restart when the WiFi radio comes up after a failover", async () => {
    // The recovery half. With only the Ethernet arm, a box that failed over to
    // WiFi never asked for the restart that revives its channel accounts.
    makeBox({ connectivity: ["full"] });

    runDispatcher("wlan0", "up");

    const asked = await deferredEventually(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("WiFi 'wlan0' up");
  });

  it("ignores an interface that is neither Ethernet nor this box's radio", async () => {
    makeBox({ connectivity: ["full"] });

    runDispatcher("docker0", "up");

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(restarts()).toBe(0);
    expect(deferred()).toHaveLength(0);
  });
});
