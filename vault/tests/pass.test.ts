// pass adapter round trip against a TEMPORARY GNUPGHOME and a TEMPORARY store.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { CardCatalog } from "../src/server/cards";
import { Catalog, StrandedRenameError } from "../src/server/catalog";
import { PassError, PassStore } from "../src/server/pass";
import { createTempStore, gitLog, PASS_BIN, passShow, passShowExitCode, type TempStore } from "./helpers/tempstore";

const PASSWORD = "Qz8!pass-adapter-Test";
let store: TempStore;
let pass: PassStore;
let catalog: Catalog;
const logs: string[] = [];

beforeAll(() => {
  store = createTempStore();
  pass = new PassStore({ bin: PASS_BIN, storeDir: store.storeDir, env: store.env, log: (l) => logs.push(l) });
  catalog = new Catalog(pass);
}, 60_000);

afterAll(() => store?.cleanup());

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? allFiles(p) : [p];
  });
}

describe("pass adapter", () => {
  test("never points at the real store", () => {
    expect(store.storeDir.startsWith(join(homedir(), ".password-store"))).toBe(false);
    expect(pass.storeDir).toBe(store.storeDir);
  });

  test("insert -m -f round trip keeps the exact multi-line format", async () => {
    const content = `${PASSWORD}\nlogin: ops@example.com\nurl: https://billing.example.com/login\n2fa: otpauth://totp/test?secret=JBSWY3DPEHPK3PXP\nnote: test entry\ncustomer: 42\n`;
    await pass.insert("billing.example.com/ops", content);
    expect(await pass.show("billing.example.com/ops")).toBe(content);
    // Same text through the pass CLI itself.
    expect(passShow(store, "billing.example.com/ops")).toBe(content);
    expect(await pass.list()).toEqual(["billing.example.com/ops"]);
  });

  test("every write is a pass git commit", async () => {
    await pass.insert("example.com/alice", "pw-one\nlogin: alice\n");
    await pass.insert("example.com/alice", "pw-two\nlogin: alice\n");
    await pass.move("example.com/alice", "example.com/alice2");
    await pass.remove("example.com/alice2");
    const log = gitLog(store);
    expect(log).toContain("Add given password for example.com/alice to store.");
    expect(log).toContain("Remove example.com/alice2 from store.");
    expect(log.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(6);
    expect(passShowExitCode(store, "example.com/alice2")).not.toBe(0);
  });

  test("the store holds only ciphertext; the password is not in any file or commit", async () => {
    const needle = Buffer.from(PASSWORD);
    for (const file of allFiles(store.storeDir)) {
      if (statSync(file).size === 0) continue;
      expect(readFileSync(file).includes(needle)).toBe(false);
    }
    const grep = Bun.spawnSync(["grep", "-rF", PASSWORD, store.storeDir], { stdout: "pipe", stderr: "pipe" });
    expect(grep.exitCode).toBe(1);
    expect(gitLog(store)).not.toContain(PASSWORD);
  });

  test("errors are typed and carry no secrets", async () => {
    await expect(pass.show("missing/entry")).rejects.toMatchObject({ code: "not_found" });
    await expect(pass.insert("../escape", "x")).rejects.toThrow();
    await expect(pass.insert("-rf", "x")).rejects.toThrow();
    expect(logs.join("\n")).not.toContain(PASSWORD);
  });
});

describe("catalog on the temp store", () => {
  test("lists metadata only, searches and matches", async () => {
    await catalog.save({ name: "github.com/alice", login: "alice", url: "", password: "gh-pass-1" });
    const list = await catalog.list();
    expect(list.map((e) => e.name)).toEqual(["billing.example.com/ops", "github.com/alice"]);
    expect(JSON.stringify(list)).not.toContain(PASSWORD);
    expect(JSON.stringify(list)).not.toContain("JBSWY3DPEHPK3PXP");
    expect(Object.keys(list[0]!).sort()).toEqual(["login", "name", "updated", "url"]);
    expect((await catalog.list({ query: "OPS@" })).map((e) => e.name)).toEqual(["billing.example.com/ops"]);
    expect((await catalog.list({ prefix: "github.com" })).map((e) => e.name)).toEqual(["github.com/alice"]);
    expect((await catalog.match("https://github.com/login")).map((e) => e.name)).toEqual(["github.com/alice"]);
  });

  test("updates merge into the entry and keep unknown lines and 2fa", async () => {
    await catalog.save({ name: "billing.example.com/ops", note: "rotated quarterly" });
    const e = await catalog.read("billing.example.com/ops");
    expect(e.password).toBe(PASSWORD);
    expect(e.note).toBe("rotated quarterly");
    expect(e.twofa).toBe("otpauth://totp/test?secret=JBSWY3DPEHPK3PXP");
    expect(e.extra).toEqual(["customer: 42"]);
  });

  test("new entries need a password; mustBeNew refuses overwrites; rename uses pass mv", async () => {
    await expect(catalog.save({ name: "new.example.com/x", login: "x" })).rejects.toThrow("password is required");
    await expect(catalog.save({ name: "github.com/alice", password: "z" }, { mustBeNew: true })).rejects.toThrow("already exists");
    await catalog.save({ name: "github.com/alice-renamed" }, { renameFrom: "github.com/alice" });
    expect(await catalog.exists("github.com/alice")).toBe(false);
    expect((await catalog.read("github.com/alice-renamed")).password).toBe("gh-pass-1");
    await catalog.remove("github.com/alice-renamed");
    await expect(catalog.remove("github.com/alice-renamed")).rejects.toBeInstanceOf(PassError);
  });

  test("a rename whose update fails leaves the entry, and a card, under the old name", async () => {
    // The real store, except that every save is refused after the move.
    const refusing = Object.create(pass) as PassStore;
    refusing.insert = async () => {
      throw new PassError("pass insert failed (exit 2)", "failed");
    };
    await catalog.save({ name: "rename.example.com/ops", login: "ops", password: "Rename-Secret-1" });
    const failing = new Catalog(refusing);
    await expect(failing.save({ name: "rename.example.com/ops2", login: "ops2" }, { renameFrom: "rename.example.com/ops" })).rejects.toMatchObject({ code: "failed" });
    expect(await pass.exists("rename.example.com/ops")).toBe(true);
    expect(await pass.exists("rename.example.com/ops2")).toBe(false);
    expect((await catalog.read("rename.example.com/ops")).login).toBe("ops");
    await catalog.remove("rename.example.com/ops");

    const cards = new CardCatalog(pass, catalog);
    const saved = await cards.save({ number: "4242424242424242", exp: "12/34", label: "Old label" });
    const failingCards = new CardCatalog(refusing, catalog);
    await expect(failingCards.save({ label: "New label" }, { name: saved.name })).rejects.toMatchObject({ code: "failed" });
    expect(await pass.exists(saved.name)).toBe(true);
    expect((await pass.list({ under: saved.name.split("/")[0] })).filter((n) => /new/i.test(n))).toEqual([]);
    await cards.remove(saved.name);
  });

  test("when the move back fails too, the save says where the entry is now, unchanged", async () => {
    // Every insert is refused, and only the first move (the rename) succeeds.
    const stuck = Object.create(pass) as PassStore;
    stuck.insert = async () => {
      throw new PassError("pass insert failed (exit 2)", "failed");
    };
    let moves = 0;
    stuck.move = async (from: string, to: string) => {
      if (moves++ > 0) throw new PassError("pass mv failed (exit 1)", "failed");
      return pass.move(from, to);
    };
    await catalog.save({ name: "stuck.example.com/ops", login: "ops", password: "Stuck-Secret-1" });
    const err = await new Catalog(stuck).save({ name: "stuck.example.com/ops2", login: "ops2" }, { renameFrom: "stuck.example.com/ops" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StrandedRenameError);
    expect(err).toMatchObject({ from: "stuck.example.com/ops", to: "stuck.example.com/ops2" });
    expect(String((err as Error).message)).not.toContain("Stuck-Secret-1");
    // Recoverable: under the new name, with the old content.
    expect(await pass.exists("stuck.example.com/ops")).toBe(false);
    expect((await catalog.read("stuck.example.com/ops2")).login).toBe("ops");
    await catalog.remove("stuck.example.com/ops2");

    moves = 0;
    const cards = new CardCatalog(pass, catalog);
    const saved = await cards.save({ number: "4242424242424242", exp: "12/34", label: "Stuck card" });
    const cardErr = await new CardCatalog(stuck, catalog).save({ label: "Moved card" }, { name: saved.name }).catch((e: unknown) => e);
    expect(cardErr).toBeInstanceOf(StrandedRenameError);
    const to = (cardErr as StrandedRenameError).to;
    expect(await pass.exists(to)).toBe(true);
    expect(await pass.exists(saved.name)).toBe(false);
    await cards.remove(to);
  });
});

describe("atomic saves", () => {
  const tempFiles = () => allFiles(store.storeDir).filter((f) => /\.(tmp|old)$/.test(f));
  const fpr = () => readFileSync(join(store.storeDir, ".gpg-id"), "utf8").trim();

  test("an overwrite replaces the entry file instead of rewriting it in place", async () => {
    await pass.insert("atomic.example.com/ops", "v0\n");
    const before = statSync(pass.fileFor("atomic.example.com/ops"));
    await pass.insert("atomic.example.com/ops", "v1\n");
    const after = statSync(pass.fileFor("atomic.example.com/ops"));
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    expect(passShow(store, "atomic.example.com/ops")).toBe("v1\n");
    expect(tempFiles()).toEqual([]);
  });

  test("readers beside a writer always decrypt a whole entry", async () => {
    const versions = Array.from({ length: 8 }, (_, i) => `version-${i}\nlogin: ops\n`);
    await pass.insert("atomic.example.com/race", "version-0\nlogin: ops\n");
    const seen: string[] = [];
    for (const v of versions.slice(1)) {
      const reads = Array.from({ length: 3 }, () => pass.show("atomic.example.com/race").then((t) => seen.push(t)));
      await Promise.all([pass.insert("atomic.example.com/race", v), ...reads]);
    }
    for (const t of seen) expect(versions).toContain(t);
    expect(await pass.show("atomic.example.com/race")).toBe("version-7\nlogin: ops\n");
  }, 60_000);

  test("a failed save keeps the previous entry, leaves no temp file and no commit", async () => {
    await pass.insert("atomic.example.com/keep", "kept\n");
    const commits = gitLog(store);
    const broken = new PassStore({
      bin: PASS_BIN,
      storeDir: store.storeDir,
      env: { ...store.env, PASSWORD_STORE_KEY: "nobody@example.invalid" },
      log: (l) => logs.push(l),
    });
    await expect(broken.insert("atomic.example.com/keep", "lost\n")).rejects.toMatchObject({ code: "failed" });
    expect(passShow(store, "atomic.example.com/keep")).toBe("kept\n");
    expect(tempFiles()).toEqual([]);
    expect(gitLog(store)).toBe(commits);
    expect(logs.join("\n")).not.toContain("lost");
  });

  test("a failed commit puts the previous entry back and leaves nothing staged", async () => {
    await pass.insert("atomic.example.com/hooked", "before\n");
    const commits = gitLog(store);
    const hook = join(store.storeDir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    try {
      await expect(pass.insert("atomic.example.com/hooked", "after\n")).rejects.toMatchObject({ code: "failed" });
      await expect(pass.insert("atomic.example.com/never", "new\n")).rejects.toMatchObject({ code: "failed" });
    } finally {
      rmSync(hook, { force: true });
    }
    expect(passShow(store, "atomic.example.com/hooked")).toBe("before\n");
    expect(await pass.exists("atomic.example.com/never")).toBe(false);
    expect(gitLog(store)).toBe(commits);
    const status = Bun.spawnSync(["git", "-C", store.storeDir, "status", "--porcelain"], { env: store.env, stdout: "pipe" });
    expect(status.stdout.toString().trim()).toBe("");
    expect(allFiles(store.storeDir).filter((f) => /\.(tmp|old)$/.test(f))).toEqual([]);
  });

  test("a store given as a relative path saves and commits", async () => {
    const rel = new PassStore({ bin: PASS_BIN, storeDir: relative(process.cwd(), store.storeDir), env: store.env });
    await rel.insert("atomic.example.com/relative", "rel\n");
    expect(passShow(store, "atomic.example.com/relative")).toBe("rel\n");
    expect(gitLog(store)).toContain("Add given password for atomic.example.com/relative to store.");
  });

  test("recipients come from the nearest .gpg-id, comments stripped, like pass", async () => {
    mkdirSync(join(store.storeDir, "team"), { recursive: true });
    writeFileSync(join(store.storeDir, "team", ".gpg-id"), "nobody@example.invalid\n");
    await expect(pass.insert("team/deep/entry", "x\n")).rejects.toMatchObject({ code: "failed" });
    expect(await pass.exists("team/deep/entry")).toBe(false);
    writeFileSync(join(store.storeDir, "team", ".gpg-id"), `# the ops key\n${fpr()}  # trailing note\n\n`);
    await pass.insert("team/deep/entry", "team secret\n");
    expect(passShow(store, "team/deep/entry")).toBe("team secret\n");
    expect(gitLog(store)).toContain("Add given password for team/deep/entry to store.");
  });

  test("PASSWORD_STORE_SIGNING_KEY refuses an unsigned .gpg-id, as pass does", async () => {
    const signed = new PassStore({
      bin: PASS_BIN,
      storeDir: store.storeDir,
      env: { ...store.env, PASSWORD_STORE_SIGNING_KEY: fpr() },
    });
    await expect(signed.insert("atomic.example.com/signed", "x\n")).rejects.toMatchObject({ code: "failed" });
    expect(await pass.exists("atomic.example.com/signed")).toBe(false);
  });
});
