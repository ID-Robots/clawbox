import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SUP-1017 (TASK-2131): on Hermes, a session that ran out while the chat was
 * answering. The session gate admits a request once; a Hermes turn then answers
 * over that one response for as long as it runs, so a browser whose session
 * expired mid-answer kept being handed the reply, its tool steps and its
 * questions. Pinned against the route itself, with a real signed cookie:
 *
 *   - the POST's stream and a re-attach (GET) end at the cookie's expiry, and
 *     within a recheck of a password change, with the session-expired frame;
 *   - the turn is NOT stopped by that — it records its answer, which the person
 *     reads after signing in again (the socket cut on OpenClaw leaves the
 *     gateway's run going the same way);
 *   - the CLI path, which answers whole at the end, answers a session that ran
 *     out while it worked with the session gate's 401 instead of the reply.
 */

const openTurnMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const appendMock = vi.hoisted(() => vi.fn());
const readTurnMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-dashboard-turn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-dashboard-turn")>()),
  openDashboardTurn: openTurnMock,
}));
vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("@/lib/harness/transcript-store", () => ({ appendTranscript: appendMock }));
vi.mock("@/lib/harness/hermes-turn-record", () => ({
  readHermesTurn: readTurnMock,
  readHermesUsageMarks: async () => null,
  readHermesBillingProvider: async () => "",
}));
vi.mock("@/lib/harness/media-root", () => ({
  resolveInMediaRoot: vi.fn(async (p: string) => p),
  chatMediaRoot: vi.fn(async () => `/tmp/clawbox-session-expiry-media-${process.pid}`),
}));
vi.mock("@/lib/hermes-model-options", () => ({
  getModelOptions: vi.fn(async () => null),
  readCurrentFromCli: vi.fn(async () => ({ provider: "", model: "", reasoning: "" })),
  isAllowedProvider: vi.fn(() => true),
  isPairAllowed: vi.fn(() => true),
  shouldEnforcePairing: vi.fn(() => false),
}));

import { GET, POST } from "@/app/setup-api/hermes/chat/route";
import { SESSION_RECHECK_MS, hasLiveTurn, resetLiveTurns } from "@/lib/harness/hermes-live-turn";
import { SESSION_EXPIRED_HEADER, SESSION_EXPIRED_STREAM_CODE } from "@/lib/session-expiry";
import { installSessionFixture, signSessionCookie, type SessionFixture } from "../helpers/session";

const SESSION = "20260823_190319_3e9e35";
const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);

/** A dashboard turn that says its first half, then waits to be released. */
function gatedTurn() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: { signal?: AbortSignal } = {};
  openTurnMock.mockImplementation(async (req: { signal?: AbortSignal }) => {
    seen.signal = req.signal;
    return {
      sessionId: SESSION,
      model: "",
      provider: "",
      async run(onDelta: (chunk: string) => void) {
        onDelta("The first half, ");
        await gate;
        onDelta("and the rest.");
        return { text: "The first half, and the rest.", reasoning: "", status: "complete" };
      },
      close() {},
    };
  });
  return { release: () => release(), seen };
}

function post(cookie: string, accept = "text/event-stream"): Request {
  return new Request("http://clawbox.local/setup-api/hermes/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept, cookie },
    body: JSON.stringify({ message: "Write me a long story" }),
  });
}

function attach(cookie: string): Request {
  return new Request("http://clawbox.local/setup-api/hermes/chat?sessionKey=desktop", {
    headers: { accept: "text/event-stream", cookie },
  });
}

function events(text: string): Array<[string, Record<string, unknown>]> {
  return text.split("\n\n").filter((f) => f.trim()).map((frame) => [
    /^event: (.*)$/m.exec(frame)?.[1] ?? "message",
    JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? "{}") as Record<string, unknown>,
  ]);
}

const records = () => appendMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
const cookieFor = (expiresInSeconds: number, gen = 0) => `clawbox_session=${signSessionCookie({ expiresInSeconds, gen })}`;

let fixture: SessionFixture;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0);
  fixture = installSessionFixture();
  openTurnMock.mockReset();
  spawnMock.mockReset();
  appendMock.mockReset();
  appendMock.mockResolvedValue(true);
  readTurnMock.mockReset();
  readTurnMock.mockResolvedValue(null);
  resetLiveTurns();
});

afterEach(() => {
  resetLiveTurns();
  fixture.cleanup();
  vi.useRealTimers();
});

describe("a Hermes answer streaming when the session runs out", () => {
  it("stops reaching the browser at the cookie's expiry, and the turn still records its answer", async () => {
    const turn = gatedTurn();
    const res = await POST(post(cookieFor(20 * 60)));
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    await vi.advanceTimersByTimeAsync(20 * 60_000);
    turn.release();
    const said = events(await res.text());
    expect(said.map(([name]) => name)).toEqual(["delta", "error"]);
    expect(said[1][1]).toMatchObject({ code: SESSION_EXPIRED_STREAM_CODE });
    expect(JSON.stringify(said)).not.toContain("and the rest.");

    // The session ended the STREAM, not the turn.
    expect(turn.seen.signal?.aborted).toBe(false);
    await vi.waitFor(() => expect(records().find((r) => r.role === "assistant")).toMatchObject({ text: "The first half, and the rest." }));
    expect(records().some((r) => r.variant === "stopped")).toBe(false);
    await vi.waitFor(() => expect(hasLiveTurn("desktop")).toBe(false));
  });

  it("stops within a recheck of a password change that revoked the cookie", async () => {
    const turn = gatedTurn();
    const res = await POST(post(cookieFor(12 * 3600)));
    fs.writeFileSync(
      path.join(fixture.root, "data", "config.json"),
      JSON.stringify({ password_configured: true, setup_complete: true, session_generation: 1 }),
    );
    await vi.advanceTimersByTimeAsync(SESSION_RECHECK_MS);
    turn.release();
    expect(events(await res.text()).map(([name, data]) => data.code ?? name)).toEqual(["delta", SESSION_EXPIRED_STREAM_CODE]);
  });

  it("follows the turn to its end while the session lasts", async () => {
    const turn = gatedTurn();
    const res = await POST(post(cookieFor(20 * 60)));
    await vi.advanceTimersByTimeAsync(60_000);
    turn.release();
    expect(events(await res.text()).map(([name]) => name)).toEqual(["delta", "delta", "done"]);
  });

  it("bounds a re-attach by the session it came in on, too", async () => {
    const turn = gatedTurn();
    // The page that started the turn reloads; its cookie has a minute left.
    const first = await POST(post(cookieFor(12 * 3600)));
    await first.body!.cancel();
    const attached = await GET(attach(cookieFor(60)));
    expect(attached.status).toBe(200);
    await vi.advanceTimersByTimeAsync(60_000);
    turn.release();
    const said = events(await attached.text());
    expect(said.map(([name, data]) => data.code ?? name)).toEqual(["delta", SESSION_EXPIRED_STREAM_CODE]);
  });
});

describe("a cookie that ran out between the session gate and the route", () => {
  it("gets a stream that has already ended, never an unbounded one", async () => {
    const turn = gatedTurn();
    const first = await POST(post(cookieFor(12 * 3600)));
    await first.body!.cancel();
    // Expired a moment ago: the middleware let it in, the route no longer would.
    const attached = await GET(attach(cookieFor(-1)));
    await vi.advanceTimersByTimeAsync(0);
    turn.release();
    expect(events(await attached.text()).map(([name, data]) => data.code ?? name)).toEqual(["delta", SESSION_EXPIRED_STREAM_CODE]);
  });
});

describe("a Hermes answer on the CLI path when the session runs out", () => {
  it("answers the session gate's 401, not the reply — which is in the transcript for the next sign-in", async () => {
    openTurnMock.mockResolvedValue(null);
    const listeners: Record<string, (...args: unknown[]) => void> = {};
    spawnMock.mockReturnValue({
      stdout: { on: (event: string, cb: (chunk: Buffer) => void) => { listeners[`stdout:${event}`] = cb as never; } },
      stderr: { on: (event: string, cb: (chunk: Buffer) => void) => { listeners[`stderr:${event}`] = cb as never; } },
      on: (event: string, cb: (...args: unknown[]) => void) => { listeners[event] = cb; },
      kill: vi.fn(),
    });
    const pending = POST(post(cookieFor(60), "application/json"));
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    vi.setSystemTime(T0 + 61_000);
    listeners["stdout:data"]?.(Buffer.from("The whole story."));
    listeners["stderr:data"]?.(Buffer.from(`session_id: ${SESSION}\n`));
    listeners.close?.(0);
    const res = await pending;

    expect(res.status).toBe(401);
    expect(res.headers.get(SESSION_EXPIRED_HEADER)).toBe("expired");
    expect(JSON.stringify(await res.json())).not.toContain("The whole story.");
    expect(records().find((r) => r.role === "assistant")).toMatchObject({ text: "The whole story." });
  });

  it("answers as before while the session lasts", async () => {
    openTurnMock.mockResolvedValue(null);
    const listeners: Record<string, (...args: unknown[]) => void> = {};
    spawnMock.mockReturnValue({
      stdout: { on: (event: string, cb: (chunk: Buffer) => void) => { listeners[`stdout:${event}`] = cb as never; } },
      stderr: { on: (event: string, cb: (chunk: Buffer) => void) => { listeners[`stderr:${event}`] = cb as never; } },
      on: (event: string, cb: (...args: unknown[]) => void) => { listeners[event] = cb; },
      kill: vi.fn(),
    });
    const pending = POST(post(cookieFor(20 * 60), "application/json"));
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    listeners["stdout:data"]?.(Buffer.from("The whole story."));
    listeners.close?.(0);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: "The whole story." });
  });
});
