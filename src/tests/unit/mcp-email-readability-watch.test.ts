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
import {
  EMAIL_READABILITY_POLL_MS,
  hasMailboxSurface,
  registerEmailTools,
  watchEmailReadability,
} from "../../../mcp/tools/email";

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
    server,
    async toolNames(): Promise<string[]> {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    changes: () => listChanged,
    async call(name: string, args: Record<string, unknown>) {
      return client.callTool({ name, arguments: args });
    },
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
  // In a hook, not at the end of the body that stubs it: an assertion that
  // failed part way through would otherwise leave `fetch` stubbed for every
  // test after it, and clearAllMocks does not restore globals.
  vi.unstubAllGlobals();
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

  it("asks the device once at a time, however often it is nudged", async () => {
    // `refreshNow` returns immediately while a probe is in flight. Without that
    // guard a box slower than the interval would have two answers racing to
    // apply, and the older one could land last.
    const h = await harness(false);
    let release: (value: boolean) => void = () => {};
    const probe = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));

    const watch = watchEmailReadability(h.reg, false, { probe });
    const first = watch.refreshNow();
    const second = watch.refreshNow();
    expect(probe).toHaveBeenCalledTimes(1);

    release(true);
    await Promise.all([first, second]);
    watch.stop();

    // The one answer that WAS given still lands.
    expect(await h.toolNames()).toContain("email_list");
  });

  it("refuses a withdrawn tool at the dispatcher as well as in the list", async () => {
    // The two halves live in different places — the SDK's registry answers
    // tools/list, and mcp/lib/register.ts owns tools/call — so a withdrawal
    // that only hid the tool would still RUN it for a host calling from a list
    // it had not refreshed yet, with the mailbox gate gone from the one side
    // that is not the route's.
    const h = await harness(true);

    const watch = watchEmailReadability(h.reg, true, { probe: async () => false });
    await watch.refreshNow();
    watch.stop();

    const refusal = await h.call("email_list", { count: 1 });
    // The ENVELOPE, not a substring of English: this is ClawBox's own
    // `{ error, code, message, next }` (mcp/lib/errors.ts), and what a caller
    // acts on is `code` plus `next`. The instruction matters as much as the
    // code — a host that retries a withdrawn name manufactures the chronic
    // `isError: true` that Hermes' per-server circuit breaker counts, which is
    // the failure the whole registration gate exists to avoid.
    expect((refusal as { isError?: boolean }).isError).toBe(true);
    const envelope = JSON.parse(
      ((refusal as { content: { text: string }[] }).content[0]).text,
    ) as { error: boolean; code: string; next: string };
    expect(envelope.error).toBe(true);
    expect(envelope.code).toBe("NOT_FOUND");
    expect(envelope.next).toMatch(/do not retry/i);
    expect(envelope.next).toMatch(/tool list/i);
  });

  it("gives the agent a tool that WORKS, not just one that is listed", async () => {
    // Listing is half the contract. The dispatcher is ClawBox's own
    // (mcp/lib/register.ts installs it at finalize(), before this tool existed),
    // so a tool registered afterwards has to reach it too — otherwise the agent
    // sees the tool, calls it, and is told the device has no such thing.
    const h = await harness(false);
    let mailbox: unknown;
    vi.stubGlobal("fetch", vi.fn(async () => {
      mailbox = { total: 2, unseen: 1, messages: [] };
      return new Response(JSON.stringify(mailbox), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const watch = watchEmailReadability(h.reg, false, { probe: async () => true });
    await watch.refreshNow();
    watch.stop();

    const result = JSON.stringify(await h.call("email_list", { count: 1 }));
    expect(result).toContain("total_in_mailbox");
    expect(result).not.toContain("NOT_FOUND");
  });

  it("survives being flipped back and forth", async () => {
    // The SDK frees a removed name (`update({ name: null })`), so a second
    // registration must not throw "already registered" — and this is the only
    // shape that proves the withdrawal really freed it rather than just hiding
    // the tool from tools/list.
    const h = await harness(false);
    const answers = [true, false, true, false];
    const watch = watchEmailReadability(h.reg, false, {
      probe: async () => answers.shift() ?? null,
    });

    await watch.refreshNow();
    expect(await h.toolNames()).toContain("email_list");
    await watch.refreshNow();
    expect(await h.toolNames()).not.toContain("email_list");
    await watch.refreshNow();
    expect(await h.toolNames()).toContain("email_read");
    await watch.refreshNow();
    watch.stop();

    const names = await h.toolNames();
    for (const tool of READ_TOOLS) expect(names).not.toContain(tool);
    // …and the server is still whole: nothing above disturbed the tool the
    // mailbox surface is anchored on.
    expect(names).toContain("email_send");
    // No duplicate rows left behind by four registrations of the same names.
    expect(h.reg.list().filter((t) => t.name === "email_send")).toHaveLength(1);
  });

  it("is not armed on a profile that has no email surface at all", async () => {
    // `core` and `browser` register no email tool, so there is nothing to keep
    // in step — and a post-connect registration on a server that had registered
    // NOTHING before connecting would throw inside the poll, because that first
    // registration is what declares the tools capability.
    for (const profile of ["core", "browser"] as const) {
      const server = new McpServer({ name: "clawbox", version: "test" });
      const reg = createRegistrar(server, "openclaw", profile);
      registerEmailTools(reg, { emailCanRead: true });
      expect(reg.list().map((t) => t.name)).not.toContain("email_send");
      expect(hasMailboxSurface(reg)).toBe(false);
    }
    const full = await harness(false);
    expect(hasMailboxSurface(full.reg)).toBe(true);
  });

  it("arms the watch on a connected server, and stops it when the transport closes", async () => {
    // The production wiring, which `main()` cannot be tested through: this is
    // the line that carries the whole fix to a real box, and a disconnected
    // runtime kept alive by an in-flight request must not go on re-registering
    // tools into a server nobody is listening to.
    process.env.CLAWBOX_MCP_NO_AUTOSTART = "1";
    const { armMailboxWatch } = await import("../../../mcp/clawbox-mcp");

    const h = await harness(false);
    let closedAfter = false;
    h.server.server.onclose = () => {
      closedAfter = true;
    };
    const probe = vi.fn(async () => false);
    // The clock goes first: the interval has to be created under it.
    vi.useFakeTimers();
    armMailboxWatch(h.server, h.reg, false, { probe, intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(2_500);
    expect(probe).toHaveBeenCalledTimes(2);

    // Closing the transport stops the poll AND still runs the handler that was
    // already there.
    h.server.server.onclose?.();
    expect(closedAfter).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(probe).toHaveBeenCalledTimes(2);
    vi.useRealTimers();

    // A registrar with no email surface is not armed at all — no timer, no
    // onclose wrapper, nothing to poll for.
    const bare = new McpServer({ name: "clawbox", version: "test" });
    const bareReg = createRegistrar(bare, "openclaw", "core");
    registerEmailTools(bareReg, { emailCanRead: true });
    const bareProbe = vi.fn(async () => true);
    vi.useFakeTimers();
    armMailboxWatch(bare, bareReg, true, { probe: bareProbe, intervalMs: 1_000 });
    expect(bare.server.onclose).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(bareProbe).not.toHaveBeenCalled();
  });

  it("ships an interval an owner does not have to wait out", async () => {
    // The number the device actually runs, which no other test sees: every
    // case here injects its own.
    expect(EMAIL_READABILITY_POLL_MS).toBeLessThanOrEqual(30_000);
    expect(EMAIL_READABILITY_POLL_MS).toBeGreaterThanOrEqual(5_000);
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
