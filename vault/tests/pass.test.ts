// pass adapter round trip against a TEMPORARY GNUPGHOME and a TEMPORARY store.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../src/server/catalog";
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
});
