// One request, one draft — however many times the tool call is repeated.
//
// THE BUG THIS PINS. The owner asked the agent, once, to send one email. The
// reply named two drafts with consecutive ids, and Settings → Email showed "2
// waiting" with two identical cards. `email_send` reaches the device over HTTP
// with a 60 s timeout, and mcp/lib/api.ts turns a timeout into a TIMEOUT
// ToolError whose advice is "Retry once" — so a route that had already written
// the draft to disk, and only answered late, was asked to write it again.
//
// That is the FALSE FAILURE class: an error reported over an operation that
// succeeded. The queue could not tell the second call from a genuine second
// message, because `queuePending` minted a fresh UUID every time it was called.
//
// So the queue is the place that has to know. A draft identical in recipients,
// subject and body, queued while an identical one is STILL WAITING and still
// inside a short window, is the same draft: the existing id comes back and
// nothing new lands on disk.
//
// Deliberately matched against WAITING drafts only. Folding into one that has
// already been approved would silently swallow a second message the owner
// really did ask for, and the queue is the wrong place to make that guess.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Store = typeof import("@/lib/email-pending");

let store: Store;
let root: string;

const DRAFT = { to: ["owner@example.com"], subject: "Hello", body: "The message body." };

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-dedupe-"));
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  store = await import("@/lib/email-pending");
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a repeated queue of the same message", () => {
  it("returns the draft already waiting instead of queueing a second one", () => {
    const first = store.queuePending(DRAFT);
    const second = store.queuePending(DRAFT);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.draft.id).toBe(first.draft.id);
    expect(second.deduped).toBe(true);
    expect(first.deduped).toBe(false);
    expect(store.countPending()).toBe(1);
  });

  it("normalises before it compares, so a retry that differs only in shape still folds", () => {
    // Every leg the key claims to normalise has to be IN the fixture, or the
    // case passes on the recipient comparison alone and the rest is untested.
    const first = store.queuePending({
      to: ["owner@example.com", "second@example.com"],
      subject: "Hello there",
      body: "First line.\nSecond line.",
    });
    const second = store.queuePending({
      // Recipient case, padding, and the other order — the same two people.
      to: ["  SECOND@Example.com ", "Owner@Example.COM"],
      // Whitespace re-flowed around and inside the subject.
      subject: "  Hello   there  ",
      // CRLF instead of LF, which renders and sends identically.
      body: "First line.\r\nSecond line.",
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.draft.id).toBe(first.draft.id);
    expect(store.countPending()).toBe(1);
  });

  it("keeps the shape of the message, not just its words", () => {
    // One paragraph and three are not the same message to the person reading
    // them, and the fold is silent: the second draft's id never comes back. The
    // key levels the whitespace a mail client would render identically and
    // nothing more.
    const first = store.queuePending({
      to: ["owner@example.com"],
      subject: "The plan",
      body: "First point. Second point. Third point.",
    });
    const second = store.queuePending({
      to: ["owner@example.com"],
      subject: "The plan",
      body: "First point.\n\nSecond point.\n\nThird point.",
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.draft.id).not.toBe(first.draft.id);
    expect(store.countPending()).toBe(2);
  });

  it("folds a retry that only re-indented its blank lines", () => {
    // The two bodies render identically in every mail client: a run of blank
    // lines is a run of blank lines whether or not the agent left a space on
    // each of them. The key levels those runs — but it used to level them
    // BEFORE trimming the spaces around each newline, so the padded rendering
    // still had spaces between its newlines when the collapse looked, kept all
    // three, and earned a second draft for a message already waiting.
    const first = store.queuePending({
      to: ["owner@example.com"],
      subject: "The plan",
      body: "First point.\n\n\nSecond point.",
    });
    const second = store.queuePending({
      to: ["owner@example.com"],
      subject: "The plan",
      body: "First point. \n \n \n Second point.",
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.draft.id).toBe(first.draft.id);
    expect(store.countPending()).toBe(1);
  });

  it("keeps a difference the reader would see", () => {
    // Case in the subject and the body is NOT normalised: "approve the invoice"
    // and "APPROVE THE INVOICE" are not obviously the same message to the
    // person whose name is on them, and this key decides whether one of them is
    // silently dropped.
    store.queuePending(DRAFT);
    store.queuePending({ ...DRAFT, subject: DRAFT.subject.toUpperCase() });
    expect(store.countPending()).toBe(2);
  });

  it("still queues a genuinely different message", () => {
    store.queuePending(DRAFT);
    store.queuePending({ ...DRAFT, subject: "Something else" });
    expect(store.countPending()).toBe(2);
  });

  it("queues a second one once the window has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
    const first = store.queuePending(DRAFT);

    vi.setSystemTime(Date.now() + store.DEDUPE_WINDOW_MS + 1_000);
    const second = store.queuePending(DRAFT);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.draft.id).not.toBe(first.draft.id);
    expect(store.countPending()).toBe(2);
  });

  it("does not fold into a draft that has already been approved", () => {
    const first = store.queuePending(DRAFT);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Approved: read-and-removed by the approve path.
    store.claimPending(first.draft.id);

    const second = store.queuePending(DRAFT);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.deduped).toBe(false);
    expect(store.countPending()).toBe(1);
  });
});

describe("duplicates already on disk", () => {
  it("finds the exact twins of a draft and takes them out of the queue", () => {
    // The state the owner's box is actually in: two identical drafts that were
    // queued before the guard above existed.
    const a = store.queuePending(DRAFT);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    // Written straight to the file, the way the box got there.
    const file = path.join(root, "data", "email-pending.json");
    const twin = { ...a.draft, id: "twin-id", createdAt: a.draft.createdAt + 1 };
    fs.writeFileSync(file, JSON.stringify([a.draft, twin], null, 2));
    expect(store.countPending()).toBe(2);

    const dropped = store.dropDuplicatesOf(a.draft);
    expect(dropped.map((d) => d.id)).toEqual(["twin-id"]);
    // The draft itself is untouched — the caller owns its lifecycle.
    expect(store.listPending().map((d) => d.id)).toEqual([a.draft.id]);
  });

  it("leaves an identical message queued LONG after the first alone", () => {
    // The case the window exists for. Two identical reminders queued forty
    // minutes apart are two reminders — DEDUPE_WINDOW_MS says as much — and
    // sending one must not delete the other. Before the window was applied
    // here, approving the first silently destroyed a message the owner had
    // asked for, and the receipt claimed it was "already sent".
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T09:00:00Z"));
    const first = store.queuePending(DRAFT);
    vi.setSystemTime(Date.now() + 40 * 60 * 1000);
    const later = store.queuePending(DRAFT);
    expect(first.ok && later.ok).toBe(true);
    if (!first.ok || !later.ok) return;
    expect(store.countPending()).toBe(2);

    expect(store.dropDuplicatesOf(first.draft)).toEqual([]);
    expect(store.listPending().map((d) => d.id)).toContain(later.draft.id);
  });

  it("sweeps a twin even when the same gesture named it", () => {
    // This used to spare a twin the owner had ticked on the same card, on the
    // reading that two ticks are two consents. They are not: the two rows say
    // the same words to the same people, he cannot tell them apart, and the
    // queue now refuses to write the second one at all — so a pair on one card
    // is a retry artefact from before the fold, and mailing both is the
    // duplicate the owner reported.
    const a = store.queuePending(DRAFT);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const file = path.join(root, "data", "email-pending.json");
    const twin = { ...a.draft, id: "twin-id", createdAt: a.draft.createdAt + 1 };
    fs.writeFileSync(file, JSON.stringify([a.draft, twin], null, 2));

    expect(store.dropDuplicatesOf(a.draft).map((d) => d.id)).toEqual(["twin-id"]);
    expect(store.listPending().map((d) => d.id)).not.toContain("twin-id");
  });

  it("does not turn a queue it cannot rewrite into a thrown error", () => {
    // Every caller reaches this INSIDE the try wrapping sendMail, past the
    // point where the mail has gone. A throw here would be caught there and
    // reported as "could not send" over a delivered message.
    const a = store.queuePending(DRAFT);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const file = path.join(root, "data", "email-pending.json");
    const twin = { ...a.draft, id: "twin-id", createdAt: a.draft.createdAt + 1 };
    fs.writeFileSync(file, JSON.stringify([a.draft, twin], null, 2));
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    expect(() => store.dropDuplicatesOf(a.draft)).not.toThrow();
    expect(store.dropDuplicatesOf(a.draft)).toEqual([]);
    write.mockRestore();
  });

  it("leaves a message that only looks similar alone", () => {
    const a = store.queuePending(DRAFT);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    store.queuePending({ ...DRAFT, body: "The message body, plus a sentence." });

    expect(store.dropDuplicatesOf(a.draft)).toEqual([]);
    expect(store.countPending()).toBe(2);
  });
});
