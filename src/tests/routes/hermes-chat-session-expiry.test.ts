import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * A Hermes answer must not outlive the session that asked for it (TASK-2131).
 *
 * Found on a board: the session gate let the POST in once, when it arrived,
 * and a turn whose tool ran past the cookie's expiry went on streaming its
 * tool result, its deltas and its `done` to the page 50 s after the session
 * was over. The stream now asks again while it runs and ends — for that
 * listener only — once the session no longer holds; the turn itself runs on
 * and records its answer, as it does when a page reloads (TASK-2117).
 *
 * Only `setInterval` is faked, so the stream's re-check can be stepped while
 * everything else — the cookie's clock, the stream — runs for real.
 */

// The box's data folder, set before the route and its stores are imported:
// config-store resolves it once, at import.
const root = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const dir = (require("node:fs") as typeof import("node:fs")).mkdtempSync(
    (require("node:path") as typeof import("node:path")).join((require("node:os") as typeof import("node:os")).tmpdir(), "hermes-chat-expiry-"),
  );
  /* eslint-enable @typescript-eslint/no-require-imports */
  const before = { SESSION_SECRET: process.env.SESSION_SECRET, CLAWBOX_ROOT: process.env.CLAWBOX_ROOT, CLAWBOX_USER: process.env.CLAWBOX_USER };
  Object.assign(process.env, { SESSION_SECRET: "test-session-secret-for-hermes-chat-expiry", CLAWBOX_ROOT: dir, CLAWBOX_USER: "clawbox" });
  return { dir, before };
});

const openTurnMock = vi.hoisted(() => vi.fn());
const appendMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-dashboard-turn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-dashboard-turn")>()),
  openDashboardTurn: openTurnMock,
}));
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("@/lib/harness/transcript-store", () => ({ appendTranscript: appendMock }));
vi.mock("@/lib/harness/hermes-turn-record", () => ({
  withHermesStateHome: (_home: unknown, fn: () => unknown) => fn(),
  readHermesTurn: async () => null,
  readHermesUsageMarks: async () => null,
  readHermesBillingProvider: async () => "",
}));
vi.mock("@/lib/harness/media-root", () => ({
  resolveInMediaRoot: vi.fn(async (p: string) => p),
  chatMediaRoot: vi.fn(async () => `/tmp/clawbox-expiry-media-${process.pid}`),
}));
vi.mock("@/lib/hermes-model-options", () => ({
  getModelOptions: vi.fn(async () => null),
  readCurrentFromCli: vi.fn(async () => ({ provider: "", model: "", reasoning: "" })),
  isAllowedProvider: vi.fn(() => true),
  isPairAllowed: vi.fn(() => true),
  shouldEnforcePairing: vi.fn(() => false),
}));

import { GET, POST } from "@/app/setup-api/hermes/chat/route";
import { LIVE_TURN_SESSION_RECHECK_MS, hasLiveTurn, resetLiveTurns } from "@/lib/harness/hermes-live-turn";

const SECRET = "test-session-secret-for-hermes-chat-expiry";
const SESSION = "20260823_190319_3e9e35";

const nowS = () => Math.floor(Date.now() / 1000);

/** A `clawbox_session` value the way src/lib/auth.ts mints one, for the owner. */
function mint(exp: number, gen = 0): string {
  const payload = Buffer.from(JSON.stringify({ exp, gen, u: "clawbox" })).toString("base64url");
  return `${payload}.${crypto.createHmac("sha256", SECRET).update(payload).digest("hex")}`;
}

function writeConfig(gen: number) {
  fs.writeFileSync(path.join(root.dir, "data", "config.json"), JSON.stringify({ setup_complete: true, password_configured: true, session_generation: gen }));
}

/** A turn that says its first half, then waits to be released before saying the rest. */
function gatedTurn() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  openTurnMock.mockImplementation(async () => ({
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
  }));
  return { release: () => release() };
}

function post(cookie?: string): Request {
  return new Request("http://localhost/setup-api/hermes/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(cookie ? { cookie: `clawbox_session=${cookie}` } : {}),
    },
    body: JSON.stringify({ message: "Run the long job and tell me how it went" }),
  });
}

function attach(cookie: string): Request {
  return new Request("http://localhost/setup-api/hermes/chat?sessionKey=desktop", {
    headers: { accept: "text/event-stream", cookie: `clawbox_session=${cookie}` },
  });
}

/** Whether the stream ends (true) or still has more to say (false) once the re-check has run. */
async function endsAfterRecheck(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<boolean> {
  const next = reader.read();
  await vi.advanceTimersByTimeAsync(LIVE_TURN_SESSION_RECHECK_MS);
  const settled = await Promise.race([next.then((r) => r.done), new Promise<"open">((r) => setTimeout(() => r("open"), 200))]);
  return settled === true;
}

const records = () => appendMock.mock.calls.map((c) => c[0] as Record<string, unknown>);

beforeAll(() => {
  fs.mkdirSync(path.join(root.dir, "data"), { recursive: true });
});

afterAll(() => {
  fs.rmSync(root.dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(root.before)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  writeConfig(0);
  openTurnMock.mockReset();
  appendMock.mockReset();
  appendMock.mockResolvedValue(true);
  resetLiveTurns();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a Hermes answer streaming past the session that asked for it", () => {
  it("ends the stream once the session has expired, and the turn still records its answer", async () => {
    const turn = gatedTurn();
    const res = await POST(post(mint(nowS() + 1)));
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("The first half");

    // Still signed in: the re-check keeps the stream.
    expect(await endsAfterRecheck(reader)).toBe(false);

    // The cookie's expiry passes while the turn is still working.
    await new Promise((r) => setTimeout(r, 2_100));
    expect(await endsAfterRecheck(reader)).toBe(true);

    // Only the listener went: the turn runs on and writes its answer down.
    expect(hasLiveTurn("desktop")).toBe(true);
    turn.release();
    await vi.waitFor(() => expect(records().some((r) => r.role === "assistant" && r.text === "The first half, and the rest.")).toBe(true));
    expect(records().some((r) => r.variant === "stopped")).toBe(false);
  });

  it("ends it when a password change revokes the session", async () => {
    const turn = gatedTurn();
    const res = await POST(post(mint(nowS() + 600)));
    const reader = res.body!.getReader();
    await reader.read();
    writeConfig(1);
    expect(await endsAfterRecheck(reader)).toBe(true);
    turn.release();
    await vi.waitFor(() => expect(records().some((r) => r.role === "assistant")).toBe(true));
  });

  it("ends a re-attached page's stream the same way", async () => {
    const turn = gatedTurn();
    const live = mint(nowS() + 600);
    const first = (await POST(post(live))).body!.getReader();
    await first.read();
    await first.cancel();

    const reattached = (await GET(attach(live))).body!.getReader();
    await reattached.read();
    writeConfig(1);
    expect(await endsAfterRecheck(reattached)).toBe(true);
    turn.release();
  });

  it("leaves a stream with no session behind it — the assistant's bearer — to run to its end", async () => {
    const turn = gatedTurn();
    const res = await POST(post());
    const reader = res.body!.getReader();
    await reader.read();
    expect(await endsAfterRecheck(reader)).toBe(false);
    turn.release();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain("event: done");
  });
});

describe("the one-shot (CLI) answer to a session that ran out while it was written", () => {
  /** A `hermes chat -q` that answers once `finish` is called. */
  function slowCli() {
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => { finish = resolve; });
    spawnMock.mockImplementation(() => ({
      stdout: { on: (e: string, cb: (c: Buffer) => void) => { if (e === "data") void done.then(() => cb(Buffer.from("the answer"))); } },
      stderr: { on: () => {} },
      on: (e: string, cb: (code: number) => void) => { if (e === "close") void done.then(() => setTimeout(() => cb(0), 0)); },
      kill: () => {},
    }));
    openTurnMock.mockResolvedValue(null);
    return { finish: () => finish() };
  }

  it("is the session gate's marked 401, not the reply — which is still recorded", async () => {
    const cli = slowCli();
    const pending = POST(post(mint(nowS() + 600)));
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    writeConfig(1);
    cli.finish();
    const res = await pending;
    expect(res.status).toBe(401);
    expect(res.headers.get("x-clawbox-session")).toBe("expired");
    await vi.waitFor(() => expect(records().some((r) => r.role === "assistant")).toBe(true));
  });

  it("is the reply while the session holds", async () => {
    const cli = slowCli();
    const pending = POST(post(mint(nowS() + 600)));
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    cli.finish();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ harness: "hermes" });
  });
});

describe("the JSON answer of a turn the dashboard carried (TASK-2152)", () => {
  // A caller that did not ask to be streamed to is now answered through the
  // dashboard too, settled and handed back whole — and held to the CLI path's
  // rule: a session that ran out while the turn ran gets the marked 401.
  function postJson(cookie: string): Request {
    return new Request("http://localhost/setup-api/hermes/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `clawbox_session=${cookie}` },
      body: JSON.stringify({ message: "Run the long job and tell me how it went" }),
    });
  }

  it("is the session gate's marked 401, not the reply — which is still recorded", async () => {
    const turn = gatedTurn();
    const pending = POST(postJson(mint(nowS() + 600)));
    await vi.waitFor(() => expect(openTurnMock).toHaveBeenCalled());
    writeConfig(1);
    turn.release();
    const res = await pending;
    expect(res.status).toBe(401);
    expect(res.headers.get("x-clawbox-session")).toBe("expired");
    await vi.waitFor(() => expect(records().some((r) => r.role === "assistant")).toBe(true));
  });

  it("is the reply while the session holds", async () => {
    const turn = gatedTurn();
    const pending = POST(postJson(mint(nowS() + 600)));
    await vi.waitFor(() => expect(openTurnMock).toHaveBeenCalled());
    turn.release();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ text: "The first half, and the rest.", harness: "hermes" });
  });
});
