import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

// TASK-1256: the privileged halves of Settings → Users. Account creation and
// removal go through root steps fed by a 0600 file; the sign-in check goes
// through the root-owned helper with the password on STDIN. Nothing is ever
// composed into a shell string, and the owner can never be removed.

const store = new Map<string, unknown>();

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: `/tmp/clawbox-users-test-${process.pid}`,
  get: vi.fn(async (key: string) => store.get(key)),
  set: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
}));
vi.mock("@/lib/root-step-runner", () => ({ startRootStep: vi.fn() }));
vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return { ...actual, default: { ...actual, mkdir: vi.fn(), writeFile: vi.fn(), unlink: vi.fn() } };
});
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return { ...actual, execFile: vi.fn(), spawn: vi.fn() };
});

import fs from "fs/promises";
import { execFile, spawn } from "child_process";
import { startRootStep } from "@/lib/root-step-runner";

type ExecFileCb = (err: (Error & { code?: number }) | null, out?: { stdout: string; stderr: string }) => void;

/** getent: 0 = found, 2 = not found, per database. */
function getentAnswers(found: { passwd?: string[]; group?: string[] }, failing = false) {
  vi.mocked(execFile).mockImplementation(((bin: string, args: string[], _opts: unknown, cb: ExecFileCb) => {
    const [db, name] = args;
    if (failing) {
      cb(Object.assign(new Error("boom"), { code: 1 }));
    } else if ((found[db as "passwd" | "group"] ?? []).includes(name)) {
      cb(null, { stdout: `${name}:x:1001:1001::/home/${name}:/bin/bash\n`, stderr: "" });
    } else {
      cb(Object.assign(new Error("not found"), { code: 2 }));
    }
    return {} as never;
  }) as never);
}

function fakeChild(exitCode: number) {
  const child = new EventEmitter() as EventEmitter & { stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> } };
  child.stdin = { end: vi.fn(), on: vi.fn() };
  setTimeout(() => child.emit("close", exitCode), 0);
  return child;
}

describe("clawbox-users", () => {
  let lib: typeof import("@/lib/clawbox-users");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    store.clear();
    process.env.CLAWBOX_USER = "clawbox";
    getentAnswers({ passwd: ["clawbox", "root"], group: ["clawbox", "sudo"] });
    vi.mocked(startRootStep).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    lib = await import("@/lib/clawbox-users");
  });

  describe("createUser", () => {
    it("hands useradd one user:password record in a 0600 file, then registers the user", async () => {
      const created = await lib.createUser("alice", "correct horse");

      expect(fs.writeFile).toHaveBeenCalledWith(lib.USER_ADD_INPUT_PATH, "alice:correct horse\n", { mode: 0o600 });
      expect(startRootStep).toHaveBeenCalledWith("user_add", { timeoutMs: 60_000 });
      expect(created.username).toBe("alice");
      expect(created.sv).toMatch(/^[0-9a-f]{32}$/);
      expect(await lib.listUsers()).toEqual([created]);
    });

    it("asks getent without a shell, argument by argument", async () => {
      await lib.createUser("alice", "correct horse");
      const calls = vi.mocked(execFile).mock.calls.map(([bin, args]) => [bin, args]);
      expect(calls).toEqual([["/usr/bin/getent", ["passwd", "alice"]], ["/usr/bin/getent", ["group", "alice"]]]);
    });

    it("refuses a name an existing Linux account or group already has", async () => {
      getentAnswers({ passwd: ["ubuntu2"], group: ["plugdev2"] });
      await expect(lib.createUser("ubuntu2", "correct horse")).rejects.toMatchObject({ code: "user_exists", status: 409 });
      await expect(lib.createUser("plugdev2", "correct horse")).rejects.toMatchObject({ code: "user_exists" });
      expect(startRootStep).not.toHaveBeenCalled();
    });

    it("fails closed when the account lookup itself fails", async () => {
      getentAnswers({}, true);
      await expect(lib.createUser("alice", "correct horse")).rejects.toMatchObject({ code: "account_check_failed" });
      expect(startRootStep).not.toHaveBeenCalled();
    });

    it("never reaches the root step for an invalid, reserved or taken name", async () => {
      await expect(lib.createUser("Alice", "correct horse")).rejects.toMatchObject({ code: "invalid_username" });
      await expect(lib.createUser("root", "correct horse")).rejects.toMatchObject({ code: "reserved_username" });
      await expect(lib.createUser("alice;id", "correct horse")).rejects.toMatchObject({ code: "invalid_username" });
      await lib.createUser("alice", "correct horse");
      vi.mocked(startRootStep).mockClear();
      await expect(lib.createUser("alice", "correct horse")).rejects.toMatchObject({ code: "user_exists" });
      expect(startRootStep).not.toHaveBeenCalled();
    });

    it("removes the password file and registers nobody when useradd fails", async () => {
      vi.mocked(startRootStep).mockRejectedValue(new Error("Job failed"));
      await expect(lib.createUser("alice", "correct horse")).rejects.toMatchObject({ code: "create_failed" });
      expect(fs.unlink).toHaveBeenCalledWith(lib.USER_ADD_INPUT_PATH);
      expect(await lib.listUsers()).toEqual([]);
    });
  });

  describe("removeUser", () => {
    beforeEach(async () => {
      await lib.createUser("alice", "correct horse");
      vi.mocked(startRootStep).mockClear();
      vi.mocked(fs.writeFile).mockClear();
    });

    it("never removes the owner", async () => {
      await expect(lib.removeUser("clawbox", { currentUser: "clawbox" })).rejects.toMatchObject({ code: "cannot_remove_owner" });
      expect(startRootStep).not.toHaveBeenCalled();
    });

    it("never removes the user who is asking", async () => {
      await expect(lib.removeUser("alice", { currentUser: "alice" })).rejects.toMatchObject({ code: "cannot_remove_self" });
      expect(startRootStep).not.toHaveBeenCalled();
    });

    it("refuses a name that is not a ClawBox user", async () => {
      await expect(lib.removeUser("root", { currentUser: "clawbox" })).rejects.toMatchObject({ code: "not_found", status: 404 });
      expect(startRootStep).not.toHaveBeenCalled();
    });

    it("drops the registry entry (ending their sessions), then runs userdel through the root step", async () => {
      vi.mocked(startRootStep).mockImplementation(async () => {
        // By the time root runs, the user's cookies are already dead.
        expect(await lib.listUsers()).toEqual([]);
      });
      await lib.removeUser("alice", { currentUser: "clawbox" });
      expect(fs.writeFile).toHaveBeenCalledWith(lib.USER_REMOVE_INPUT_PATH, "alice\n", { mode: 0o600 });
      expect(startRootStep).toHaveBeenCalledWith("user_remove", { timeoutMs: 60_000 });
      expect(await lib.listUsers()).toEqual([]);
    });

    it("puts the user back under a NEW session version when userdel fails, so old sessions stay dead", async () => {
      const before = (await lib.listUsers())[0];
      vi.mocked(startRootStep).mockRejectedValue(new Error("Job failed"));
      await expect(lib.removeUser("alice", { currentUser: "clawbox" })).rejects.toMatchObject({ code: "remove_failed" });
      const after = await lib.listUsers();
      expect(after.map((u) => u.username)).toEqual(["alice"]);
      expect(after[0].sv).not.toBe(before.sv);
    });
  });

  describe("verifyUserPassword", () => {
    it("asks the root-owned helper with the password on stdin, never argv", async () => {
      vi.mocked(spawn).mockImplementation((() => fakeChild(0)) as never);
      expect(await lib.verifyUserPassword("alice", "p@ss word")).toBe(true);
      const [bin, args] = vi.mocked(spawn).mock.calls[0];
      expect(bin).toBe("/usr/bin/sudo");
      expect(args).toEqual(["-n", "/usr/local/libexec/clawbox/clawbox-user-helper.sh", "verify"]);
      expect(JSON.stringify(args)).not.toContain("p@ss");
      const child = vi.mocked(spawn).mock.results[0].value as ReturnType<typeof fakeChild>;
      expect(child.stdin.end).toHaveBeenCalledWith("alice\np@ss word\n");
    });

    it("is false for a wrong password (PAM_AUTH_ERR) or a missing grant", async () => {
      vi.mocked(spawn).mockImplementation((() => fakeChild(7)) as never);
      expect(await lib.verifyUserPassword("alice", "wrong")).toBe(false);
      vi.mocked(spawn).mockImplementation((() => fakeChild(1)) as never);
      expect(await lib.verifyUserPassword("alice", "wrong")).toBe(false);
    });

    it("never spawns anything for an unsafe name or password", async () => {
      expect(await lib.verifyUserPassword("alice\nroot", "x")).toBe(false);
      expect(await lib.verifyUserPassword("root", "x")).toBe(false);
      expect(await lib.verifyUserPassword("alice", "pw\nroot")).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    });
  });
});
