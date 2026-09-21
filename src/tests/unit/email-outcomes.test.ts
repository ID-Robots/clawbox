// What became of a draft after it left the queue.
//
// THE BUG THIS PINS. Approving read-and-REMOVED the draft, and that was the end
// of it: nothing on disk remembered whether the message went out, was deleted,
// or failed on the wire. Every surface that had the draft on screen was left
// guessing, and the chat card guessed "still waiting" — a live Approve button
// over a message that had already been sent. That is the FALSE SUCCESS class
// pointing the other way: the screen says nothing happened when it did.
//
// So a draft leaving the queue writes one small record, and every surface reads
// it. It holds no body — the surfaces that need the text already have it, and
// a second file full of agent-composed prose is a second thing to be careful
// with. It is capped and it expires, because it is a receipt, not an archive.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Outcomes = typeof import("@/lib/email-outcomes");

let outcomes: Outcomes;
let root: string;
let outcomesPath: string;

const DRAFT = { id: "draft-1", to: ["owner@example.com"], subject: "Hello" };

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-outcomes-"));
  process.env.CLAWBOX_ROOT = root;
  outcomesPath = path.join(root, "data", "email-outcomes.json");
  vi.resetModules();
  outcomes = await import("@/lib/email-outcomes");
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("recording", () => {
  it("remembers that a draft was sent, and when", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T11:30:00Z"));
    outcomes.recordOutcome(DRAFT, "sent");

    expect(outcomes.getOutcome("draft-1")).toMatchObject({
      id: "draft-1",
      kind: "sent",
      at: Date.now(),
      subject: "Hello",
    });
  });

  it("remembers a rejection, a failure and a duplicate apart from each other", () => {
    outcomes.recordOutcome({ ...DRAFT, id: "a" }, "rejected");
    outcomes.recordOutcome({ ...DRAFT, id: "b" }, "failed", { error: "The mail server refused it." });
    outcomes.recordOutcome({ ...DRAFT, id: "c" }, "duplicate", { sentAs: "a" });

    expect(outcomes.getOutcome("a")?.kind).toBe("rejected");
    expect(outcomes.getOutcome("b")).toMatchObject({ kind: "failed", error: "The mail server refused it." });
    expect(outcomes.getOutcome("c")).toMatchObject({ kind: "duplicate", sentAs: "a" });
  });

  it("lists the newest first", async () => {
    outcomes.recordOutcome({ ...DRAFT, id: "older" }, "sent");
    await new Promise((r) => setTimeout(r, 5));
    outcomes.recordOutcome({ ...DRAFT, id: "newer" }, "sent");
    expect(outcomes.listOutcomes().map((o) => o.id)).toEqual(["newer", "older"]);
  });

  it("writes the file 0600, like every other store that holds the owner's mail", () => {
    outcomes.recordOutcome(DRAFT, "sent");
    expect(fs.statSync(outcomesPath).mode & 0o777).toBe(0o600);
  });

  it("never stores the body", () => {
    // The KEYS, not a substring: a fixture whose subject happened to contain
    // the word "body" would have failed a text search while the file was fine,
    // and one that stored the body under another name would have passed.
    outcomes.recordOutcome(DRAFT, "sent");
    const [row] = JSON.parse(fs.readFileSync(outcomesPath, "utf-8")) as Record<string, unknown>[];
    expect(Object.keys(row).sort()).toEqual(["at", "id", "kind", "subject", "to"]);
  });
});

describe("it stays small", () => {
  it("keeps at most MAX_OUTCOMES records", () => {
    for (let n = 0; n < outcomes.MAX_OUTCOMES + 5; n++) {
      outcomes.recordOutcome({ ...DRAFT, id: `d${n}` }, "sent");
    }
    expect(outcomes.listOutcomes()).toHaveLength(outcomes.MAX_OUTCOMES);
    // The oldest went, not the newest.
    expect(outcomes.getOutcome("d0")).toBeNull();
    expect(outcomes.getOutcome(`d${outcomes.MAX_OUTCOMES + 4}`)).not.toBeNull();
  });

  it("forgets a receipt older than its TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T11:30:00Z"));
    outcomes.recordOutcome(DRAFT, "sent");

    vi.setSystemTime(Date.now() + outcomes.OUTCOME_TTL_MS + 1_000);
    expect(outcomes.getOutcome("draft-1")).toBeNull();
    expect(outcomes.listOutcomes()).toEqual([]);
  });
});

describe("robustness", () => {
  it("treats an unreadable file as no receipts rather than throwing", () => {
    fs.mkdirSync(path.dirname(outcomesPath), { recursive: true });
    fs.writeFileSync(outcomesPath, "{ not json");
    expect(outcomes.listOutcomes()).toEqual([]);
    expect(() => outcomes.recordOutcome(DRAFT, "sent")).not.toThrow();
    expect(outcomes.getOutcome("draft-1")?.kind).toBe("sent");
  });

  it("clears everything when the account is disconnected", () => {
    outcomes.recordOutcome(DRAFT, "sent");
    outcomes.clearOutcomes();
    expect(outcomes.listOutcomes()).toEqual([]);
  });
});
