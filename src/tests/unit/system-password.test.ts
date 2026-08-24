import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

const mockExecFile = vi.mocked(childProcess.execFile);
const mockSpawn = vi.mocked(childProcess.spawn);

type ExecCb = (err: Error | null, result: { stdout: string; stderr: string }) => void;

/** `passwd -S` prints one status line, or the helper fails outright. */
function passwdSays(line: string | Error) {
  mockExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: object, cb: ExecCb) => {
    if (line instanceof Error) cb(line, { stdout: "", stderr: "" });
    else cb(null, { stdout: line, stderr: "" });
    return {} as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
}

interface FakeChild {
  stdin: { on: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
  emit: (event: string, arg?: unknown) => void;
}

/**
 * Stand in for `/usr/sbin/unix_chkpwd`. `exitCode` follows PAM: 0 = the
 * password matched, 7 = it did not, anything else = the helper could not tell.
 * `"error"` makes the child emit a spawn error instead of ever closing;
 * `"throw"` makes spawn() itself throw (ENOENT surfaces that way in some
 * sandboxes).
 */
function chkpwd(outcome: number | null | "error" | "throw"): FakeChild {
  const listeners = new Map<string, Array<(arg?: unknown) => void>>();
  const child: FakeChild = {
    stdin: {
      on: vi.fn(),
      end: vi.fn(() => {
        queueMicrotask(() => {
          if (outcome === "error") child.emit("error", new Error("spawn ENOENT"));
          else child.emit("close", outcome);
        });
      }),
    },
    on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) || []), cb]);
      return child;
    }),
    emit: (event, arg) => listeners.get(event)?.forEach((cb) => cb(arg)),
  };
  if (outcome === "throw") {
    mockSpawn.mockImplementation((() => { throw new Error("spawn EACCES"); }) as never);
  } else {
    mockSpawn.mockReturnValue(child as never);
  }
  return child;
}

describe("@/lib/system-password", () => {
  const previousUser = process.env.CLAWBOX_USER;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.CLAWBOX_USER = "clawbox";
  });

  afterEach(() => {
    if (previousUser === undefined) delete process.env.CLAWBOX_USER;
    else process.env.CLAWBOX_USER = previousUser;
  });

  describe("parsePasswdStatus", () => {
    it("reads the status column", async () => {
      const { parsePasswdStatus } = await import("@/lib/system-password");
      expect(parsePasswdStatus("clawbox P 05/08/2026 0 99999 7 -1\n")).toBe(true);
      expect(parsePasswdStatus("clawbox NP 05/08/2026 0 99999 7 -1\n")).toBe(false);
      expect(parsePasswdStatus("clawbox L 05/08/2026 0 99999 7 -1\n")).toBe(false);
      expect(parsePasswdStatus("\n  clawbox P 05/08/2026\n")).toBe(true);
    });

    it("returns null for anything it does not recognise", async () => {
      const { parsePasswdStatus } = await import("@/lib/system-password");
      expect(parsePasswdStatus("")).toBeNull();
      expect(parsePasswdStatus("\n\n")).toBeNull();
      expect(parsePasswdStatus("clawbox")).toBeNull();
      expect(parsePasswdStatus("clawbox ? 05/08/2026")).toBeNull();
    });
  });

  describe("hasSystemPassword", () => {
    it("asks passwd -S about the install user", async () => {
      passwdSays("desktopuser P 05/08/2026 0 99999 7 -1\n");
      process.env.CLAWBOX_USER = "desktopuser";
      const { hasSystemPassword } = await import("@/lib/system-password");
      await expect(hasSystemPassword()).resolves.toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith(
        "/usr/bin/passwd",
        ["-S", "desktopuser"],
        expect.objectContaining({ timeout: 5_000 }),
        expect.any(Function),
      );
    });

    it("returns null — not false — when the helper fails", async () => {
      passwdSays(new Error("permission denied"));
      const { hasSystemPassword } = await import("@/lib/system-password");
      await expect(hasSystemPassword()).resolves.toBeNull();
    });
  });

  describe("isFactoryDefaultPassword", () => {
    it("feeds the shipping default to unix_chkpwd for the install user", async () => {
      const child = chkpwd(0);
      const { isFactoryDefaultPassword, FACTORY_DEFAULT_PASSWORD } = await import("@/lib/system-password");
      await expect(isFactoryDefaultPassword()).resolves.toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith(
        "/usr/sbin/unix_chkpwd",
        ["clawbox", "nonull"],
        expect.objectContaining({ stdio: ["pipe", "ignore", "ignore"], timeout: 5_000, killSignal: "SIGKILL" }),
      );
      expect(child.stdin.end).toHaveBeenCalledWith(FACTORY_DEFAULT_PASSWORD + "\0");
      expect(FACTORY_DEFAULT_PASSWORD).toBe("clawbox");
    });

    it("is false on PAM_AUTH_ERR (somebody set their own password)", async () => {
      chkpwd(7);
      const { isFactoryDefaultPassword } = await import("@/lib/system-password");
      await expect(isFactoryDefaultPassword()).resolves.toBe(false);
    });

    it.each([
      ["PAM_USER_UNKNOWN", 10],
      ["PAM_SYSTEM_ERR", 4],
      ["killed by signal / timeout", null],
    ])("is null when the helper could not tell (%s)", async (_label, code) => {
      chkpwd(code);
      const { isFactoryDefaultPassword } = await import("@/lib/system-password");
      await expect(isFactoryDefaultPassword()).resolves.toBeNull();
    });

    it("kills with SIGKILL on timeout — unix_chkpwd ignores SIGTERM", async () => {
      chkpwd(0);
      const { isFactoryDefaultPassword } = await import("@/lib/system-password");
      await isFactoryDefaultPassword();
      const opts = mockSpawn.mock.calls[0][2] as { killSignal?: string; timeout?: number };
      expect(opts.killSignal).toBe("SIGKILL");
      expect(opts.timeout).toBe(5_000);
    });

    it("is null when the child errors instead of closing", async () => {
      chkpwd("error");
      const { isFactoryDefaultPassword } = await import("@/lib/system-password");
      await expect(isFactoryDefaultPassword()).resolves.toBeNull();
    });

    it("is null — and never rejects — when spawn itself throws", async () => {
      chkpwd("throw");
      const { isFactoryDefaultPassword } = await import("@/lib/system-password");
      await expect(isFactoryDefaultPassword()).resolves.toBeNull();
    });

    it("swallows a stdin EPIPE from a helper that exits early", async () => {
      const child = chkpwd(7);
      const { isFactoryDefaultPassword } = await import("@/lib/system-password");
      await isFactoryDefaultPassword();
      expect(child.stdin.on).toHaveBeenCalledWith("error", expect.any(Function));
    });
  });

  describe("hasOwnerPassword", () => {
    it("is false — without running unix_chkpwd — when the account has no password", async () => {
      passwdSays("clawbox NP 05/08/2026 0 99999 7 -1\n");
      const { hasOwnerPassword } = await import("@/lib/system-password");
      await expect(hasOwnerPassword()).resolves.toBe(false);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("is false — without running unix_chkpwd — when the account is locked", async () => {
      passwdSays("clawbox L 05/08/2026 0 99999 7 -1\n");
      const { hasOwnerPassword } = await import("@/lib/system-password");
      await expect(hasOwnerPassword()).resolves.toBe(false);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("is false when the only password is the factory default (as-flashed / factory reset)", async () => {
      passwdSays("clawbox P 05/08/2026 0 99999 7 -1\n");
      chkpwd(0);
      const { hasOwnerPassword } = await import("@/lib/system-password");
      await expect(hasOwnerPassword()).resolves.toBe(false);
    });

    it("is true when the password is anything else (TASK-444a drift)", async () => {
      passwdSays("clawbox P 05/08/2026 0 99999 7 -1\n");
      chkpwd(7);
      const { hasOwnerPassword } = await import("@/lib/system-password");
      await expect(hasOwnerPassword()).resolves.toBe(true);
    });

    it("fails closed (true) when shadow has a hash but the default check cannot run", async () => {
      passwdSays("clawbox P 05/08/2026 0 99999 7 -1\n");
      chkpwd(10);
      const { hasOwnerPassword } = await import("@/lib/system-password");
      await expect(hasOwnerPassword()).resolves.toBe(true);
    });

    it("passes null through — without running unix_chkpwd — when shadow is unreadable", async () => {
      passwdSays(new Error("EACCES"));
      const { hasOwnerPassword } = await import("@/lib/system-password");
      await expect(hasOwnerPassword()).resolves.toBeNull();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("checks the user it was given, not the environment's", async () => {
      passwdSays("other P 05/08/2026 0 99999 7 -1\n");
      chkpwd(0);
      const { hasOwnerPassword } = await import("@/lib/system-password");
      await hasOwnerPassword("other");
      expect(mockExecFile).toHaveBeenCalledWith("/usr/bin/passwd", ["-S", "other"], expect.anything(), expect.any(Function));
      expect(mockSpawn).toHaveBeenCalledWith("/usr/sbin/unix_chkpwd", ["other", "nonull"], expect.anything());
    });
  });
});
