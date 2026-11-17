import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-2446 — the audit log: one append-only JSON line per sign-in or
 * administrator action under the data directory, 0600, bounded by rotation to
 * one older generation, read back newest first. Never holds a control
 * character, an unknown event or an oversized field; writing it never throws.
 */

const ROOT = path.join(fs.realpathSync(os.tmpdir()), `clawbox-audit-${process.pid}-${Date.now()}`);
type Mod = typeof import("@/lib/audit-log");
let audit: Mod;

const req = (headers: Record<string, string> = {}) => new Request("http://localhost/x", { headers });

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = ROOT;
  vi.resetModules();
  audit = await import("@/lib/audit-log");
});

beforeEach(() => {
  fs.rmSync(path.join(ROOT, "data"), { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const lines = () => fs.readFileSync(audit.auditLogPath(), "utf-8").trim().split("\n").map((l) => JSON.parse(l));

describe("writing", () => {
  it("appends one JSON line per entry under the data directory, readable by the box account only", async () => {
    await audit.recordAudit({ event: "login", actor: "owner", detail: { remote: false } }, req({ "x-clawbox-peer": "192.0.2.10" }));
    await audit.recordAudit({ event: "user_create", actor: "owner", target: "ivan" });
    expect(audit.auditLogPath()).toBe(path.join(ROOT, "data", "audit-log.jsonl"));
    const [first, second] = lines();
    expect(first).toMatchObject({ event: "login", actor: "owner", ip: "192.0.2.10", detail: { remote: false } });
    expect(typeof first.ts).toBe("string");
    expect(second).toMatchObject({ event: "user_create", actor: "owner", target: "ivan" });
    expect(second.ip).toBeUndefined();
    expect(fs.statSync(audit.auditLogPath()).mode & 0o777).toBe(0o600);
  });

  it("keeps what an earlier line said: it only ever appends", async () => {
    await audit.recordAudit({ event: "login", actor: "owner" });
    const before = fs.readFileSync(audit.auditLogPath(), "utf-8");
    await audit.recordAudit({ event: "logout", actor: "owner" });
    expect(fs.readFileSync(audit.auditLogPath(), "utf-8").startsWith(before)).toBe(true);
  });

  it("takes the tunnel's address, else the socket peer the guard wrote — never a client's forwarded-for", async () => {
    expect(audit.auditAddress(req({ "cf-connecting-ip": "198.51.100.7", "x-clawbox-peer": "127.0.0.1" }))).toBe("198.51.100.7");
    expect(audit.auditAddress(req({ "x-clawbox-peer": "::ffff:192.0.2.1" }))).toBe("192.0.2.1");
    // A LAN client sets X-Forwarded-For to whatever it likes: it is not an address the box knows.
    expect(audit.auditAddress(req({ "x-forwarded-for": "203.0.113.66", "x-clawbox-peer": "192.0.2.5" }))).toBe("192.0.2.5");
    expect(audit.auditAddress(req({ "x-forwarded-for": "203.0.113.66" }))).toBeUndefined();
    expect(audit.auditAddress(req({ "x-clawbox-peer": "<script>" }))).toBeUndefined();
    expect(audit.auditAddress(req())).toBeUndefined();
  });

  it("records no address under next dev, which runs without the guard that writes them", async () => {
    const env = process.env as Record<string, string | undefined>;
    const before = env.NODE_ENV;
    env.NODE_ENV = "development";
    try {
      expect(audit.auditAddress(req({ "cf-connecting-ip": "198.51.100.7", "x-clawbox-peer": "192.0.2.5" }))).toBeUndefined();
    } finally {
      env.NODE_ENV = before;
    }
  });

  it("strips control characters, bounds every field and drops what is not a plain value", async () => {
    await audit.recordAudit({
      event: "user_remove",
      actor: "owner\nINJECTED",
      target: "x".repeat(500),
      detail: { note: "a\u0000b", nested: { a: 1 } as unknown as string, n: 3, gone: undefined as unknown as string },
    });
    const [line] = lines();
    expect(line.actor).toBe("owner INJECTED");
    expect(line.target.length).toBeLessThanOrEqual(64);
    expect(line.detail).toEqual({ note: "a b", n: 3 });
    expect(fs.readFileSync(audit.auditLogPath(), "utf-8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("writes nothing for an event it does not know", async () => {
    await audit.recordAudit({ event: "made_up" as never, actor: "owner" });
    expect(fs.existsSync(audit.auditLogPath())).toBe(false);
  });

  it("never throws when the log cannot be written", async () => {
    fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
    fs.mkdirSync(audit.auditLogPath());
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(audit.recordAudit({ event: "login", actor: "owner" })).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("rotates past its size bound into one older generation", async () => {
    fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
    const old = `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", event: "login", actor: "owner" })}\n`;
    fs.writeFileSync(audit.auditLogPath(), old.repeat(Math.ceil(audit.AUDIT_LOG_MAX_BYTES / old.length)));
    await audit.recordAudit({ event: "logout", actor: "owner" });
    expect(fs.existsSync(`${audit.auditLogPath()}.1`)).toBe(true);
    expect(lines()).toHaveLength(1);
    expect(lines()[0].event).toBe("logout");
  });
});

describe("reading", () => {
  it("answers newest first, up to the limit, saying whether there is more", async () => {
    for (const event of ["login", "user_create", "org_mode", "logout"] as const) await audit.recordAudit({ event, actor: "owner" });
    const all = await audit.readAuditLog({ limit: 10 });
    expect(all.entries.map((e) => e.event)).toEqual(["logout", "org_mode", "user_create", "login"]);
    expect(all.more).toBe(false);
    const two = await audit.readAuditLog({ limit: 2 });
    expect(two.entries.map((e) => e.event)).toEqual(["logout", "org_mode"]);
    expect(two.more).toBe(true);
  });

  it("reaches into the older generation when the current one is short", async () => {
    fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
    fs.writeFileSync(`${audit.auditLogPath()}.1`, `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", event: "login", actor: "maria" })}\n`);
    await audit.recordAudit({ event: "logout", actor: "owner" });
    const { entries } = await audit.readAuditLog();
    expect(entries.map((e) => `${e.event}:${e.actor}`)).toEqual(["logout:owner", "login:maria"]);
  });

  it("skips a damaged line instead of failing the whole read", async () => {
    fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
    fs.writeFileSync(audit.auditLogPath(), `not json\n${JSON.stringify({ ts: "x", event: "nope", actor: null })}\n`);
    await audit.recordAudit({ event: "login", actor: null });
    const { entries } = await audit.readAuditLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: "login", actor: null });
  });

  it("answers an empty log for a box that has recorded nothing", async () => {
    expect(await audit.readAuditLog()).toEqual({ entries: [], more: false });
  });

  it("fails, rather than answering empty, for a log that is there but cannot be read", async () => {
    fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
    // A folder where the file should be: open() fails with EISDIR, not ENOENT.
    fs.mkdirSync(audit.auditLogPath());
    await expect(audit.readAuditLog()).rejects.toThrow();
  });
});

describe("a factory reset", () => {
  it("clears the log and its older generation after every line queued before it", async () => {
    fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
    fs.writeFileSync(`${audit.auditLogPath()}.1`, "old\n");
    // Queued first, then the clear: the queued line is written and then removed with the rest.
    const queued = audit.recordAudit({ event: "login", actor: "previous-owner" });
    const cleared = audit.clearAuditLogForReset();
    await Promise.all([queued, cleared]);
    expect(fs.existsSync(audit.auditLogPath())).toBe(false);
    expect(fs.existsSync(`${audit.auditLogPath()}.1`)).toBe(false);
    await audit.recordAudit({ event: "factory_reset", actor: "owner" });
    expect(lines().map((l) => l.event)).toEqual(["factory_reset"]);
  });
});
