// email_connect: connect a mailbox from chat. The three limits that make it
// safe to offer to an agent — never replaces an existing account, always
// "ask before sending", never the "answer senders" mode — and the password
// never coming back in a result.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerEmailTools } from "../../../mcp/tools/email";
import { ToolError } from "../../../mcp/lib/errors";
import type { RegisteredToolInfo, ToolHandler, ToolOpts } from "../../../mcp/lib/register";
import type { Shape } from "../../../mcp/lib/schema";

function connectTool(): { info: RegisteredToolInfo; handler: ToolHandler } {
  const tools = new Map<string, { info: RegisteredToolInfo; handler: ToolHandler }>();
  registerEmailTools({
    tool(name: string, description: string, shape: Shape, opts: ToolOpts, handler: ToolHandler) {
      tools.set(name, { info: { name, description, params: Object.keys(shape), shape, opts }, handler });
    },
    remove: (name: string) => void tools.delete(name),
    list: () => [...tools.values()].map((t) => t.info),
    finalize: () => undefined,
  }, { emailCanRead: false });
  return tools.get("email_connect")!;
}

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ARGS = { address: "me@example.com", app_password: "abcd efgh ijkl mnop", mode: "read", confirm: true };

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("email_connect", () => {
  it("is offered on both editions, as a write that needs confirm", () => {
    const { info } = connectTool();
    expect(info.opts.editions).toEqual(["openclaw", "hermes"]);
    expect(info.opts.readOnly).not.toBe(true);
    expect(info.params).toContain("confirm");
    expect(info.shape.mode.safeParse("answer").success).toBe(false);
  });

  it("refuses to replace an account that is already connected", async () => {
    const fetch = vi.fn(async () => reply(200, { configured: true, address: "owner@example.com" }));
    vi.stubGlobal("fetch", fetch);
    const err = (await Promise.resolve(connectTool().handler(ARGS)).catch((e: unknown) => e)) as ToolError;
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe("CONFLICT");
    expect(err.next).toMatch(/Settings/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("forces ask-before-send on, strips spaces from the app password and never returns it", async () => {
    const calls: { url: string; body?: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return String(url).includes("/email/status") ? reply(200, { configured: false }) : reply(200, { success: true });
    }));
    const result = await connectTool().handler(ARGS);
    const save = calls.find((c) => c.url.includes("/email/configure"))!;
    expect(save.body).toMatchObject({ address: "me@example.com", password: "abcdefghijklmnop", smtpHost: "smtp.gmail.com", mode: "read", askBeforeSend: true });
    expect(JSON.stringify(result)).not.toContain("abcd");
    expect(JSON.stringify(result)).toMatch(/connected/);
  });

  it("turns a refused login into one plain sentence and no retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("/email/status") ? reply(200, { configured: false }) : reply(400, { error: "The password was not accepted.", kind: "auth" })));
    const err = (await Promise.resolve(connectTool().handler(ARGS)).catch((e: unknown) => e)) as ToolError;
    expect(err.code).toBe("BAD_ARGUMENT");
    expect(err.message).toMatch(/password was not accepted/);
    expect(err.next).toMatch(/Do not retry/);
  });
});
