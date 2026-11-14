// The audit log: one JSON line per action, mode 600, rotated to audit.jsonl.1
// once it passes 5 MiB, with the card redactor over every field.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/server/audit";

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
    writeFileSync(file, "", { mode: 0o644 });
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

  test("redacts a card number in any field", () => {
    const dir = tempDir();
    new AuditLog(dir).record({ actor: "agent", action: "fill", detail: "card 4111 1111 1111 1111" });
    expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).not.toContain("4111 1111 1111 1111");
  });
});
