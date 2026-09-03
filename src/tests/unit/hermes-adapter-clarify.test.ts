import { describe, expect, it, vi } from "vitest";

import { HermesAdapter } from "@/lib/harness/hermes-adapter";
import { capabilitiesFor } from "@/lib/harness/capabilities";
import type { TurnEvent } from "@/lib/harness/transport";

/**
 * The Hermes adapter reading a CLARIFY frame.
 *
 * The streaming tests next door pin the answer path. This pins the other
 * thing a turn can do: stop, and ask. What is at stake is narrower than a
 * delta and less forgiving — a dropped `tool` frame costs a pill that `done`
 * repaints anyway, but a dropped or malformed clarify leaves the agent parked
 * for an hour behind a turn that dies on its 180s deadline, with nothing on
 * screen that could ever answer it.
 *
 * So the assertions are about two things only: the shape that reaches the
 * surface, and the frames that must NOT become a card the customer can click.
 */

const CAPS = capabilitiesFor("hermes", {
  hasClawaiToken: true,
  hermesSupportsImages: false,
  hermesHasVisionRoute: false,
  hermesStreamsTurns: true,
  hasClawaiImageRoute: false,
  hermesAgentDrawsImages: false,
  hermesSpeaksReplies: false,
});

/** One SSE frame, framed the way the route frames it. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(pieces: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: {
      getReader() {
        return {
          async read() {
            if (i >= pieces.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(pieces[i++]) };
          },
        };
      },
    },
    json: async () => {
      throw new Error("a streamed response must not be read as JSON");
    },
  } as unknown as Response;
}

function makeAdapter(pieces: string[]) {
  const fetchImpl = vi.fn(async () => sseResponse(pieces));
  return new HermesAdapter(
    CAPS,
    () => ({ devicePairing: { provider: "clawai", model: "deepseek-v4-flash" }, modelsReady: true, sessionKey: "desktop" }),
    fetchImpl as unknown as typeof fetch,
  );
}

const turn = { text: "Deploy it", attachments: [], idempotencyKey: "k1" };

/** Run one turn over the given frames and collect everything the surface saw. */
async function eventsFrom(pieces: string[]): Promise<TurnEvent[]> {
  const seen: TurnEvent[] = [];
  await makeAdapter([...pieces, frame("done", { text: "ok", harness: "hermes" })]).sendTurn(turn, (e) => seen.push(e));
  return seen;
}

describe("a Hermes turn that stops to ask", () => {
  it("forwards a single question with the empty qid the route sends", async () => {
    // The empty qid is not a missing value — it is how the answer route tells
    // "the one question of this request" from "one of a batch", and a surface
    // that invented an id for it would post a `questionId` the gateway never
    // asked about.
    const seen = await eventsFrom([
      frame("clarify", {
        requestId: "req-1",
        questions: [{ qid: "", question: "Deploy to production?", choices: ["Yes", "No"], multiSelect: false }],
      }),
    ]);
    expect(seen).toEqual([
      {
        kind: "clarify",
        requestId: "req-1",
        questions: [{ qid: "", question: "Deploy to production?", choices: ["Yes", "No"], multiSelect: false }],
      },
    ]);
  });

  it("carries a reconnect replay's already-locked answers", async () => {
    // `answered` is the whole difference between a replay that comes back with
    // the first question collapsed and one that invites a second answer to a
    // question the agent already has.
    const seen = await eventsFrom([
      frame("clarify", {
        requestId: "req-2",
        questions: [
          { qid: "q1", question: "Which branch?", choices: ["main", "beta"], multiSelect: false },
          { qid: "q2", question: "Which boxes?", choices: ["dev", "prod"], multiSelect: true },
        ],
        answered: { q1: "beta" },
      }),
    ]);
    expect(seen).toHaveLength(1);
    const event = seen[0];
    expect(event.kind).toBe("clarify");
    if (event.kind !== "clarify") return;
    expect(event.answered).toEqual({ q1: "beta" });
    expect(event.questions[1].multiSelect).toBe(true);
  });

  it("omits `answered` entirely when the frame carried none", async () => {
    // Present-but-empty and absent mean the same thing to a renderer, so the
    // optional field is left off — where it DOES appear, it means "this is a
    // replay", and an always-present empty object would make that unreadable.
    const seen = await eventsFrom([
      frame("clarify", {
        requestId: "req-3",
        questions: [{ qid: "", question: "Ready?", choices: [], multiSelect: false }],
      }),
    ]);
    expect(seen[0]).not.toHaveProperty("answered");
  });

  it("coerces the wire rather than trusting it", async () => {
    // Every one of these becomes a CONTROL. A non-string choice would render
    // as `[object Object]` on a real button, a missing `choices` would crash a
    // `.map`, and `multiSelect: "yes"` would send a plain string where the
    // route expects a JSON array.
    const seen = await eventsFrom([
      frame("clarify", {
        requestId: "req-4",
        questions: [
          { qid: "q1", question: "  Which one?  ", choices: ["a", 7, null, "b"], multiSelect: "yes" },
          { qid: "q2", question: "No choices at all" },
        ],
        answered: { q1: 5, q2: "typed" },
      }),
    ]);
    expect(seen).toEqual([
      {
        kind: "clarify",
        requestId: "req-4",
        questions: [
          { qid: "q1", question: "Which one?", choices: ["a", "b"], multiSelect: false },
          { qid: "q2", question: "No choices at all", choices: [], multiSelect: false },
        ],
        // The numeric answer is dropped: a locked answer decides whether a
        // question renders as a control or as a read-only summary.
        answered: { q2: "typed" },
      },
    ]);
  });

  it("drops a frame that could not produce a working card, and finishes the turn", async () => {
    // Nothing later in the turn repairs a clarify — unlike a tool pill, there
    // is no authoritative copy on `done`. So the test is not "it recovers", it
    // is "it never draws a prompt that cannot be answered": no requestId means
    // no route home, and no askable question means a card with nothing on it.
    const seen = await eventsFrom([
      frame("clarify", { questions: [{ qid: "", question: "Orphaned", choices: [], multiSelect: false }] }),
      frame("clarify", { requestId: "req-5", questions: [] }),
      frame("clarify", { requestId: "req-6", questions: [{ qid: "q1", question: "   " }] }),
      frame("clarify", { requestId: "req-7", questions: "not an array" }),
    ]);
    expect(seen).toEqual([]);
  });

  it("drops a frame whose JSON is broken rather than failing the turn", async () => {
    // A turn the box has already paid for must not be lost to one unreadable
    // frame — the same posture the delta path already keeps.
    const seen: TurnEvent[] = [];
    const result = await makeAdapter([
      "event: clarify\ndata: {not json at all\n\n",
      frame("clarify", {
        requestId: "req-8",
        questions: [{ qid: "", question: "Still here?", choices: ["Yes"], multiSelect: false }],
      }),
      frame("done", { text: "ok", harness: "hermes" }),
    ]).sendTurn(turn, (e) => seen.push(e));
    expect(seen).toHaveLength(1);
    expect(result.text).toBe("ok");
  });
});

describe("a clarify the agent stopped waiting on", () => {
  it("forwards the expiry so the card can go dead in place", async () => {
    // The card is not removed on expiry — a question that silently vanished
    // would read as an answer that was sent. It is disabled, which is why the
    // event has to arrive at all.
    const seen = await eventsFrom([
      frame("clarify", {
        requestId: "req-9",
        questions: [{ qid: "", question: "Proceed?", choices: ["Yes"], multiSelect: false }],
      }),
      frame("clarifyExpire", { requestId: "req-9" }),
    ]);
    expect(seen[1]).toEqual({ kind: "clarifyExpire", requestId: "req-9" });
  });

  it("ignores an expiry that names no request", async () => {
    // There is nothing it could expire, and guessing — the newest card, say —
    // would disable a prompt the customer is still able to answer.
    const seen = await eventsFrom([frame("clarifyExpire", { requestId: "" })]);
    expect(seen).toEqual([]);
  });
});
