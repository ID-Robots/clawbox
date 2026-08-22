// The email_send tool's contract, exercised through the real registrar shape
// rather than through the whole MCP server: the two things that must never
// regress are (a) an unconfigured device produces a "stop and tell the user"
// answer rather than a retry loop, and (b) the tool is offered on BOTH editions
// — it is the only email capability the OpenClaw edition has at all.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerEmailTools } from "../../../mcp/tools/email";
import { ToolError } from "../../../mcp/lib/errors";
import type { RegisteredToolInfo, ToolHandler, ToolOpts } from "../../../mcp/lib/register";
import type { Shape } from "../../../mcp/lib/schema";

interface Captured {
  info: RegisteredToolInfo;
  handler: ToolHandler;
}

function collect(): Map<string, Captured> {
  const tools = new Map<string, Captured>();
  const reg = {
    tool(name: string, description: string, shape: Shape, opts: ToolOpts, handler: ToolHandler) {
      tools.set(name, {
        info: { name, description, params: Object.keys(shape), shape, opts },
        handler,
      });
    },
    list: () => [...tools.values()].map((t) => t.info),
    finalize: () => undefined,
  };
  registerEmailTools(reg);
  return tools;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("email_send registration", () => {
  it("is offered on both editions", () => {
    const { info } = collect().get("email_send")!;
    expect(info.opts.editions).toEqual(["openclaw", "hermes"]);
  });

  it("is not marked read-only, because a sent email cannot be recalled", () => {
    // readOnlyHint is what exempts a tool from an MCP host's approval gate.
    // ClawBox itself registers with `trust: full` — see the header of
    // mcp/tools/email.ts — so on this device the annotation buys no prompt; it
    // is still wrong to claim a send is read-only, and a host that does gate
    // must see the truth.
    const { info } = collect().get("email_send")!;
    expect(info.opts.readOnly).not.toBe(true);
  });

  it("takes exactly the three parameters a person would name", () => {
    const { info } = collect().get("email_send")!;
    expect(info.params.sort()).toEqual(["body", "subject", "to"]);
  });

  it("keeps parameter names inside the harness-safe pattern", () => {
    const { info } = collect().get("email_send")!;
    for (const param of info.params) expect(param).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
  });
});

describe("email_send behaviour", () => {
  it("refuses with a do-not-retry instruction when nothing is configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(409, { error: "not set up", kind: "unconfigured" })),
    );
    const { handler } = collect().get("email_send")!;
    const err = (await Promise.resolve(handler({ to: "a@b.com", subject: "s", body: "b" })).catch(
      (e: unknown) => e,
    )) as ToolError;

    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toMatch(/no email account/i);
    expect(err.next).toMatch(/Do not retry/i);
    // The remedy names the exact place a person has to go.
    expect(err.next).toMatch(/Settings/);
    vi.unstubAllGlobals();
  });

  it("reports a mail-server refusal without inviting a retry storm", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(502, { error: "refused", kind: "blocked" })));
    const { handler } = collect().get("email_send")!;
    const err = (await Promise.resolve(handler({ to: "a@b.com", subject: "s", body: "b" })).catch(
      (e: unknown) => e,
    )) as ToolError;
    expect(err.code).toBe("ENDPOINT_DOWN");
    expect(err.next).toMatch(/not retry more than once/i);
    vi.unstubAllGlobals();
  });

  it("treats an exhausted send budget as a stop, not a retry", async () => {
    // The budget exists to bound a looping or prompt-injected agent; an agent
    // that retries on 429 is the exact failure it is there to stop.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(429, { error: "budget spent", kind: "rate_limited" })),
    );
    const { handler } = collect().get("email_send")!;
    const err = (await Promise.resolve(handler({ to: "a@b.com", subject: "s", body: "b" })).catch(
      (e: unknown) => e,
    )) as ToolError;
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toMatch(/this hour/i);
    // Not the generic 429 mapping, which says "retry once".
    expect(err.next).toMatch(/Do not retry/i);
    vi.unstubAllGlobals();
  });

  it("returns the send result on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { success: true, messageId: "x@y", recipients: 1 })),
    );
    const { handler } = collect().get("email_send")!;
    const result = await Promise.resolve(handler({ to: "a@b.com", subject: "s", body: "b" }));
    expect(JSON.parse(result.content[0].type === "text" ? result.content[0].text : "{}")).toMatchObject({
      sent: true,
      recipients: 1,
    });
    vi.unstubAllGlobals();
  });
});
