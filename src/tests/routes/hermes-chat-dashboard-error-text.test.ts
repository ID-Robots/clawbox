import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The STREAMED transport's failure text, which #515 never reached.
 *
 * #515 taught the chat route to clean the text of a failed Hermes turn:
 * `withoutTracebackFrames` drops the CPython frames, `redactDevicePaths`
 * replaces `/home/clawbox/…` with `<path>`, and `MAX_MESSAGE_CHARS` caps the
 * result at 400. All of it lived on the CLI transport, and the CLI transport is
 * the FALLBACK: `POST` opens a dashboard turn first for every non-image turn
 * (route.ts, "the fast path"), and the chat surface asks for
 * `Accept: text/event-stream`, so the streamed branch is what a customer
 * actually gets.
 *
 * On that branch the Hermes Python dashboard's own text went out untouched —
 * `payload.error` off `message.complete`, `payload.message` off the `error`
 * frame — into two places at once: the SSE `error` event the chat bubble
 * renders, and the customer's DURABLE transcript, which survives the refresh
 * that would have hidden a one-off bubble.
 *
 * These pin the streamed branch against the same inputs the CLI branch was
 * fixed for, plus the one that needs no traceback at all: an errored turn with
 * no `error` field, where the answer body — capped upstream at 2 MB, not at 400
 * chars — was being written into the transcript as the failure.
 */

const openTurnMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const appendMock = vi.hoisted(() => vi.fn());
const readTurnMock = vi.hoisted(() => vi.fn());

// Only the OPENING is faked, for the reason the sibling suite gives: the
// route's recovery path turns on `isQuietStreamError`, and a hand-written
// stand-in would let the predicate and the route drift.
vi.mock("@/lib/hermes-dashboard-turn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-dashboard-turn")>()),
  openDashboardTurn: openTurnMock,
}));
vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("@/lib/harness/transcript-store", () => ({ appendTranscript: appendMock }));
// The billing read answers "" here: nothing in this file is about the served
// pair, and a module mock that omits an export the route imports fails as a
// missing-export error rather than as the assertion it was written for.
vi.mock("@/lib/harness/hermes-turn-record", () => ({
  readHermesTurn: readTurnMock,
  readHermesBillingProvider: async () => "",
}));
vi.mock("@/lib/harness/media-root", () => ({
  resolveInMediaRoot: vi.fn(async (p: string) => p),
  chatMediaRoot: vi.fn(async () => "/tmp/clawbox-dashboard-error-media"),
}));
vi.mock("@/lib/hermes-model-options", () => ({
  getModelOptions: vi.fn(async () => null),
  isAllowedProvider: vi.fn(() => true),
  isPairAllowed: vi.fn(() => true),
  shouldEnforcePairing: vi.fn(() => false),
}));

import { POST } from "@/app/setup-api/hermes/chat/route";

/** A turn handle that settles exactly as the dashboard said it did. */
function fakeTurn(opts: { text?: string; status?: string; error?: string; fail?: Error }) {
  return {
    sessionId: "20260828_101500_a1b2c3",
    model: "",
    provider: "",
    async run() {
      if (opts.fail) throw opts.fail;
      return {
        text: opts.text ?? "",
        reasoning: "",
        status: opts.status ?? "complete",
        ...(opts.error ? { error: opts.error } : {}),
      };
    },
    close() {},
  };
}

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/setup-api/hermes/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
}

async function readEvents(res: Response): Promise<Array<[string, Record<string, unknown>]>> {
  const text = await res.text();
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const frame of text.split("\n\n")) {
    if (!frame.trim()) continue;
    let name = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    out.push([name, JSON.parse(data.join("\n")) as Record<string, unknown>]);
  }
  return out;
}

/** The `error` event's text, and the transcript line written beside it. */
async function failureOf(res: Response): Promise<{ shown: string; recorded: string }> {
  const events = await readEvents(res);
  const [name, payload] = events[events.length - 1];
  expect(name).toBe("error");
  const row = appendMock.mock.calls
    .map(([record]) => record as Record<string, unknown>)
    .find((r) => r.variant === "error");
  return { shown: String(payload.error ?? ""), recorded: String(row?.text ?? "") };
}

beforeEach(() => {
  openTurnMock.mockReset();
  spawnMock.mockReset();
  appendMock.mockReset();
  appendMock.mockResolvedValue(true);
  readTurnMock.mockReset();
  readTurnMock.mockResolvedValue(null);
});

describe("a streamed turn that failed", () => {
  it("shows the exception, not the Python frames under it", async () => {
    // The shape hermes-dashboard-turn.ts reports as `payload.error` on
    // `message.complete` when the agent's own call stack blew up.
    openTurnMock.mockResolvedValue(fakeTurn({
      status: "error",
      error: [
        "Traceback (most recent call last):",
        '  File "/home/clawbox/.hermes/agent.py", line 88, in _call_provider',
        '    raise RuntimeError("upstream refused the request")',
        "RuntimeError: upstream refused the request",
      ].join("\n"),
    }));
    const { shown, recorded } = await failureOf(await POST(post({ message: "Hey" })));
    expect(shown).toBe("RuntimeError: upstream refused the request");
    expect(shown).not.toContain('File "');
    expect(shown).not.toContain("/home/clawbox");
    // The transcript is the durable copy — a leak there outlives the bubble.
    expect(recorded).toBe("Error: RuntimeError: upstream refused the request");
    expect(recorded).not.toContain("/home/clawbox");
  });

  it("keeps the device layout out of a one-line failure that names no traceback", async () => {
    openTurnMock.mockResolvedValue(fakeTurn({
      status: "error",
      error: "Error: cannot write /home/clawbox/.hermes/config.yaml: permission denied",
    }));
    const { shown, recorded } = await failureOf(await POST(post({ message: "Hey" })));
    expect(shown).not.toContain("/home/clawbox");
    // Redacted, not dropped: "permission denied" is the half a person can act on.
    expect(shown).toContain("permission denied");
    expect(recorded).not.toContain("/home/clawbox");
  });

  it("cleans the `error` FRAME the same way, not only the settled turn", async () => {
    // hermes-dashboard-turn.ts throws `payload.message` verbatim on the error
    // frame, so this arrives at the route's catch rather than its status check.
    // Both write the same bubble and the same transcript row.
    openTurnMock.mockResolvedValue(fakeTurn({
      fail: new Error([
        "Traceback (most recent call last):",
        '  File "/home/clawbox/.hermes/dashboard/rpc.py", line 210, in _dispatch',
        '    raise PermissionError(13, "auth-profiles.json")',
        "PermissionError: [Errno 13] Permission denied: '/home/clawbox/.hermes/auth-profiles.json'",
      ].join("\n")),
    }));
    const { shown, recorded } = await failureOf(await POST(post({ message: "Hey" })));
    expect(shown).not.toContain("/home/clawbox");
    expect(shown).not.toContain('File "');
    expect(shown).toContain("Permission denied");
    expect(recorded).not.toContain("/home/clawbox");
  });

  it("never writes the ANSWER body into the transcript as the failure", async () => {
    // Provable without a traceback. `final.text` was a legal fallback for the
    // failure text, and the transport caps an answer at MAX_TEXT_BYTES =
    // 2,000,000 — four thousand times the 400-char cap the CLI branch applies —
    // so a status-error turn with no `error` field wrote a multi-megabyte
    // `Error: …` row into a customer's durable transcript.
    const body = "x".repeat(5000);
    openTurnMock.mockResolvedValue(fakeTurn({ status: "error", text: body }));
    const { shown, recorded } = await failureOf(await POST(post({ message: "Hey" })));
    expect(shown).toBe("Hermes chat failed");
    expect(recorded).toBe("Error: Hermes chat failed");
    expect(recorded).not.toContain("xxxx");
  });

  it("caps what it shows, because a bubble is not a log viewer", async () => {
    openTurnMock.mockResolvedValue(fakeTurn({
      status: "error",
      error: `provider request failed: ${"detail ".repeat(200)}`,
    }));
    const { shown } = await failureOf(await POST(post({ message: "Hey" })));
    expect(shown.length).toBeLessThanOrEqual(400);
  });
});
