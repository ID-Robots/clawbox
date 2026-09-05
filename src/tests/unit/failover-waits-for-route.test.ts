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
  /**
   * What `systemctl` reports for the gateway unit's LoadState:
   * `loaded` (the OpenClaw edition), `masked` (the Hermes edition, which stops,
   * disables and MASKS it), or `not-found` (no such unit at all). A boolean
   * could not tell the middle case from the first, which is exactly how the
   * Hermes edition went untested.
   */
  unitLoadState?: "loaded" | "masked" | "not-found";
  /**
   * `systemctl` itself cannot answer — a `daemon-reexec`, a bus hiccup, or no
   * systemd at all. Distinct from every value above: it is not evidence that
   * this edition has no gateway.
   */
  unitProbeFails?: boolean;
  /** Whether `curl` is on PATH for the HTTPS half of the probe. */
  curlWorks?: boolean;
  /** Drop a re-arm marker once, from inside the poll loop. */
  rearmMidWait?: boolean;
}

/** A fake CLAWBOX_ROOT plus a PATH of stubs, so nothing touches a real radio. */
function makeBox(opts: BoxOptions = {}): void {
  root = mkdtempSync(path.join(tmpdir(), "clawbox-failover-"));
  bin = path.join(root, "bin");
  mkdirSync(path.join(root, "data"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(bin, { recursive: true });

  // The shipped waiter. On a box it is installed ROOT-OWNED under
  // /usr/local/libexec/clawbox and the dispatcher is pointed there; the sandbox
  // stands in for that path through CLAWBOX_ONLINE_WAITER.
  mkdirSync(path.join(root, "libexec"), { recursive: true });
  mkdirSync(path.join(root, "run"), { recursive: true });
  copyFileSync(WAITER, path.join(root, "libexec", "gateway-restart-when-online.sh"));
  chmodSync(path.join(root, "libexec", "gateway-restart-when-online.sh"), 0o755);

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
  *"networking connectivity"*)
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

  // The updater's own second half: ICMP is blocked on plenty of real networks.
  stub("curl", `
echo "curl $*" >> ${JSON.stringify(calls)}
exit ${opts.curlWorks ? 0 : 1}`);

  // Modelled on the real systemctl for BOTH questions, because the difference
  // between them is the defect: a masked unit is still LISTED, so
  // `list-unit-files` answers "present" on the Hermes edition, and only
  // LoadState tells a masked unit from a live one.
  const loadState = opts.unitLoadState ?? "loaded";
  stub("systemctl", `
echo "systemctl $*" >> ${JSON.stringify(calls)}
case "$1" in
  # try-restart is a no-op on a stopped unit and reports success either way —
  # exactly what the real one does, and why the script uses it.
  try-restart) exit 0 ;;
  # Kept, and kept FAITHFUL, although the shipped script no longer asks this:
  # only a unit that is not installed at all goes unlisted, so a regression to
  # this question turns the masked case below red instead of quietly passing.
  # Verbatim shape of what the Hermes box prints:
  # "clawbox-gateway.service masked enabled".
  list-unit-files)
    ${loadState === "not-found"
      ? "exit 1"
      : `echo "clawbox-gateway.service ${loadState === "masked" ? "masked" : "enabled"} enabled"`}
    ;;
  # Matched on the PROPERTY, not just the verb, so a change to some other
  # 'systemctl show -p ...' cannot keep passing on this answer.
  show)
    case "$*" in
      *"-p LoadState"*) ${opts.unitProbeFails
        ? 'echo "Failed to connect to bus" >&2; exit 1'
        : `echo ${JSON.stringify(loadState)}`} ;;
      *) exit 0 ;;
    esac
    ;;
  *) exit 0 ;;
esac`);

  stub("logger", `
shift 2 2>/dev/null || true
echo "log $*" >> ${JSON.stringify(root + "/journal.log")}`);

  // Real `sleep` would make a 120 s wait a 120 s test. It is also the only
  // hook a test has INSIDE the poll loop, which is where a second network
  // event would really arrive.
  stub("sleep", opts.rearmMidWait
    ? `f=${JSON.stringify(path.join(root, "run", "gateway-online-restart.rearm"))}
m=${JSON.stringify(path.join(root, "rearmed"))}
if [ ! -e "$m" ]; then : > "$m"; : > "$f"; fi
true`
    : "true");
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
    CLAWBOX_ONLINE_WAITER: path.join(root, "libexec", "gateway-restart-when-online.sh"),
    CLAWBOX_RUN_DIR: path.join(root, "run"),
    CLAWBOX_ONLINE_TIMEOUT: "2",
    CLAWBOX_ONLINE_POLL: "1",
    // The unit-existence gate is the Hermes arm; the cases that care set it.
    CLAWBOX_SKIP_UNIT_CHECK: "1",
    NETWORK_INTERFACE: "wlan0",
    ...extra,
  };
}

function runDispatcher(iface: string, action: string, extraEnv: Record<string, string> = {}): void {
  const r = spawnSync("bash", [DISPATCHER, iface, action], { env: env(extraEnv), encoding: "utf-8", timeout: 25_000 });
  expect(r.status).toBe(0);
}

function runWaiter(reason = "test", extraEnv: Record<string, string> = {}): { stdout: string } {
  const r = spawnSync("bash", [path.join(root, "libexec", "gateway-restart-when-online.sh"), reason], {
    env: env(extraEnv),
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
  return calls().split("\n").filter((l) => l.startsWith("systemctl try-restart")).length;
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

  it("does not restart on a captive portal that really has no way out", () => {
    // `portal` and `limited` are "carrier is up, the internet is not" — the
    // state that makes a restart harmful rather than merely useless.
    for (const state of ["portal", "limited"]) {
      makeBox({ connectivity: [state], defaultRoute: true, pingWorks: false, curlWorks: false });
      runWaiter(`Ethernet 'eth0' down (${state})`);
      expect(restarts()).toBe(0);
      rmSync(root, { recursive: true, force: true });
    }
    makeBox();
  });

  it("does NOT take NetworkManager's word for it when the box can really reach out", () => {
    // Connectivity checking is ENABLED on the Ubuntu/JetPack base, pointed at
    // connectivity-check.ubuntu.com. Any LAN that blocks or hijacks that URL —
    // a corporate egress filter, a Pi-hole, an ISP NXDOMAIN redirector — parks
    // NM at `portal` or `limited` permanently while the box reaches Telegram
    // and Anthropic perfectly well. Treating that as offline would mean the
    // gateway is never restarted again: GH #529 back through another door.
    makeBox({ connectivity: ["portal"], defaultRoute: true, pingWorks: true });

    runWaiter("Ethernet 'eth0' up behind a captive-portal check");

    expect(calls()).toContain("ping");
    expect(restarts()).toBe(1);
  });

  it("falls back to HTTPS when ICMP is blocked, as the updater does", () => {
    makeBox({ connectivity: ["limited"], defaultRoute: true, pingWorks: false, curlWorks: true });

    runWaiter("Ethernet 'eth0' up on an ICMP-filtered network");

    expect(calls()).toContain("curl");
    expect(restarts()).toBe(1);
  });

  it("does not spend a probe when there is no default route at all", () => {
    makeBox({ connectivity: ["none"], defaultRoute: false, pingWorks: true });

    runWaiter("Ethernet 'eth0' down");

    expect(calls()).not.toContain("ping");
    expect(restarts()).toBe(0);
  });

  it("does nothing at all on an edition where the unit was never installed", () => {
    makeBox({ connectivity: ["none"], unitLoadState: "not-found" });

    runWaiter("Ethernet 'eth0' down", { CLAWBOX_SKIP_UNIT_CHECK: "0" });

    expect(restarts()).toBe(0);
    expect(journal()).toBe("");
  });

  it("does nothing at all on the Hermes edition, where the unit is MASKED rather than absent", () => {
    // The Hermes SKU stops, disables and MASKS clawbox-gateway.service, and its
    // agent never has sockets to drop — so there is nothing here to do.
    //
    // But a masked unit is still LISTED. Measured read-only on the Hermes box:
    // `systemctl list-unit-files clawbox-gateway.service` prints
    // "clawbox-gateway.service masked enabled" and exits 0. A guard reading
    // that exit status therefore fires on no edition at all: every
    // NetworkManager event on Hermes — eth up/down, WiFi up, dhcp4-change,
    // connectivity-change — started a waiter that ended either in a
    // `try-restart` on a masked unit and a "restart request … failed" journal
    // line about a box where nothing is wrong, or in a full 120 s wait. The
    // false-failure class, on the edition the shared-tools rule says this must
    // work on.
    //
    // `full` connectivity, so a guard that does not fire restarts immediately
    // rather than after a wait — the failure is the restart, not the delay.
    makeBox({ connectivity: ["full"], unitLoadState: "masked" });

    runWaiter("Ethernet 'eth0' up", { CLAWBOX_SKIP_UNIT_CHECK: "0" });

    expect(restarts()).toBe(0);
    expect(journal()).toBe("");
  });

  it("says so, rather than standing down silently, when systemctl cannot answer", () => {
    // `2>/dev/null` plus a `!= loaded` test would read "the question could not
    // be asked" as "this edition has no gateway", and drop the network event
    // with no trace anywhere — including the `dhcp4-change` that would have
    // revived the suppressed accounts. src/lib/gateway-health.ts states the
    // rule for the same property: systemctl not answering "is not evidence
    // either way".
    makeBox({ connectivity: ["full"], unitProbeFails: true });

    runWaiter("Ethernet 'eth0' up", { CLAWBOX_SKIP_UNIT_CHECK: "0" });

    expect(restarts()).toBe(0);
    expect(journal()).toContain("could not read");
  });

  it("still restarts on the edition that does have a live gateway unit", () => {
    // The other half of the guard, and the reason it reads LoadState rather
    // than simply refusing: a check that skipped every edition would silence
    // GH #529's fix on the edition that needs it.
    makeBox({ connectivity: ["full"], unitLoadState: "loaded" });

    runWaiter("Ethernet 'eth0' up", { CLAWBOX_SKIP_UNIT_CHECK: "0" });

    expect(restarts()).toBe(1);
  });

  it("takes a request that arrived while it was waiting rather than losing it", () => {
    // `flock -n` turns an overlapping event into a no-op with no memory of it,
    // so a waiter could time out one second before the route landed having
    // ignored the very event that would have succeeded.
    makeBox({ connectivity: ["none"], defaultRoute: false, rearmMidWait: true });

    runWaiter("Ethernet 'eth0' down");

    expect(journal()).toContain("extending the wait");
  });

  it("restarts as soon as the route returns, which is what revives the suppressed accounts", () => {
    // The suppression lives in the gateway process — OpenClaw's channel
    // RetrySupervisor, with no CLI verb to start an account again — so the
    // restart IS the recovery, and it has to land after the route.
    makeBox({ connectivity: ["none", "none", "full"], defaultRoute: false });

    runWaiter("Ethernet 'eth0' down");

    expect(restarts()).toBe(1);
    expect(calls()).toContain("systemctl try-restart clawbox-gateway.service");
    expect(journal()).toContain("channel accounts its supervisor gave up on");
  });

  it("accepts a route NetworkManager itself cannot judge, when the box can really reach out", () => {
    // Connectivity checking is often disabled on an appliance image, and
    // `unknown` must not be read as "offline" for ever.
    makeBox({ connectivity: ["unknown"], defaultRoute: true, pingWorks: true });

    runWaiter("Ethernet 'eth0' up");

    expect(restarts()).toBe(1);
  });

  it("asks with try-restart, which cannot start a gateway the owner stopped", () => {
    // The probe and the action are two commands and the gap is a whole wait
    // long. `restart` would START a unit that is stopped — deliberately by the
    // owner, or masked by the Hermes edition — which install.sh forbids in
    // writing for this same unit. `is-active` would be wrong twice over: it
    // also reports non-zero for `activating`, and this unit's RestartSec plus a
    // cold-Jetson TimeoutStartSec make that window minutes long.
    makeBox({ connectivity: ["full"] });

    runWaiter("Ethernet 'eth0' up");

    expect(calls()).toContain("systemctl try-restart clawbox-gateway.service");
    expect(calls()).not.toContain("systemctl restart ");
    expect(calls()).not.toContain("systemctl is-active");
    // Asked, not "restarted": the exit code says the request was accepted.
    expect(journal()).toContain("asked systemd to restart");
  });

  it("lets one waiter hold the wait, so a flapping carrier cannot stack restarts", async () => {
    // Overlapping NetworkManager events — a carrier that flaps, or eth down
    // then wifi up — would otherwise stack several waits and fire several
    // restarts the moment the route returned, which is its own way of tripping
    // the account supervisor.
    makeBox({ connectivity: ["full"] });
    const lock = path.join(root, "run", "gateway-online-restart.lock");
    const holder = spawn("flock", ["-n", lock, "-c", "sleep 20"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const r = spawnSync("bash", [path.join(root, "libexec", "gateway-restart-when-online.sh"), "second"], {
        env: env(),
        encoding: "utf-8",
        timeout: 25_000,
      });
      expect(r.status).toBe(0);
      expect(journal()).toContain("already pending");
      // ...and the dropped request is REMEMBERED, so the holder does not time
      // out one second before the route lands having ignored it.
      expect(existsSync(path.join(root, "run", "gateway-online-restart.rearm"))).toBe(true);
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

  it("ignores every transition of the box's own recovery AP", async () => {
    // The AP is not a network this box got onto — it is the one it is
    // offering, with no default route. ap-watchdog.sh re-raises it every ~20 s
    // while setup is incomplete, so without this skip each of those would start
    // a full wait, take the lock, and drop a genuine Ethernet request meanwhile.
    makeBox({ connectivity: ["full"] });

    runDispatcher("wlan0", "up", { CONNECTION_ID: "ClawBox-Setup" });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(deferred()).toHaveLength(0);
    expect(restarts()).toBe(0);
  });

  it("asks for the restart when a DHCP lease lands after an association", async () => {
    // The lease arrives a second or two after the `up` the interface arm sees,
    // which is precisely why `up` alone was not enough.
    makeBox({ connectivity: ["full"] });

    runDispatcher("wlan0", "dhcp4-change");

    const asked = await deferredEventually(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("DHCP lease on 'wlan0'");
  });

  it("ignores a DHCP lease that renews the same address", async () => {
    // NM emits dhcp4-change on every T1/T2 renew. Measured on the office LAN:
    // `dhcp_lease_time = 86400`, so twice a day on a box where nothing at all
    // has happened — and 24-48 times a day on the one- to two-hour leases
    // consumer routers and hotel networks hand out. Restarting there bounces a
    // healthy gateway and drops an in-flight conversation, which is the harm
    // the rest of this script exists to avoid.
    makeBox({ connectivity: ["full"] });
    const lease = { IP4_ADDRESS_0: "192.0.2.50/24 192.0.2.1", IP4_GATEWAY: "192.0.2.1" };

    runDispatcher("eth0", "dhcp4-change", lease);
    expect(await deferredEventually(1)).toHaveLength(1);

    runDispatcher("eth0", "dhcp4-change", lease);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(deferred()).toHaveLength(1);
  });

  it("asks again when a lease actually moves the box", async () => {
    // The other half: a lease that changes the address or the gateway IS a
    // network change, and the sockets bound to the old address are dead.
    makeBox({ connectivity: ["full"] });

    runDispatcher("eth0", "dhcp4-change", { IP4_ADDRESS_0: "192.0.2.50/24 192.0.2.1", IP4_GATEWAY: "192.0.2.1" });
    expect(await deferredEventually(1)).toHaveLength(1);

    runDispatcher("eth0", "dhcp4-change", { IP4_ADDRESS_0: "198.51.100.7/24 198.51.100.1", IP4_GATEWAY: "198.51.100.1" });

    expect(await deferredEventually(2)).toHaveLength(2);
  });

  it("ignores a DHCP lease on an interface this box does not route through", async () => {
    // The arm ran before the interface filter, so a docker or veth lease asked
    // for a gateway restart too.
    makeBox({ connectivity: ["full"] });

    runDispatcher("docker0", "dhcp4-change");

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(deferred()).toHaveLength(0);
  });

  it("asks for the restart when NetworkManager itself confirms full connectivity", async () => {
    // The upstream-router-reboot shape: carrier never drops, so there is no
    // up/down and no new lease, and this is the only event that fires.
    makeBox({ connectivity: ["full"] });

    runDispatcher("eth0", "connectivity-change", { CONNECTIVITY_STATE: "FULL" });

    const asked = await deferredEventually(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("full connectivity");
  });

  it("does not ask on a connectivity state NetworkManager has not resolved", async () => {
    // Deliberate, and not the waiter's rule inverted. The waiter is lenient
    // about NM's verdict because it decides whether a restart can SUCCEED. This
    // arm decides whether an event is worth ASKING about, and `full` is NM's
    // only positive statement — `portal`, `limited` and `unknown` mean "not
    // decided". Since the waiter accepts a working ping whatever NM thinks,
    // dispatching on those would bounce a healthy gateway mid-conversation
    // every time a flaky connectivity check flapped.
    makeBox({ connectivity: ["full"] });

    runDispatcher("eth0", "connectivity-change", { CONNECTIVITY_STATE: "LIMITED" });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(deferred()).toHaveLength(0);
  });
});

/**
 * The installer half of the same feature. The dispatcher is inert without the
 * root-owned waiter it defers the restart to, so `step_nm_dispatcher` installs
 * both — and it is called from `step_post_update`, the path every field box
 * takes on an in-app update, as
 *
 *     step_nm_dispatcher || echo "  Warning: nm_dispatcher step failed (non-fatal)"
 *
 * Bash suspends `set -e` for the whole dynamic extent of a function run in a
 * condition context, so on that path a failed install is not fatal and not even
 * visible unless the step says so itself. These run the REAL function out of
 * install.sh in both shapes.
 */
describe("the installer reports what it actually installed", () => {
  const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");

  /** The house pattern: lift the real function out of install.sh and run it. */
  function shellFunction(name: string): string {
    const start = INSTALL_SH.indexOf(`${name}() {`);
    if (start < 0) throw new Error(`${name} not found in install.sh`);
    const end = INSTALL_SH.indexOf("\n}", start);
    if (end < 0) throw new Error(`${name} has no closing brace`);
    return INSTALL_SH.slice(start, end + 2);
  }

  function runStep(opts: { waiterInstallFails?: boolean; dispatcherDirReadOnly?: boolean; shape: "update" | "fresh" }) {
    const project = path.join(root, "project");
    const dispatcherDir = path.join(root, "dispatcher.d");
    const libexec = path.join(root, "root-libexec");
    mkdirSync(path.join(project, "scripts"), { recursive: true });
    copyFileSync(DISPATCHER, path.join(project, "scripts", "nm-dispatcher-failover.sh"));
    copyFileSync(WAITER, path.join(project, "scripts", "gateway-restart-when-online.sh"));

    if (opts.dispatcherDirReadOnly) {
      // A full or read-only /etc is the likelier failure of the two, and it is
      // the half `install_root_file` does not cover.
      mkdirSync(dispatcherDir, { recursive: true });
      chmodSync(dispatcherDir, 0o555);
    }

    const body = shellFunction("step_nm_dispatcher")
      .replace("/etc/NetworkManager/dispatcher.d", dispatcherDir);

    const script = [
      // install.sh's own options, which are half of what this is about.
      "set -euo pipefail",
      `PROJECT_DIR=${JSON.stringify(project)}`,
      `ROOT_LIBEXEC_DIR=${JSON.stringify(libexec)}`,
      // Not root in a test: ownership is not what is under test here.
      "chown() { :; }",
      // The step's only `install` call is `install -d … "$ROOT_LIBEXEC_DIR"`.
      "install() { for a; do :; done; mkdir -p \"$a\"; }",
      opts.waiterInstallFails
        ? "install_root_file() { return 1; }"
        : "install_root_file() { cp \"$1\" \"$2\"; }",
      // The real one stamps $PROVISION_STATUS_FILE, which the dashboard and the
      // flash host read. A step that only warns leaves the update's own verdict
      // saying it was clean.
      'record_provision_failure() { echo "provision-failure: $1"; }',
      body,
      opts.shape === "update"
        // Verbatim from step_post_update.
        ? 'step_nm_dispatcher || echo "  Warning: nm_dispatcher step failed (non-fatal)"'
        : "step_nm_dispatcher",
    ].join("\n");

    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 25_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, libexec };
  }

  it("does not claim the deferred-restart helper is installed when it is not", () => {
    // The false-success class. `install_root_file` returns 1 on both of its
    // failure paths — a full or read-only /usr — and leaves the PREVIOUS copy
    // in place, so the operator is told a new waiter landed while a stale one,
    // or none, is what the dispatcher will call.
    makeBox();

    const r = runStep({ waiterInstallFails: true, shape: "update" });

    expect(r.out).not.toContain("Deferred gateway-restart helper installed");
    expect(r.out).toContain("could not install the deferred gateway-restart helper");
    expect(r.out).toContain("provision-failure: nm_dispatcher");
  });

  it("reports the failed step to step_post_update instead of returning success", () => {
    // Without this the `|| echo "Warning: nm_dispatcher step failed"` in
    // step_post_update can never fire: the function returned 0 from its last
    // echo, so the update path reported a clean step over a missing waiter.
    makeBox();

    const r = runStep({ waiterInstallFails: true, shape: "update" });

    expect(r.out).toContain("nm_dispatcher step failed");
    expect(r.out).not.toContain("NetworkManager failover dispatcher installed");
  });

  it("does not claim the dispatcher is installed when the copy failed", () => {
    // The other half of the same function, and the one that fires on a full or
    // read-only /etc: `cp`, `chown` and `chmod` were unchecked too, so the
    // update path printed "NetworkManager failover dispatcher installed" over
    // a dispatcher that never landed.
    makeBox();

    const r = runStep({ dispatcherDirReadOnly: true, shape: "update" });

    expect(r.out).not.toContain("NetworkManager failover dispatcher installed");
    expect(r.out).toContain("could not install the NetworkManager failover dispatcher");
    expect(r.out).toContain("provision-failure: nm_dispatcher");
    expect(r.out).toContain("nm_dispatcher step failed");
  });

  it("still aborts the fresh install, where a failure is fatal by design", () => {
    makeBox();

    const r = runStep({ waiterInstallFails: true, shape: "fresh" });

    expect(r.status).not.toBe(0);
  });

  it("installs both halves and says so when the install really succeeds", () => {
    makeBox();

    const r = runStep({ shape: "update" });

    expect(r.status).toBe(0);
    expect(r.out).toContain("Deferred gateway-restart helper installed");
    expect(r.out).toContain("NetworkManager failover dispatcher installed");
    expect(r.out).not.toContain("Warning");
    expect(r.out).not.toContain("provision-failure");
    expect(existsSync(path.join(r.libexec, "gateway-restart-when-online.sh"))).toBe(true);
  });
});
