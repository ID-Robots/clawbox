import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

const REPO = process.cwd();
const WATCHDOG = path.join(REPO, "scripts", "ap-watchdog.sh");
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

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
  writeFileSync(
    path.join(root, "scripts", "start-ap.sh"),
    `#!/usr/bin/env bash\ntouch "${path.join(root, "STARTED")}"\n`,
    { mode: 0o755 }
  );

  const state = opts.radioState ?? "disconnected";
  writeFileSync(
    path.join(bin, "nmcli"),
    `#!/usr/bin/env bash\necho "wlP1p1s0:${state}"\n`,
    { mode: 0o755 }
  );
}

function runWatchdog(): { started: boolean; status: number | null } {
  const res = spawnSync("bash", [WATCHDOG], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CLAWBOX_ROOT: root,
      NETWORK_INTERFACE: "wlP1p1s0",
    },
    encoding: "utf-8",
  });
  return { started: existsSync(path.join(root, "STARTED")), status: res.status };
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasBash)("the AP watchdog tells a drop from a decision", () => {
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
    expect(runWatchdog().started).toBe(true);
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
