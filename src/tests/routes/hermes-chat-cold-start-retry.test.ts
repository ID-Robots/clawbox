import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The first message after Hermes restarts (TASK-2152).
 *
 * Found on a board: after the gateway's idle exit, and after a provider or
 * model switch, the first message of an ongoing chat failed with a red
 * "Error: Error: permission_denied" and the same message sent again worked.
 * One dashboard turn could not be opened, the route fell back to `hermes chat
 * -q --resume`, and from v0.22.4 that CLI is refused a conversation the
 * dashboard owns — `Error: permission_denied` on stderr, exit 1.
 *
 * Pinned here, against the route itself:
 *   - that refusal, on a resumed turn the dashboard could take, waits for the
 *     dashboard and opens the SAME turn there once, and the owner gets the
 *     answer on the first send;
 *   - once means once: a retry that cannot open either ends the turn with a
 *     sentence, never another round and never the raw code;
 *   - nothing else is retried — another CLI failure, a new conversation, a
 *     turn the dashboard never could take;
 *   - and no failure reaches the owner as "Error: Error: …".
 */

const openTurnMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const appendMock = vi.hoisted(() => vi.fn());
const waitMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-dashboard-turn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-dashboard-turn")>()),
  openDashboardTurn: openTurnMock,
}));
// The wait is the library's own to prove (hermes-session-refusal.test.ts);
// here it only has to say whether the dashboard came back.
vi.mock("@/lib/hermes-session-refusal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-session-refusal")>()),
  waitForDashboard: waitMock,
}));
vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("@/lib/harness/transcript-store", () => ({ appendTranscript: appendMock }));
vi.mock("@/lib/harness/hermes-turn-record", () => ({
  readHermesTurn: async () => null,
  readHermesUsageMarks: async () => null,
  readHermesBillingProvider: async () => "",
}));
vi.mock("@/lib/harness/media-root", () => ({
  resolveInMediaRoot: vi.fn(async (p: string) => p),
  chatMediaRoot: vi.fn(async () => `/tmp/clawbox-cold-start-media-${process.pid}`),
}));
vi.mock("@/lib/hermes-model-options", () => ({
  getModelOptions: vi.fn(async () => null),
  readCurrentFromCli: vi.fn(async () => ({ provider: "", model: "", reasoning: "" })),
  isAllowedProvider: vi.fn(() => true),
  isPairAllowed: vi.fn(() => true),
  shouldEnforcePairing: vi.fn(() => false),
}));

import { POST } from "@/app/setup-api/hermes/chat/route";
import { resetLiveTurns, stopLiveTurns } from "@/lib/harness/hermes-live-turn";
import { SESSION_REFUSED_MESSAGE, SESSION_REFUSED_PICTURE_MESSAGE } from "@/lib/hermes-session-refusal";

const SESSION = "20261104_090334_5e1f0a";

/** What the CLI printed on the board when it was refused the conversation. */
const REFUSED_STDERR = [
  `↻ Resumed session ${SESSION} "Remember the word" (2 user messages, 6 total messages)`,
  "Error: permission_denied",
  "",
].join("\n");

/** A `hermes chat -q` child that writes `stderr` and exits with `code`. */
function cliChild(stderr: string, code: number) {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  const child = {
    stdout: { on: (event: string, cb: (chunk: Buffer) => void) => { listeners[`stdout:${event}`] = cb as never; } },
    stderr: { on: (event: string, cb: (chunk: Buffer) => void) => { listeners[`stderr:${event}`] = cb as never; } },
    on: (event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = cb;
      // Exit once the route has listened to everything it reads.
      if (event === "close") {
        queueMicrotask(() => {
          if (stderr) listeners["stderr:data"]?.(Buffer.from(stderr));
          listeners.close?.(code);
        });
      }
    },
    kill: vi.fn(),
  };
  return child;
}

/** A dashboard turn that answers `text`. */
function answeringTurn(text: string) {
  return {
    sessionId: SESSION,
    model: "deepseek-v4-flash",
    provider: "clawai",
    async run(onDelta: (chunk: string) => void) {
      onDelta(text);
      return { text, reasoning: "", status: "complete", model: "deepseek-v4-flash", provider: "clawai" };
    },
    respondToClarify: async () => {},
    close() {},
  };
}

function post(body: Record<string, unknown>, opts: { stream?: boolean } = {}): Request {
  return new Request("http://localhost/setup-api/hermes/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.stream === false ? {} : { accept: "text/event-stream" }),
    },
    body: JSON.stringify(body),
  });
}

function parse(text: string): Array<[string, Record<string, unknown>]> {
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

const records = () => appendMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
const errorRows = () => records().filter((r) => r.variant === "error");

beforeEach(() => {
  openTurnMock.mockReset();
  spawnMock.mockReset();
  appendMock.mockReset();
  appendMock.mockResolvedValue(true);
  waitMock.mockReset();
  waitMock.mockResolvedValue(true);
  resetLiveTurns();
});

describe("the CLI refused a conversation the dashboard owns", () => {
  it("waits for the dashboard and answers through it, on the first send", async () => {
    openTurnMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(answeringTurn("lighthouse"));
    spawnMock.mockImplementation(() => cliChild(REFUSED_STDERR, 1));

    const res = await POST(post({ message: "What word did I ask you to remember?", sessionId: SESSION }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parse(await res.text());
    expect(events.find(([name]) => name === "done")?.[1]).toMatchObject({ text: "lighthouse", sessionId: SESSION });
    expect(events.some(([name]) => name === "error")).toBe(false);
    // The CLI once, the dashboard twice — and the same turn both times.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(waitMock).toHaveBeenCalledTimes(1);
    expect(openTurnMock).toHaveBeenCalledTimes(2);
    const [first, second] = openTurnMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(second.sessionId).toBe(SESSION);
    expect({ ...second, signal: undefined, onOpenFailure: undefined }).toEqual({ ...first, signal: undefined, onOpenFailure: undefined });
    expect(typeof second.onOpenFailure).toBe("function");
    // The answer is the turn's record, and no failure was written beside it.
    expect(records().find((r) => r.role === "assistant")).toMatchObject({ text: "lighthouse" });
    expect(errorRows()).toEqual([]);
  });

  it("takes the turn back to the dashboard that still holds it, too", async () => {
    // The lease's shape of the same refusal (SESSION_NOT_OWNED), captured on a
    // board while the dashboard was still holding the conversation.
    openTurnMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(answeringTurn("lighthouse"));
    spawnMock.mockImplementation(() => cliChild([
      "hermes-refusal-reason: SESSION_NOT_OWNED",
      "This chat is open in another Hermes window/terminal. Use it there, or start a new chat here.",
      "",
    ].join("\n"), 1));

    const res = await POST(post({ message: "What word did I ask you to remember?", sessionId: SESSION }));

    expect(res.status).toBe(200);
    expect(parse(await res.text()).find(([name]) => name === "done")?.[1]).toMatchObject({ text: "lighthouse" });
    expect(openTurnMock).toHaveBeenCalledTimes(2);
    expect(errorRows()).toEqual([]);
  });

  it("retries ONCE: a retry that cannot open ends the turn with a sentence", async () => {
    openTurnMock.mockResolvedValue(null);
    spawnMock.mockImplementation(() => cliChild(REFUSED_STDERR, 1));

    const res = await POST(post({ message: "Hello again", sessionId: SESSION }));

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(SESSION_REFUSED_MESSAGE);
    expect(openTurnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Neither the raw code nor a doubled prefix, in the reply or the record.
    expect(errorRows()).toHaveLength(1);
    expect(errorRows()[0].text).toBe(`Error: ${SESSION_REFUSED_MESSAGE}`);
    for (const text of [body.error, String(errorRows()[0].text)]) {
      expect(text).not.toContain("permission_denied");
      expect(text).not.toMatch(/Error:\s*Error:/);
    }
  });

  it("does not open the dashboard again when it never came back", async () => {
    openTurnMock.mockResolvedValue(null);
    waitMock.mockResolvedValue(false);
    spawnMock.mockImplementation(() => cliChild(REFUSED_STDERR, 1));

    const res = await POST(post({ message: "Hello again", sessionId: SESSION }));

    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe(SESSION_REFUSED_MESSAGE);
    expect(openTurnMock).toHaveBeenCalledTimes(1);
  });

  it("records a Stop, not a failure, when the owner stops the turn while it waits", async () => {
    openTurnMock.mockResolvedValue(null);
    spawnMock.mockImplementation(() => cliChild(REFUSED_STDERR, 1));
    // The real wait ends the moment its signal fires; so does this one.
    waitMock.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise<boolean>((resolve) => {
      signal.addEventListener("abort", () => resolve(false), { once: true });
    }));

    const pending = POST(post({ message: "Hello again", sessionId: SESSION, turnId: "turn-1" }));
    await vi.waitFor(() => expect(waitMock).toHaveBeenCalled());
    // The owner's Stop, the way DELETE delivers it.
    await stopLiveTurns("desktop", { turnId: "turn-1", waitMs: 0 });
    const res = await pending;

    expect(res.status).toBe(499);
    expect(openTurnMock).toHaveBeenCalledTimes(1);
    expect(errorRows()).toEqual([]);
    expect(records().some((r) => r.variant === "stopped")).toBe(true);
  });
});

describe("nothing else is retried", () => {
  it("leaves another CLI failure as it was, without a second Error: prefix", async () => {
    openTurnMock.mockResolvedValue(null);
    spawnMock.mockImplementation(() => cliChild("Error: Gateway could not start: runtime_exited\n", 1));

    const res = await POST(post({ message: "Hello", sessionId: SESSION }));

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Gateway could not start: runtime_exited");
    expect(errorRows()[0].text).toBe("Error: Gateway could not start: runtime_exited");
    expect(waitMock).not.toHaveBeenCalled();
    expect(openTurnMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a NEW conversation, which has nothing to reopen", async () => {
    openTurnMock.mockResolvedValue(null);
    spawnMock.mockImplementation(() => cliChild("Error: permission_denied\n", 1));

    const res = await POST(post({ message: "Hello" }));

    expect(res.status).toBe(502);
    expect(waitMock).not.toHaveBeenCalled();
    expect(openTurnMock).toHaveBeenCalledTimes(1);
    expect(((await res.json()) as { error: string }).error).not.toMatch(/^Error:/);
  });

  it("does not retry a PICTURE turn, which the dashboard cannot carry, and says so plainly", async () => {
    spawnMock.mockImplementation(() => cliChild(REFUSED_STDERR, 1));

    // `--image` is a CLI flag: a picture turn never goes to the dashboard.
    const res = await POST(post({ message: "What is this?", sessionId: SESSION, imagePaths: ["/tmp/shot.png"] }));

    expect(res.status).toBe(502);
    // Sending again would be refused the same way, so it does not say to.
    expect(((await res.json()) as { error: string }).error).toBe(SESSION_REFUSED_PICTURE_MESSAGE);
    expect(openTurnMock).not.toHaveBeenCalled();
    expect(waitMock).not.toHaveBeenCalled();
  });

  it("never doubles the prefix on a CLI line that was nothing but the opener", async () => {
    openTurnMock.mockResolvedValue(null);
    spawnMock.mockImplementation(() => cliChild("Error:\n", 1));

    const res = await POST(post({ message: "Hello", sessionId: SESSION }));

    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("Hermes chat failed");
    expect(errorRows()[0].text).toBe("Error: Hermes chat failed");
  });

  it("answers a successful CLI turn exactly as before", async () => {
    openTurnMock.mockResolvedValue(null);
    spawnMock.mockImplementation(() => {
      const child = cliChild(`session_id: ${SESSION}\n`, 0);
      const on = child.stdout.on;
      child.stdout.on = (event: string, cb: (chunk: Buffer) => void) => {
        on(event, cb);
        if (event === "data") queueMicrotask(() => cb(Buffer.from("lighthouse")));
      };
      return child;
    });

    const res = await POST(post({ message: "What word?", sessionId: SESSION }));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toBe("lighthouse");
    expect(waitMock).not.toHaveBeenCalled();
    expect(openTurnMock).toHaveBeenCalledTimes(1);
  });
});

/** An open that fails the way the real one says it did. */
function failingOpen(reason: string) {
  return async (req: { onOpenFailure?: (f: { reason: string; detail: string }) => void }) => {
    req.onOpenFailure?.({ reason, detail: `test: ${reason}` });
    return null;
  };
}

describe("a TEXT turn the page did not ask to stream (TASK-2152, reopened)", () => {
  // Found on a board after an update: the page read its `streamsTurns` fact
  // while the dashboard was restarting, kept the "no", and sent every later
  // turn without `Accept: text/event-stream`. The route used that header as
  // the gate for the dashboard, so a plain "hey" in an ongoing chat went to the
  // CLI, was refused, and was answered with the picture sentence.
  it("goes through the dashboard and is answered as JSON", async () => {
    openTurnMock.mockResolvedValue(answeringTurn("lighthouse"));

    const res = await POST(post({ message: "hey", sessionId: SESSION }, { stream: false }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ text: "lighthouse", harness: "hermes", sessionId: SESSION });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(records().find((r) => r.role === "assistant")).toMatchObject({ text: "lighthouse" });
    expect(errorRows()).toEqual([]);
  });

  it("answers a failed dashboard turn as a 502 in the CLI's shape, one Error: prefix", async () => {
    openTurnMock.mockResolvedValue({
      ...answeringTurn(""),
      async run() {
        return { text: "", reasoning: "", status: "error", error: "Error: upstream refused the request" };
      },
    });

    const res = await POST(post({ message: "hey", sessionId: SESSION }, { stream: false }));

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("upstream refused the request");
    expect(errorRows()).toHaveLength(1);
    expect(errorRows()[0].text).toBe("Error: upstream refused the request");
  });

  it("answers a Stop during the JSON turn with 499 and records it as a Stop", async () => {
    openTurnMock.mockImplementation(async (req: { signal: AbortSignal }) => ({
      ...answeringTurn(""),
      run: () => new Promise((_resolve, reject) => {
        req.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    }));

    const pending = POST(post({ message: "hey", sessionId: SESSION, turnId: "turn-json" }, { stream: false }));
    await vi.waitFor(() => expect(openTurnMock).toHaveBeenCalled());
    await stopLiveTurns("desktop", { turnId: "turn-json", waitMs: 0 });
    const res = await pending;

    expect(res.status).toBe(499);
    expect(records().some((r) => r.variant === "stopped")).toBe(true);
    expect(errorRows()).toEqual([]);
  });

  it("takes the turn back to the dashboard once the CLI is refused, and answers JSON", async () => {
    openTurnMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(answeringTurn("lighthouse"));
    spawnMock.mockImplementation(() => cliChild(REFUSED_STDERR, 1));

    const res = await POST(post({ message: "hey", sessionId: SESSION }, { stream: false }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: "lighthouse" });
    expect(openTurnMock).toHaveBeenCalledTimes(2);
    expect(waitMock).toHaveBeenCalledTimes(1);
  });

  it("is never told it was a picture", async () => {
    openTurnMock.mockResolvedValue(null);
    spawnMock.mockImplementation(() => cliChild(REFUSED_STDERR, 1));

    const res = await POST(post({ message: "hey", sessionId: SESSION }, { stream: false }));

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(SESSION_REFUSED_MESSAGE);
    expect(body.error).not.toMatch(/picture/i);
    expect(String(errorRows()[0].text)).not.toMatch(/picture/i);
  });
});

describe("a dashboard that is not ready yet — an update, a restart (TASK-2152, reopened)", () => {
  it("is waited for, and the turn opens there without the CLI detour", async () => {
    openTurnMock
      .mockImplementationOnce(failingOpen("unavailable"))
      .mockResolvedValueOnce(answeringTurn("lighthouse"));

    const res = await POST(post({ message: "hey", sessionId: SESSION }));

    expect(res.status).toBe(200);
    expect(parse(await res.text()).find(([name]) => name === "done")?.[1]).toMatchObject({ text: "lighthouse" });
    expect(waitMock).toHaveBeenCalledTimes(1);
    expect(openTurnMock).toHaveBeenCalledTimes(2);
    // The CLI would only have been refused, and would have started a gateway to be refused by.
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("is waited for when it was up but too slow to answer", async () => {
    openTurnMock
      .mockImplementationOnce(failingOpen("timeout"))
      .mockResolvedValueOnce(answeringTurn("lighthouse"));

    const res = await POST(post({ message: "hey", sessionId: SESSION }, { stream: false }));

    expect(res.status).toBe(200);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("is not waited for on a conversation the CLI started: the CLI may continue that one", async () => {
    const cliSession = `local-${"ab".repeat(32)}`;
    openTurnMock.mockImplementation(failingOpen("unavailable"));
    spawnMock.mockImplementation(() => {
      const child = cliChild(`session_id: ${cliSession}\n`, 0);
      const on = child.stdout.on;
      child.stdout.on = (event: string, cb: (chunk: Buffer) => void) => {
        on(event, cb);
        if (event === "data") queueMicrotask(() => cb(Buffer.from("lighthouse")));
      };
      return child;
    });

    const res = await POST(post({ message: "hey", sessionId: cliSession }, { stream: false }));

    expect(res.status).toBe(200);
    expect(waitMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("is not waited for when it REFUSED the conversation: the CLI comes first", async () => {
    openTurnMock
      .mockImplementationOnce(failingOpen("refused"))
      .mockResolvedValueOnce(answeringTurn("lighthouse"));
    spawnMock.mockImplementation(() => cliChild(REFUSED_STDERR, 1));

    const res = await POST(post({ message: "hey", sessionId: SESSION }));

    expect(res.status).toBe(200);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(waitMock).toHaveBeenCalledTimes(1);
  });

  it("spends the one retry once: no second wait after the CLI is refused", async () => {
    openTurnMock.mockImplementation(failingOpen("unavailable"));
    spawnMock.mockImplementation(() => cliChild(REFUSED_STDERR, 1));

    const res = await POST(post({ message: "hey", sessionId: SESSION }));

    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe(SESSION_REFUSED_MESSAGE);
    expect(waitMock).toHaveBeenCalledTimes(1);
    expect(openTurnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not open it again when it did not come back in time", async () => {
    openTurnMock.mockImplementation(failingOpen("unavailable"));
    waitMock.mockResolvedValue(false);
    spawnMock.mockImplementation(() => cliChild(REFUSED_STDERR, 1));

    const res = await POST(post({ message: "hey", sessionId: SESSION }));

    expect(res.status).toBe(502);
    expect(openTurnMock).toHaveBeenCalledTimes(1);
    expect(waitMock).toHaveBeenCalledTimes(1);
  });
});
