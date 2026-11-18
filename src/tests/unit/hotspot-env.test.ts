import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * GitHub #1517: the hotspot switch had two homes. `data/hotspot.env`
 * (`HOTSPOT_DISABLED=1`) is what start-ap.sh, ap-watchdog.sh and
 * wifi-failover.sh obey. `config.json`'s `hotspot_enabled` is what Settings
 * showed. POST /setup-api/wifi/connect wrote only the second, so a box showed
 * "off" while its AP kept coming back. src/lib/hotspot-env.ts now owns both.
 * These tests hold it to the scripts' own reading of the file.
 */

// Runs bash: vitest's 5 s default is not enough on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const { config, configState } = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  /** `unreadable`: config.json cannot be read (strict readers and writes fail). */
  configState: { unreadable: false },
}));
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => (configState.unreadable ? undefined : config[key])),
  getAll: vi.fn(async () => (configState.unreadable ? {} : { ...config })),
  getKnownMany: vi.fn(async (keys: string[]) => configState.unreadable
    ? { values: {}, known: false }
    : { values: Object.fromEntries(keys.filter((k) => k in config).map((k) => [k, config[k]])), known: true }),
  setMany: vi.fn(async (entries: Record<string, unknown>) => {
    if (configState.unreadable) throw new Error("data/config.json could not be read");
    // Like the real store: yield before the write lands, so interleaving shows.
    await new Promise((r) => setTimeout(r, 5));
    for (const [k, v] of Object.entries(entries)) {
      if (v === undefined) delete config[k];
      else config[k] = v;
    }
  }),
}));

const REPO = process.cwd();
const START_AP = path.join(REPO, "scripts", "start-ap.sh");

beforeAll(() => {
  if (spawnSync("bash", ["--version"], { stdio: "ignore" }).status !== 0) {
    throw new Error("bash is required: these tests read the env file with start-ap.sh's own parser");
  }
});

/** start-ap.sh's `read_env_value`, cut out of the shipped script and run on `file`. */
function scriptReads(file: string, key: string): string {
  const src = readFileSync(START_AP, "utf8");
  const fn = src.slice(src.indexOf("read_env_value() {"), src.indexOf("\n}\n", src.indexOf("read_env_value() {")) + 3);
  expect(fn).toContain("read_env_value");
  const res = spawnSync("bash", ["-c", `${fn}\nread_env_value "$1" "$2"`, "bash", file, key], { encoding: "utf8" });
  expect(res.status).toBe(0);
  return res.stdout;
}

let root: string;
let envFile: string;
let mod: typeof import("@/lib/hotspot-env");

beforeEach(async () => {
  for (const k of Object.keys(config)) delete config[k];
  configState.unreadable = false;
  root = mkdtempSync(path.join(tmpdir(), "clawbox-hotspot-env-"));
  mkdirSync(path.join(root, "data"), { recursive: true });
  envFile = path.join(root, "data", "hotspot.env");
  vi.stubEnv("CLAWBOX_ROOT", root);
  vi.resetModules();
  mod = await import("@/lib/hotspot-env");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("parseHotspotEnv reads the file the way start-ap.sh does", () => {
  const cases: Record<string, string> = {
    "as the route writes it": "HOTSPOT_SSID='Home AP'\nHOTSPOT_PASSWORD='pa ss#word'\nHOTSPOT_DISABLED=1\n",
    "double quotes and export": 'export HOTSPOT_SSID="Box"\nexport HOTSPOT_DISABLED="1"\n',
    "CRLF line ends": "HOTSPOT_SSID='Box'\r\nHOTSPOT_DISABLED=1\r\n",
    "first line wins": "HOTSPOT_DISABLED=0\nHOTSPOT_DISABLED=1\n",
    "anything but 1 is on": "HOTSPOT_DISABLED=yes\n",
    "indented": "   HOTSPOT_DISABLED=1\n",
    "no flag at all": "HOTSPOT_SSID='ClawBox-Setup'\n",
  };
  for (const [name, text] of Object.entries(cases)) {
    it(name, () => {
      writeFileSync(envFile, text);
      const parsed = mod.parseHotspotEnv(text);
      expect(parsed.disabled).toBe(scriptReads(envFile, "HOTSPOT_DISABLED") === "1");
      expect(parsed.ssid ?? "").toBe(scriptReads(envFile, "HOTSPOT_SSID"));
      expect(parsed.password ?? "").toBe(scriptReads(envFile, "HOTSPOT_PASSWORD"));
    });
  }
});

describe("readHotspotSettings: the switch the radio obeys", () => {
  it("after setup reads the env file, so a box that drifted shows ON (the AP the scripts raise)", () => {
    // The reported box: config says off, the env file never got the flag, and
    // the AP was up on Ethernet. Settings must not say "off" over that.
    Object.assign(config, { setup_complete: true, hotspot_enabled: false });
    writeFileSync(envFile, "HOTSPOT_SSID='ClawBox-Setup'\n");
    return expect(mod.readHotspotSettings()).resolves.toMatchObject({ enabled: true });
  });

  it("after setup, HOTSPOT_DISABLED=1 is off whatever config says", () => {
    Object.assign(config, { setup_complete: true, hotspot_enabled: true });
    writeFileSync(envFile, "HOTSPOT_SSID='ClawBox-Setup'\nHOTSPOT_DISABLED=1\n");
    return expect(mod.readHotspotSettings()).resolves.toMatchObject({ enabled: false });
  });

  it("a symlinked env file counts as absent, as the scripts treat it (on)", async () => {
    Object.assign(config, { setup_complete: true });
    const elsewhere = path.join(root, "elsewhere.env");
    writeFileSync(elsewhere, "HOTSPOT_DISABLED=1\n");
    symlinkSync(elsewhere, envFile);
    expect(scriptReads(envFile, "HOTSPOT_DISABLED")).toBe("");
    await expect(mod.readHotspotSettings()).resolves.toMatchObject({ enabled: true });
  });

  it("a fresh box (no file, no config) is on, with the product SSID", () => {
    return expect(mod.readHotspotSettings()).resolves.toEqual({
      ssid: "ClawBox-Setup",
      hasPassword: false,
      enabled: true,
    });
  });

  it("before setup reads the wizard's working value in config, as it always did", async () => {
    Object.assign(config, { setup_complete: false, hotspot_enabled: false });
    await expect(mod.readHotspotSettings()).resolves.toMatchObject({ enabled: false });
    config.hotspot_enabled = true;
    writeFileSync(envFile, "HOTSPOT_DISABLED=1\n");
    await expect(mod.readHotspotSettings()).resolves.toMatchObject({ enabled: true });
  });
});

describe("writes keep the env file and config together", () => {
  it("writeHotspotSettings writes both, and the script reads back what was saved", async () => {
    await mod.writeHotspotSettings({ ssid: "Home's AP", password: "secret-123", enabled: false });

    expect(scriptReads(envFile, "HOTSPOT_DISABLED")).toBe("1");
    expect(scriptReads(envFile, "HOTSPOT_PASSWORD")).toBe("secret-123");
    expect(config).toMatchObject({ hotspot_ssid: "Home's AP", hotspot_password: "secret-123", hotspot_enabled: false });
    // The WPA key is in it.
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    // Temp-and-rename: nothing left beside it.
    expect(readdirSync(path.join(root, "data"))).toEqual(["hotspot.env"]);

    await mod.writeHotspotSettings({ ssid: "Home's AP", password: undefined, enabled: true });
    expect(scriptReads(envFile, "HOTSPOT_DISABLED")).toBe("");
    expect(scriptReads(envFile, "HOTSPOT_PASSWORD")).toBe("");
    expect(config.hotspot_enabled).toBe(true);
    expect("hotspot_password" in config).toBe(false);
  });

  it("replaces a symlink planted at the path instead of writing through it", async () => {
    const target = path.join(root, "target.txt");
    writeFileSync(target, "untouched\n");
    symlinkSync(target, envFile);

    await mod.writeHotspotSettings({ ssid: "Box", password: undefined, enabled: false });

    expect(readFileSync(target, "utf8")).toBe("untouched\n");
    expect(lstatSync(envFile).isSymbolicLink()).toBe(false);
    expect(scriptReads(envFile, "HOTSPOT_DISABLED")).toBe("1");
  });

  it("setHotspotEnabled flips only the switch, keeping the name and key the radio uses", async () => {
    writeFileSync(envFile, "HOTSPOT_SSID='Radio Name'\nHOTSPOT_PASSWORD='radio-key-1'\n");
    Object.assign(config, { hotspot_ssid: "Radio Name", hotspot_password: "radio-key-1", hotspot_enabled: true });

    await mod.setHotspotEnabled(false);
    expect(scriptReads(envFile, "HOTSPOT_DISABLED")).toBe("1");
    expect(scriptReads(envFile, "HOTSPOT_SSID")).toBe("Radio Name");
    expect(scriptReads(envFile, "HOTSPOT_PASSWORD")).toBe("radio-key-1");
    expect(config.hotspot_enabled).toBe(false);

    await mod.setHotspotEnabled(true);
    expect(scriptReads(envFile, "HOTSPOT_DISABLED")).toBe("");
    expect(scriptReads(envFile, "HOTSPOT_PASSWORD")).toBe("radio-key-1");
    expect(config.hotspot_enabled).toBe(true);
  });

  it("setHotspotEnabled on a box with no env file yet takes the name and key from config", async () => {
    Object.assign(config, { hotspot_ssid: "Cfg Name", hotspot_password: "cfg-key-12" });
    await mod.setHotspotEnabled(false);
    expect(scriptReads(envFile, "HOTSPOT_SSID")).toBe("Cfg Name");
    expect(scriptReads(envFile, "HOTSPOT_PASSWORD")).toBe("cfg-key-12");
    expect(scriptReads(envFile, "HOTSPOT_DISABLED")).toBe("1");
  });
});

describe("switchHotspotOffAfterWifiJoin (POST /setup-api/wifi/connect)", () => {
  it("after setup switches the hotspot off where the AP scripts read it", async () => {
    Object.assign(config, { setup_complete: true, hotspot_enabled: true });
    writeFileSync(envFile, "HOTSPOT_SSID='ClawBox-Setup'\n");

    await expect(mod.switchHotspotOffAfterWifiJoin()).resolves.toBe("switched-off");

    expect(scriptReads(envFile, "HOTSPOT_DISABLED")).toBe("1");
    expect(config.hotspot_enabled).toBe(false);
    await expect(mod.readHotspotSettings()).resolves.toMatchObject({ enabled: false });
  });

  it("before setup only proposes off to the wizard; the env file is left for the setup hotspot's recovery", async () => {
    // A fresh box mid-wizard. ap-watchdog.sh and wifi-failover.sh honour
    // HOTSPOT_DISABLED=1 before setup; writing it here would stop them from
    // bringing the setup hotspot back if this WiFi drops before Step 3.
    Object.assign(config, { setup_complete: false });

    await expect(mod.switchHotspotOffAfterWifiJoin()).resolves.toBe("proposed-off");

    expect(() => lstatSync(envFile)).toThrow();
    expect(config.hotspot_enabled).toBe(false);
    // ...and the wizard's hotspot step still defaults to off, as before.
    await expect(mod.readHotspotSettings()).resolves.toMatchObject({ enabled: false });
  });
});

describe("what the scripts read back is exactly what was saved (review of #1517)", () => {
  it("a key with a single quote reaches the radio as typed, not shell-escaped", async () => {
    await mod.writeHotspotSettings({ ssid: "Bob's AP", password: "it's-a-key'", enabled: true });
    expect(scriptReads(envFile, "HOTSPOT_SSID")).toBe("Bob's AP");
    expect(scriptReads(envFile, "HOTSPOT_PASSWORD")).toBe("it's-a-key'");
    // ...and stays so however often the switch is flipped after it.
    Object.assign(config, { setup_complete: true });
    await mod.setHotspotEnabled(false);
    await mod.setHotspotEnabled(true);
    expect(scriptReads(envFile, "HOTSPOT_PASSWORD")).toBe("it's-a-key'");
    expect(scriptReads(envFile, "HOTSPOT_SSID")).toBe("Bob's AP");
  });

  it("refuses a newline (it would start a HOTSPOT_DISABLED line of its own) and writes nothing", async () => {
    await expect(mod.writeHotspotSettings({ ssid: "Box", password: "key-12345\nHOTSPOT_DISABLED=1", enabled: true }))
      .rejects.toThrow(/control characters/);
    expect(() => lstatSync(envFile)).toThrow();
    expect(config).toEqual({});
  });

  it("an unreadable config.json changes nothing: no env file without its key", async () => {
    writeFileSync(envFile, "HOTSPOT_SSID='Box'\nHOTSPOT_PASSWORD='kept-key-1'\n");
    configState.unreadable = true;

    await expect(mod.setHotspotEnabled(false)).rejects.toThrow(/could not be read/);
    await expect(mod.writeHotspotSettings({ ssid: "Box", password: undefined, enabled: false })).rejects.toThrow();

    expect(readFileSync(envFile, "utf8")).toBe("HOTSPOT_SSID='Box'\nHOTSPOT_PASSWORD='kept-key-1'\n");
  });

  it("two saves at once end with the env file and config agreeing", async () => {
    Object.assign(config, { setup_complete: true });
    await Promise.all([
      mod.writeHotspotSettings({ ssid: "First", password: "first-key-1", enabled: true }),
      mod.setHotspotEnabled(false),
      mod.writeHotspotSettings({ ssid: "Second", password: "second-key", enabled: true }),
    ]);
    expect(scriptReads(envFile, "HOTSPOT_SSID")).toBe(config.hotspot_ssid);
    expect(scriptReads(envFile, "HOTSPOT_PASSWORD")).toBe(config.hotspot_password);
    expect(scriptReads(envFile, "HOTSPOT_DISABLED") === "1").toBe(config.hotspot_enabled === false);
    expect(config).toMatchObject({ hotspot_ssid: "Second", hotspot_enabled: true });
  });
});
