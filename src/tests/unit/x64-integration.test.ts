import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import { hasX64DesktopIntegration } from "@/lib/x64-integration";

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
