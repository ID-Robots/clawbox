import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * TASK-507. A hotspot switched off in the setup wizard came back roughly twenty
 * seconds later and stayed up until the next reboot.
 *
 * The route did its job: it wrote `HOTSPOT_DISABLED=1` and ran stop-ap.sh, and
 * the AP went down. But `setup_complete` is still false at the Security step —
 * the customer has AI Provider and Telegram to go — and this watchdog exited
 * early ONLY on setup_complete. Seeing an idle radio and unfinished setup, it
 * took its "the hotspot was torn down with nothing to bring it back" branch and
 * started the AP again. start-ap.sh gates its own HOTSPOT_DISABLED check behind
 * the same `setup_complete = true`, so the flag was ignored on both sides of the
 * loop. Measured on a freshly flashed .65 (beta 97072ba): the box came out of
 * setup broadcasting an open, unpassworded network its owner had switched off
 * and been told would not start.
 *
 * These tests EXECUTE the shipped scripts/ap-watchdog.sh against a fake root and
 * stubbed nmcli, and assert on whether it actually invoked start-ap.sh. Grepping
 * the source would pass on a rewrite that kept the words and dropped the guard.
 *
 * The distinction under test is drop versus decision: healing an AP that fell
 * over is the reason this watchdog exists, and it must keep doing that.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const WATCHDOG = path.join(REPO, "scripts", "ap-watchdog.sh");
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

// Unconditional, not skipIf. This file is the ONLY thing standing between a
// customer and an open network they switched off, and a suite that quietly
// skips itself on a runner without bash would report green while proving
// nothing — which is the same shape of silence the fix itself is about.
beforeAll(() => {
  if (!hasBash) {
    throw new Error(
      "bash is required: these tests execute scripts/ap-watchdog.sh rather than reading it"
    );
  }
});

let root: string;
let bin: string;

/** A fake CLAWBOX_ROOT plus a PATH of stubs, so nothing touches a real radio. */
function makeBox(opts: {
  setupComplete: boolean;
  hotspotEnv?: string | null;
  /** What `nmcli -t -f DEVICE,STATE device status` reports for the radio. */
  radioState?: string;
}) {
  root = mkdtempSync(path.join(tmpdir(), "clawbox-ap-"));
  bin = path.join(root, "bin");
  mkdirSync(path.join(root, "data"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(bin, { recursive: true });

  writeFileSync(
    path.join(root, "data", "config.json"),
    JSON.stringify({ setup_complete: opts.setupComplete })
  );
  if (opts.hotspotEnv !== null && opts.hotspotEnv !== undefined) {
    writeFileSync(path.join(root, "data", "hotspot.env"), opts.hotspotEnv);
  }

  // start-ap.sh is replaced by a witness: if the watchdog calls it, a file
  // appears. That is the whole assertion — "did it bring the AP back".
  //
  // The witness stands where the ROOT-OWNED copy stands on a box
  // (/usr/local/libexec/clawbox/start-ap.sh), handed in through
  // CLAWBOX_START_AP the way the failover tests hand in CLAWBOX_ONLINE_WAITER.
  // The tree copy under $CLAWBOX_ROOT/scripts is a SECOND witness that must
  // never fire: the watchdog runs as root on a timer and that tree is
  // clawbox-writable (security scan #21).
  mkdirSync(path.join(root, "libexec"), { recursive: true });
  writeFileSync(
    path.join(root, "libexec", "start-ap.sh"),
    `#!/usr/bin/env bash\ntouch "${path.join(root, "STARTED")}"\n`,
    { mode: 0o755 }
  );
  writeFileSync(
    path.join(root, "scripts", "start-ap.sh"),
    `#!/usr/bin/env bash\ntouch "${path.join(root, "TREE-STARTED")}"\n`,
    { mode: 0o755 }
  );

  const state = opts.radioState ?? "disconnected";
  writeFileSync(
    path.join(bin, "nmcli"),
    `#!/usr/bin/env bash\necho "wlP1p1s0:${state}"\n`,
    { mode: 0o755 }
  );
}

function runWatchdog(
  startAp: string = path.join(root, "libexec", "start-ap.sh"),
): { started: boolean; treeStarted: boolean; status: number | null; stderr: string } {
  const res = spawnSync("bash", [WATCHDOG], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CLAWBOX_ROOT: root,
      // ALWAYS set: the script's default is the real /usr/local/libexec copy,
      // which exists on a box that runs this suite.
      CLAWBOX_START_AP: startAp,
      NETWORK_INTERFACE: "wlP1p1s0",
    },
    encoding: "utf-8",
  });
  return {
    started: existsSync(path.join(root, "STARTED")),
    treeStarted: existsSync(path.join(root, "TREE-STARTED")),
    status: res.status,
    stderr: res.stderr ?? "",
  };
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("the AP watchdog tells a drop from a decision", () => {
  it("does NOT resurrect a hotspot the owner switched off", () => {
    // The exact state a box is in between the Security step and the end of the
    // wizard: disabled on purpose, setup not finished, radio idle.
    makeBox({
      setupComplete: false,
      hotspotEnv: "HOTSPOT_SSID='ClawBox-Setup'\nHOTSPOT_DISABLED=1\n",
    });
    expect(runWatchdog()).toMatchObject({ started: false, status: 0 });
  });

  it("still heals an AP that dropped on its own", () => {
    // The reason this watchdog exists. ClawBox-Setup is autoconnect=no, so a
    // driver hiccup or a stray `nmcli connection down` leaves the radio dark
    // with nothing to bring it back, and mid-setup that is a box nobody can
    // reach without a cable.
    makeBox({
      setupComplete: false,
      hotspotEnv: "HOTSPOT_SSID='ClawBox-Setup'\n",
    });
    expect(runWatchdog()).toMatchObject({ started: true, treeStarted: false });
  });

  it("never runs the start-ap.sh under CLAWBOX_ROOT, even when it has to heal", () => {
    // Security scan #21. clawbox-ap-watchdog.service has no User=, so this
    // script is root every twenty seconds, and $CLAWBOX_ROOT/scripts is the
    // clawbox-owned tree install.sh chowns after every git reset. Deriving
    // START_AP from $ROOT was root running whatever clawbox had put there —
    // with no grant, no manifest check and no wait beyond the timer. The only
    // start-ap.sh the watchdog may run is the root-owned libexec copy (or the
    // test's stand-in for it), and a tree copy planted right where the old
    // derivation looked must stay untouched.
    makeBox({ setupComplete: false, hotspotEnv: null });
    const r = runWatchdog();
    expect(r.started).toBe(true);
    expect(r.treeStarted, "the watchdog ran the clawbox-writable tree copy").toBe(false);
  });

  it("stands down, without falling back to the tree copy, when the root-owned copy is missing", () => {
    // A box mid-migration (new tree, root step not yet run) has no libexec
    // copy. The wrong answer is the tree copy; the right one is to say so and
    // exit 0, so the timer does not paint a failed unit every twenty seconds.
    makeBox({ setupComplete: false, hotspotEnv: null });
    const r = runWatchdog(path.join(root, "libexec", "not-installed.sh"));
    expect(r).toMatchObject({ started: false, treeStarted: false, status: 0 });
    expect(r.stderr).toContain("not-installed.sh");
  });

  it("executes the root-owned copy by default and never derives it from CLAWBOX_ROOT", () => {
    // The default is pinned by reading rather than running, because running it
    // on a box means the real /usr/local/libexec copy.
    const src = readFileSync(WATCHDOG, "utf-8");
    const m = /^START_AP="([^"]*)"$/m.exec(src);
    expect(m, "START_AP assignment not found").not.toBeNull();
    expect(m![1]).toBe("${CLAWBOX_START_AP:-/usr/local/libexec/clawbox/start-ap.sh}");
    expect(m![1]).not.toContain("$ROOT");
    expect(m![1]).not.toContain("CLAWBOX_ROOT");
  });

  it("heals when there is no hotspot.env at all", () => {
    // A box that has never reached the Security step has no env file. Reading
    // that absence as "disabled" would strand every customer who unboxes one.
    makeBox({ setupComplete: false, hotspotEnv: null });
    expect(runWatchdog().started).toBe(true);
  });

  it.each(["HOTSPOT_DISABLED=0", "HOTSPOT_DISABLED=", "HOTSPOT_DISABLED=true", "HOTSPOT_SSID='x #1'"])(
    "treats %j as not-disabled and still heals",
    (line) => {
      // Only an explicit 1 means off. Every other shape — including an SSID
      // with a '#' in it, which is why this is sourced rather than grepped —
      // fails in the direction that keeps a box reachable.
      makeBox({ setupComplete: false, hotspotEnv: `${line}\n` });
      expect(runWatchdog().started).toBe(true);
    }
  );

  it("does not fall over on a malformed env file", () => {
    // A truncated or corrupt file must not take the watchdog's own variables
    // with it, or a box loses its lifeline to a stray byte.
    makeBox({ setupComplete: false, hotspotEnv: "HOTSPOT_SSID='unterminated\n" });
    const r = runWatchdog();
    expect(r.status).toBe(0);
    expect(r.started).toBe(true);
  });

  it("keeps out of the way once setup is finished, disabled or not", () => {
    // Post-setup the hotspot is owned by the normal flow; the watchdog has
    // always stood down there and still must.
    makeBox({ setupComplete: true, hotspotEnv: "HOTSPOT_DISABLED=1\n" });
    expect(runWatchdog().started).toBe(false);
    rmSync(root, { recursive: true, force: true });
    makeBox({ setupComplete: true, hotspotEnv: "HOTSPOT_SSID='ClawBox-Setup'\n" });
    expect(runWatchdog().started).toBe(false);
  });

  it("leaves a connected radio alone", () => {
    // Either the AP is up (nothing to heal) or the box joined a network on
    // purpose (the AP is meant to be down).
    makeBox({ setupComplete: false, radioState: "connected" });
    expect(runWatchdog().started).toBe(false);
  });

  it("stands down while a deliberate WiFi handoff owns the radio", () => {
    makeBox({ setupComplete: false });
    writeFileSync(path.join(root, "data", "wifi-connecting.lock"), "");
    expect(runWatchdog().started).toBe(false);
  });

  it("reads the disable from the same file the route writes", () => {
    // The route and the watchdog agreeing on one path is the guarantee here;
    // two spellings of it is how this bug comes back.
    const route = readFileSync(
      path.join(REPO, "src", "app", "setup-api", "system", "hotspot", "route.ts"),
      "utf-8"
    );
    expect(route).toContain('"hotspot.env"');
    expect(route).toContain("HOTSPOT_DISABLED=1");
    expect(readFileSync(WATCHDOG, "utf-8")).toContain('data/hotspot.env');
  });
});
