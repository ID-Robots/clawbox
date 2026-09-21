/**
 * /setup-api/coding-agent/message — telling a run that is still going
 * something.
 *
 * The gate is the run-lifecycle factory's, which is the point: agent-callable
 * like starting and stopping a run, with a run the OWNER started answering the
 * MCP bearer 403 whatever state it is in. A prompt-injected "tell that run to
 * delete the tests" must not reach work the person at the desk asked for.
 *
 * Beyond the gate: every refusal carries a stable `code` beside its English
 * sentence, each with the status a caller can act on, and the answer says
 * WHICH delivery happened rather than a flat "sent".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

const getRun = vi.hoisted(() => vi.fn());
const queueRunMessage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/coding-agent")>("@/lib/coding-agent");
  return { ...actual, getRun, queueRunMessage };
});

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";
const AGENT_RUN = { id: "run-k3x9q2ab", status: "running", source: "agent" };
const OWNER_RUN = { ...AGENT_RUN, source: "owner" };

type Handler = (req: Request) => Promise<Response>;
let POST: Handler;
let RunMessageError: typeof import("@/lib/coding-run-messages").RunMessageError;
let CodingAgentError: typeof import("@/lib/coding-agent").CodingAgentError;
let MAX_RUN_MESSAGE_CHARS: number;
let session: SessionFixture;
let restore: () => void;

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  vi.resetModules();
  vi.clearAllMocks();
  getRun.mockReturnValue(AGENT_RUN);
  queueRunMessage.mockReturnValue({ run: { ...AGENT_RUN, messages: [] }, delivered: true });
  const messages = await import("@/lib/coding-run-messages");
  RunMessageError = messages.RunMessageError;
  MAX_RUN_MESSAGE_CHARS = messages.MAX_RUN_MESSAGE_CHARS;
  CodingAgentError = (await import("@/lib/coding-agent")).CodingAgentError;
  POST = (await import("@/app/setup-api/coding-agent/message/route")).POST;
});

afterEach(() => {
  session.cleanup();
  restore();
});

function post(
  body: unknown,
  auth: "cookie" | "bearer" | "none" = "cookie",
  origin?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", host: "localhost" };
  if (auth === "cookie") headers.Cookie = session.cookie;
  if (auth === "bearer") headers.Authorization = `Bearer ${MCP_TOKEN}`;
  if (origin !== undefined) headers.Origin = origin;
  return POST(new Request("http://localhost/setup-api/coding-agent/message", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
}

describe("the gate", () => {
  it("is 401 with no session, and queues nothing", async () => {
    expect((await post({ runId: AGENT_RUN.id, text: "hi" }, "none")).status).toBe(401);
    expect(queueRunMessage).not.toHaveBeenCalled();
  });

  it("needs a run id", async () => {
    expect((await post({ text: "hi" })).status).toBe(400);
    expect(queueRunMessage).not.toHaveBeenCalled();
  });

  it("takes the `id` alias the other run routes take", async () => {
    expect((await post({ id: AGENT_RUN.id, text: "hi" })).status).toBe(200);
    expect(queueRunMessage).toHaveBeenCalledWith(AGENT_RUN.id, "hi");
  });

  it("is a JSON 404 for a run this box does not have", async () => {
    getRun.mockReturnValue(null);
    const res = await post({ runId: "run-nope", text: "hi" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ kind: "not_found" });
    expect(queueRunMessage).not.toHaveBeenCalled();
  });

  it("refuses the MCP bearer on a run the OWNER started, and lets it message its own", async () => {
    getRun.mockReturnValue(OWNER_RUN);
    const refused = await post({ runId: OWNER_RUN.id, text: "hi" }, "bearer");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ kind: "owner_only" });
    expect(queueRunMessage).not.toHaveBeenCalled();

    getRun.mockReturnValue(AGENT_RUN);
    expect((await post({ runId: AGENT_RUN.id, text: "hi" }, "bearer")).status).toBe(200);
  });

  it("lets the OWNER's own cookie through on their own run", async () => {
    getRun.mockReturnValue(OWNER_RUN);
    expect((await post({ runId: OWNER_RUN.id, text: "hi" })).status).toBe(200);
  });

  it("refuses another site's page even with the owner's cookie on it", async () => {
    // Unlike stop and pause, this route puts WORDS in front of a shell that
    // edits files. A form posted as text/plain from anywhere on the web carries
    // the cookie and needs no preflight, so the origin is checked too.
    const res = await post({ runId: AGENT_RUN.id, text: "rm -rf everything" }, "cookie", "https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "cross_origin" });
    expect(queueRunMessage).not.toHaveBeenCalled();
  });

  it("lets our own page and a header-less caller through", async () => {
    expect((await post({ runId: AGENT_RUN.id, text: "hi" }, "cookie", "http://localhost")).status).toBe(200);
    // The MCP server sends no Origin at all; its gate is the run's source.
    expect((await post({ runId: AGENT_RUN.id, text: "hi" }, "bearer")).status).toBe(200);
  });
});

describe("the answer", () => {
  it("says the harness has it when the message went into the live session", async () => {
    queueRunMessage.mockReturnValue({
      run: { ...AGENT_RUN, messages: [{ at: 1, text: "hi", deliveredAt: 2 }] },
      delivered: true,
    });
    const res = await post({ runId: AGENT_RUN.id, text: "hi" });
    const body = await res.json();
    expect(body.queued).toBe(true);
    expect(body.delivered).toBe(true);
    expect(body.run.messages[0].deliveredAt).toBe(2);
    expect(body.limits.maxChars).toBe(MAX_RUN_MESSAGE_CHARS);
  });

  it("says it is only QUEUED when the box could not hand it over", async () => {
    queueRunMessage.mockReturnValue({
      run: { ...AGENT_RUN, messages: [{ at: 1, text: "hi", deliveredAt: null }] },
      delivered: false,
    });
    const body = await (await post({ runId: AGENT_RUN.id, text: "hi" })).json();
    expect(body.queued).toBe(true);
    expect(body.delivered).toBe(false);
  });
});

describe("the refusals", () => {
  const cases: [string, string, number][] = [
    ["empty", "A message is required.", 400],
    ["not_plain_text", "A message must be plain text.", 400],
    ["too_long", "That message is too long.", 413],
    ["queue_full", "Too many waiting.", 409],
    ["settled", "That run has finished.", 409],
  ];

  for (const [code, sentence, status] of cases) {
    it(`answers ${code} as ${status}, with the code beside the sentence`, async () => {
      queueRunMessage.mockImplementation(() => {
        throw new RunMessageError(code as never, sentence);
      });
      const res = await post({ runId: AGENT_RUN.id, text: "hi" });
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: sentence, code });
    });
  }

  it("leaves anything else to the factory's own table", async () => {
    queueRunMessage.mockImplementation(() => {
      throw new CodingAgentError("not_found", "There is no coding run with that id.");
    });
    const res = await post({ runId: AGENT_RUN.id, text: "hi" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ kind: "not_found" });
  });

  it("is 400 for a body that is not JSON at all", async () => {
    const res = await POST(new Request("http://localhost/setup-api/coding-agent/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: session.cookie },
      body: "{oops",
    }));
    expect(res.status).toBe(400);
    expect(queueRunMessage).not.toHaveBeenCalled();
  });

  it("hands the library whatever `text` was, so one reader decides what a message is", async () => {
    // The route does not validate: `normalizeRunMessage` is the single reader,
    // shared with the MCP tool's device call, so the two cannot disagree.
    await post({ runId: AGENT_RUN.id, text: 42 });
    expect(queueRunMessage).toHaveBeenCalledWith(AGENT_RUN.id, 42);
  });
});
