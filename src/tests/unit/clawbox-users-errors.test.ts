import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

// "The account could not be created. Try again." — and nothing else — was what
// the owner of an x64 desktop read on every Add a user: the PC's root-step
// launcher had never been given user_add, sudo answered "step not permitted
// from the web server", and createUser threw that away. Run here through the
// REAL root-step runner, with only the processes it starts stood in for, so
// each failure arrives the way it does on a box and leaves with its reason.

const store = new Map<string, unknown>();

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: `/tmp/clawbox-users-errors-test-${process.pid}`,
  get: vi.fn(async (key: string) => store.get(key)),
  set: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
}));
vi.mock("@/lib/desktop-state-store", () => ({ removeDesktopState: vi.fn(async () => {}) }));
vi.mock("@/lib/user-chats", () => ({ forgetUserChats: vi.fn(async () => {}) }));
vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return { ...actual, default: { ...actual, mkdir: vi.fn(), writeFile: vi.fn(), unlink: vi.fn() } };
});
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return { ...actual, execFile: vi.fn(), spawn: vi.fn() };
});

import fs from "fs";
import fsp from "fs/promises";
import { execFile, spawn } from "child_process";

type Cb = (err: Error | null, out?: { stdout: string; stderr: string }) => void;

const LAUNCHER = "/usr/local/libexec/clawbox/clawbox-run-root-step.sh";
const X64_ENV = "/etc/clawbox/x64.env";

interface Box {
  /** What `sudo -n <launcher> <step>` does: undefined runs the step fine. */
  launcher?: (step: string) => Error | null;
  /** The step's journal, as `journalctl -o cat` prints it. */
  journal?: string;
  /** Whether journalctl itself fails (the web server cannot read the journal). */
  journalUnreadable?: boolean;
}

function stage(box: Box) {
  vi.mocked(execFile).mockImplementation(((bin: string, args: string[], _opts: unknown, cb: Cb) => {
    if (bin === "/usr/bin/getent") {
      cb(Object.assign(new Error("not found"), { code: 2 }));
    } else if (bin === "/usr/bin/sudo" && args[1] === LAUNCHER) {
      cb(box.launcher ? box.launcher(args[args.length - 1]) : null, { stdout: "", stderr: "" });
    } else if (bin === "/usr/bin/journalctl") {
      if (box.journalUnreadable) cb(Object.assign(new Error("No journal files were opened due to insufficient permissions."), { code: 1 }));
      else cb(null, { stdout: box.journal ?? "", stderr: "" });
    } else {
      cb(Object.assign(new Error(`unexpected ${bin}`), { code: 127 }));
    }
    return {} as never;
  }) as never);
}

/** The launcher's own refusal, exactly as sudo relays it on an x64 PC that was installed before this fix. */
function stepNotPermitted(step: string) {
  return Object.assign(new Error(`Command failed: /usr/bin/sudo -n ${LAUNCHER} ${step}`), {
    code: 64,
    stderr: `clawbox-run-root-step: step not permitted from the web server: ${step}\n`,
  });
}

/** A unit that ran and failed: what `systemctl start` says, with the reason left in the journal. */
function unitFailed(step: string) {
  return Object.assign(new Error(`Command failed: /usr/bin/sudo -n ${LAUNCHER} ${step}`), {
    code: 1,
    stderr: `Job for clawbox-root-update@${step}.service failed because the control process exited with error code.\n`,
  });
}

function fakeChild(exitCode: number | null, opts: { error?: boolean } = {}) {
  const child = new EventEmitter() as EventEmitter & { stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> } };
  child.stdin = { end: vi.fn(), on: vi.fn() };
  setTimeout(() => (opts.error ? child.emit("error", new Error("spawn ENOENT")) : child.emit("close", exitCode)), 0);
  return child;
}

describe("Settings → Users on an x64 desktop: every failure says why", () => {
  let lib: typeof import("@/lib/clawbox-users");
  let existsSync: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    store.clear();
    process.env.CLAWBOX_USER = "owner";
    process.env.CLAWBOX_ROOT = "/opt/clawbox";
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.unlink).mockResolvedValue(undefined);
    // An install-x64.sh PC: the record its installer writes beside the dispatcher.
    existsSync = vi.spyOn(fs, "existsSync").mockImplementation((p) => p === X64_ENV);
    stage({});
    lib = await import("@/lib/clawbox-users");
  });

  it("RED before the fix: the x64 launcher refused user_add — now the owner is told, with the one command that repairs it", async () => {
    stage({ launcher: stepNotPermitted });
    const err = await lib.createUser("carol", "correct horse battery").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(lib.UserAdminError);
    expect(err).toMatchObject({
      code: "root_step_unavailable",
      status: 503,
      repairCommand: "sudo bash /opt/clawbox/install-x64.sh --step root_step_contract",
    });
    expect((err as Error).message).toContain("install-x64.sh --step root_step_contract");
    // The password record is gone and nobody was registered.
    expect(fsp.unlink).toHaveBeenCalledWith(lib.USER_ADD_INPUT_PATH);
    expect(await lib.listUsers()).toEqual([]);
    expect(existsSync).toHaveBeenCalled();
  });

  it("names the missing sudo grant the same way", async () => {
    stage({ launcher: (step) => Object.assign(new Error(`Command failed: sudo ${step}`), { code: 1, stderr: "sudo: a password is required\n" }) });
    await expect(lib.createUser("carol", "correct horse battery")).rejects.toMatchObject({ code: "root_step_unavailable" });
  });

  it("names an x64 root dispatcher older than its launcher (the step has no implementation)", async () => {
    stage({
      launcher: unitFailed,
      journal: "clawbox-root-step: step 'user_add' has no implementation on the x64 install\n",
    });
    await expect(lib.createUser("carol", "correct horse battery")).rejects.toMatchObject({
      code: "root_step_unavailable",
      repairCommand: expect.stringContaining("install-x64.sh --step root_step_contract"),
      detail: "clawbox-root-step: step 'user_add' has no implementation on the x64 install",
    });
  });

  it("passes on what useradd itself said", async () => {
    stage({ launcher: unitFailed, journal: "useradd: cannot lock /etc/passwd; try again later.\nError: useradd could not create 'carol'\n" });
    const err = await lib.createUser("carol", "correct horse battery").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "create_failed", status: 500, detail: "useradd could not create 'carol'" });
    expect((err as Error).message).toBe("The account could not be created: useradd could not create 'carol'");
  });

  it("answers a name that appeared between the check and the step as taken", async () => {
    stage({ launcher: unitFailed, journal: "Error: an account or group named 'carol' already exists\n" });
    await expect(lib.createUser("carol", "correct horse battery")).rejects.toMatchObject({ code: "user_exists", status: 409 });
  });

  it("answers a password the box refused as that, not as a failure to try again", async () => {
    stage({ launcher: unitFailed, journal: "Error: could not set the password for 'carol'; the account was removed again\n" });
    await expect(lib.createUser("carol", "correct horse battery")).rejects.toMatchObject({ code: "password_rejected", status: 400 });
  });

  it("never carries the password into the reason, whatever the step printed", async () => {
    stage({ launcher: unitFailed, journal: "Error: chpasswd rejected correct horse battery for carol\n" });
    const err = await lib.createUser("carol", "correct horse battery").catch((e: unknown) => e) as { detail?: string; message: string };
    expect(err.detail).toBe("chpasswd rejected ••• for carol");
    expect(JSON.stringify(err)).not.toContain("correct horse");
    expect(err.message).not.toContain("correct horse");
  });

  it("still says the account could not be created when the journal cannot be read", async () => {
    stage({ launcher: unitFailed, journalUnreadable: true });
    const err = await lib.createUser("carol", "correct horse battery").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "create_failed" });
    expect((err as { detail?: string }).detail).toBeUndefined();
  });

  it("calls a step killed at its deadline a timeout", async () => {
    stage({ launcher: () => Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" }) });
    await expect(lib.createUser("carol", "correct horse battery")).rejects.toMatchObject({ code: "create_timeout", status: 504 });
  });

  it("explains a refused removal the same way, and keeps the user listed under a new session version", async () => {
    stage({});
    await lib.createUser("carol", "correct horse battery");
    const before = (await lib.listUsers())[0];
    stage({ launcher: stepNotPermitted });
    await expect(lib.removeUser("carol", { currentUser: "owner" })).rejects.toMatchObject({
      code: "root_step_unavailable",
      repairCommand: expect.stringContaining("root_step_contract"),
    });
    const after = await lib.listUsers();
    expect(after.map((u) => u.username)).toEqual(["carol"]);
    expect(after[0].sv).not.toBe(before.sv);
  });

  it("forgets a removed user's chat with their account", async () => {
    stage({});
    await lib.createUser("carol", "correct horse battery");
    await lib.removeUser("carol", { currentUser: "owner" });
    const { forgetUserChats } = await import("@/lib/user-chats");
    expect(forgetUserChats).toHaveBeenCalledWith("carol");
  });
});

describe("signing in a second user: wrong password vs a box that cannot check", () => {
  let lib: typeof import("@/lib/clawbox-users");
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    lib = await import("@/lib/clawbox-users");
  });

  it.each([
    [0, "ok"],
    [7, "wrong"],
    // sudo's own exit: no grant for the helper (an x64 PC before its repair), or no helper at all.
    [1, "unavailable"],
    [null, "unavailable"],
  ])("helper exit %s is %s", async (code, verdict) => {
    vi.mocked(spawn).mockImplementation((() => fakeChild(code as number | null)) as never);
    expect(await lib.checkUserPassword("carol", "pw")).toBe(verdict);
    expect(await lib.verifyUserPassword("carol", "pw")).toBe(verdict === "ok");
  });

  it("calls a helper that could not even be started unavailable", async () => {
    vi.mocked(spawn).mockImplementation((() => fakeChild(null, { error: true })) as never);
    expect(await lib.checkUserPassword("carol", "pw")).toBe("unavailable");
  });

  it("asks the helper about nobody to learn whether it can answer at all", async () => {
    vi.mocked(spawn).mockImplementation((() => fakeChild(7)) as never);
    expect(await lib.userHelperAvailable()).toBe(true);
    const child = vi.mocked(spawn).mock.results[0].value as ReturnType<typeof fakeChild>;
    expect(child.stdin.end).toHaveBeenCalledWith("\n\n");
    vi.mocked(spawn).mockImplementation((() => fakeChild(1)) as never);
    expect(await lib.userHelperAvailable()).toBe(false);
  });
});
