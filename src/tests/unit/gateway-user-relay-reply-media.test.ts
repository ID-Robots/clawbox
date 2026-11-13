import { describe, expect, it } from "vitest";
import { createRequire } from "module";

// The OpenClaw half of TASK-2516: the user-chat relay finds the files a member
// of staff's assistant names in its replies (`MEDIA:` lines, `mediaUrls`, an
// attachment part) on the member's OWN sessions only — a final `chat` event,
// a `session.message`, a `chat.history` answer — with the turn's times, so
// scripts/chat-reply-media.js can record them as that member's before the
// reply reaches their browser. A home box's user and another session name
// nothing.

const requireCjs = createRequire(import.meta.url);
const relay = requireCjs("../../../scripts/gateway-user-relay.js") as {
  createRelayState(username: string, options?: { staffAgent?: string | null; staffReady?: () => boolean }): Record<string, unknown> & { connectId: string | null; connected: boolean };
  filterClientFrame(state: unknown, frame: unknown): { toGateway?: Record<string, unknown> };
  replyMediaClaims(state: unknown, frame: unknown): Array<{ paths: string[]; since: number | null; until: number | null }>;
};
const media = requireCjs("../../../scripts/chat-reply-media.js") as {
  replyMediaPaths(message: unknown): string[];
  mediaDirectives(text: unknown): string[];
};

const STAFF = "clawbox-staff-alice";
const MAIN = `agent:${STAFF}:clawbox-user-alice`;
const BOBS = "agent:clawbox-staff-bob:clawbox-user-bob";
const DOC = "/home/clawbox/.openclaw/media/word-docs/report.docx";

function member() {
  const state = relay.createRelayState("alice", { staffAgent: STAFF, staffReady: () => true });
  state.connectId = "c1";
  state.connected = true;
  return state;
}

const reply = (text: string, extra: Record<string, unknown> = {}) => ({ role: "assistant", content: [{ type: "text", text }], ...extra });
const finalEvent = (sessionKey: string, message: unknown, state = "final") => ({ type: "event", event: "chat", payload: { sessionKey, state, message } });

describe("the files a reply names", () => {
  it("reads MEDIA: lines outside code fences, mediaUrls and an attachment's local path — never a web URL or the user's words", () => {
    expect(media.mediaDirectives("Done.\nMEDIA: `/a/b.docx`\n```\nMEDIA:/fenced.docx\n```\n  media:/c d.pdf")).toEqual(["/a/b.docx", "/c d.pdf"]);
    expect(media.replyMediaPaths(reply(`Here.\nMEDIA:${DOC}`, { mediaUrls: ["file:///x/y.pdf", "https://example.com/z.pdf"] }))).toEqual([DOC, "/x/y.pdf"]);
    expect(media.replyMediaPaths({ role: "assistant", content: [{ type: "attachment", path: "/x/att.pdf" }] })).toEqual(["/x/att.pdf"]);
    expect(media.replyMediaPaths({ role: "user", content: `MEDIA:${DOC}` })).toEqual([]);
    expect(media.replyMediaPaths({ role: "assistant", content: "MEDIA:relative/file.docx" })).toEqual([]);
  });
});

describe("a member of staff's relay", () => {
  it("claims a final reply on their own session with the turn their socket started", () => {
    const state = member();
    const before = Date.now();
    expect(relay.filterClientFrame(state, { type: "req", id: "s1", method: "chat.send", params: { sessionKey: MAIN, message: "write the report", idempotencyKey: "k" } }).toGateway).toBeTruthy();
    const [claim, ...rest] = relay.replyMediaClaims(state, finalEvent(MAIN, reply(`Your report:\nMEDIA:${DOC}`)));
    expect(rest).toEqual([]);
    expect(claim.paths).toEqual([DOC]);
    expect(claim.since).toBeGreaterThanOrEqual(before);
    expect(claim.until).toBeGreaterThanOrEqual(claim.since!);
  });

  it("claims nothing from a delta, another member's session, or a reply naming no file", () => {
    const state = member();
    expect(relay.replyMediaClaims(state, finalEvent(MAIN, reply(`MEDIA:${DOC}`), "delta"))).toEqual([]);
    expect(relay.replyMediaClaims(state, finalEvent(BOBS, reply(`MEDIA:${DOC}`)))).toEqual([]);
    expect(relay.replyMediaClaims(state, finalEvent(MAIN, reply("No file this time.")))).toEqual([]);
  });

  it("claims a reply that finished while their browser was away from the history answer, each with its own turn's times", () => {
    const state = member();
    relay.filterClientFrame(state, { type: "req", id: "h1", method: "chat.history", params: { sessionKey: MAIN } });
    const claims = relay.replyMediaClaims(state, {
      type: "res", id: "h1", ok: true,
      payload: {
        sessionKey: MAIN,
        messages: [
          { role: "user", content: "first", timestamp: 1_790_000_000_000 },
          reply(`MEDIA:${DOC}`, { timestamp: 1_790_000_060_000 }),
          { role: "user", content: "second", timestamp: 1_790_001_000_000 },
          reply("no file", { timestamp: 1_790_001_010_000 }),
        ],
      },
    });
    expect(claims).toEqual([{ paths: [DOC], since: 1_790_000_000_000, until: 1_790_000_060_000 }]);
  });

  it("reads a delta history answer's envelopes too (the chat's read after every turn)", () => {
    const state = member();
    relay.filterClientFrame(state, { type: "req", id: "h3", method: "chat.history", params: { sessionKey: MAIN, cursor: "c1" } });
    const claims = relay.replyMediaClaims(state, {
      type: "res", id: "h3", ok: true,
      payload: {
        kind: "delta",
        sessionKey: MAIN,
        messages: [
          { sessionKey: MAIN, messageId: "m1", message: { role: "user", content: "write it", timestamp: 1_790_002_000_000 } },
          { sessionKey: MAIN, messageId: "m2", message: reply(`Here it is.\nMEDIA:${DOC}`, { timestamp: 1_790_002_030_000 }) },
        ],
      },
    });
    expect(claims).toEqual([{ paths: [DOC], since: 1_790_002_000_000, until: 1_790_002_030_000 }]);
  });

  it("ignores a history answer to a request it did not send, and one for another member's key", () => {
    const state = member();
    expect(relay.replyMediaClaims(state, { type: "res", id: "never", ok: true, payload: { messages: [reply(`MEDIA:${DOC}`)] } })).toEqual([]);
    relay.filterClientFrame(state, { type: "req", id: "h2", method: "chat.history", params: { sessionKey: MAIN } });
    expect(relay.replyMediaClaims(state, { type: "res", id: "h2", ok: true, payload: { sessionKey: BOBS, messages: [reply(`MEDIA:${DOC}`)] } })).toEqual([]);
  });

  it("claims nothing for a user on a home box (no staff agent): the media route serves them the tree as before", () => {
    const state = relay.createRelayState("alice");
    state.connectId = "c1";
    state.connected = true;
    expect(relay.replyMediaClaims(state, finalEvent("agent:main:clawbox-user-alice", reply(`MEDIA:${DOC}`)))).toEqual([]);
  });
});
