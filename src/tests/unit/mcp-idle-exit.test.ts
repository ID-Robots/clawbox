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
 * `bash` command that sleeps past the period must not be cut off), a CANCELLED
 * request gives its id back but still defers while its handler runs on — the
 * SDK's abort never reaches a handler — `0` disables the whole thing, and
 * arming it leaves any close handler already installed — `armMailboxWatch`'s —
 * still running.
 *
 * The idle clock is injected, so no case waits out a period. The one real wait
 * in the file is a real background job being reaped, in the case that holds the
 * production `busy` default: injecting that one would prove nothing about it.
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
  IDLE_EXIT_MAX_MS,
  resolveIdleExitMs,
  type IdleExit,
} from "../../../mcp/clawbox-mcp";
import { hasRunningJobs, startJob, stopJob, type BgJob } from "../../../mcp/lib/jobs";
import { createRegistrar, hasActiveToolCalls } from "../../../mcp/lib/register";
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
/** Real background jobs a case started, stopped here however the case ended. */
const started: BgJob[] = [];

/** Poll a real condition on the real clock. The injected clock drives nothing here. */
async function until(ok: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const job of started.splice(0)) {
    if (job.status === "running") stopJob(job);
  }
  for (const h of open.splice(0)) {
    await h.close().catch(() => {});
  }
  // In the hook, not at the end of the body that stubs it: a case that failed
  // part way through would otherwise leave the global clock fake for every case
  // after it.
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.CLAWBOX_MCP_IDLE_EXIT_MS;
});

/**
 * A real client on a real transport pair, connected the way `main()` connects.
 *
 * `slow` is a tool whose handler waits on a gate the test opens, which is the
 * only honest way to hold a request "in flight": the SDK decides when a
 * response goes out, and that decision is exactly what the deferral depends on.
 *
 * It is registered THROUGH THE REGISTRAR rather than straight onto the SDK,
 * because mcp/lib/register.ts owns the tools/call dispatch on a real device and
 * that dispatch is what counts a handler still running after its request was
 * cancelled. A tool wired past it would let the cancellation case below pass
 * over a server that exits out from under the work.
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
  const reg = createRegistrar(server, "openclaw", "full");
  reg.tool("slow", "Waits until the test lets it go.", {}, { readOnly: true }, async () => {
    await gate;
    return { content: [{ type: "text" as const, text: "woke" }] };
  });
  reg.finalize();

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
  overrides: Partial<{
    idleMs: number;
    busy: () => boolean;
    exit: () => void;
    log: (line: string) => void;
  }> = {},
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

  it("releases a cancelled request's id, and still waits for the handler it could not stop", async () => {
    // Two rules meeting, and getting only the first of them right is a way to
    // lose somebody's work.
    //
    // `Protocol._onrequest` aborts a cancelled request and deliberately sends
    // NOTHING back, so an id left held by that would pin this process open for
    // the life of the gateway — the exact shape the whole change exists to
    // remove. It is released. But the abort the SDK raises is a signal
    // `installCallHandler` never hands to the handler, so the handler runs ON:
    // the `write_file` half-written, the `web_fetch` still open. Releasing the
    // id and exiting on the next boundary would abandon it. `hasActiveToolCalls`
    // is what still knows, and it defers exactly like a background job does.
    const h = await connected();
    // No `busy` override anywhere in this case: it is the PRODUCTION default
    // being asked, through the real dispatcher.
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
    // The id is gone — nothing is waiting for an answer that will never come.
    expect(idle?.inFlight()).toBe(0);
    expect(hasActiveToolCalls()).toBe(true);

    // And the process stays, period after period, while the handler is in it.
    clock.advance(IDLE_MS * 5);
    expect(exits()).toBe(0);
    expect(h.gateWasOpened()).toBe(false);
    expect(clock.pending()).toBe(1);

    h.openGate();
    await settle();
    expect(hasActiveToolCalls()).toBe(false);

    // Deferred by a whole period, so it goes at the next boundary and not before.
    clock.advance(IDLE_MS - 1);
    expect(exits()).toBe(0);
    clock.advance(1);
    expect(exits()).toBe(1);
  });

  it("waits again, and again, while a background job is still running", async () => {
    // `bash` with `run_in_background` answers at once and leaves a DETACHED
    // shell running, with its handle and its output in this process's memory
    // (mcp/lib/jobs.ts). Exiting would not stop that build, only hide it: every
    // later `job_status` would answer "no background job with that id". So the
    // period restarts for as long as the job runs — no request is outstanding,
    // and nothing but this check will ever call back about it.
    const h = await connected();
    let jobRunning = true;
    const { clock, exits } = arm(h, { busy: () => jobRunning });

    // Three whole periods with the harness silent throughout.
    clock.advance(IDLE_MS * 3);
    expect(exits()).toBe(0);
    // Deferred, not abandoned: something is still armed to ask again.
    expect(clock.pending()).toBe(1);

    jobRunning = false;
    // The deferral is a whole period, so the answer is not acted on early…
    clock.advance(IDLE_MS - 1);
    expect(exits()).toBe(0);
    // …and is acted on at the next boundary.
    clock.advance(1);
    expect(exits()).toBe(1);
  });

  it("asks the real job registry by default, so a caller cannot forget to", async () => {
    // The default is `hasRunningJobs() || hasActiveToolCalls()`, not
    // `() => false`, and wiring it from main() instead would let the next
    // caller orphan somebody's build. Held with a REAL tracked job and NO
    // `busy` override: a case that injected its own predicate proves the
    // deferral works and says nothing about what production actually asks, so
    // it would go on passing over a default that had quietly become `() =>
    // false`.
    const h = await connected();
    expect(hasRunningJobs()).toBe(false);
    const job = startJob("sleep 20", 20_000, "held open by this test", process.cwd(), false);
    started.push(job);
    expect(hasRunningJobs()).toBe(true);

    const { clock, exits } = arm(h);
    clock.advance(IDLE_MS * 3);
    expect(exits()).toBe(0);
    expect(clock.pending()).toBe(1);

    stopJob(job);
    await until(() => !hasRunningJobs(), "the killed job to be reaped");

    clock.advance(IDLE_MS - 1);
    expect(exits()).toBe(0);
    clock.advance(1);
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

  it("clamps a period longer than a timer can hold, instead of firing in 1ms", () => {
    // Measured on both runtimes: `setTimeout` past 2^31-1 ms answers
    // `TimeoutOverflowWarning: ... Timeout duration was set to 1` and fires
    // immediately. Thirty days — what an operator writes when they mean
    // "effectively never", rather than the `0` that says it properly — would
    // have torn down every session the instant it connected, which is the
    // exact opposite of the instruction. Bigger must never mean sooner.
    expect(IDLE_EXIT_MAX_MS).toBe(2_147_483_647);
    expect(resolveIdleExitMs(String(IDLE_EXIT_MAX_MS))).toBe(IDLE_EXIT_MAX_MS);
    expect(resolveIdleExitMs("2592000000")).toBe(IDLE_EXIT_MAX_MS);
    expect(resolveIdleExitMs("1e21")).toBe(IDLE_EXIT_MAX_MS);
    // `Infinity` is not a number of milliseconds at all, so it reads as a typo.
    expect(resolveIdleExitMs("Infinity")).toBe(IDLE_EXIT_DEFAULT_MS);
  });

  it("never asks the runtime for a delay the runtime would shorten", async () => {
    // The clamp where it matters: what actually reaches `setTimeout`.
    const h = await connected();
    const clock = fakeClock();
    const asked: number[] = [];
    armIdleExit(h.server, h.transport, {
      idleMs: resolveIdleExitMs("2592000000"),
      setTimer: (fire, ms) => {
        asked.push(ms);
        return clock.setTimer(fire, ms);
      },
      clearTimer: clock.clearTimer,
      log: () => {},
      exit: () => {},
    });
    expect(asked).toEqual([IDLE_EXIT_MAX_MS]);
  });

  it("ships a period an idle session is actually reaped within", () => {
    // The number a box runs with, which no other case here sees: every one of
    // them injects its own.
    expect(IDLE_EXIT_DEFAULT_MS).toBeGreaterThanOrEqual(60_000);
    expect(IDLE_EXIT_DEFAULT_MS).toBeLessThanOrEqual(30 * 60_000);
  });
});
