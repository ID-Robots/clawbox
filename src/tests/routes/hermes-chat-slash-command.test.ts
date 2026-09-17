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

vi.mock("@/lib/hermes-slash-exec", () => ({ runHermesSlashCommand: slashMock }));
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
    slashMock.mockResolvedValue({ output: "Session · gemma · 1.2k tokens", sessionId: SESSION_ID });
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
    slashMock.mockResolvedValue({ output: "Session · gemma", sessionId: SESSION_ID });
    await POST(post({ message: "/status", sessionId: SESSION_ID }));
    expect(recordedReplies()).toEqual(["Session · gemma"]);
  });

  it("carries the command's own text through, arguments included", async () => {
    slashMock.mockResolvedValue({ output: "done", sessionId: SESSION_ID });
    await POST(post({ message: "/undo 2", sessionId: SESSION_ID }));
    expect(slashMock.mock.calls[0][0].command).toBe("/undo 2");
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
    slashMock.mockResolvedValue({ output: "ran", sessionId: SESSION_ID });
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
