// The audit log (one JSON line per action, mode 600, rotated to audit.jsonl.1
// past 5 MiB, the card redactor over every field) and the agent token file.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/server/audit";
import { Auth } from "../src/server/auth";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vault-audit-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("AuditLog", () => {
  test("appends one line per record, mode 600, newest first in recent()", () => {
    const dir = tempDir();
    const log = new AuditLog(dir);
    log.record({ actor: "agent", action: "list" });
    log.record({ actor: "owner", action: "save", name: "shop.example.com/me" });
    const file = join(dir, "audit.jsonl");
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(log.recent().map((r) => r.action)).toEqual(["save", "list"]);
  });

  test("tightens a log someone left readable", () => {
    const dir = tempDir();
    const file = join(dir, "audit.jsonl");
    writeFileSync(file, "");
    chmodSync(file, 0o644);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    new AuditLog(dir).record({ actor: "agent", action: "list" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("rotates a log over 5 MiB into audit.jsonl.1 and starts a fresh one", () => {
    const dir = tempDir();
    const file = join(dir, "audit.jsonl");
    const old = `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", actor: "agent", action: "old" })}\n`.repeat(90_000);
    expect(old.length).toBeGreaterThan(5 * 1024 * 1024);
    writeFileSync(file, old, { mode: 0o600 });
    writeFileSync(`${file}.1`, "an older rotation\n", { mode: 0o644 });

    const log = new AuditLog(dir);
    log.record({ actor: "agent", action: "new" });

    expect(readFileSync(`${file}.1`, "utf8")).toBe(old);
    expect(statSync(`${file}.1`).mode & 0o777).toBe(0o600);
    const fresh = readFileSync(file, "utf8").trim().split("\n");
    expect(fresh).toHaveLength(1);
    expect(JSON.parse(fresh[0]).action).toBe("new");
    expect(log.recent().map((r) => r.action)).toEqual(["new"]);
  });

  test("redacts a card number in every field it keeps", () => {
    const dir = tempDir();
    const pan = "4111 1111 1111 1111";
    new AuditLog(dir).record({ actor: "agent", action: `fill ${pan}`, name: `shop/${pan}`, host: `${pan}.example.com`, status: `ok ${pan}`, detail: `card ${pan}` });
    const line = readFileSync(join(dir, "audit.jsonl"), "utf8");
    expect(line).not.toContain(pan);
    expect(line).not.toContain("4111111111111111");
    expect(Object.keys(JSON.parse(line))).toEqual(["ts", "actor", "action", "name", "host", "status", "detail"]);
  });
});

describe("Auth's agent token", () => {
  test("is made mode 600 on first start, and checkMcp accepts it", () => {
    const dir = tempDir();
    const auth = new Auth(dir);
    const file = join(dir, "agent-token");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(auth.checkMcp(readFileSync(file, "utf8").trim())).toBe(true);
  });

  for (const mode of [0o644, 0o000, 0o200]) {
    test(`a token file left at mode ${mode.toString(8).padStart(3, "0")} is kept and made 600`, () => {
      const dir = tempDir();
      const token = "a".repeat(43);
      const file = join(dir, "agent-token");
      writeFileSync(file, `${token}\n`);
      chmodSync(file, mode);
      expect(statSync(file).mode & 0o777).toBe(mode);
      const auth = new Auth(dir);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(auth.checkMcp(token)).toBe(true);
    });
  }
});
