import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import { desktopCoreStepIsNoop, hasX64DesktopIntegration, hasX64Install, X64_INSTALL_FILE } from "@/lib/x64-integration";

vi.mock("fs", async (original) => {
  const actual = await original<typeof import("fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      openSync: vi.fn(), fstatSync: vi.fn(), readFileSync: vi.fn(), closeSync: vi.fn(),
      lstatSync: vi.fn(), readdirSync: vi.fn(),
    },
  };
});

describe("installed x64 desktop integration", () => {
  beforeEach(() => {
    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.fstatSync).mockReturnValue({
      /** Model a plain file accepted by the inode-type gate. */
      isFile() { return true; },
      uid: 0, mode: 0o100644, size: 200,
    } as ReturnType<typeof fs.fstatSync>);
    vi.mocked(fs.readFileSync).mockReturnValue("INSTALL_USER=fixture\nPROJECT_DIR=/fixture/clawbox\n");
  });
  afterEach(() => vi.resetAllMocks());

  it("uses the desktop contract only for its configured checkout", () => {
    expect(hasX64DesktopIntegration("/fixture/clawbox")).toBe(true);
    expect(hasX64DesktopIntegration("/another/clawbox")).toBe(false);
    expect(fs.openSync).toHaveBeenCalledWith(
      "/etc/clawbox/x64-integration.env",
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    expect(fs.closeSync).toHaveBeenCalledTimes(2);
  });

  it("keeps ordinary installations on their existing updater", () => {
    vi.mocked(fs.openSync).mockImplementation(() => { throw Object.assign(new Error(), { code: "ENOENT" }); });
    expect(hasX64DesktopIntegration("/fixture/clawbox")).toBe(false);
    expect(fs.closeSync).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "ELOOP"])("refuses %s instead of falling back to appliance migrations", (code) => {
    vi.mocked(fs.openSync).mockImplementation(() => { throw Object.assign(new Error(), { code }); });
    expect(() => hasX64DesktopIntegration("/fixture/clawbox")).toThrow("repair it before updating");
  });

  it.each([
    { uid: 1000 }, { mode: 0o100664 }, { size: 4097 }, {
      /** Model a special inode that must not be read as configuration. */
      isFile() { return false; },
    },
  ])("rejects an unsafe host file: %o", (override) => {
    vi.mocked(fs.fstatSync).mockReturnValue({
      /** Keep the inode valid unless this case overrides its type. */
      isFile() { return true; },
      uid: 0, mode: 0o100644, size: 200, ...override,
    } as ReturnType<typeof fs.fstatSync>);
    expect(() => hasX64DesktopIntegration("/fixture/clawbox")).toThrow("root-owned file");
    expect(fs.closeSync).toHaveBeenCalledWith(42);
  });

  it.each([
    "INSTALL_USER=fixture\n", "PROJECT_DIR=relative\n", "PROJECT_DIR=$(touch /tmp/never)\n",
    "PROJECT_DIR=/fixture/clawbox\nPROJECT_DIR=/another/clawbox\n",
  ])("refuses a malformed project without interpreting shell syntax", (text) => {
    vi.mocked(fs.readFileSync).mockReturnValue(text);
    expect(() => hasX64DesktopIntegration("/fixture/clawbox")).toThrow("valid project directory");
    expect(fs.closeSync).toHaveBeenCalledWith(42);
  });
});

/**
 * The record install-x64.sh writes beside its root dispatcher. A PC set up
 * that way has NO integration file, so before this check its updater took the
 * appliance's path and asked a root helper for bootstrap_updater and
 * rebuild_reboot it never had. Same gate as the integration file: what a
 * non-root account could have written is not evidence of what root installed.
 */
describe("a PC installed with install-x64.sh", () => {
  beforeEach(() => {
    vi.mocked(fs.openSync).mockReturnValue(43);
    vi.mocked(fs.fstatSync).mockReturnValue({
      /** Model the 0644 root:root plain file the installer writes. */
      isFile() { return true; },
      uid: 0, mode: 0o100644, size: 116,
    } as ReturnType<typeof fs.fstatSync>);
    vi.mocked(fs.readFileSync).mockReturnValue(
      "CLAWBOX_USER=fixture\nPROJECT_DIR=/fixture/clawbox\nROOT_INSTALLER=/usr/local/libexec/clawbox/clawbox-x64-install.sh\n",
    );
  });
  afterEach(() => vi.resetAllMocks());

  it("is recognised from /etc/clawbox/x64.env, for its own checkout only", () => {
    expect(X64_INSTALL_FILE).toBe("/etc/clawbox/x64.env");
    expect(hasX64Install("/fixture/clawbox")).toBe(true);
    expect(hasX64Install("/fixture/clawbox/")).toBe(true);
    expect(hasX64Install("/another/clawbox")).toBe(false);
    expect(fs.openSync).toHaveBeenCalledWith(
      "/etc/clawbox/x64.env",
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    expect(fs.closeSync).toHaveBeenCalledTimes(3);
  });

  it("is not claimed by an appliance, which has no such file", () => {
    vi.mocked(fs.openSync).mockImplementation(() => { throw Object.assign(new Error(), { code: "ENOENT" }); });
    expect(hasX64Install("/fixture/clawbox")).toBe(false);
    expect(fs.closeSync).not.toHaveBeenCalled();
  });

  it("does not read the integration package's file, nor the other way round", () => {
    hasX64Install("/fixture/clawbox");
    hasX64DesktopIntegration("/fixture/clawbox");
    expect(vi.mocked(fs.openSync).mock.calls.map(([file]) => file)).toEqual([
      "/etc/clawbox/x64.env",
      "/etc/clawbox/x64-integration.env",
    ]);
  });

  it.each(["EACCES", "ELOOP"])("refuses %s rather than guessing which updater applies", (code) => {
    vi.mocked(fs.openSync).mockImplementation(() => { throw Object.assign(new Error(), { code }); });
    expect(() => hasX64Install("/fixture/clawbox")).toThrow("Cannot read the x64 install record (/etc/clawbox/x64.env); repair it before updating.");
  });

  it.each([
    { uid: 1000 }, { mode: 0o100666 }, { mode: 0o100620 }, { size: 4097 }, {
      /** Model a FIFO or directory planted at the path. */
      isFile() { return false; },
    },
  ])("rejects a record a non-root account could have written: %o", (override) => {
    vi.mocked(fs.fstatSync).mockReturnValue({
      /** Keep the inode valid unless this case overrides its type. */
      isFile() { return true; },
      uid: 0, mode: 0o100644, size: 116, ...override,
    } as ReturnType<typeof fs.fstatSync>);
    expect(() => hasX64Install("/fixture/clawbox")).toThrow(
      "The x64 install record (/etc/clawbox/x64.env) must be a small, root-owned file without group or other write access.",
    );
    expect(fs.closeSync).toHaveBeenCalledWith(43);
  });

  it.each([
    "CLAWBOX_USER=fixture\n", "PROJECT_DIR=relative\n", "PROJECT_DIR=$(touch /tmp/never)\n",
    "PROJECT_DIR=/fixture/clawbox\nPROJECT_DIR=/another/clawbox\n", "PROJECT_DIR=\"/fixture/clawbox\"\n",
  ])("refuses a malformed project directory without interpreting it: %j", (text) => {
    vi.mocked(fs.readFileSync).mockReturnValue(text);
    expect(() => hasX64Install("/fixture/clawbox")).toThrow("has no valid project directory");
    expect(fs.closeSync).toHaveBeenCalledWith(43);
  });
});

describe("X64_DESKTOP_CORE_STEP_TIMEOUT_MS", () => {
  it("outlasts an archive and a multi-GB migration and stays inside the root unit's 7200 s ceiling", async () => {
    const { X64_DESKTOP_CORE_STEP_TIMEOUT_MS } = await import("@/lib/x64-integration");
    expect(X64_DESKTOP_CORE_STEP_TIMEOUT_MS).toBeGreaterThanOrEqual(30 * 60_000);
    expect(X64_DESKTOP_CORE_STEP_TIMEOUT_MS).toBeLessThan(7_200_000);
  });
});

/**
 * Issue #1269: the desktop adapter's `openclaw_install` stops the owner's
 * gateway before it looks whether the core needs replacing. The updater asks
 * this check first and leaves the gateway alone only when the step would have
 * changed nothing; every doubt runs the adapter's step as before.
 */
describe("desktopCoreStepIsNoop", () => {
  const PREFIX = "/fixture/home/.npm-global";
  const HOME = "/fixture/home";
  const PIN = "/var/lib/clawbox/root-exec-mirror/config/openclaw-target.txt";
  const PKG = `${PREFIX}/lib/node_modules/openclaw/package.json`;
  const ENV = `INSTALL_USER=fixture\nINSTALL_UID=1000\nINSTALL_HOME=${HOME}\nPROJECT_DIR=/fixture/clawbox\nNODE_DIR=/opt/node/bin\nNPM_PREFIX=${PREFIX}\n`;
  const errno = (code: string) => Object.assign(new Error(code), { code });

  function host({ env = ENV, pin = "2026.10.7\n" as string | null, installed = '{"name":"openclaw","version":"2026.10.7"}' as string | null,
    present = [] as string[], points = null as string[] | Error | null, lstatError = {} as Record<string, string> } = {}) {
    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.fstatSync).mockReturnValue({
      /** The root-owned 0644 file build-package.py writes. */
      isFile() { return true; },
      uid: 0, mode: 0o100644, size: 200,
    } as ReturnType<typeof fs.fstatSync>);
    vi.mocked(fs.readFileSync).mockImplementation(((file: unknown) => {
      if (file === 42) return env;
      if (file === PIN && pin !== null) return pin;
      if (file === PKG && installed !== null) return installed;
      throw errno("ENOENT");
    }) as typeof fs.readFileSync);
    vi.mocked(fs.lstatSync).mockImplementation(((p: unknown) => {
      if (lstatError[String(p)]) throw errno(lstatError[String(p)]);
      if (present.includes(String(p))) return {} as ReturnType<typeof fs.lstatSync>;
      throw errno("ENOENT");
    }) as typeof fs.lstatSync);
    vi.mocked(fs.readdirSync).mockImplementation((() => {
      if (points instanceof Error) throw points;
      if (points === null) throw errno("ENOENT");
      return points;
    }) as unknown as typeof fs.readdirSync);
  }
  afterEach(() => vi.resetAllMocks());

  it("answers a no-op at the pin with nothing to recover, from the files the adapter itself reads", () => {
    host();
    expect(desktopCoreStepIsNoop()).toEqual({ noop: true, version: "2026.10.7" });
    const reads = vi.mocked(fs.readFileSync).mock.calls.map(([file]) => file);
    expect(reads).toEqual([42, PIN, PKG]);
    expect(fs.closeSync).toHaveBeenCalledWith(42);
  });

  it("reads shlex-quoted paths the way build-package.py writes them", () => {
    host({ env: ENV.replace(`INSTALL_HOME=${HOME}`, `INSTALL_HOME='${HOME}'`).replace(`NPM_PREFIX=${PREFIX}`, `NPM_PREFIX='${PREFIX}'`) });
    expect(desktopCoreStepIsNoop()).toEqual({ noop: true, version: "2026.10.7" });
  });

  it.each([
    ["the pin moved", { installed: '{"version":"2026.10.3"}' }, "OpenClaw 2026.10.3 is installed and the pin is 2026.10.7"],
    ["no installed core", { installed: null }, "the installed OpenClaw core could not be read"],
    ["a core without a version", { installed: '{"name":"openclaw"}' }, "OpenClaw (unknown) is installed"],
    ["an unreadable pin", { pin: null }, "the pinned OpenClaw version could not be read"],
    ["a pin that is not a version", { pin: "latest\n" }, "not a version"],
    ["a stage left behind", { present: [`${PREFIX}/.openclaw-stage`] }, ".openclaw-stage"],
    ["a replacement still pending", { present: [`${PREFIX}/.openclaw-migration-pending`] }, ".openclaw-migration-pending"],
    ["a leftover that cannot be inspected", { lstatError: { [`${PREFIX}/.openclaw-stage`]: "EACCES" } }, ".openclaw-stage"],
    ["links set aside by a cut-short swap", {
      points: ["20261021T153440Z-2026.10.3-to-2026.10.7"],
      present: [`${HOME}/backups/openclaw-core-update/20261021T153440Z-2026.10.3-to-2026.10.7/set-aside-links.txt`],
    }, "links set aside"],
    ["unreadable recovery points", { points: errno("EACCES") }, "recovery points could not be read"],
    ["an owner core patch", { present: [`${HOME}/bin/openclaw-patch-memory-maintenance`] }, "openclaw-patch-memory-maintenance"],
    ["no NPM_PREFIX", { env: ENV.replace(`NPM_PREFIX=${PREFIX}\n`, "") }, "names no plain NPM_PREFIX and INSTALL_HOME"],
    ["a shell expression for a path", { env: ENV.replace(`NPM_PREFIX=${PREFIX}`, "NPM_PREFIX=$(touch /tmp/never)") }, "names no plain"],
    ["a relative path", { env: ENV.replace(`INSTALL_HOME=${HOME}`, "INSTALL_HOME=home/fixture") }, "names no plain"],
  ])("runs the adapter's step for %s", (_label, setup, reason) => {
    host(setup as Parameters<typeof host>[0]);
    const answer = desktopCoreStepIsNoop();
    expect(answer.noop).toBe(false);
    expect(answer.noop === false && answer.reason).toContain(reason);
  });

  it("keeps recovery points that hold no set-aside links out of the way", () => {
    host({ points: ["20261021T153440Z-2026.10.3-to-2026.10.7"] });
    expect(desktopCoreStepIsNoop()).toEqual({ noop: true, version: "2026.10.7" });
  });

  it("is never a no-op without the integration file, and refuses one a non-root account could write", () => {
    host();
    vi.mocked(fs.openSync).mockImplementation(() => { throw errno("ENOENT"); });
    expect(desktopCoreStepIsNoop()).toEqual({ noop: false, reason: "no x64 integration file" });
    host();
    vi.mocked(fs.fstatSync).mockReturnValue({
      /** A file the owner could have edited. */
      isFile() { return true; },
      uid: 1000, mode: 0o100644, size: 200,
    } as ReturnType<typeof fs.fstatSync>);
    expect(() => desktopCoreStepIsNoop()).toThrow("root-owned file");
  });
});
