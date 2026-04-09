import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(childProcess.execFile);

// Helper to setup promisified execFile mock
function setupExecFileMock(
  results: Record<string, { stdout: string; stderr: string } | Error> = {}
) {
  mockExecFile.mockImplementation(((
    cmd: string,
    args: string[],
    optsOrCallback?: object | ((error: Error | null, result: { stdout: string; stderr: string }) => void),
    maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;

    // Build key from command and args
    const key = `${cmd} ${args.join(" ")}`;
    let result = results[key];

    // Try partial match
    if (!result) {
      for (const k of Object.keys(results)) {
        if (key.includes(k) || k.includes(cmd)) {
          result = results[k];
          break;
        }
      }
    }

    // Default success
    if (!result) {
      result = { stdout: "", stderr: "" };
    }

    // Return thenable for promisified usage
    const thenable = {
      then: (resolve: (r: { stdout: string; stderr: string }) => void, reject?: (e: Error) => void) => {
        queueMicrotask(() => {
          if (result instanceof Error) {
            reject?.(result);
          } else {
            resolve(result);
          }
        });
        return thenable;
      },
      catch: (reject: (e: Error) => void) => {
        queueMicrotask(() => {
          if (result instanceof Error) {
            reject(result);
          }
        });
        return thenable;
      },
    };

    // Also call callback if provided
    if (callback) {
      queueMicrotask(() => {
        if (result instanceof Error) {
          callback(result, { stdout: "", stderr: "" });
        } else {
          callback(null, result);
        }
      });
    }

    return thenable as unknown as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
}

describe("network", () => {
  let network: typeof import("@/lib/network");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("scanWifi", () => {
    it("returns cached results if fresh", async () => {
      setupExecFileMock({
        "iw": { stdout: "type managed", stderr: "" },
        "nmcli": { stdout: "HomeNet:90:WPA2:5180\n", stderr: "" },
      });

      network = await import("@/lib/network");

      // First call populates cache
      const result1 = await network.scanWifi();
      expect(result1).toHaveLength(1);
      expect(result1[0].ssid).toBe("HomeNet");

      // Second call should use cache (no additional exec calls)
      const callCount = mockExecFile.mock.calls.length;
      const result2 = await network.scanWifi();
      expect(result2).toEqual(result1);
      // Should not have made more calls
      expect(mockExecFile.mock.calls.length).toBe(callCount);
    });

    it("parses nmcli output correctly", async () => {
      setupExecFileMock({
        "iw": { stdout: "type managed", stderr: "" },
        "nmcli -t -f SSID,SIGNAL,SECURITY,FREQ device wifi list": {
          stdout: "Network1:85:WPA2:5180\nNetwork2:70:WPA3:2437\nNetwork3:60:OPEN:2412\n",
          stderr: "",
        },
      });

      network = await import("@/lib/network");
      const result = await network.scanWifi();

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ ssid: "Network1", signal: 85, security: "WPA2", freq: "5180" });
      expect(result[1]).toEqual({ ssid: "Network2", signal: 70, security: "WPA3", freq: "2437" });
      expect(result[2]).toEqual({ ssid: "Network3", signal: 60, security: "OPEN", freq: "2412" });
    });

    it("filters out ClawBox-Setup network", async () => {
      setupExecFileMock({
        "iw": { stdout: "type managed", stderr: "" },
        "nmcli": {
          stdout: "ClawBox-Setup:100:OPEN:2412\nOtherNet:80:WPA2:5180\n",
          stderr: "",
        },
      });

      network = await import("@/lib/network");
      const result = await network.scanWifi();

      expect(result).toHaveLength(1);
      expect(result[0].ssid).toBe("OtherNet");
    });

    it("deduplicates networks keeping strongest signal", async () => {
      setupExecFileMock({
        "iw": { stdout: "type managed", stderr: "" },
        "nmcli": {
          stdout: "SameNet:60:WPA2:5180\nSameNet:90:WPA2:2437\nSameNet:75:WPA2:5200\n",
          stderr: "",
        },
      });

      network = await import("@/lib/network");
      const result = await network.scanWifi();

      expect(result).toHaveLength(1);
      expect(result[0].signal).toBe(90);
    });

    it("handles SSID with colon character", async () => {
      setupExecFileMock({
        "iw": { stdout: "type managed", stderr: "" },
        "nmcli": {
          stdout: "My:Network:Name:80:WPA2:5180\n",
          stderr: "",
        },
      });

      network = await import("@/lib/network");
      const result = await network.scanWifi();

      expect(result).toHaveLength(1);
      expect(result[0].ssid).toBe("My:Network:Name");
    });

    it("drops malformed lines", async () => {
      setupExecFileMock({
        "iw": { stdout: "type managed", stderr: "" },
        "nmcli": {
          stdout: "ValidNet:80:WPA2:5180\nmalformed\n:only:three\n",
          stderr: "",
        },
      });

      network = await import("@/lib/network");
      const result = await network.scanWifi();

      expect(result).toHaveLength(1);
      expect(result[0].ssid).toBe("ValidNet");
    });

    it("drops lines with empty SSID", async () => {
      setupExecFileMock({
        "iw": { stdout: "type managed", stderr: "" },
        "nmcli": {
          stdout: ":80:WPA2:5180\nValidNet:70:WPA2:5180\n",
          stderr: "",
        },
      });

      network = await import("@/lib/network");
      const result = await network.scanWifi();

      expect(result).toHaveLength(1);
      expect(result[0].ssid).toBe("ValidNet");
    });

    it("drops lines with non-numeric signal", async () => {
      setupExecFileMock({
        "iw": { stdout: "type managed", stderr: "" },
        "nmcli": {
          stdout: "BadSignal:abc:WPA2:5180\nGoodNet:80:WPA2:5180\n",
          stderr: "",
        },
      });

      network = await import("@/lib/network");
      const result = await network.scanWifi();

      expect(result).toHaveLength(1);
      expect(result[0].ssid).toBe("GoodNet");
    });

    it("sorts networks by signal strength descending", async () => {
      setupExecFileMock({
        "iw": { stdout: "type managed", stderr: "" },
        "nmcli": {
          stdout: "Low:30:WPA2:5180\nHigh:95:WPA2:5180\nMid:60:WPA2:5180\n",
          stderr: "",
        },
      });

      network = await import("@/lib/network");
      const result = await network.scanWifi();

      expect(result[0].ssid).toBe("High");
      expect(result[1].ssid).toBe("Mid");
      expect(result[2].ssid).toBe("Low");
    });
  });

  describe("getScanStatus", () => {
    it("returns scanning false with null networks when no scan performed", async () => {
      setupExecFileMock({});
      network = await import("@/lib/network");

      const status = network.getScanStatus();

      expect(status.scanning).toBe(false);
      expect(status.networks).toBeNull();
    });

    it("returns cached networks after scan completes", async () => {
      setupExecFileMock({
        "iw": { stdout: "type managed", stderr: "" },
        "nmcli": { stdout: "TestNet:80:WPA2:5180\n", stderr: "" },
      });

      network = await import("@/lib/network");
      await network.scanWifi();

      const status = network.getScanStatus();

      expect(status.scanning).toBe(false);
      expect(status.networks).toHaveLength(1);
      expect(status.networks![0].ssid).toBe("TestNet");
    });
  });

  describe("triggerBackgroundScan", () => {
    it("does not trigger if cache is fresh", async () => {
      setupExecFileMock({
        "iw": { stdout: "type managed", stderr: "" },
        "nmcli": { stdout: "CachedNet:80:WPA2:5180\n", stderr: "" },
      });

      network = await import("@/lib/network");

      // Populate cache
      await network.scanWifi();

      const callCount = mockExecFile.mock.calls.length;

      // Background scan should skip because cache is fresh
      network.triggerBackgroundScan();

      expect(mockExecFile.mock.calls.length).toBe(callCount);
    });

  });

  describe("getWifiStatus", () => {
    it("returns parsed nmcli output", async () => {
      setupExecFileMock({
        "nmcli -t -f GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS,IP4.GATEWAY device show": {
          stdout: "GENERAL.STATE:100 (connected)\nGENERAL.CONNECTION:MyNetwork\nIP4.ADDRESS:192.168.1.100/24\nIP4.GATEWAY:192.168.1.1\n",
          stderr: "",
        },
      });

      network = await import("@/lib/network");
      const result = await network.getWifiStatus();

      expect(result["GENERAL.STATE"]).toBe("100 (connected)");
      expect(result["GENERAL.CONNECTION"]).toBe("MyNetwork");
      expect(result["IP4.ADDRESS"]).toBe("192.168.1.100/24");
      expect(result["IP4.GATEWAY"]).toBe("192.168.1.1");
    });

    it("returns error when interface not available", async () => {
      setupExecFileMock({
        "nmcli": new Error("Device not found"),
      });

      network = await import("@/lib/network");
      const result = await network.getWifiStatus();

      expect(result.error).toBe("WiFi interface not available");
    });

    it("handles lines without colon", async () => {
      setupExecFileMock({
        "nmcli": {
          stdout: "GENERAL.STATE:connected\nno-colon-line\n",
          stderr: "",
        },
      });

      network = await import("@/lib/network");
      const result = await network.getWifiStatus();

      expect(result["GENERAL.STATE"]).toBe("connected");
      // no-colon-line is ignored
    });
  });

  describe("getEthernetStatus", () => {
    it("returns connected when ethernet device found", async () => {
      setupExecFileMock({
        "nmcli": { stdout: "eth0:ethernet:connected\n", stderr: "" },
      });
      network = await import("@/lib/network");
      const status = await network.getEthernetStatus();
      expect(status.connected).toBe(true);
      expect(status.iface).toBe("eth0");
    });

    it("returns disconnected when no ethernet found", async () => {
      setupExecFileMock({
        "nmcli -t -f DEVICE,TYPE,STATE device status": { stdout: "wlan0:wifi:connected\n", stderr: "" },
        "ip link show": { stdout: "1: lo: <LOOPBACK> state UNKNOWN\n", stderr: "" },
      });
      network = await import("@/lib/network");
      const status = await network.getEthernetStatus();
      expect(status.connected).toBe(false);
    });

    it("returns disconnected on error", async () => {
      setupExecFileMock({
        "nmcli": new Error("command not found"),
      });
      network = await import("@/lib/network");
      const status = await network.getEthernetStatus();
      expect(status.connected).toBe(false);
    });
  });

  describe("restartAP", () => {
    it("calls the AP start script", async () => {
      setupExecFileMock({
        "bash": { stdout: "", stderr: "" },
      });
      network = await import("@/lib/network");
      await network.restartAP();
      expect(mockExecFile).toHaveBeenCalled();
      const [cmd, args] = mockExecFile.mock.calls[0];
      expect(cmd).toBe("bash");
      expect(args).toEqual(expect.arrayContaining([expect.stringContaining("start-ap.sh")]));
    });
  });

  describe("getCachedScan", () => {
    it("returns empty array when cache doesn't exist", async () => {
      setupExecFileMock({});
      network = await import("@/lib/network");
      // getCachedScan reads a file that doesn't exist in test env
      const result = network.getCachedScan();
      expect(result).toEqual([]);
    });
  });
});
