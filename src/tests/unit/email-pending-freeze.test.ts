// Freezing a batch of drafts at the moment the owner is shown them.
//
// WHAT IS BEING PROVED. The chat's batch card draws N drafts, the owner reads
// them, and some seconds later he clicks once. The agent is still running for
// the whole of that pause. Nothing may be sent that was not on the screen he
// read — which is the same class of bug as #492, where device state moved
// during exactly such a dialog pause and the confirmation ended up describing
// something other than what happened.
//
// Real filesystem in a temp CLAWBOX_ROOT, for the reason email-pending.test.ts
// gives: a mocked fs would prove nothing about a store whose job is to survive
// being written and read back.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Store = typeof import("@/lib/email-pending");

let store: Store;
let root: string;

const DRAFT = { to: ["someone@example.com"], subject: "Hello", body: "The message body." };

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-freeze-"));
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  store = await import("@/lib/email-pending");
});

afterEach(() => {
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("draftFingerprint", () => {
  it("is stable for the same draft", () => {
    const queued = store.queuePending(DRAFT);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(store.draftFingerprint(queued.draft)).toBe(store.draftFingerprint(queued.draft));
  });

  it("changes when any part of what the owner read changes", () => {
    const queued = store.queuePending(DRAFT);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const base = store.draftFingerprint(queued.draft);

    expect(store.draftFingerprint({ ...queued.draft, body: "Something else entirely." })).not.toBe(base);
    expect(store.draftFingerprint({ ...queued.draft, subject: "Other" })).not.toBe(base);
    expect(store.draftFingerprint({ ...queued.draft, to: ["elsewhere@example.com"] })).not.toBe(base);
    // A recipient ADDED is the one that matters most: the owner read a message
    // going to one person.
    expect(store.draftFingerprint({ ...queued.draft, to: [...queued.draft.to, "extra@example.com"] })).not.toBe(base);
  });

  it("travels with the draft, so a surface can hand it back", () => {
    const queued = store.queuePending(DRAFT);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(store.listPending()[0].fingerprint).toBe(store.draftFingerprint(queued.draft));
  });
});

describe("claimPendingIfUnchanged", () => {
  it("hands over the draft and takes it out of the queue", () => {
    const queued = store.queuePending(DRAFT);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;

    const claim = store.claimPendingIfUnchanged(queued.draft.id, store.draftFingerprint(queued.draft));
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.draft.body).toBe(DRAFT.body);
    expect(store.countPending()).toBe(0);
  });

  it("claims once, so a double click cannot send the same message twice", () => {
    const queued = store.queuePending(DRAFT);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const fingerprint = store.draftFingerprint(queued.draft);

    expect(store.claimPendingIfUnchanged(queued.draft.id, fingerprint).ok).toBe(true);
    const second = store.claimPendingIfUnchanged(queued.draft.id, fingerprint);
    expect(second).toEqual({ ok: false, reason: "gone" });
  });

  it("refuses a draft whose content no longer matches, and leaves it queued", () => {
    const queued = store.queuePending(DRAFT);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;

    const claim = store.claimPendingIfUnchanged(queued.draft.id, "0".repeat(32));
    expect(claim).toEqual({ ok: false, reason: "changed" });
    // Not consented to, so not deleted either: silently dropping text the owner
    // never agreed to lose would be its own bug.
    expect(store.countPending()).toBe(1);
  });

  it("FREEZE: a draft queued during the owner's pause is not part of the batch", () => {
    // What the card was drawn from.
    const first = store.queuePending({ ...DRAFT, subject: "One" });
    const second = store.queuePending({ ...DRAFT, subject: "Two" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const batch = store.listPending().map((d) => ({ id: d.id, fingerprint: d.fingerprint }));
    expect(batch).toHaveLength(2);

    // ...and what the agent queued while he was reading it.
    const late = store.queuePending({ ...DRAFT, subject: "Queued while he was reading" });
    expect(late.ok).toBe(true);
    if (!late.ok) return;
    expect(store.countPending()).toBe(3);

    // Approving the batch claims exactly the two that were on screen.
    const claimed = batch.map((entry) => store.claimPendingIfUnchanged(entry.id, entry.fingerprint));
    expect(claimed.every((c) => c.ok)).toBe(true);

    const left = store.listPending();
    expect(left).toHaveLength(1);
    expect(left[0].subject).toBe("Queued while he was reading");
  });
});
