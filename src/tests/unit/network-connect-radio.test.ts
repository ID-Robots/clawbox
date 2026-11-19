import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * switchToClient — what a WiFi connect does before it joins a network.
 *
 * Two defects met on a box whose setup hotspot was not running:
 *
 *  1. The connect ran stop-ap.sh unconditionally, and stop-ap.sh, run by the web
 *     account, died taking a radio lock under /run/clawbox-radio that only root
 *     can create: Settings showed "Command failed: bash .../stop-ap.sh" for a
 *     connect that had no access point to stop.
 *  2. With the WiFi radio switched off (`nmcli radio wifi` disabled, the device
 *     `unavailable`, rfkill soft-blocked) the connect failed three times over in
 *     a way that named nothing — after the AP had been torn down for it.
 */

const execFile = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execFile }));

const execWifiNmcli = vi.hoisted(() => vi.fn());
vi.mock("@/lib/wifi-radio", () => ({ execWifiNmcli, spawnWifiScan: vi.fn() }));

const startRootStep = vi.hoisted(() => vi.fn());
vi.mock("@/lib/root-step-runner", () => ({ startRootStep }));

const STOP_AP = "/usr/local/libexec/clawbox/stop-ap.sh";

interface FakeBox {
  /** A ClawBox-Setup profile is active on the radio. */
  apProfile: boolean;
  /** What `iw dev <iface> info` says the radio is. */
  iwType: "AP" | "managed";
  /** `nmcli -t -f NAME,TYPE,DEVICE connection show --active` fails. */
  activeProbeFails: boolean;
  hardware: "enabled" | "disabled";
  software: "enabled" | "disabled";
  /** `nmcli radio` cannot be read. */
  radioProbeFails: boolean;
  /** Whether `nmcli radio wifi on` (through the lock helper) is allowed. */
  radioOnAllowed: boolean;
}

let box: FakeBox;
let calls: string[];

function freshBox(): FakeBox {
  return {
    apProfile: false,
    iwType: "managed",
    activeProbeFails: false,
    hardware: "enabled",
    software: "enabled",
    radioProbeFails: false,
    radioOnAllowed: true,
  };
}

function answer(cmd: string, args: string[]): { stdout: string; stderr: string } | Error {
  const line = `${cmd} ${args.join(" ")}`;
  calls.push(line);
  if (cmd === "nmcli" && args.includes("--active")) {
    if (box.activeProbeFails) return new Error("nmcli: no answer");
    const rows = ["Wired connection 1:802-3-ethernet:enP8p1s0"];
    if (box.apProfile) rows.push("ClawBox-Setup:802-11-wireless:wlP1p1s0");
    return { stdout: rows.join("\n") + "\n", stderr: "" };
  }
  if (cmd === "nmcli" && args.includes("radio")) {
    if (box.radioProbeFails) return new Error("nmcli: no answer");
    return { stdout: `${box.hardware}:${box.software}\n`, stderr: "" };
  }
  if (cmd === "iw") return { stdout: `Interface wlP1p1s0\n\ttype ${box.iwType}\n`, stderr: "" };
  if (cmd === "bash" && args[0] === STOP_AP) return { stdout: "[AP] Access point stopped.\n", stderr: "" };
  return { stdout: "", stderr: "" };
}

function fakeExecFile(cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) {
  const r = answer(cmd, args);
  queueMicrotask(() => (r instanceof Error ? cb(r) : cb(null, r)));
}

function fakeWifiNmcli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  calls.push(`wifi-radio.sh --nmcli ${args.join(" ")}`);
  if (args[0] === "radio" && args[1] === "wifi" && args[2] === "on") {
    if (!box.radioOnAllowed) return Promise.reject(new Error("Error: Failed to set WiFi: Not authorized to perform this operation"));
    box.software = "enabled";
    return Promise.resolve({ stdout: "", stderr: "" });
  }
  if (args.includes("connect")) {
    return Promise.resolve({ stdout: "Device 'wlP1p1s0' successfully activated\n", stderr: "" });
  }
  return Promise.resolve({ stdout: "", stderr: "" });
}

const ranStopAp = () => calls.some((c) => c === `bash ${STOP_AP}`);
const askedRadioOn = () => calls.some((c) => c === "wifi-radio.sh --nmcli radio wifi on");
const triedConnect = () => calls.some((c) => c.startsWith("wifi-radio.sh --nmcli") && c.includes(" connect "));

describe("switchToClient", () => {
  let network: typeof import("@/lib/network");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    delete process.env.NETWORK_INTERFACE;
    delete process.env.CLAWBOX_TEST_MODE;
    process.env.CLAWBOX_ROOT = "/tmp/clawbox-test-nonexistent-" + Math.random().toString(36).slice(2);
    box = freshBox();
    calls = [];
    execFile.mockImplementation(fakeExecFile);
    execWifiNmcli.mockImplementation(fakeWifiNmcli);
    startRootStep.mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    network = await import("@/lib/network");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** switchToClient with every settle/retry sleep run on the fake clock. */
  async function connect(): Promise<{ message: string }> {
    const pending = network.switchToClient("Example-Home", "correct horse");
    // Attach the rejection handler before the timers run, so a failure is never "unhandled".
    const settled = pending.then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await vi.runAllTimersAsync();
    const r = await settled;
    if (!r.ok) throw r.e;
    return r.v;
  }

  describe("the access point", () => {
    it("does not run stop-ap.sh when no setup access point is active, and still connects", async () => {
      const r = await connect();
      expect(ranStopAp()).toBe(false);
      expect(triedConnect()).toBe(true);
      expect(r.message).toContain("successfully activated");
      // Nothing went wrong, so nothing tried to bring the AP back.
      expect(startRootStep).not.toHaveBeenCalled();
    });

    it("runs stop-ap.sh once when the ClawBox-Setup access point is active", async () => {
      box.apProfile = true;
      box.iwType = "AP";
      await connect();
      expect(calls.filter((c) => c === `bash ${STOP_AP}`)).toHaveLength(1);
      // ...and only then does it go on to join the network.
      expect(calls.indexOf(`bash ${STOP_AP}`)).toBeLessThan(calls.findIndex((c) => c.includes(" connect ")));
    });

    it("leaves a client profile that merely carries the name ClawBox-Setup alone", async () => {
      box.apProfile = true;
      box.iwType = "managed";
      await connect();
      expect(ranStopAp()).toBe(false);
    });

    it("does not count a ClawBox-Setup profile on another interface", async () => {
      execFile.mockImplementation((cmd: string, args: string[], _o: unknown, cb: (e: Error | null, r?: unknown) => void) => {
        if (cmd === "nmcli" && args.includes("--active")) {
          calls.push(`${cmd} ${args.join(" ")}`);
          return queueMicrotask(() => cb(null, { stdout: "ClawBox-Setup:802-11-wireless:wlan9\n", stderr: "" }));
        }
        return fakeExecFile(cmd, args, _o, cb);
      });
      await connect();
      expect(ranStopAp()).toBe(false);
    });

    it("still runs stop-ap.sh when nmcli cannot say whether the access point is up", async () => {
      box.activeProbeFails = true;
      await connect();
      expect(ranStopAp()).toBe(true);
    });

    it("keeps reporting a stop-ap.sh that really fails, with its own words", async () => {
      box.apProfile = true;
      box.iwType = "AP";
      execFile.mockImplementation((cmd: string, args: string[], o: unknown, cb: (e: Error | null, r?: unknown) => void) => {
        if (cmd === "bash" && args[0] === STOP_AP) {
          calls.push(`bash ${STOP_AP}`);
          return queueMicrotask(() => cb(new Error(`Command failed: bash ${STOP_AP}\n[AP] radio lock is not set up`)));
        }
        return fakeExecFile(cmd, args, o, cb);
      });
      await expect(connect()).rejects.toThrow(/radio lock is not set up/);
      expect(triedConnect()).toBe(false);
    });
  });

  describe("the radio", () => {
    it("does not touch the radio when it is on", async () => {
      await connect();
      expect(askedRadioOn()).toBe(false);
      expect(triedConnect()).toBe(true);
    });

    it("fails with \"WiFi radio is turned off\" when the radio is off and cannot be turned on", async () => {
      box.software = "disabled";
      box.radioOnAllowed = false;
      const err = await connect().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(network.WifiRadioOffError);
      expect((err as Error).message).toBe("WiFi radio is turned off");
      expect(askedRadioOn()).toBe(true);
      // It failed BEFORE tearing anything down or trying a connect, and did not
      // go on to "restore" an access point that was never stopped.
      expect(ranStopAp()).toBe(false);
      expect(triedConnect()).toBe(false);
      expect(startRootStep).not.toHaveBeenCalled();
    });

    it("keeps the radio-off error free of the nmcli noise and of the password", async () => {
      box.software = "disabled";
      box.radioOnAllowed = false;
      const err = (await connect().catch((e: unknown) => e)) as Error;
      expect(err.message).not.toMatch(/Not authorized|nmcli|correct horse/);
    });

    it("asks once to turn a software-disabled radio on, and connects when that works", async () => {
      box.software = "disabled";
      await connect();
      expect(calls.filter((c) => c === "wifi-radio.sh --nmcli radio wifi on")).toHaveLength(1);
      expect(triedConnect()).toBe(true);
    });

    it("never asks to turn on a radio a hardware switch holds off", async () => {
      box.hardware = "disabled";
      box.software = "enabled";
      const err = await connect().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(network.WifiRadioOffError);
      expect(askedRadioOn()).toBe(false);
      expect(triedConnect()).toBe(false);
    });

    it("checks the radio before it takes the access point down", async () => {
      box.apProfile = true;
      box.iwType = "AP";
      box.software = "disabled";
      box.radioOnAllowed = false;
      await expect(connect()).rejects.toBeInstanceOf(network.WifiRadioOffError);
      expect(ranStopAp()).toBe(false);
    });

    it("does not block a connect on an unreadable radio state", async () => {
      box.radioProbeFails = true;
      await connect();
      expect(askedRadioOn()).toBe(false);
      expect(triedConnect()).toBe(true);
    });
  });
});
