import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Hermes chat route, asked to run a slash command.
 *
 * The defect this exists to prevent is a quiet one: `/status` down either of
 * the route's two ordinary transports reaches the MODEL, not the harness.
 * `prompt.submit` submits it as a prompt and `hermes chat -q "/status"` passes
 * it as the query — so a composer that offers the harness's own command list
 * would offer commands that then do nothing but make the model talk about
 * itself. The only thing that runs a Hermes command is `slash.exec`.
 *
 * So what is pinned here is the ROUTING: a command-shaped message reaches the
 * command path and neither transport; an ordinary message still reaches the
 * transports and never the command path; and a box whose dashboard cannot
 * answer falls through to the CLI instead of failing the turn.
 */

const slashMock = vi.hoisted(() => vi.fn());
const openTurnMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const appendMock = vi.hoisted(() => vi.fn());
const readTurnMock = vi.hoisted(() => vi.fn());

// PARTIAL: `withSessionModelNote` is the route's own wording of a session-only
// model switch and is exactly what two of the cases below assert, so it stays
// real; only the socket-opening call is replaced.
vi.mock("@/lib/hermes-slash-exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-slash-exec")>()),
  runHermesSlashCommand: slashMock,
}));
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
  chatMediaRoot: vi.fn(async () => `/tmp/clawbox-slash-media-${process.pid}`),
}));
vi.mock("@/lib/hermes-model-options", () => ({
  getModelOptions: vi.fn(async () => null),
  isAllowedProvider: vi.fn(() => true),
  isPairAllowed: vi.fn(() => true),
  shouldEnforcePairing: vi.fn(() => false),
  // Reached only by the attachment path below; a module mock that omits an
  // export the route imports fails as a missing-export error rather than as
  // the assertion it was written for.
  readCurrentFromCli: vi.fn(async () => ({ provider: "", model: "" })),
}));

import { POST } from "@/app/setup-api/hermes/chat/route";

/** The shape the route validates a Hermes session id against. */
const SESSION_ID = "20260917_101500_a1b2c3";

/** A dashboard turn that would answer as the MODEL — never wanted here. */
function modelTurn(text: string) {
  return {
    sessionId: "20260917_101500_a1b2c3",
    model: "",
    provider: "",
    async run() {
      return { text, reasoning: "", status: "complete" };
    },
    close() {},
  };
}

function post(body: Record<string, unknown>, stream = false): Request {
  return new Request("http://localhost/setup-api/hermes/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(stream ? { accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify(body),
  });
}

/**
 * What `runHermesSlashCommand` answers: the output, the stored session id, and
 * what Hermes announced the session's model to be afterwards (blank unless a
 * case is about that).
 */
function slashResult(output: string, sessionModel = "", sessionProvider = "") {
  return { output, sessionId: SESSION_ID, sessionModel, sessionProvider };
}

/** Every assistant line the route recorded in the durable transcript. */
function recordedReplies(): string[] {
  return appendMock.mock.calls
    .map(([record]) => record as Record<string, unknown>)
    .filter((r) => r.role === "assistant")
    .map((r) => String(r.text ?? ""));
}

beforeEach(() => {
  slashMock.mockReset();
  openTurnMock.mockReset();
  openTurnMock.mockResolvedValue(modelTurn("the model talking about slashes"));
  spawnMock.mockReset();
  appendMock.mockReset();
  appendMock.mockResolvedValue(true);
  readTurnMock.mockReset();
  readTurnMock.mockResolvedValue(null);
});

describe("a slash command typed into the Hermes chat", () => {
  it("runs it as a COMMAND, and never as a prompt", async () => {
    slashMock.mockResolvedValue(slashResult("Session · gemma · 1.2k tokens"));
    const res = await POST(post({ message: "/status", sessionId: SESSION_ID }, true));

    expect(slashMock).toHaveBeenCalledTimes(1);
    expect(slashMock.mock.calls[0][0]).toMatchObject({ command: "/status", sessionId: SESSION_ID });
    // Neither transport was reached: the model never saw the word.
    expect(openTurnMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      text: "Session · gemma · 1.2k tokens",
      harness: "hermes",
      sessionId: SESSION_ID,
    });
  });

  it("records the output in the durable transcript, so a refresh keeps it", async () => {
    slashMock.mockResolvedValue(slashResult("Session · gemma"));
    await POST(post({ message: "/status", sessionId: SESSION_ID }));
    expect(recordedReplies()).toEqual(["Session · gemma"]);
  });

  it("carries the command's own text through, arguments included", async () => {
    slashMock.mockResolvedValue(slashResult("done"));
    await POST(post({ message: "/undo 2", sessionId: SESSION_ID }));
    expect(slashMock.mock.calls[0][0].command).toBe("/undo 2");
  });

  it("says so when the command switched THIS conversation's model only", async () => {
    // The defect: Hermes answers `/model gpt-5.6-sol` with its own success
    // line, the switch is real and per-session, and the next ordinary turn
    // re-points the session at the model this chat carries — so the owner was
    // told a switch had happened that was silently undone one message later.
    slashMock.mockResolvedValue(slashResult("Switched to gpt-5.6-sol", "gpt-5.6-sol", "openai"));
    const res = await POST(post({ message: "/model gpt-5.6-sol", sessionId: SESSION_ID, model: "deepseek-v4-flash" }));

    const { text } = (await res.json()) as { text: string };
    // Hermes' own words first, untouched.
    expect(text.startsWith("Switched to gpt-5.6-sol")).toBe(true);
    // …then ClawBox's, naming the model the NEXT message will assert and the
    // two ways to make the change stick.
    expect(text).toContain("deepseek-v4-flash");
    expect(text).toContain("--global");
    // And the transcript carries the caveat too, or a refresh would restore
    // the false success this removes.
    expect(recordedReplies()).toEqual([text]);
  });

  it("says nothing when the session and the next turn already agree", async () => {
    // `/model … --global` writes Hermes' config.yaml, which is the file the
    // chat header reads, so the two end up on the same model and there is
    // nothing to warn about. Nothing here parses the flag — the agreement is
    // measured, which is why a `--global` switch needs no special case.
    slashMock.mockResolvedValue(slashResult("Switched to deepseek-v4-flash", "deepseek-v4-flash", "clawai"));
    const res = await POST(post({ message: "/model deepseek-v4-flash --global", sessionId: SESSION_ID, model: "deepseek-v4-flash" }));
    expect((await res.json()).text).toBe("Switched to deepseek-v4-flash");
  });

  it("says nothing when the turn carried no model to be switched back to", async () => {
    // The full-screen chat has no model picker and sends none, so
    // `openDashboardTurn` re-points nothing and the switch survives. A warning
    // there would be a false one.
    slashMock.mockResolvedValue(slashResult("Switched to gpt-5.6-sol", "gpt-5.6-sol", "openai"));
    const res = await POST(post({ message: "/model gpt-5.6-sol", sessionId: SESSION_ID }));
    expect((await res.json()).text).toBe("Switched to gpt-5.6-sol");
  });

  it("leaves an ordinary message to the ordinary transports", async () => {
    await POST(post({ message: "what does /status show?" }, true));
    expect(slashMock).not.toHaveBeenCalled();
    expect(openTurnMock).toHaveBeenCalledTimes(1);
  });

  it("leaves a message that merely OPENS with a path to the transports", async () => {
    // `/home/clawbox/notes.md` is not a command, and treating it as one would
    // answer a customer's question with "unknown command".
    await POST(post({ message: "/home/clawbox/notes.md — read this" }, true));
    expect(slashMock).not.toHaveBeenCalled();
    expect(openTurnMock).toHaveBeenCalledTimes(1);
  });

  it("leaves a command-shaped message CARRYING A PICTURE to the ordinary transports", async () => {
    // The command path has nowhere to put an attachment, and the user turn has
    // already been recorded WITH its media — so running the command and
    // dropping the file would show the owner their screenshot in the transcript
    // over an answer that never saw it.
    slashMock.mockResolvedValue(slashResult("ran"));
    await POST(post({ message: "/save", imagePaths: ["shot.png"] }, true));
    expect(slashMock).not.toHaveBeenCalled();
  });

  it("falls through to the ordinary path when the dashboard cannot be reached", async () => {
    // Null is "this transport is unavailable", not "the command failed": the
    // owner gets the same answer they got before this branch existed, rather
    // than an error over a box that is merely running its CLI transport.
    slashMock.mockResolvedValue(null);
    await POST(post({ message: "/status" }, true));
    expect(slashMock).toHaveBeenCalledTimes(1);
    expect(openTurnMock).toHaveBeenCalledTimes(1);
  });
});
