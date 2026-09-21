// The queue of outgoing mail waiting for the owner.
//
// Run against the real filesystem in a temp CLAWBOX_ROOT rather than a mocked
// fs: the store's whole job is "survive being written to, read back, and
// crashed on", and a mocked fs would prove none of that. It is also how the
// 0600 permission and the atomic rename get exercised at all.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Store = typeof import("@/lib/email-pending");

let store: Store;
let root: string;
let pendingPath: string;

const DRAFT = { to: ["owner@example.com"], subject: "Hello", body: "The message body." };

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-pending-"));
  process.env.CLAWBOX_ROOT = root;
  pendingPath = path.join(root, "data", "email-pending.json");
  // CONFIG_ROOT is read at module load, so the env has to be set before the
  // import and the registry reset between tests.
  vi.resetModules();
  store = await import("@/lib/email-pending");
});

afterEach(() => {
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("queue", () => {
  it("stores a draft and reports it", () => {
    const result = store.queuePending(DRAFT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pending = store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: result.draft.id, subject: "Hello", to: ["owner@example.com"] });
    expect(store.countPending()).toBe(1);
  });

  // What this used to assert was that queueing DRAFT twice produced two ids —
  // which is exactly the duplicate an owner met on a real box, because a
  // timed-out `email_send` was retried and the queue had no way to tell the
  // retry from a second message. Two different messages still get two ids;
  // the same message twice is one draft, and email-queue-dedupe.test.ts owns
  // that rule.
  it("gives every distinct draft its own id", () => {
    const a = store.queuePending(DRAFT);
    const b = store.queuePending({ ...DRAFT, subject: "A different message" });
    expect(a.ok && b.ok && a.draft.id !== b.draft.id).toBe(true);
  });

  it("shortens the body into a preview but keeps the whole thing", () => {
    const body = "x".repeat(500);
    store.queuePending({ ...DRAFT, body });
    const [draft] = store.listPending();
    expect(draft.preview.length).toBe(store.PREVIEW_CHARS);
    expect(draft.body.length).toBe(500);
  });

  it("shows the newest first", async () => {
    store.queuePending({ ...DRAFT, subject: "older" });
    await new Promise((r) => setTimeout(r, 5));
    store.queuePending({ ...DRAFT, subject: "newer" });
    expect(store.listPending().map((d) => d.subject)).toEqual(["newer", "older"]);
  });

  it("rejects a draft with no recipient, subject or body", () => {
    expect(store.queuePending({ ...DRAFT, to: [] }).ok).toBe(false);
    expect(store.queuePending({ ...DRAFT, subject: "  " }).ok).toBe(false);
    expect(store.queuePending({ ...DRAFT, body: "" }).ok).toBe(false);
  });

  it("refuses once the queue is full, rather than dropping the oldest", () => {
    // Evicting would hand an injected agent a way to push a real draft out of
    // the owner's view by queueing more. The queue must never be a place things
    // quietly disappear from.
    for (let i = 0; i < store.MAX_PENDING; i++) {
      expect(store.queuePending({ ...DRAFT, subject: `draft ${i}` }).ok).toBe(true);
    }
    const overflow = store.queuePending({ ...DRAFT, subject: "one too many" });
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.reason).toBe("full");
    expect(overflow.error).toMatch(/Settings/);

    const subjects = store.listPending().map((d) => d.subject);
    expect(subjects).toHaveLength(store.MAX_PENDING);
    expect(subjects).toContain("draft 0");
    expect(subjects).not.toContain("one too many");
  });
});

describe("what may reach the file", () => {
  // Every case here is the same question: the queue file is written from data
  // that arrived over HTTP, so what lands in it has to be text this module has
  // agreed to store rather than whatever the request happened to carry.

  it("refuses a subject with a control character in it", () => {
    const result = store.queuePending({ ...DRAFT, subject: "Invoice\u001b[2K attached" });
    expect(result.ok).toBe(false);
    expect(store.listPending()).toEqual([]);
    expect(fs.existsSync(pendingPath)).toBe(false);
  });

  it("refuses a subject with a line break in it, which is a header injection", () => {
    const result = store.queuePending({ ...DRAFT, subject: "Hello\r\nBcc: someone@example.com" });
    expect(result.ok).toBe(false);
    expect(store.listPending()).toEqual([]);
  });

  it("refuses a body with a NUL or an escape sequence in it", () => {
    expect(store.queuePending({ ...DRAFT, body: "before\u0000after" }).ok).toBe(false);
    expect(store.queuePending({ ...DRAFT, body: "\u001b[31mred" }).ok).toBe(false);
    expect(store.listPending()).toEqual([]);
  });

  it("refuses a bidi override, which makes the approval read differently from the send", () => {
    expect(store.queuePending({ ...DRAFT, subject: "invoice\u202e fdp.exe" }).ok).toBe(false);
  });

  it("refuses a recipient that is not an address", () => {
    const result = store.queuePending({ ...DRAFT, to: ["owner@example.com", "not an address"] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("invalid");
    expect(store.listPending()).toEqual([]);
  });

  it("refuses a recipient with a NUL in it, which SMTP would read as a command", () => {
    expect(store.queuePending({ ...DRAFT, to: ["own\u0000er@example.com"] }).ok).toBe(false);
  });

  it("still takes text in any language, with emoji and paragraphs", () => {
    const subject = "Здравей 👋 — среща утре";
    const body = "Ред едно\n\nРед две\tс табулация 🎉";
    const result = store.queuePending({ ...DRAFT, subject, body });
    expect(result.ok).toBe(true);
    const [draft] = store.listPending();
    expect(draft.subject).toBe(subject);
    expect(draft.body).toBe(body);
  });

  it("writes nothing but the characters it agreed to store", () => {
    store.queuePending({ ...DRAFT, subject: "Plain subject", body: "Line one\nLine two" });
    const raw = fs.readFileSync(pendingPath, "utf-8");
    // No C0 control byte other than the newlines JSON.stringify adds itself.
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw)).toBe(false);
  });
});

describe("approve and reject", () => {
  it("claims a draft exactly once", () => {
    // Read-and-remove in one step is what stops a double click sending twice.
    const queued = store.queuePending(DRAFT);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;

    const first = store.claimPending(queued.draft.id);
    expect(first?.subject).toBe("Hello");
    expect(first?.body).toBe("The message body.");

    const second = store.claimPending(queued.draft.id);
    expect(second).toBeNull();
    expect(store.countPending()).toBe(0);
  });

  it("deletes a rejected draft and says whether there was one", () => {
    const queued = store.queuePending(DRAFT);
    if (!queued.ok) return;
    expect(store.removePending(queued.draft.id)).toBe(true);
    expect(store.removePending(queued.draft.id)).toBe(false);
    expect(store.listPending()).toHaveLength(0);
  });

  it("leaves the other drafts alone", () => {
    const a = store.queuePending({ ...DRAFT, subject: "keep me" });
    const b = store.queuePending({ ...DRAFT, subject: "delete me" });
    if (!a.ok || !b.ok) return;
    store.removePending(b.draft.id);
    expect(store.listPending().map((d) => d.subject)).toEqual(["keep me"]);
  });

  it("clears everything when the account is disconnected", () => {
    store.queuePending(DRAFT);
    store.queuePending(DRAFT);
    store.clearPending();
    expect(store.listPending()).toHaveLength(0);
    expect(store.countPending()).toBe(0);
  });
});

describe("the file on disk", () => {
  it("is written 0600, because it holds mail the owner has not seen", () => {
    store.queuePending(DRAFT);
    const mode = fs.statSync(pendingPath).mode & 0o777;
    // Windows does not model POSIX permission bits; the device is Linux.
    if (process.platform !== "win32") expect(mode).toBe(0o600);
    expect(fs.existsSync(pendingPath)).toBe(true);
  });

  it("leaves no temp file behind", () => {
    store.queuePending(DRAFT);
    expect(fs.existsSync(`${pendingPath}.tmp`)).toBe(false);
  });

  it("treats a corrupt queue as an empty one instead of breaking email", () => {
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
    fs.writeFileSync(pendingPath, "{ this is not json");
    expect(store.listPending()).toEqual([]);
    // ...and the next queue repairs it.
    expect(store.queuePending(DRAFT).ok).toBe(true);
    expect(store.listPending()).toHaveLength(1);
  });

  it("ignores entries that are not drafts", () => {
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
    fs.writeFileSync(pendingPath, JSON.stringify([{ id: 1 }, "nope", null]));
    expect(store.listPending()).toEqual([]);
  });

  it("survives a restart", async () => {
    store.queuePending({ ...DRAFT, subject: "still here" });
    vi.resetModules();
    const reloaded = await import("@/lib/email-pending");
    expect(reloaded.listPending().map((d) => d.subject)).toEqual(["still here"]);
  });
});
