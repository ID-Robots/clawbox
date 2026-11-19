import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";

// TASK-2702. NetworkManager keeps WiFi switched off across a reboot, and the
// web account was refused `nmcli radio wifi on` ("Not authorized"), so every
// join failed with nothing able to switch the radio back on. These drive
// switchToClient against a modelled box: its radio, its hotspot, its network.

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("@/lib/root-step-runner", () => ({ startRootStep: vi.fn(async () => {}) }));

import { startRootStep } from "@/lib/root-step-runner";

const mockExecFile = vi.mocked(childProcess.execFile);
const mockStartRootStep = vi.mocked(startRootStep);

const IFACE = "wlP1p1s0";
const NOT_AUTHORIZED = "Error: failed to set Wi-Fi radio: Not authorized to perform this operation\n";

interface Box {
  hardware: boolean;
  software: boolean;
  /** polkit lets the web account switch the radio (config/49-clawbox-updates.pkla). */
  mayEnable: boolean;
  /** iw reports the radio hosting the setup hotspot. */
  ap: boolean;
  stopApFails: boolean;
  join: "ok" | "wrong-key" | "fail";
  /** Reads of the device state that still say `unavailable` once the radio is on. */
  unavailableReads: number;
}

let box: Box;
let calls: string[];

function answer(cmd: string, args: string[]): { stdout?: string; stderr?: string; fail?: boolean } {
  const line = `${cmd} ${args.join(" ")}`;
  if (line === "nmcli -t -f WIFI-HW,WIFI radio") {
    const v = (on: boolean) => (on ? "enabled" : "disabled");
    return { stdout: `${v(box.hardware)}:${v(box.software)}\n` };
  }
  if (line === "nmcli radio wifi on") {
    if (!box.mayEnable) return { fail: true, stderr: NOT_AUTHORIZED };
    box.software = true;
    return {};
  }
  if (line === "nmcli -t -f DEVICE,STATE device") {
    const unavailable = !box.software || box.unavailableReads-- > 0;
    return { stdout: `enP8p1s0:connected\n${IFACE}:${unavailable ? "unavailable" : "disconnected"}\n` };
  }
  if (line === `iw dev ${IFACE} info`) return { stdout: `Interface ${IFACE}\n\ttype ${box.ap ? "AP" : "managed"}\n` };
  if (line.endsWith("/stop-ap.sh")) {
    if (box.stopApFails) return { fail: true, stderr: "[WiFi] Radio ownership timed out\n" };
    box.ap = false;
    return {};
  }
  if (line.includes(" device wifi connect ")) {
    if (box.join === "ok" && box.software) return { stdout: `Device '${IFACE}' successfully activated.\n` };
    return { fail: true, stderr: "Error: Connection activation failed: (7) Secrets were required, but not provided.\n" };
  }
  if (cmd === "journalctl") return { stdout: box.join === "wrong-key" ? "WRONG_KEY\n" : "" };
  if (line === `nmcli -g IP4.ADDRESS device show ${IFACE}`) return { stdout: "192.0.2.23/24\n" };
  return {};
}

function installExecFile() {
  mockExecFile.mockImplementation(((cmd: string, args: string[], opts: unknown, cb?: unknown) => {
    const callback = (typeof opts === "function" ? opts : cb) as (e: Error | null, r?: unknown) => void;
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    const a = answer(cmd, args);
    queueMicrotask(() => {
      if (a.fail) callback(Object.assign(new Error(`Command failed: ${line}\n${a.stderr ?? ""}`), { stderr: a.stderr ?? "", stdout: "" }));
      else callback(null, { stdout: a.stdout ?? "", stderr: "" });
    });
    return {} as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
}

/** Run the switch with every sleep in it elapsed on the fake clock. */
async function run<T>(pending: Promise<T>): Promise<T> {
  let done = false;
  pending.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(500);
  return pending;
}

const index = (pred: (l: string) => boolean) => calls.findIndex(pred);
const radioOn = (l: string) => l === "nmcli radio wifi on";
const stopAp = (l: string) => l.endsWith("/stop-ap.sh");
const joins = () => calls.filter((l) => l.includes(" device wifi connect "));

describe("switchToClient turns a switched-off WiFi radio on before it joins (TASK-2702)", () => {
  let network: typeof import("@/lib/network");
  let steps: string[];
  const onStep = (s: string) => { steps.push(s); };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubEnv("CLAWBOX_ROOT", "/tmp/clawbox-test-nonexistent-" + Math.random().toString(36).slice(2));
    vi.stubEnv("CLAWBOX_TEST_MODE", "");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    box = { hardware: true, software: true, mayEnable: true, ap: true, stopApFails: false, join: "ok", unavailableReads: 0 };
    calls = [];
    steps = [];
    installExecFile();
    network = await import("@/lib/network");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("switches the radio on first, waits for its device, then joins, and reports the address it got", async () => {
    box.software = false;
    box.ap = false;
    box.unavailableReads = 2;
    const result = await run(network.switchToClient("HomeNet", "home-pass-1", onStep));

    expect(result.ip).toBe("192.0.2.23");
    expect(index(radioOn)).toBeGreaterThan(-1);
    expect(index(radioOn)).toBeLessThan(index(stopAp));
    // The device reads `unavailable` for a moment after the switch; the join waits it out.
    const deviceReads = calls.flatMap((l, i) => (l === "nmcli -t -f DEVICE,STATE device" ? [i] : []));
    expect(deviceReads).toHaveLength(3);
    expect(deviceReads[2]).toBeLessThan(index(stopAp));
    expect(index(stopAp)).toBeLessThan(calls.findIndex((l) => l.includes(" device wifi connect ")));
    // No hotspot was up (the radio was off): the step says "joining".
    expect(steps).toEqual(["radio-on", "joining"]);
    expect(mockStartRootStep).not.toHaveBeenCalled();
  });

  it("leaves a radio that is on alone, and says it is switching from the hotspot", async () => {
    const result = await run(network.switchToClient("HomeNet", "home-pass-1", onStep));

    expect(result.message).toContain("successfully activated");
    expect(calls.some(radioOn)).toBe(false);
    expect(steps).toEqual(["switching"]);
  });

  it("refused the radio: fails with NetworkManager's reason, joins nothing, and brings the hotspot back", async () => {
    box.software = false;
    box.ap = false;
    box.mayEnable = false;
    const pending = run(network.switchToClient("HomeNet", "home-pass-1", onStep));

    await expect(pending).rejects.toMatchObject({
      name: "WifiRadioOffError",
      message: "failed to set Wi-Fi radio: Not authorized to perform this operation",
    });
    expect(joins()).toEqual([]);
    expect(calls.some(stopAp)).toBe(false);
    // Never stranded: the root service owns the hotspot, and it may switch the radio on.
    expect(mockStartRootStep).toHaveBeenCalledWith("restart_ap", expect.anything());
    // No join was tried, so no profile of ours to delete (one saved earlier is the owner's).
    expect(calls.some((l) => l.includes("connection delete"))).toBe(false);
    expect(steps).toEqual(["radio-on", "restoring"]);
  });

  it("never asks to override a hardware switch", async () => {
    box.hardware = false;
    box.software = false;
    box.ap = false;
    const pending = run(network.switchToClient("HomeNet", undefined, onStep));

    await expect(pending).rejects.toMatchObject({ name: "WifiRadioOffError", message: "the WiFi hardware switch is off" });
    expect(calls.some(radioOn)).toBe(false);
    expect(joins()).toEqual([]);
  });

  it("a wrong password brings the hotspot back and says so", async () => {
    box.join = "wrong-key";
    const pending = run(network.switchToClient("HomeNet", "not-the-password", onStep));

    await expect(pending).rejects.toMatchObject({ name: "WifiAuthError" });
    expect(joins()).toHaveLength(1);
    expect(calls).toContain(`bash /usr/local/libexec/clawbox/wifi-radio.sh --nmcli connection delete HomeNet`);
    expect(mockStartRootStep).toHaveBeenCalledWith("restart_ap", expect.anything());
    expect(steps).toEqual(["switching", "restoring"]);
  });

  it("any other failure names nmcli's reason, never the command line with the password in it", async () => {
    box.join = "fail";
    const pending = run(network.switchToClient("HomeNet", "secret-pass-9", onStep));

    await expect(pending).rejects.toThrow("Connection activation failed: (7) Secrets were required, but not provided.");
    await pending.catch((err: Error) => {
      expect(err.message).not.toContain("secret-pass-9");
      expect(err.message).not.toContain("Command failed");
    });
    expect(joins()).toHaveLength(3);
    expect(mockStartRootStep).toHaveBeenCalledWith("restart_ap", expect.anything());
  });

  it("a hotspot that would not stop is a failed join too: the hotspot is put back", async () => {
    box.stopApFails = true;
    const pending = run(network.switchToClient("HomeNet", "home-pass-1", onStep));

    await expect(pending).rejects.toThrow("[WiFi] Radio ownership timed out");
    expect(joins()).toEqual([]);
    expect(mockStartRootStep).toHaveBeenCalledWith("restart_ap", expect.anything());
  });
});
