import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The OpenClaw WhatsApp pairing session.
 *
 * It holds no child process — the gateway owns the login — so what is worth
 * pinning here is the translation between `web.login.*` answers and the
 * snapshot the panel renders, and the two rules that keep it honest:
 * a QR is only ever a QR the gateway actually sent, and a login nobody is
 * watching stops.
 */

vi.mock("@/lib/openclaw-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openclaw-config")>(
    "@/lib/openclaw-config",
  );
  return { ...actual, openclawIsAbsent: () => false, spawnOpenclawCli: vi.fn() };
});
vi.mock("@/lib/openclaw-channels", () => ({ readChannelStatus: vi.fn() }));

import { spawnOpenclawCli } from "@/lib/openclaw-config";
import { readChannelStatus } from "@/lib/openclaw-channels";

const mockSpawn = vi.mocked(spawnOpenclawCli);
const mockChannel = vi.mocked(readChannelStatus);

const QR_A = "data:image/png;base64,AAAA";
const QR_B = "data:image/png;base64,BBBB";

/** What `openclaw gateway call` prints: the result object with `ok` merged in. */
function rpcOk(result: Record<string, unknown>) {
  return JSON.stringify({ ok: true, ...result });
}
function rpcError(message: string) {
  return JSON.stringify({ ok: false, error: { message } });
}

describe("OpenclawWhatsappPairing", () => {
  let lib: typeof import("@/lib/openclaw-whatsapp");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    lib = await import("@/lib/openclaw-whatsapp");
  });

  it("starts a login and exposes the QR the gateway rendered", async () => {
    mockSpawn.mockResolvedValueOnce(rpcOk({ qrDataUrl: QR_A }));

    const snap = await new lib.OpenclawWhatsappPairing().start();

    expect(snap.phase).toBe("waiting");
    expect(snap.qrImage).toBe(QR_A);
    // There is no raw payload on this harness; the field stays null rather than
    // carrying a data URL the panel would try to re-encode as a QR.
    expect(snap.qr).toBeNull();
    expect(snap.qrCount).toBe(1);
    expect(mockSpawn.mock.calls[0][0].slice(0, 3)).toEqual(["gateway", "call", "web.login.start"]);
  });

  it("reports a completed link as paired, with the restart still pending", async () => {
    mockSpawn.mockResolvedValueOnce(rpcOk({ connected: true }));

    const snap = await new lib.OpenclawWhatsappPairing().start();

    expect(snap.phase).toBe("paired");
    expect(snap.qrImage).toBeNull();
    // Linked is not yet receiving: the channel config reaches the gateway at
    // start, so until it restarts the box is paired and answering nobody.
    expect(snap.gatewayRestartPending).toBe(true);
  });

  it("refuses to put anything but a PNG data URL in front of an <img>", async () => {
    mockSpawn.mockResolvedValueOnce(rpcOk({ qrDataUrl: "javascript:alert(1)" }));

    const snap = await new lib.OpenclawWhatsappPairing().start();

    expect(snap.qrImage).toBeNull();
    expect(snap.phase).toBe("starting");
  });

  it("names a missing plugin, because that one is fixed by saving, not rescanning", async () => {
    mockSpawn.mockResolvedValueOnce(rpcError("web login provider is not available"));

    const snap = await new lib.OpenclawWhatsappPairing().start();

    expect(snap.phase).toBe("error");
    expect(snap.error).toBe("plugin_missing");
  });

  it("reports any other start failure as a code, never as the gateway's sentence", async () => {
    mockSpawn.mockResolvedValueOnce(rpcError("connect ECONNREFUSED /home/clawbox/.openclaw/gateway.sock"));

    const snap = await new lib.OpenclawWhatsappPairing().start();

    expect(snap.phase).toBe("error");
    expect(snap.error).toBe("start_failed");
    // The gateway's text can name paths; it belongs in the log, not the panel.
    expect(JSON.stringify(snap)).not.toContain("/home/clawbox");
  });

  it("does not start a second login behind a double-click", async () => {
    mockSpawn.mockResolvedValue(rpcOk({ qrDataUrl: QR_A }));
    const pairing = new lib.OpenclawWhatsappPairing();

    await pairing.start();
    await pairing.start();

    // `web.login.start` stops the running channel to take the socket over;
    // doing that twice would tear down a login that was already up.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("re-starts when the caller explicitly forces it", async () => {
    mockSpawn.mockResolvedValue(rpcOk({ qrDataUrl: QR_A }));
    const pairing = new lib.OpenclawWhatsappPairing();

    await pairing.start();
    await pairing.start({ force: true });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(mockSpawn.mock.calls[1][0][4])).force).toBe(true);
  });

  it("begins a fresh session on a forced restart", async () => {
    // force is the panel's "start over" button, so the counters start over too
    // — a rotation count carried across a deliberate restart would describe a
    // session that no longer exists.
    mockSpawn.mockResolvedValue(rpcOk({ qrDataUrl: QR_A }));
    const pairing = new lib.OpenclawWhatsappPairing();

    await pairing.start();
    await pairing.start({ force: true });

    expect(pairing.peek().qrCount).toBe(1);
  });

  it("counts a rotation only when the code actually changed", async () => {
    // Rotation happens in the keepalive loop, not in start(): the gateway holds
    // the QR open and `web.login.wait` answers with the next one.
    vi.useFakeTimers();
    try {
      mockSpawn.mockResolvedValueOnce(rpcOk({ qrDataUrl: QR_A }));
      const pairing = new lib.OpenclawWhatsappPairing();
      await pairing.start();
      expect(pairing.peek().qrCount).toBe(1);

      // The same code again is the gateway re-answering, not a new code.
      mockSpawn.mockResolvedValueOnce(rpcOk({ qrDataUrl: QR_A }));
      await vi.advanceTimersByTimeAsync(lib.TICK_MS + 1);
      expect(pairing.peek().qrCount).toBe(1);

      mockSpawn.mockResolvedValueOnce(rpcOk({ qrDataUrl: QR_B }));
      await vi.advanceTimersByTimeAsync(lib.TICK_MS + 1);
      expect(pairing.peek().qrImage).toBe(QR_B);
      expect(pairing.peek().qrCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops asking the gateway once nobody is polling", async () => {
    vi.useFakeTimers();
    try {
      mockSpawn.mockResolvedValue(rpcOk({ qrDataUrl: QR_A }));
      const pairing = new lib.OpenclawWhatsappPairing();
      await pairing.start();
      const callsAfterStart = mockSpawn.mock.calls.length;

      // Nobody polls for longer than the reap window: the panel is closed.
      await vi.advanceTimersByTimeAsync(lib.REAP_AFTER_MS + lib.TICK_MS * 2);
      expect(pairing.peek().phase).toBe("idle");

      const callsAfterReap = mockSpawn.mock.calls.length;
      await vi.advanceTimersByTimeAsync(lib.TICK_MS * 4);
      expect(mockSpawn.mock.calls.length).toBe(callsAfterReap);
      expect(callsAfterReap).toBeGreaterThanOrEqual(callsAfterStart);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a wait that belongs to a session already stopped", async () => {
    // `web.login.wait` can be in flight for tens of seconds. Without the epoch
    // guard its answer — a QR for a login the gateway has since torn down —
    // landed in the idle snapshot, and the panel showed a code that could
    // never be scanned.
    vi.useFakeTimers();
    try {
      mockSpawn.mockResolvedValueOnce(rpcOk({ qrDataUrl: QR_A }));
      const pairing = new lib.OpenclawWhatsappPairing();
      await pairing.start();

      let releaseWait: (value: string) => void = () => {};
      mockSpawn.mockReturnValueOnce(
        new Promise<string>((resolve) => {
          releaseWait = resolve;
        }),
      );
      // Let the tick fire and block inside the wait. Asserting the call
      // happened is what makes this a race test: without it, the expectations
      // below are satisfied by stop() alone even if tick() never ran.
      await vi.advanceTimersByTimeAsync(lib.TICK_MS + 1);
      expect(mockSpawn).toHaveBeenCalledTimes(2);

      pairing.stop();
      releaseWait(rpcOk({ qrDataUrl: QR_B }));
      await vi.advanceTimersByTimeAsync(1);

      expect(pairing.peek().phase).toBe("idle");
      expect(pairing.peek().qrImage).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops cleanly", async () => {
    mockSpawn.mockResolvedValueOnce(rpcOk({ qrDataUrl: QR_A }));
    const pairing = new lib.OpenclawWhatsappPairing();
    await pairing.start();

    expect(pairing.stop().phase).toBe("idle");
    expect(pairing.peek().qrImage).toBeNull();
  });
});

describe("readOpenclawWhatsappStatus", () => {
  let lib: typeof import("@/lib/openclaw-whatsapp");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    lib = await import("@/lib/openclaw-whatsapp");
  });

  function row(over: Record<string, unknown> = {}) {
    return {
      configured: true,
      running: true,
      connected: true,
      tokenStatus: null,
      restartPending: false,
      lastError: null,
      ...over,
    } as NonNullable<Awaited<ReturnType<typeof readChannelStatus>>>;
  }

  it("reports a live channel as paired and connected", async () => {
    mockChannel.mockResolvedValue(row());
    expect(await lib.readOpenclawWhatsappStatus()).toEqual({
      state: "paired",
      enabled: true,
      paired: true,
      connected: true,
    });
  });

  it("does not call an unconnected channel 'receiving' material", async () => {
    mockChannel.mockResolvedValue(row({ connected: false }));
    expect((await lib.readOpenclawWhatsappStatus()).connected).toBe(false);
  });

  it("reports an enabled-but-unlinked channel distinctly", async () => {
    mockChannel.mockResolvedValue(row({ configured: false, connected: false }));
    expect((await lib.readOpenclawWhatsappStatus()).state).toBe("enabled_not_paired");
  });

  it("never invents a link when the gateway could not be asked", async () => {
    mockChannel.mockResolvedValue(null);
    expect(await lib.readOpenclawWhatsappStatus()).toEqual({
      state: "not_configured",
      enabled: false,
      paired: false,
      connected: false,
    });
  });
});
