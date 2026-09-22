/**
 * The MCP server has to hang up on itself.
 *
 * A harness spawns one `bun run mcp/clawbox-mcp.ts` per SESSION KEY and holds
 * it for its own lifetime. Measured on a v4.0.0 box (OpenClaw core 2026.9.3):
 * three turns on three keys left three processes alive, all still there after
 * 90 s of silence, and a ten-prompt run left NINE resident at 63–70 MB each,
 * reaped only by restarting the gateway. Reconnecting costs 0.31–0.35 s plus
 * 0.02 s to re-list the tools, and the gateway does it on its own — so the
 * server exits itself instead.
 *
 * What is held here is the rule, not the number: every request resets the
 * clock, a request still in flight defers the exit for as long as it runs (a
 * `bash` command that sleeps past the period must not be cut off), `0` disables
 * the whole thing, and arming it leaves any close handler already installed —
 * `armMailboxWatch`'s — still running. The clock is injected, so none of it
 * waits on a real timer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// The module claims stdio the moment it is imported, so the autostart guard has
// to be set before the import — and `vi.hoisted` is the only thing that runs
// before one. mcp/check-tools.ts sets the same variable for the same reason.
vi.hoisted(() => {
  process.env.CLAWBOX_MCP_NO_AUTOSTART = "1";
});
import {
  armIdleExit,
  armMailboxWatch,
  IDLE_EXIT_DEFAULT_MS,
  resolveIdleExitMs,
  type IdleExit,
} from "../../../mcp/clawbox-mcp";
import { createRegistrar } from "../../../mcp/lib/register";
import { registerEmailTools } from "../../../mcp/tools/email";

const IDLE_MS = 60_000;

/**
 * One turn of the real event loop.
 *
 * The clock under test is injected, so the global timers are untouched and this
 * is a genuine macrotask: it lets the SDK finish putting a message on the wire
 * before the test asks what is in flight. Never called under
 * `vi.useFakeTimers()`.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A clock the test drives by hand.
 *
 * Deliberately not `vi.useFakeTimers()`: the seam under test is the one the
 * production default fills with `setTimeout(...).unref()`, and a test that
 * replaced the global would be proving something about vitest's timer
 * replacement instead. `pending` is how "armed or not" is asserted without
 * reaching inside the closure.
 */
function fakeClock() {
  const timers = new Map<number, { at: number; fire: () => void }>();
  let now = 0;
  let seq = 0;
  return {
    setTimer(fire: () => void, ms: number): unknown {
      const id = (seq += 1);
      timers.set(id, { at: now + ms, fire });
      return id;
    },
    clearTimer(handle: unknown): void {
      timers.delete(handle as number);
    },
    /** Run every timer due within `ms`, in order, at its own due time. */
    advance(ms: number): void {
      const until = now + ms;
      for (;;) {
        let dueId: number | null = null;
        let due: { at: number; fire: () => void } | null = null;
        for (const [id, timer] of timers) {
          if (timer.at <= until && (due === null || timer.at < due.at)) {
            dueId = id;
            due = timer;
          }
        }
        if (due === null || dueId === null) break;
        timers.delete(dueId);
        now = due.at;
        due.fire();
      }
      now = until;
    },
    pending: () => timers.size,
  };
}

type Harness = {
  server: McpServer;
  client: Client;
  transport: Transport;
  close(): Promise<void>;
};

const open: Harness[] = [];

afterEach(async () => {
  for (const h of open.splice(0)) {
    await h.close().catch(() => {});
  }
  vi.restoreAllMocks();
  delete process.env.CLAWBOX_MCP_IDLE_EXIT_MS;
});

/**
 * A real client on a real transport pair, connected the way `main()` connects.
 *
 * `slow` is a tool whose handler waits on a gate the test opens, which is the
 * only honest way to hold a request "in flight": the SDK decides when a
 * response goes out, and that decision is exactly what the deferral depends on.
 */
async function connected(): Promise<
  Harness & { openGate: () => void; gateWasOpened: () => boolean }
> {
  const server = new McpServer({ name: "clawbox", version: "test" });
  let release: (() => void) | null = null;
  let opened = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.registerTool("slow", { description: "waits until the test lets it go" }, async () => {
    await gate;
    return { content: [{ type: "text" as const, text: "woke" }] };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-host", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const h = {
    server,
    client,
    transport: serverTransport as Transport,
    openGate: () => {
      opened = true;
      release?.();
    },
    gateWasOpened: () => opened,
    async close() {
      // Let a held handler finish rather than leaving a promise pending for the
      // rest of the file.
      release?.();
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
  open.push(h);
  return h;
}

/** Arm the idle rule on a connected server with the test's own clock. */
function arm(
  h: Harness,
  overrides: Partial<{ idleMs: number; exit: () => void; log: (line: string) => void }> = {},
): { idle: IdleExit | null; clock: ReturnType<typeof fakeClock>; exits: () => number; lines: string[] } {
  const clock = fakeClock();
  const lines: string[] = [];
  let exits = 0;
  const idle = armIdleExit(h.server, h.transport, {
    idleMs: IDLE_MS,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: (line) => lines.push(line),
    exit: () => {
      exits += 1;
    },
    ...overrides,
  });
  return { idle, clock, exits: () => exits, lines };
}

describe("the MCP server's idle self-exit", () => {
  it("exits after the idle period, once, and says why on stderr", async () => {
    const h = await connected();
    const { clock, exits, lines } = arm(h);

    clock.advance(IDLE_MS - 1);
    expect(exits()).toBe(0);
    clock.advance(1);
    expect(exits()).toBe(1);
    // The line the gateway journal is read for. Seconds, not milliseconds: it
    // is for a person looking at why the server they were talking to is gone.
    expect(lines).toEqual([
      "[clawbox-mcp] idle for 60s with no request in flight;"
      + " exiting so the harness reconnects on the next call",
    ]);

    // Nothing is left armed to fire a second time.
    clock.advance(IDLE_MS * 10);
    expect(exits()).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it("closes the transport and exits 0 when nothing overrides the exit", async () => {
    // The production path, with only `process.exit` held back: a harness that
    // got a dead pipe instead of a close would report an error rather than
    // "next request reconnects".
    const h = await connected();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    let clientSawClose = false;
    h.client.onclose = () => {
      clientSawClose = true;
    };
    const clock = fakeClock();
    armIdleExit(h.server, h.transport, {
      idleMs: IDLE_MS,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    clock.advance(IDLE_MS);
    // `close()` is async; the client learns of it on the next turn of the loop.
    await settle();
    expect(exit).toHaveBeenCalledWith(0);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("no request in flight");
    expect(clientSawClose).toBe(true);
  });

  it("is reset by every request, including the ones no handler here sees", async () => {
    const h = await connected();
    const { clock, exits } = arm(h);

    clock.advance(IDLE_MS - 1_000);
    await h.client.listTools();
    // The list request put the clock back to zero: what was 1 s from firing is
    // now a full period away, so the same advance again lands short of it.
    clock.advance(IDLE_MS - 1_000);
    expect(exits()).toBe(0);

    // `ping` is answered by the SDK's own Protocol and never reaches a handler
    // this file could wrap — the transport is the seam precisely so it counts.
    await h.client.ping();
    clock.advance(IDLE_MS - 1_000);
    expect(exits()).toBe(0);

    // Two near-misses in a row, and only silence gets there.
    clock.advance(1_000);
    expect(exits()).toBe(1);
  });

  it("defers for as long as a request is in flight, however long that is", async () => {
    // The `bash` case: a command that sleeps past the idle period is not cut
    // off under the agent, and the clock only starts again once its result has
    // actually gone back.
    const h = await connected();
    const { idle, clock, exits } = arm(h);
    expect(idle).not.toBeNull();

    const call = h.client.callTool({ name: "slow", arguments: {} });
    await settle();
    expect(idle?.inFlight()).toBe(1);
    // No timer exists at all while the server owes an answer.
    expect(clock.pending()).toBe(0);

    clock.advance(IDLE_MS * 10);
    expect(exits()).toBe(0);
    expect(h.gateWasOpened()).toBe(false);

    h.openGate();
    await expect(call).resolves.toMatchObject({ content: [{ text: "woke" }] });
    expect(idle?.inFlight()).toBe(0);

    clock.advance(IDLE_MS - 1);
    expect(exits()).toBe(0);
    clock.advance(1);
    expect(exits()).toBe(1);
  });

  it("releases a cancelled request, which the SDK never answers", async () => {
    // `Protocol._onrequest` aborts a cancelled request and deliberately sends
    // NOTHING back. An id left held by that would pin this process open for the
    // life of the gateway — the exact shape the whole change exists to remove.
    const h = await connected();
    const { idle, clock, exits } = arm(h);

    const abort = new AbortController();
    const call = h.client
      .callTool({ name: "slow", arguments: {} }, undefined, { signal: abort.signal })
      .catch(() => "cancelled");
    await settle();
    expect(idle?.inFlight()).toBe(1);

    abort.abort(new Error("host gave up"));
    await expect(call).resolves.toBe("cancelled");
    await settle();
    expect(idle?.inFlight()).toBe(0);

    clock.advance(IDLE_MS);
    expect(exits()).toBe(1);
  });

  it("does nothing at all when the period is 0", async () => {
    const h = await connected();
    const onmessage = h.transport.onmessage;
    const send = h.transport.send;

    const { idle, clock, exits } = arm(h, { idleMs: 0 });
    expect(idle).toBeNull();
    // Disabled means UNWRAPPED, not "wrapped with an unreachable timer".
    expect(h.transport.onmessage).toBe(onmessage);
    expect(h.transport.send).toBe(send);
    expect(clock.pending()).toBe(0);

    await h.client.listTools();
    clock.advance(IDLE_MS * 100);
    expect(exits()).toBe(0);
  });

  it("chains onto the close handler already there, and stops with the transport", async () => {
    // `main()` arms the mailbox watch first and this second, so this wrapper is
    // the outer of the two: the poll must still stop, and the timer must not
    // outlive a connection nobody is on the other end of.
    const h = await connected();
    const reg = createRegistrar(h.server, "openclaw", "full");
    registerEmailTools(reg, { emailCanRead: false });
    const probe = vi.fn(async () => false);
    vi.useFakeTimers();
    armMailboxWatch(h.server, reg, false, { probe, intervalMs: 1_000 });
    const mailboxWrapper = h.server.server.onclose;
    expect(mailboxWrapper).toBeTypeOf("function");

    const { clock, exits } = arm(h);
    expect(h.server.server.onclose).not.toBe(mailboxWrapper);

    await vi.advanceTimersByTimeAsync(2_500);
    expect(probe).toHaveBeenCalledTimes(2);

    // Closed through the real transport, not by calling the hook: that the SDK
    // reaches `onclose` at all is its behaviour, and a test that invoked the
    // handler itself would keep passing over an SDK that stopped.
    await h.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(probe).toHaveBeenCalledTimes(2);
    vi.useRealTimers();

    expect(clock.pending()).toBe(0);
    clock.advance(IDLE_MS * 10);
    expect(exits()).toBe(0);
  });

  it("reads CLAWBOX_MCP_IDLE_EXIT_MS, and refuses to read a typo as 'off'", () => {
    expect(IDLE_EXIT_DEFAULT_MS).toBe(600_000);
    expect(resolveIdleExitMs(undefined)).toBe(IDLE_EXIT_DEFAULT_MS);
    expect(resolveIdleExitMs("")).toBe(IDLE_EXIT_DEFAULT_MS);
    expect(resolveIdleExitMs("  ")).toBe(IDLE_EXIT_DEFAULT_MS);
    expect(resolveIdleExitMs("30000")).toBe(30_000);
    expect(resolveIdleExitMs(" 30000 ")).toBe(30_000);
    expect(resolveIdleExitMs("1500.9")).toBe(1_500);
    // The one value that turns the rule off, and only when it was written.
    expect(resolveIdleExitMs("0")).toBe(0);
    for (const typo of ["off", "10m", "-1", "NaN", "1e", "ten"]) {
      expect(resolveIdleExitMs(typo)).toBe(IDLE_EXIT_DEFAULT_MS);
    }
    // And it is the env that production reads, with no argument.
    process.env.CLAWBOX_MCP_IDLE_EXIT_MS = "45000";
    expect(resolveIdleExitMs()).toBe(45_000);
  });

  it("ships a period an idle session is actually reaped within", () => {
    // The number a box runs with, which no other case here sees: every one of
    // them injects its own.
    expect(IDLE_EXIT_DEFAULT_MS).toBeGreaterThanOrEqual(60_000);
    expect(IDLE_EXIT_DEFAULT_MS).toBeLessThanOrEqual(30 * 60_000);
  });
});
