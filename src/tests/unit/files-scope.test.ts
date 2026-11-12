import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * TASK-2377 — the Files fence of a member of staff: their own home and the
 * shared folder, and nothing else — no traversal, no absolute path, no link
 * out of either root, no secret store inside their own home. The owner's
 * fence is the browse root exactly as before.
 */

const ROOT = path.join(fs.realpathSync(os.tmpdir()), `clawbox-files-scope-${process.pid}-${Date.now()}`);
const OWNER = path.join(ROOT, "owner");
const HOME = path.join(ROOT, "staff", "ivan");
const OTHER = path.join(ROOT, "staff", "maria");

let scope: typeof import("@/lib/files-scope");

beforeAll(async () => {
  for (const dir of [OWNER, HOME, OTHER, path.join(OWNER, "secret-project"), path.join(HOME, "Documents"), path.join(HOME, ".ssh"), path.join(OTHER, "private")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(HOME, "Documents", "notes.txt"), "mine");
  fs.writeFileSync(path.join(HOME, ".ssh", "id_ed25519"), "key");
  fs.writeFileSync(path.join(OWNER, "secret-project", "plan.txt"), "owner's");
  fs.writeFileSync(path.join(OTHER, "private", "diary.txt"), "maria's");
  // Links a user could have left in their home before organisation mode.
  fs.symlinkSync(path.join(OWNER, "secret-project"), path.join(HOME, "owner-link"));
  fs.symlinkSync(path.join(OTHER, "private", "diary.txt"), path.join(HOME, "maria-diary"));
  fs.symlinkSync("/etc", path.join(HOME, "etc-link"));
  fs.symlinkSync(path.join(HOME, "Documents"), path.join(HOME, "docs-link"));
  process.env.FILES_ROOT = OWNER;
  process.env.CLAWBOX_ROOT = path.join(ROOT, "clawbox");
  vi.resetModules();
  scope = await import("@/lib/files-scope");
});

afterAll(() => {
  delete process.env.FILES_ROOT;
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function memberFence() {
  const roots = scope.memberRoots(HOME, OWNER);
  if (!roots.ok) throw new Error(roots.code);
  return scope.fenceFor({ kind: "member", username: "ivan", roots: roots.roots });
}

describe("a member of staff's roots", () => {
  it("are their home and <owner home>/Shared, which is created when missing", () => {
    expect(fs.existsSync(path.join(OWNER, "Shared"))).toBe(false);
    const roots = scope.memberRoots(HOME, OWNER);
    expect(roots).toEqual({
      ok: true,
      roots: [
        { name: "Home", real: HOME },
        { name: "Shared", real: path.join(OWNER, "Shared") },
      ],
    });
    expect(fs.statSync(path.join(OWNER, "Shared")).isDirectory()).toBe(true);
  });

  it("refuse a home that holds or sits inside the owner's home", () => {
    expect(scope.memberRoots(ROOT, OWNER)).toEqual({ ok: false, code: "home_unavailable" });
    expect(scope.memberRoots(path.join(OWNER, "secret-project"), OWNER)).toEqual({ ok: false, code: "home_unavailable" });
    expect(scope.memberRoots(OWNER, OWNER)).toEqual({ ok: false, code: "home_unavailable" });
    expect(scope.memberRoots("/", OWNER)).toEqual({ ok: false, code: "home_unavailable" });
    expect(scope.memberRoots(path.join(ROOT, "nobody"), OWNER)).toEqual({ ok: false, code: "home_unavailable" });
  });

  it("refuse a Shared that is a link out of the owner's home", () => {
    const owner2 = path.join(ROOT, "owner2");
    fs.mkdirSync(owner2, { recursive: true });
    fs.symlinkSync(path.join(OTHER, "private"), path.join(owner2, "Shared"));
    expect(scope.memberRoots(HOME, owner2)).toEqual({ ok: false, code: "shared_unavailable" });
  });
});

describe("the member's fence", () => {
  it("lists the two roots at its virtual top folder, and nothing can be resolved there", () => {
    const fence = memberFence();
    for (const top of ["", "/", ".", "//"]) {
      expect(fence.isVirtualRoot(top)).toBe(true);
      expect(fence.resolve(top)).toBeNull();
    }
    expect(fence.rootEntries().map((e) => e.name)).toEqual(["Home", "Shared"]);
  });

  it("resolves paths under Home and Shared to their own folders", () => {
    const fence = memberFence();
    expect(fence.resolve("Home")).toBe(HOME);
    expect(fence.resolve("Home/Documents/notes.txt")).toBe(path.join(HOME, "Documents", "notes.txt"));
    expect(fence.resolve("Shared")).toBe(path.join(OWNER, "Shared"));
    expect(fence.resolve("Shared/new.txt")).toBe(path.join(OWNER, "Shared", "new.txt"));
    // A link that stays inside their home is fine.
    expect(fence.resolve("Home/docs-link/notes.txt")).toBe(path.join(HOME, "docs-link", "notes.txt"));
    expect(fence.relOf(path.join(HOME, "Documents", "notes.txt"))).toBe("Home/Documents/notes.txt");
    expect(fence.relOf(path.join(OWNER, "Shared"))).toBe("Shared");
  });

  it("refuses traversal, absolute paths and names that are not one of its roots", () => {
    const fence = memberFence();
    for (const rel of [
      "..", "../owner", "Home/..", "Home/../..", "Home/../../owner/secret-project/plan.txt",
      "Shared/../secret-project", "Shared/../../staff/maria/private", "secret-project", "Documents",
      OWNER, `${OWNER}/secret-project`, HOME, `${HOME}/Documents`, "/etc/passwd", "\\etc", "home", "SHARED",
      `Home/${String.fromCharCode(0)}x`, "Home\\..", "Home\\..\\..\\owner",
    ]) {
      expect(fence.resolve(rel), rel).toBeNull();
    }
  });

  it("refuses every symlink that leads out of its root, wherever it points", () => {
    const fence = memberFence();
    expect(fence.resolve("Home/owner-link")).toBeNull();
    expect(fence.resolve("Home/owner-link/plan.txt")).toBeNull();
    expect(fence.resolve("Home/maria-diary")).toBeNull();
    expect(fence.resolve("Home/etc-link/passwd")).toBeNull();
    expect(fence.allows(path.join(HOME, "owner-link"))).toBe(false);
    expect(fence.allows(path.join(HOME, "etc-link"))).toBe(false);
    expect(fence.allows(path.join(HOME, "docs-link"))).toBe(true);
    // A path that does not exist yet, under an escaping link, lands outside too.
    expect(fence.resolve("Home/owner-link/new-dir/x.txt")).toBeNull();
  });

  it("keeps secret stores out even in the member's own home", () => {
    const fence = memberFence();
    expect(fence.resolve("Home/.ssh")).toBeNull();
    expect(fence.resolve("Home/.ssh/id_ed25519")).toBeNull();
    expect(fence.allows(path.join(HOME, ".ssh"))).toBe(false);
  });

  it("names its roots, which are never renamed, moved or deleted", () => {
    const fence = memberFence();
    expect(fence.isRoot(HOME)).toBe(true);
    expect(fence.isRoot(path.join(OWNER, "Shared"))).toBe(true);
    expect(fence.isRoot(path.join(HOME, "Documents"))).toBe(false);
    expect(fence.key).toBe("member:ivan");
  });
});

describe("a member's open is judged by the file actually opened", () => {
  it("refuses to read or write through a link that leads out, and leaves nothing behind outside", () => {
    const fence = memberFence();
    // A path the fence would have taken lexically, made a link after the check.
    const swapped = path.join(HOME, "Documents", "swapped.txt");
    fs.symlinkSync(path.join(OWNER, "secret-project", "plan.txt"), swapped);
    expect(scope.openInMemberView(fence, swapped, "read")).toBeNull();
    expect(scope.openInMemberView(fence, swapped, "write")).toBeNull();
    expect(fs.readFileSync(path.join(OWNER, "secret-project", "plan.txt"), "utf-8")).toBe("owner's");
    // A parent folder swapped for a link: a NEW file would be created outside — and is removed again.
    const dirLink = path.join(HOME, "swapped-dir");
    fs.symlinkSync(path.join(OWNER, "secret-project"), dirLink);
    expect(scope.openInMemberView(fence, path.join(dirLink, "new.txt"), "write")).toBeNull();
    expect(fs.existsSync(path.join(OWNER, "secret-project", "new.txt"))).toBe(false);
  });

  it("never waits on a FIFO left in a home, and serves only regular files", () => {
    const fence = memberFence();
    const fifo = path.join(HOME, "Documents", "pipe");
    execFileSync("mkfifo", [fifo]);
    expect(scope.openInMemberView(fence, fifo, "read")).toBeNull();
    expect(() => scope.openInMemberView(fence, fifo, "write")).toThrow(); // ENXIO: no reader, no wait
  });

  it("opens a file inside the view, and a write truncates only after the check", () => {
    const fence = memberFence();
    const file = path.join(HOME, "Documents", "notes.txt");
    const opened = scope.openInMemberView(fence, file, "write");
    expect(opened?.real).toBe(file);
    fs.writeSync(opened!.fd, "new");
    fs.closeSync(opened!.fd);
    expect(fs.readFileSync(file, "utf-8")).toBe("new");
    const read = scope.openInMemberView(fence, file, "read");
    expect(read).not.toBeNull();
    fs.closeSync(read!.fd);
    scope.unlinkInMemberView(fence, path.join(OWNER, "secret-project", "plan.txt"));
    expect(fs.existsSync(path.join(OWNER, "secret-project", "plan.txt"))).toBe(true);
  });
});

describe("the owner's fence", () => {
  it("is the browse root exactly as before: no virtual top folder, absolute paths under it accepted", () => {
    const fence = scope.fenceFor(scope.ownerScope(OWNER));
    expect(fence.isVirtualRoot("")).toBe(false);
    expect(fence.resolve("")).toBe(OWNER);
    expect(fence.resolve("secret-project/plan.txt")).toBe(path.join(OWNER, "secret-project", "plan.txt"));
    expect(fence.resolve(`${OWNER}/secret-project`)).toBe(path.join(OWNER, "secret-project"));
    expect(fence.resolve("..")).toBeNull();
    expect(fence.resolve("Shared")).toBe(path.join(OWNER, "Shared"));
    expect(fence.rootEntries()).toEqual([]);
    expect(fence.key).toBe("owner");
  });
});
