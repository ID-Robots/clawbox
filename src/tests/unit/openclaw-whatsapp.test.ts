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
vi.mock("@/lib/openclaw-channels", () => ({
  invalidateChannelStatus: vi.fn(),
  readCachedChannelRow: vi.fn(),
}));

import { spawnOpenclawCli } from "@/lib/openclaw-config";
import { readCachedChannelRow } from "@/lib/openclaw-channels";

const mockSpawn = vi.mocked(spawnOpenclawCli);
const mockChannel = vi.mocked(readCachedChannelRow);

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

  /** `--timeout <ms>` as it was handed to the CLI, and the method's own budget. */
  function budgets(call: number): { rpc: number; method: number } {
    const args = mockSpawn.mock.calls[call][0] as string[];
    return {
      rpc: Number(args[args.indexOf("--timeout") + 1]),
      method: Number(JSON.parse(String(args[args.indexOf("--params") + 1])).timeoutMs),
    };
  }

  it("gives the transport more time than the method it is carrying", async () => {
    // `--timeout` bounds the RPC round trip; `params.timeoutMs` is how long the
    // gateway itself may spend producing the answer. Equal budgets race: a QR
    // that takes the whole window is abandoned by the caller at the moment the
    // gateway is handing it over, and the panel says `start_failed` for a login
    // that worked. A Jetson is exactly where that window is used up.
    //
    // The wait call already reserves headroom; the start call did not.
    vi.useFakeTimers();
    try {
      mockSpawn.mockResolvedValue(rpcOk({ qrDataUrl: QR_A }));
      const pairing = new lib.OpenclawWhatsappPairing();
      await pairing.start();

      const start = budgets(0);
      expect(start.rpc).toBeGreaterThan(start.method);

      await vi.advanceTimersByTimeAsync(lib.TICK_MS + 1);
      const wait = budgets(1);
      expect(wait.rpc).toBeGreaterThan(wait.method);
    } finally {
      vi.useRealTimers();
    }
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

  it("rejects a data URL with no image in it", async () => {
    // `"data:image/png;base64,"` is a well-formed data URL for an EMPTY image.
    // It passes a prefix check, and would put a blank square on screen in the
    // waiting phase — a QR the owner is invited to scan and cannot.
    mockSpawn.mockResolvedValueOnce(rpcOk({ qrDataUrl: "data:image/png;base64," }));

    const snap = await new lib.OpenclawWhatsappPairing().start();

    expect(snap.qrImage).toBeNull();
    expect(snap.phase).toBe("starting");
  });

  it("rejects a payload outside the base64 alphabet", async () => {
    mockSpawn.mockResolvedValueOnce(rpcOk({ qrDataUrl: "data:image/png;base64,<script>" }));

    expect((await new lib.OpenclawWhatsappPairing().start()).qrImage).toBeNull();
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

  /** The gateway's real WhatsApp account row, narrowed to what we read. */
  function row(over: Record<string, unknown> = {}) {
    return {
      accountId: "default",
      enabled: true,
      configured: true,
      linked: true,
      statusState: "ready",
      connected: true,
      running: true,
      lastError: null,
      ...over,
    };
  }

  it("reports a linked, connected channel as paired", async () => {
    mockChannel.mockResolvedValue(row());
    expect(await lib.readOpenclawWhatsappStatus()).toEqual({
      state: "paired",
      enabled: true,
      paired: true,
      connected: true,
      verified: true,
    });
  });

  it("does not call an unconnected channel 'receiving' material", async () => {
    mockChannel.mockResolvedValue(row({ connected: false, running: false }));
    expect((await lib.readOpenclawWhatsappStatus()).connected).toBe(false);
  });

  it("does NOT call an installed-but-unscanned channel paired", async () => {
    // The bug this pins, caught on hardware. Installing the plugin and
    // enabling the channel makes the gateway report `configured: true` with
    // NOTHING scanned — `configured` means "there is an account entry", not
    // "a device is linked". Reading it as paired told the panel a phone was
    // connected when no QR had ever been shown.
    //
    // `linked` is the field that answers the question, and the gateway
    // publishes `statusState: "not-linked"` and `lastError: "not linked"`
    // alongside it.
    mockChannel.mockResolvedValue(
      row({
        configured: true,
        linked: false,
        statusState: "not-linked",
        connected: false,
        running: false,
        lastError: "not linked",
      }),
    );

    const status = await lib.readOpenclawWhatsappStatus();
    expect(status.paired).toBe(false);
    expect(status.state).toBe("enabled_not_paired");
    expect(status.connected).toBe(false);
  });

  it("reports a channel that is off at all as not_configured", async () => {
    mockChannel.mockResolvedValue(
      row({ enabled: false, configured: false, linked: false, connected: false, running: false }),
    );
    expect((await lib.readOpenclawWhatsappStatus()).state).toBe("not_configured");
  });

  // `configured` is not a fact about this channel — the plugin HARDCODES it.
  //
  //   resolveAccountSnapshot: async ({ account, runtime }) => ({
  //     accountId, name, enabled: account.enabled,
  //     configured: true,                       // <- @openclaw/whatsapp 2026.7.1
  //     extra: { statusState: authState, linked, connected, ... },
  //   })
  //
  // and that snapshot is exactly what `channels status --json` publishes as the
  // per-account row (createAsyncComputedAccountStatusAdapter maps it to the
  // host's `status.buildAccountSnapshot`). So every real WhatsApp row carries
  // `configured: true` — including one the owner has just switched off.
  //
  // The fixture above cannot happen on a device: it pairs `enabled: false` with
  // `configured: false`, and the gateway never says that. These two cases use
  // the shape it does say.
  it("believes the channel is off when the gateway's own enabled flag says so", async () => {
    // Straight after Settings -> WhatsApp -> off. `enabled` is the plugin's
    // real answer (isEnabled: account.enabled && cfg.web?.enabled !== false);
    // `configured: true` is the constant beside it.
    mockChannel.mockResolvedValue(
      row({ enabled: false, configured: true, linked: false, connected: false, running: false }),
    );

    const status = await lib.readOpenclawWhatsappStatus();

    expect(status.enabled).toBe(false);
    expect(status.state).toBe("not_configured");
  });

  it("does not report a switched-off channel as paired because a phone is still linked", async () => {
    // The worst version of the same shape: the owner turned WhatsApp off but
    // the linked device is still on disk. Reading `configured` as enablement
    // put the card back at "paired"/active for a channel receiving nothing —
    // the false-success class, one field over from the one #548 removed.
    mockChannel.mockResolvedValue(
      row({ enabled: false, configured: true, linked: true, connected: false, running: false }),
    );

    const status = await lib.readOpenclawWhatsappStatus();

    expect(status.enabled).toBe(false);
    expect(status.state).toBe("not_configured");
  });

  it("still trusts a running channel that forgot to say it was enabled", async () => {
    // `running` stays in the disjunction on purpose: a channel the gateway is
    // actually running is enabled, whatever the config row claims. Only
    // `configured` is dropped, because only `configured` is a constant.
    mockChannel.mockResolvedValue(
      row({ enabled: false, configured: true, linked: true, connected: true, running: true }),
    );

    expect((await lib.readOpenclawWhatsappStatus()).state).toBe("paired");
  });

  it("never invents a link when the gateway could not be asked", async () => {
    mockChannel.mockResolvedValue(null);
    expect(await lib.readOpenclawWhatsappStatus()).toEqual({
      state: "not_configured",
      enabled: false,
      paired: false,
      connected: false,
      // The panel has to be told this "not_configured" is the gateway failing
      // to answer, not the gateway saying there is no channel. Without it the
      // Settings list draws "Not configured" over a paired phone whenever the
      // gateway is restarting.
      verified: false,
    });
  });
});
