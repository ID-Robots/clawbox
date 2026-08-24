/**
 * The bootstrap carve-out in `requireSession` (wifi/connect, update/run): the
 * wizard's first steps run before any session can exist, and may only do so
 * while the device has no owner. "Owner" is decided from data/config.json AND
 * /etc/shadow — and a /etc/shadow hash that is merely the factory default must
 * NOT count, or every as-flashed / factory-reset box locks its own wizard out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";
import { installSessionFixture, type SessionFixture, type SessionFixtureOptions } from "@/tests/helpers/session";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

const mockExecFile = vi.mocked(childProcess.execFile);
const mockSpawn = vi.mocked(childProcess.spawn);

type ExecCb = (err: Error | null, result: { stdout: string; stderr: string }) => void;

function passwdSays(status: "P" | "NP" | "L" | Error) {
  mockExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: object, cb: ExecCb) => {
    if (status instanceof Error) cb(status, { stdout: "", stderr: "" });
    else cb(null, { stdout: `clawbox ${status} 05/08/2026 0 99999 7 -1\n`, stderr: "" });
    return {} as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
}

function chkpwdExits(code: number | null) {
  mockSpawn.mockImplementation((() => {
    const listeners = new Map<string, Array<(arg?: unknown) => void>>();
    const child = {
      stdin: {
        on: vi.fn(),
        end: vi.fn(() => {
          queueMicrotask(() => listeners.get("close")?.forEach((cb) => cb(code)));
        }),
      },
      on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) || []), cb]);
        return child;
      }),
    };
    return child;
  }) as unknown as typeof childProcess.spawn);
}

describe("requireSession({ allowBootstrap: true })", () => {
  let session: SessionFixture | undefined;
  const previousUser = process.env.CLAWBOX_USER;
  const previousTestMode = process.env.CLAWBOX_TEST_MODE;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.CLAWBOX_USER = "clawbox";
    // The e2e escape hatch would short-circuit every case below.
    delete process.env.CLAWBOX_TEST_MODE;
  });

  afterEach(() => {
    session?.cleanup();
    session = undefined;
    if (previousUser === undefined) delete process.env.CLAWBOX_USER;
    else process.env.CLAWBOX_USER = previousUser;
    if (previousTestMode === undefined) delete process.env.CLAWBOX_TEST_MODE;
    else process.env.CLAWBOX_TEST_MODE = previousTestMode;
  });

  /** Anonymous request against a box in the given config state. */
  async function gate(fixture: SessionFixtureOptions = {}, opts: { allowBootstrap?: boolean } = { allowBootstrap: true }) {
    session = installSessionFixture({ passwordConfigured: false, setupComplete: false, ...fixture });
    const { requireSession } = await import("@/lib/route-auth");
    return requireSession(new Request("http://localhost/setup-api/wifi/connect", { method: "POST" }), opts);
  }

  it("lets first boot through when the account has no password", async () => {
    passwdSays("NP");
    await expect(gate()).resolves.toBeNull();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("lets first boot through while the account still carries the factory default", async () => {
    // As-flashed / factory-reset: shadow has a hash, and it is `clawbox`.
    passwdSays("P");
    chkpwdExits(0);
    await expect(gate()).resolves.toBeNull();
    expect(mockSpawn).toHaveBeenCalledWith("/usr/sbin/unix_chkpwd", ["clawbox", "nonull"], expect.anything());
  });

  it("fails closed when /etc/shadow holds an owner's password the config flag has lost (TASK-444a)", async () => {
    passwdSays("P");
    chkpwdExits(7);
    const res = await gate();
    expect(res?.status).toBe(401);
    await expect(res!.json()).resolves.toEqual({ error: "Authentication required" });
  });

  it("fails closed when shadow has a hash and the default check cannot run", async () => {
    passwdSays("P");
    chkpwdExits(null);
    const res = await gate();
    expect(res?.status).toBe(401);
  });

  it("closes the window on the config flag alone, without touching /etc/shadow", async () => {
    passwdSays("NP");
    const res = await gate({ passwordConfigured: true });
    expect(res?.status).toBe(401);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("falls back to the config flag when passwd -S is unavailable", async () => {
    // Unknown shadow state + flag unset = first boot, as before TASK-444a.
    passwdSays(new Error("EACCES"));
    await expect(gate()).resolves.toBeNull();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("never opens the window for a route that did not ask for it", async () => {
    passwdSays("NP");
    const res = await gate({}, {});
    expect(res?.status).toBe(401);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("still honours a valid session on an owned box", async () => {
    passwdSays("P");
    chkpwdExits(7);
    session = installSessionFixture({ passwordConfigured: true, setupComplete: true });
    const { requireSession } = await import("@/lib/route-auth");
    const req = new Request("http://localhost/setup-api/wifi/connect", {
      method: "POST",
      headers: { cookie: session.cookie },
    });
    await expect(requireSession(req, { allowBootstrap: true })).resolves.toBeNull();
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
