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

/** The shape NetworkManager's DHCP client actually writes for the wired link. */
const ETH_ROUTE = "default via 192.0.2.1 dev eth0 proto dhcp src 192.0.2.50 metric 100";

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
  /** `systemctl try-restart` refuses — nothing was restarted. */
  tryRestartFails?: boolean;
  /** Drop a re-arm marker once, from inside the poll loop. */
  rearmMidWait?: boolean;
  /**
   * The carrier drops WHILE `systemctl try-restart` is running. That call
   * BLOCKS until the restart job completes — ~40 s on this hardware — so it is
   * a wide window, and the dispatcher's stamp clear lands inside it. Modelled
   * by running the real dispatcher's `down` arm from inside the stub.
   */
  dropCarrierDuringRestart?: boolean;
  /** Bring the Ethernet route back once, from inside the poll loop. */
  restoreRouteMidWait?: boolean;
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

  // A routing table in a file rather than baked into the stub, so a test can
  // move the route between two waiter runs — a failover from Ethernet to WiFi
  // is a new recovery, and the route is how the waiter tells one from another.
  writeFileSync(path.join(root, "routes"), opts.defaultRoute ? `${ETH_ROUTE}\n` : "");
  stub("ip", `
echo "ip $*" >> ${JSON.stringify(calls)}
routes=${JSON.stringify(path.join(root, "routes"))}
case "$*" in
  *"route get"*)
    # The real one answers with the route the KERNEL SELECTED for that one
    # destination plus the source address it would use — not the table. Modelled
    # as the first line of the table, which is the order the kernel returns
    # routes in (by metric), and with the same "unreachable" failure when there
    # is none.
    dest="\${@: -1}"
    answer="$(awk -v d="$dest" 'NR == 1 {
      gw = ""; dev = ""; src = "";
      for (i = 1; i < NF; i++) {
        if ($i == "via") gw = $(i + 1);
        if ($i == "dev") dev = $(i + 1);
        if ($i == "src") src = $(i + 1);
      }
      if (dev == "") exit;
      printf "%s", d;
      if (gw != "") printf " via %s", gw;
      printf " dev %s", dev;
      if (src != "") printf " src %s", src;
      printf " uid 0";
    }' "$routes" 2>/dev/null)"
    [ -n "$answer" ] || { echo "RTNETLINK answers: Network is unreachable" >&2; exit 2; }
    echo "$answer"
    ;;
  *) cat "$routes" 2>/dev/null || true ;;
esac`);

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
  # try-restart is a no-op on a stopped unit and reports success for it —
  # exactly what the real one does, and why the script uses it. It does fail on
  # a masked unit, which is what tryRestartFails models.
  try-restart)
    ${opts.dropCarrierDuringRestart
      ? `m=${JSON.stringify(path.join(root, "carrier-dropped"))}
    if [ ! -e "$m" ]; then
      : > "$m"
      # The carrier really goes, and NetworkManager runs the dispatcher for it
      # while this restart is still in flight.
      : > ${JSON.stringify(path.join(root, "routes"))}
      bash ${JSON.stringify(DISPATCHER)} eth0 down >/dev/null 2>&1 || true
    fi`
      : ""}
    exit ${opts.tryRestartFails ? 1 : 0} ;;
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
  stub("sleep", [
    opts.rearmMidWait
      ? `f=${JSON.stringify(path.join(root, "run", "gateway-online-restart.rearm"))}
m=${JSON.stringify(path.join(root, "rearmed"))}
if [ ! -e "$m" ]; then : > "$m"; : > "$f"; fi`
      : "",
    // The link comes back while the waiter is polling — the only place a test
    // can put an event that lands INSIDE the wait, which is where a real
    // carrier returns.
    opts.restoreRouteMidWait
      ? `r=${JSON.stringify(path.join(root, "routes"))}
m=${JSON.stringify(path.join(root, "route-restored"))}
if [ ! -e "$m" ]; then : > "$m"; printf '%s\\n' ${JSON.stringify(ETH_ROUTE)} > "$r"; fi`
      : "",
    "true",
  ].filter(Boolean).join("\n"));
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
 * The box's routing table from now on, most-preferred route first — which is
 * the order the kernel returns them in, and therefore the one it selects from.
 * No lines at all = no route.
 */
function moveRoute(...lines: string[]): void {
  writeFileSync(path.join(root, "routes"), lines.filter(Boolean).map((l) => `${l}\n`).join(""));
}

/** What `nmcli networking connectivity` answers from now on, one per call. */
function setConnectivity(...states: string[]): void {
  writeFileSync(path.join(root, "connectivity"), `${states.join("\n")}\n`);
}

function journalLines(needle: string): string[] {
  return journal().split("\n").filter((l) => l.includes(needle));
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

  it("says so, rather than dropping the event, when the lock file cannot be opened", () => {
    // `exec 9>"$LOCK_FILE" || exit 0` cannot do what it looks like it does: a
    // failed redirection on `exec` kills a non-interactive bash outright, so
    // the `||` fallback never runs and the network event vanishes with nothing
    // in the journal. Same silent-drop shape as reading a failed systemctl
    // probe as "this edition has no gateway".
    makeBox({ connectivity: ["full"] });
    // A DIRECTORY at the lock path, not a read-only parent: root bypasses DAC
    // write checks, so a 0555 directory stops nobody in a root CI container,
    // while no uid at all can open a directory for writing.
    mkdirSync(path.join(root, "run", "gateway-online-restart.lock"), { recursive: true });

    runWaiter("Ethernet 'eth0' up");

    expect(journal()).toContain("no single-waiter guard");
    // ...and the wait still happens: dropping the event is the worse failure.
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

  it("lets one waiter hold the wait, so overlapping events do not stack two waits", async () => {
    // Overlapping NetworkManager events — a carrier that flaps, or eth down
    // then wifi up — would otherwise run two waits at once, each holding the
    // box's fate for two minutes.
    //
    // CONCURRENCY only, which this test is careful to say: events that do not
    // overlap take this lock one after another and every one of them used to
    // reach the restart. Collapsing those is the coalescing describe block that
    // follows this one, not this lock.
    makeBox({ connectivity: ["full"] });
    const lock = path.join(root, "run", "gateway-online-restart.lock");
    const holder = spawn("flock", ["-n", lock, "-c", "sleep 20"], { stdio: "ignore" });
    // `spawn` reports a missing executable asynchronously, and a ChildProcess
    // with no `error` listener turns that into an uncaught exception that fails
    // the entire run rather than this one case. flock is util-linux and is not
    // guaranteed on every runner image.
    holder.on("error", (err) => {
      throw new Error(`flock is required for this test: ${err.message}`);
    });
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

describe("one restart per route recovery, not one per NetworkManager event", () => {
  it("collapses a burst of NetworkManager events into a single restart request", () => {
    // Measured on a box: one boot produced `Ethernet 'enP8p1s0' up`,
    // `connectivity-change FULL` and `dhcp4-change` inside the SAME SECOND, and
    // NetworkManager runs dispatchers serially — so three waiters ran one after
    // another, each proved the same route, and each logged
    // `asked systemd to restart clawbox-gateway.service`. The `flock` turned
    // none of them away (no "already pending" line anywhere in that journal):
    // it stops two waiters waiting AT ONCE, and these did not overlap.
    //
    // The unit then went through three stop/start cycles, the first landing one
    // second after it had finally reached active. The gateway did not serve
    // until three minutes after boot and churned for five and a half, burning
    // ~3.5 minutes of CPU re-running gateway-pre-start.sh — and every one of
    // those bounces drops the channel accounts a restart is supposed to revive.
    makeBox({ connectivity: ["full"], defaultRoute: true });

    runWaiter("Ethernet 'eth0' up");
    runWaiter("NetworkManager reports full connectivity");
    runWaiter("DHCP lease on 'eth0' changed");

    expect(restarts()).toBe(1);
    // ...and the two that stood down said so, rather than vanishing.
    expect(journalLines("already asked for this route recovery")).toHaveLength(2);
  });

  it("does not treat NetworkManager rewriting a route's metric as a new recovery", () => {
    // NM rewrites `metric` and `proto` on a route that has not moved (a second
    // profile activating, a renewed lease), so a recovery cannot be keyed on
    // the raw line: only the device and the gateway say where the traffic goes.
    makeBox({ connectivity: ["full"], defaultRoute: true });

    runWaiter("Ethernet 'eth0' up");
    moveRoute("default via 192.0.2.1 dev eth0 proto dhcp src 192.0.2.50 metric 700");
    runWaiter("DHCP lease on 'eth0' changed");

    expect(restarts()).toBe(1);
  });

  it("asks again when the route moved, even inside the same window", () => {
    // A failover from Ethernet to WiFi is a NEW recovery, not a repeat of the
    // one before it: the sockets the gateway holds are bound to the address
    // that just died, which is GH #529's own harm. A blanket cooldown would
    // swallow exactly that restart, so the coalescing is keyed on the route.
    makeBox({ connectivity: ["full"], defaultRoute: true });

    runWaiter("Ethernet 'eth0' down");
    moveRoute("default via 198.51.100.1 dev wlan0 proto dhcp src 198.51.100.20 metric 600");
    runWaiter("WiFi 'wlan0' up");

    expect(restarts()).toBe(2);
  });

  it("asks again when a lease moved only the box's own address", () => {
    // Same interface, same gateway, new address — a DHCP NAK and re-DISCOVER,
    // which consumer routers and guest WiFi do routinely. The dispatcher
    // already treats it as a real change (see the lease arm below) precisely
    // because every socket bound to the old address is dead, so the waiter must
    // not then throw that verdict away for being "the same route".
    makeBox({ connectivity: ["full"], defaultRoute: true });

    runWaiter("DHCP lease on 'eth0' changed");
    moveRoute("default via 192.0.2.1 dev eth0 proto dhcp src 192.0.2.77 metric 100");
    runWaiter("DHCP lease on 'eth0' changed");

    expect(restarts()).toBe(2);
  });

  it("does not treat a second uplink appearing beside the first as a new recovery", () => {
    // Any box with a saved WiFi profile brings up a second default route at a
    // higher metric while Ethernet keeps the traffic. Nothing moved, so nothing
    // is owed a restart — and a key that read the whole table would have fired
    // one, mid-cold-start, on the SKU this whole feature exists for.
    makeBox({ connectivity: ["full"], defaultRoute: true });

    runWaiter("Ethernet 'eth0' up");
    moveRoute(ETH_ROUTE, "default via 198.51.100.1 dev wlan0 proto dhcp src 198.51.100.20 metric 600");
    runWaiter("WiFi 'wlan0' up");

    expect(restarts()).toBe(1);
  });

  it("asks again when it watched the route go away and come back on the same lease", () => {
    // THE dangerous half of coalescing. A cable pulled and replugged inside the
    // window returns on the identical lease, so "same route, recently" is true
    // — and the sockets it killed are just as dead as ones on a new address.
    // A waiter that polled and found no route has PROVEN an absence since the
    // last restart, and may never stand down on it.
    makeBox({
      connectivity: ["none"],
      defaultRoute: true,
      pingWorks: true,
      restoreRouteMidWait: true,
    });

    runWaiter("Ethernet 'eth0' up");
    expect(restarts()).toBe(1);

    // The carrier really drops: no route at all, and NM has no verdict either.
    moveRoute();
    // ...and it returns from inside the wait, on the very same lease.
    runWaiter("Ethernet 'eth0' up");

    expect(restarts()).toBe(2);
    expect(journalLines("already asked for this route recovery")).toHaveLength(0);
  });

  it("never coalesces against a route the kernel could not name", () => {
    // `nmcli` can answer `full` while `ip` cannot answer at all (an IPv6-only
    // uplink, a transient failure). An empty key matching a recorded empty key
    // would turn this into the blanket cooldown the route key exists to avoid.
    makeBox({ connectivity: ["full"] });
    moveRoute();

    runWaiter("Ethernet 'eth0' up");
    runWaiter("NetworkManager reports full connectivity");

    expect(restarts()).toBe(2);
    expect(journalLines("already asked for this route recovery")).toHaveLength(0);
  });

  it("asks again for a later recovery on the same route, once the window has passed", async () => {
    // The other side of the same coin: a cable pulled and replugged an hour
    // later comes back on the very same lease, and that gateway must still be
    // restarted. The shipped window is 60 s — long enough for the whole event
    // burst above, short enough that a genuine second recovery is not held
    // hostage by it — so this shortens the window rather than sleeping for it.
    makeBox({ connectivity: ["full"], defaultRoute: true });
    const window = { CLAWBOX_RESTART_COALESCE: "1" };

    runWaiter("Ethernet 'eth0' up", window);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    runWaiter("Ethernet 'eth0' up", window);

    expect(restarts()).toBe(2);
  });

  // The flap the waiter cannot see: down and up again before any waiter runs,
  // so no waiter ever polls an absence. Only the dispatcher knows the carrier
  // went, and it is the one that clears the record.
  //
  // Parameterised over BOTH uplinks on purpose. A box provisioned through its
  // own `ClawBox-Setup` AP and joined to the customer's WiFi has no Ethernet
  // arm to save it — its carrier drop arrives as `<radio> down` — and a clear
  // that only Ethernet reaches leaves that box standing down on the very
  // restart its re-association owes, which is GH #529 through the wireless
  // door. `wlan0` is what NETWORK_INTERFACE is set to in env().
  it.each([
    { iface: "eth0", dispatches: 1 },
    { iface: "wlan0", dispatches: 0 },
  ])("forgets the last restart request when the carrier actually drops on $iface", async ({ iface, dispatches }) => {
    makeBox({ connectivity: ["full"], defaultRoute: true });
    const stamp = path.join(root, "run", "gateway-online-restart.stamp");
    runWaiter(`'${iface}' up`);
    expect(existsSync(stamp)).toBe(true);

    runDispatcher(iface, "down");

    expect(existsSync(stamp)).toBe(false);
    // ...and Ethernet still hands the failover restart to the waiter, as
    // before. The radio's own `down` never dispatched one and must not start:
    // the AP/profile failover below is the Ethernet arm's job.
    if (dispatches > 0) {
      expect(await deferredEventually(dispatches)).toHaveLength(dispatches);
    } else {
      // Nothing to poll FOR — `deferredEventually(0)` returns on its first
      // iteration and would pass on a launch that simply had not landed yet.
      // Give the launch that must not happen room to happen, then assert.
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(deferred()).toHaveLength(0);
    }
  });

  it("does not forget the record when the box's own recovery AP goes down", () => {
    // `ap-watchdog.sh` re-raises the setup AP every ~20 s while setup is
    // incomplete, and that profile is a `shared` one with no default route — so
    // its transitions are not carrier events and must invalidate nothing. Now
    // that the clear sits ABOVE the interface case, the AP guard at the top of
    // the dispatcher is the only thing standing between that watchdog and a
    // record cleared on every cycle.
    makeBox({ connectivity: ["full"], defaultRoute: true });
    const stamp = path.join(root, "run", "gateway-online-restart.stamp");
    runWaiter("Ethernet 'eth0' up");
    expect(existsSync(stamp)).toBe(true);

    runDispatcher("wlan0", "down", { CONNECTION_ID: "ClawBox-Setup" });

    expect(existsSync(stamp)).toBe(true);
  });

  it("never lets a probe target be expanded into a filename", () => {
    // A bare `${CLAWBOX_PING_TARGETS:-…}` is word-split AND pathname-expanded,
    // so a `*` in the value made whatever happens to be in the working
    // directory the ping destination — and therefore the destination
    // `ip route get` keys the whole recovery on. The waiter runs from the repo
    // root here, which is never empty, so an expansion would be visible.
    makeBox({ connectivity: ["portal"], defaultRoute: true, pingWorks: true });

    runWaiter("Ethernet 'eth0' up", { CLAWBOX_PING_TARGETS: "*" });

    const pings = calls().split("\n").filter((l) => l.startsWith("ping "));
    expect(pings).toEqual(["ping -c 1 -W 2 *"]);
    expect(calls()).toContain("ip -o route get *");
    expect(restarts()).toBe(1);
  });

  it("does not put back a record the carrier drop cleared while the restart was still running", () => {
    // `systemctl try-restart` BLOCKS for the whole restart — ~40 s on this
    // hardware — and the record was written after it returned, stamped with the
    // route key read BEFORE the call. So a carrier drop inside that window was
    // cleared by the dispatcher and then immediately re-written by the waiter,
    // and the next recovery stood down on a record for a route that had already
    // died. Nothing else notices: the waiter the `down` event dispatches is
    // turned away by the flock this one holds, so no poll ever proves the
    // absence for it.
    //
    // The clear must therefore win over the record whatever the ordering.
    makeBox({ connectivity: ["full"], defaultRoute: true, dropCarrierDuringRestart: true });
    const stamp = path.join(root, "run", "gateway-online-restart.stamp");

    runWaiter("Ethernet 'eth0' up");

    expect(restarts()).toBe(1);
    // The hook really fired — otherwise this test would pass by not testing.
    expect(existsSync(path.join(root, "carrier-dropped"))).toBe(true);
    expect(existsSync(stamp)).toBe(false);

    // The carrier returns on the very same lease, well inside the window.
    moveRoute(ETH_ROUTE);
    runWaiter("Ethernet 'eth0' up");

    expect(restarts()).toBe(2);
    expect(journalLines("already asked for this route recovery")).toHaveLength(0);
  });

  it("keeps the record in the root-owned run directory, beside the lock", () => {
    // Not under the clawbox-writable data/: this runs as root, so a path that
    // user can replace with a symlink is root writing wherever it points. /run
    // is also cleared on boot, which is what "did we already restart for this
    // recovery" wants — the first event after a boot is never a repeat.
    makeBox({ connectivity: ["full"], defaultRoute: true });

    runWaiter("Ethernet 'eth0' up");

    expect(existsSync(path.join(root, "run", "gateway-online-restart.stamp"))).toBe(true);
  });

  it("does not record a restart it failed to ask for", () => {
    // False success in the other direction: try-restart failing means nothing
    // was restarted, so the next event must still be allowed to try.
    makeBox({ connectivity: ["full"], defaultRoute: true, tryRestartFails: true });

    runWaiter("Ethernet 'eth0' up");
    runWaiter("NetworkManager reports full connectivity");

    expect(restarts()).toBe(2);
    expect(journalLines("already asked for this route recovery")).toHaveLength(0);
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

  it("raises the recovery hotspot from the root-owned copy, never from the tree", async () => {
    // Security scan #21. This hook runs as ROOT from NetworkManager's
    // dispatcher.d, and when no saved WiFi profile will connect it starts the
    // setup hotspot as a last resort. START_AP used to be derived from
    // $CLAWBOX_ROOT/scripts — the clawbox-owned tree — so a planted start-ap.sh
    // there was root code on the next failed failover. The copy it runs now is
    // the libexec one (the sandbox stands in through CLAWBOX_START_AP, exactly
    // as it does for the waiter), and a start-ap.sh planted where the old
    // derivation looked must stay untouched.
    makeBox({ connectivity: ["none"], defaultRoute: false });
    // A saved profile that will not come up: the only way to the recovery arm.
    writeFileSync(path.join(bin, "nmcli"), `#!/usr/bin/env bash
echo "nmcli $*" >> ${JSON.stringify(path.join(root, "calls.log"))}
case "$*" in
  *"networking connectivity"*) echo none ;;
  *"NAME,TYPE,AUTOCONNECT-PRIORITY"*) echo "Home:802-11-wireless:10" ;;
  *"connection up"*) exit 1 ;;
  *) exit 0 ;;
esac`, { mode: 0o755 });
    const witness = path.join(root, "libexec", "start-ap.sh");
    writeFileSync(witness, `#!/usr/bin/env bash\ntouch ${JSON.stringify(path.join(root, "AP-STARTED"))}\n`, { mode: 0o755 });
    writeFileSync(path.join(root, "scripts", "start-ap.sh"),
      `#!/usr/bin/env bash\ntouch ${JSON.stringify(path.join(root, "TREE-AP-STARTED"))}\n`, { mode: 0o755 });

    runDispatcher("eth0", "down", { CLAWBOX_START_AP: witness });

    // The launch is backgrounded, so allow the child a moment to land.
    const deadline = Date.now() + 5_000;
    while (!existsSync(path.join(root, "AP-STARTED")) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(existsSync(path.join(root, "AP-STARTED")), "the recovery hotspot was not started").toBe(true);
    expect(existsSync(path.join(root, "TREE-AP-STARTED")), "root ran the clawbox-writable tree copy").toBe(false);
    expect(journalLines("Recovery AP launch dispatched")).toHaveLength(1);
  });

  it("says so, rather than reaching for the tree copy, when the root-owned start-ap.sh is missing", async () => {
    makeBox({ connectivity: ["none"], defaultRoute: false });
    writeFileSync(path.join(bin, "nmcli"), `#!/usr/bin/env bash
case "$*" in
  *"networking connectivity"*) echo none ;;
  *"NAME,TYPE,AUTOCONNECT-PRIORITY"*) echo "Home:802-11-wireless:10" ;;
  *"connection up"*) exit 1 ;;
  *) exit 0 ;;
esac`, { mode: 0o755 });
    writeFileSync(path.join(root, "scripts", "start-ap.sh"),
      `#!/usr/bin/env bash\ntouch ${JSON.stringify(path.join(root, "TREE-AP-STARTED"))}\n`, { mode: 0o755 });

    runDispatcher("eth0", "down", { CLAWBOX_START_AP: path.join(root, "libexec", "not-installed.sh") });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(path.join(root, "TREE-AP-STARTED"))).toBe(false);
    expect(journalLines("not-installed.sh missing")).toHaveLength(1);
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
    const body = INSTALL_SH.slice(start, end + 2);
    // The terminator is the first line starting with `}`, which is how every
    // top-level function in install.sh closes — but a heredoc or an awk program
    // inside the step could contain one and silently cut the body short. A
    // truncated body is worse than a broken test: bash would fail to parse it,
    // and every `not.toContain(...)` assertion below would then pass vacuously.
    const opens = (body.match(/\{/g) ?? []).length;
    const closes = (body.match(/\}/g) ?? []).length;
    if (opens !== closes) {
      throw new Error(`${name} was extracted truncated from install.sh (${opens} { vs ${closes} })`);
    }
    return body;
  }

  function runStep(opts: { waiterInstallFails?: boolean; dispatcherInstallFails?: boolean; shape: "update" | "fresh" }) {
    const project = path.join(root, "project");
    const dispatcherDir = path.join(root, "dispatcher.d");
    const libexec = path.join(root, "root-libexec");
    mkdirSync(path.join(project, "scripts"), { recursive: true });
    copyFileSync(DISPATCHER, path.join(project, "scripts", "nm-dispatcher-failover.sh"));
    copyFileSync(WAITER, path.join(project, "scripts", "gateway-restart-when-online.sh"));

    const body = shellFunction("step_nm_dispatcher")
      .replaceAll("/etc/NetworkManager/dispatcher.d", dispatcherDir);
    // Fail fast rather than write into the developer's or the runner's real
    // dispatcher directory: `replace` with a string pattern rewrites only the
    // first match, so a second literal added later would escape the sandbox.
    if (body.includes("/etc/NetworkManager")) {
      throw new Error("step_nm_dispatcher still references a real system path after redirection");
    }

    const script = [
      // install.sh's own options, which are half of what this is about.
      "set -euo pipefail",
      `PROJECT_DIR=${JSON.stringify(project)}`,
      `ROOT_LIBEXEC_DIR=${JSON.stringify(libexec)}`,
      // The step's only `install` call is `install -d … "$ROOT_LIBEXEC_DIR"`.
      "install() { for a; do :; done; mkdir -p \"$a\"; }",
      // Modelled on the real install_root_file: stage "$dst.new", then rename,
      // so the test exercises the atomicity the dispatcher now depends on. Not
      // root in a test, so ownership is dropped rather than faked.
      'install_root_file() { cp "$1" "$2.new" && mv -f "$2.new" "$2"; }',
      // Both halves go through install_root_file, so a blanket failure would
      // fire on the wrong one — each case fails only its own destination.
      // Keyed on the path rather than on directory permissions, because root
      // bypasses DAC write checks and CI may well run as root.
      ...(opts.waiterInstallFails
        ? ['install_root_file() { case "$2" in *gateway-restart-when-online.sh) return 1 ;; esac; cp "$1" "$2.new" && mv -f "$2.new" "$2"; }']
        : []),
      ...(opts.dispatcherInstallFails
        ? ['install_root_file() { case "$2" in *90-clawbox-failover) return 1 ;; esac; cp "$1" "$2.new" && mv -f "$2.new" "$2"; }']
        : []),
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
    return { status: r.status, out: `${r.stdout}${r.stderr}`, libexec, dispatcherDir };
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
    // read-only /etc: the copy was unchecked too, so the update path printed
    // "NetworkManager failover dispatcher installed" over a dispatcher that
    // never landed.
    makeBox();

    const r = runStep({ dispatcherInstallFails: true, shape: "update" });

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
    // The staged copy is renamed, never left behind for NetworkManager to find.
    expect(existsSync(path.join(r.dispatcherDir, "90-clawbox-failover"))).toBe(true);
    expect(existsSync(path.join(r.dispatcherDir, "90-clawbox-failover.new"))).toBe(false);
  });
});
