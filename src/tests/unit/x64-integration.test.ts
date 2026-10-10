import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import { hasX64DesktopIntegration, hasX64Install, X64_INSTALL_FILE } from "@/lib/x64-integration";

vi.mock("fs", async (original) => {
  const actual = await original<typeof import("fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      openSync: vi.fn(), fstatSync: vi.fn(), readFileSync: vi.fn(), closeSync: vi.fn(),
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
