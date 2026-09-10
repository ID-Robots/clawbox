/**
 * Settings → Email must reach a RUNNING agent.
 *
 * `email_list` and `email_read` are registered conditionally, on a probe of
 * `/setup-api/email/status` taken while the MCP server boots
 * (mcp/lib/context.ts). The server is then a long-lived child of the harness,
 * so on the owner's OpenClaw box the two tools were still missing seven
 * minutes after the mode was moved to "Read on demand" — the tool list was
 * built when the mode was still "Send only" and nothing rebuilt it.
 *
 * The contract these tests hold is the MCP one: when the answer changes the
 * server re-registers (or withdraws) the pair and tells the host, which is what
 * both harnesses act on — OpenClaw's bundle MCP runtime invalidates its cached
 * catalogue on `notifications/tools/list_changed` and re-lists on the next
 * turn.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRegistrar } from "../../../mcp/lib/register";
import { registerEmailTools, watchEmailReadability } from "../../../mcp/tools/email";

const READ_TOOLS = ["email_list", "email_read"];

async function connectedServer(emailCanRead: boolean) {
  const server = new McpServer({ name: "clawbox", version: "test" });
  const reg = createRegistrar(server, "openclaw", "full");
  registerEmailTools(reg, { emailCanRead });
  reg.finalize();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-host", version: "0" });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged += 1;
  });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    reg,
    async toolNames(): Promise<string[]> {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    changes: () => listChanged,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const open: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
  vi.useRealTimers();
});

async function harness(emailCanRead: boolean) {
  const h = await connectedServer(emailCanRead);
  open.push(h);
  return h;
}

describe("mailbox readability, after the server is already running", () => {
  it("adds the read tools when the owner switches to Read on demand", async () => {
    const h = await harness(false);
    expect(await h.toolNames()).toContain("email_send");
    expect(await h.toolNames()).not.toContain("email_list");
    const before = h.changes();

    const watch = watchEmailReadability(h.reg, false, { probe: async () => true });
    await watch.refreshNow();
    watch.stop();

    const names = await h.toolNames();
    for (const tool of READ_TOOLS) expect(names).toContain(tool);
    // The host is TOLD. Without the notification OpenClaw keeps the catalogue
    // it cached when the server connected and never asks again.
    expect(h.changes()).toBeGreaterThan(before);
  });

  it("withdraws them again when the owner goes back to Send only", async () => {
    const h = await harness(true);
    expect(await h.toolNames()).toContain("email_list");
    const before = h.changes();

    const watch = watchEmailReadability(h.reg, true, { probe: async () => false });
    await watch.refreshNow();
    watch.stop();

    const names = await h.toolNames();
    for (const tool of READ_TOOLS) expect(names).not.toContain(tool);
    expect(names).toContain("email_send");
    expect(h.changes()).toBeGreaterThan(before);
  });

  it("leaves the tool list alone when the device cannot be asked", async () => {
    // A probe that could not reach the device answers null. Reading that as
    // "no" would strip a working mailbox's tools off the agent on one slow
    // moment — the false-failure shape, over an operation that never failed.
    const h = await harness(true);
    const before = h.changes();

    const watch = watchEmailReadability(h.reg, true, { probe: async () => null });
    await watch.refreshNow();
    watch.stop();

    expect(await h.toolNames()).toContain("email_list");
    expect(h.changes()).toBe(before);
  });

  it("says nothing to the host when the answer has not changed", async () => {
    // A notification per poll would invalidate the host's catalogue every
    // interval, for nothing.
    const h = await harness(true);
    const before = h.changes();

    const watch = watchEmailReadability(h.reg, true, { probe: async () => true });
    await watch.refreshNow();
    await watch.refreshNow();
    watch.stop();

    expect(h.changes()).toBe(before);
  });

  it("keeps asking on its own interval, and stop() ends it", async () => {
    vi.useFakeTimers();
    const h = await harness(false);
    const probe = vi.fn(async () => false);

    const watch = watchEmailReadability(h.reg, false, { probe, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(probe).toHaveBeenCalledTimes(3);

    watch.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(probe).toHaveBeenCalledTimes(3);
  });
});
