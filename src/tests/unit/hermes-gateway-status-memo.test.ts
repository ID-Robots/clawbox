/**
 * The ONE `hermes gateway status` memo.
 *
 * WHY IT EXISTS. That command is a Hermes CLI cold start (~2 s on a Jetson) and
 * three status routes ask for it — Telegram, WhatsApp and Discord. Opening
 * Settings → Channels asks all three at once, so the box used to pay for the
 * same command three times concurrently while each route's private cache sat
 * empty. The dedup belongs at the one place that runs the command.
 *
 * WHAT IS EASY TO GET WRONG, and what each test below pins:
 *  - a memo that outlives the thing it describes (a restart) is a probe-once
 *    bug, and clearing the cache is NOT enough while a read is in flight — the
 *    older read resolves afterwards and repopulates it with the pre-restart
 *    answer;
 *  - caching only successes means the slower a wedged CLI gets, the more often
 *    the box re-enters it, so a failure is remembered too — but briefly;
 *  - a caller that brought its own deadline cannot be handed a shared promise
 *    it has no way to abort.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runHermesCliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: runHermesCliMock }));
vi.mock("child_process", () => ({ execFile: vi.fn() }));

/** Real `hermes gateway status` output for a running system-scope gateway. */
const RUNNING = "✓ Gateway is running\n  system gateway service is running\n";

let lib: typeof import("@/lib/hermes-telegram");

beforeEach(async () => {
  vi.resetModules();
  runHermesCliMock.mockReset();
  runHermesCliMock.mockResolvedValue({ stdout: RUNNING, stderr: "", code: 0 });
  lib = await import("@/lib/hermes-telegram");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hermesGatewayStatus memo", () => {
  it("runs the CLI once for concurrent callers", async () => {
    const [a, b, c] = await Promise.all([
      lib.hermesGatewayStatus(),
      lib.hermesGatewayStatus(),
      lib.hermesGatewayStatus(),
    ]);

    expect(runHermesCliMock).toHaveBeenCalledTimes(1);
    expect(a.running).toBe(true);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("serves a repeat read from the memo", async () => {
    await lib.hermesGatewayStatus();
    await lib.hermesGatewayStatus();

    expect(runHermesCliMock).toHaveBeenCalledTimes(1);
  });

  it("gives a caller with its own deadline its own probe", async () => {
    await lib.hermesGatewayStatus();
    await lib.hermesGatewayStatus(new AbortController().signal);

    // A shared promise cannot honour someone else's abort, and the ensure and
    // restart paths need the truth as of now.
    expect(runHermesCliMock).toHaveBeenCalledTimes(2);
  });

  it("remembers a failure for a much shorter window than an answer", async () => {
    vi.useFakeTimers();
    runHermesCliMock.mockRejectedValue(new Error("hermes: command not found"));

    const failed = await lib.hermesGatewayStatus();
    // `answered: false` is the whole point of the shorter window, and it is
    // carried out to the routes now so one can say "could not ask" rather than
    // publishing a definite "not running".
    expect(failed).toEqual({ installed: false, running: false, scope: null, answered: false });
    expect(runHermesCliMock).toHaveBeenCalledTimes(1);

    // Inside the failure window the box must not re-enter a wedged CLI...
    vi.setSystemTime(Date.now() + 2_000);
    await lib.hermesGatewayStatus();
    expect(runHermesCliMock).toHaveBeenCalledTimes(1);

    // ...but a failure may not stand for the full success window either.
    vi.setSystemTime(Date.now() + 2_000);
    runHermesCliMock.mockResolvedValue({ stdout: RUNNING, stderr: "", code: 0 });
    expect((await lib.hermesGatewayStatus()).running).toBe(true);
    expect(runHermesCliMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a successful answer for its full window", async () => {
    vi.useFakeTimers();
    await lib.hermesGatewayStatus();

    vi.setSystemTime(Date.now() + 14_000);
    await lib.hermesGatewayStatus();
    expect(runHermesCliMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 2_000);
    await lib.hermesGatewayStatus();
    expect(runHermesCliMock).toHaveBeenCalledTimes(2);
  });

  it("forgets the remembered answer when the gateway is changed", async () => {
    await lib.hermesGatewayStatus();
    lib.invalidateHermesGatewayStatus();
    await lib.hermesGatewayStatus();

    expect(runHermesCliMock).toHaveBeenCalledTimes(2);
  });

  it("does not let a read started before an invalidation repopulate the memo", async () => {
    // THE PROBE-ONCE TRAP. The owner is on Settings → Channels, so a gateway
    // read is in flight. He saves the pane; the save restarts the gateway and
    // invalidates. Clearing the cache alone is not enough: the older read —
    // which saw the process that no longer exists — resolves afterwards and
    // writes itself in, and every caller is told about it for a full window.
    let release: ((v: { stdout: string; stderr: string; code: number }) => void) | null = null;
    runHermesCliMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const inFlight = lib.hermesGatewayStatus();
    await vi.waitFor(() => expect(release).not.toBeNull());

    lib.invalidateHermesGatewayStatus();

    // The pre-restart answer lands after the invalidation.
    release!({ stdout: RUNNING, stderr: "", code: 0 });
    await inFlight;

    runHermesCliMock.mockResolvedValue({
      stdout: "✗ Gateway is not running\n  system gateway service is stopped\n",
      stderr: "",
      code: 0,
    });
    const after = await lib.hermesGatewayStatus();

    expect(runHermesCliMock).toHaveBeenCalledTimes(2);
    expect(after.running).toBe(false);
  });

  it("does not turn a cancelled probe into 'there is no gateway'", async () => {
    // Swallowing an abort would hand `ensureHermesGateway` an
    // `installed: false` for a healthy box and send it down the privileged
    // install path, carrying a signal that can no longer cancel anything.
    const controller = new AbortController();
    runHermesCliMock.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error("aborted"));
    });

    await expect(lib.hermesGatewayStatus(controller.signal)).rejects.toThrow("aborted");
  });

  it("still degrades a genuine CLI failure that nobody cancelled", async () => {
    runHermesCliMock.mockRejectedValue(new Error("hermes: command not found"));

    await expect(lib.hermesGatewayStatus(new AbortController().signal)).resolves.toEqual({
      installed: false,
      running: false,
      scope: null,
      answered: false,
    });
  });

  it("does not join a read that started before an invalidation", async () => {
    let release: ((v: { stdout: string; stderr: string; code: number }) => void) | null = null;
    runHermesCliMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const stale = lib.hermesGatewayStatus();
    await vi.waitFor(() => expect(release).not.toBeNull());
    lib.invalidateHermesGatewayStatus();

    // A caller arriving after the change must not be handed the read that
    // predates it.
    const fresh = lib.hermesGatewayStatus();
    expect(runHermesCliMock).toHaveBeenCalledTimes(2);

    release!({ stdout: RUNNING, stderr: "", code: 0 });
    await Promise.all([stale, fresh]);
  });
});
