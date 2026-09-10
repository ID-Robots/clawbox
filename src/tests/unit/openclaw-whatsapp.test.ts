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
  return {
    ...actual,
    openclawIsAbsent: () => false,
    spawnOpenclawCli: vi.fn(),
    restartGateway: vi.fn(),
    // Both mocked because the repair now READS the config and, on one path
    // only, writes one key back — an unmocked `readConfig` would reach the
    // machine's own openclaw.json and an unmocked write would spawn the CLI.
    readConfig: vi.fn(),
    runOpenclawConfigSet: vi.fn(),
  };
});
vi.mock("@/lib/openclaw-channels", () => ({
  invalidateChannelStatus: vi.fn(),
  readCachedChannelRowResult: vi.fn(),
  ensureChannelPlugin: vi.fn(),
}));

import {
  GatewayNotReadyError,
  readConfig,
  restartGateway,
  runOpenclawConfigSet,
  spawnOpenclawCli,
} from "@/lib/openclaw-config";
import { ensureChannelPlugin, readCachedChannelRowResult } from "@/lib/openclaw-channels";

const mockSpawn = vi.mocked(spawnOpenclawCli);
const mockChannelResult = vi.mocked(readCachedChannelRowResult);
const mockEnsurePlugin = vi.mocked(ensureChannelPlugin);
const mockRestart = vi.mocked(restartGateway);
const mockReadConfig = vi.mocked(readConfig);
const mockConfigSet = vi.mocked(runOpenclawConfigSet);

/**
 * The gateway ANSWERED. A `null` row from an answering gateway means "there is
 * no such channel here" — a real fact about an unconfigured box — which is a
 * different thing from the gateway not being reachable at all.
 */
const mockChannel = {
  mockResolvedValue: (row: Record<string, unknown> | null) =>
    mockChannelResult.mockResolvedValue({ answered: true, row }),
  mockResolvedValueOnce: (row: Record<string, unknown> | null) =>
    mockChannelResult.mockResolvedValueOnce({ answered: true, row }),
};

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
    // The plugin is present on a healthy box, so the repair path below is
    // never entered by the tests that are not about it.
    mockEnsurePlugin.mockResolvedValue({ ok: true, installed: false });
    mockRestart.mockResolvedValue(undefined);
    // A config with no `channels.whatsapp` at all: the shape of a box that has
    // never configured the channel, where the repair must write nothing.
    mockReadConfig.mockResolvedValue({});
    mockConfigSet.mockResolvedValue(undefined as never);
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
    // A healthy box pays nothing for the repair path: no `plugins list`, and
    // above all no gateway restart, which would drop every other channel.
    expect(mockEnsurePlugin).not.toHaveBeenCalled();
    expect(mockRestart).not.toHaveBeenCalled();
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

  it("installs the plugin the gateway says is missing, then asks again", async () => {
    // The deadlock this breaks is written up in repairWebLoginProvider(): a box
    // with no `@openclaw/whatsapp` on disk could not pair, and the only thing
    // that installed the plugin was a channel save the panel kept behind a
    // pairing. The gateway names the one failure with a remedy, so it runs.
    mockSpawn.mockResolvedValueOnce(rpcError("web login provider is not available"));
    mockSpawn.mockResolvedValueOnce(rpcOk({ qrDataUrl: QR_A }));
    mockEnsurePlugin.mockResolvedValue({ ok: true, installed: true });

    const snap = await new lib.OpenclawWhatsappPairing().start();

    expect(mockEnsurePlugin).toHaveBeenCalledWith("whatsapp");
    // Installed is not loaded: `plugins install` says so itself.
    expect(mockRestart).toHaveBeenCalled();
    expect(snap.phase).toBe("waiting");
    expect(snap.qrImage).toBe(QR_A);
    expect(snap.error).toBeNull();
  });

  it("clears the channel key that keeps the plugin unloaded on the pinned core", async () => {
    // TASK-788. `/whatsapp/unpair` writes `channels.whatsapp.enabled = false`,
    // and 2026.9.1 stopped LOADING a channel plugin whose channel is off —
    // measured on 2026.9.3 against 2026.8.1 with the same config, the row going
    // from `enabled true, status loaded` to `enabled false, status disabled`.
    // `/whatsapp/pair` never touches that key, so on the new core "unpair, then
    // Link your phone" refuses for ever: installing an installed plugin and
    // bouncing the gateway cannot load a plugin the channel key excludes.
    mockReadConfig.mockResolvedValue({ channels: { whatsapp: { enabled: false } } });
    mockSpawn.mockResolvedValueOnce(rpcError("web login provider is not available"));
    mockSpawn.mockResolvedValueOnce(rpcOk({ qrDataUrl: QR_A }));
    mockEnsurePlugin.mockResolvedValue({ ok: true, installed: false });

    const snap = await new lib.OpenclawWhatsappPairing().start();

    expect(mockConfigSet).toHaveBeenCalledWith(
      ["channels.whatsapp.enabled", "true", "--json"],
      expect.anything(),
    );
    // …and BEFORE the reload, which is the whole point: a restart that runs
    // first reloads the same unloadable plugin.
    expect(mockConfigSet.mock.invocationCallOrder[0])
      .toBeLessThan(mockRestart.mock.invocationCallOrder[0]);
    expect(snap.qrImage).toBe(QR_A);
  });

  it("does not bounce the gateway for a card the owner closed while the key was being written", async () => {
    // The window the new write opens: `config set` takes up to 45 s, and a
    // cancel inside it used to reach the gateway restart anyway, because the
    // phase was checked BEFORE the write and the epoch only AFTER the restart.
    // Dropping the Telegram conversation the owner went back to is exactly what
    // the phase check above this exists to prevent.
    mockReadConfig.mockResolvedValue({ channels: { whatsapp: { enabled: false } } });
    mockSpawn.mockResolvedValue(rpcError("web login provider is not available"));
    mockEnsurePlugin.mockResolvedValue({ ok: true, installed: false });

    const pairing = new lib.OpenclawWhatsappPairing();
    let finishWrite: () => void = () => {};
    mockConfigSet.mockImplementation(
      () => new Promise<void>((resolve) => { finishWrite = () => resolve(); }),
    );

    const started = pairing.start();
    await vi.waitFor(() => expect(mockConfigSet).toHaveBeenCalled());
    // The owner closes the card while the write is in flight.
    pairing.stop();
    finishWrite();
    await started;

    expect(mockRestart).not.toHaveBeenCalled();
  });

  it("does not bounce the gateway for a card closed while the config was being READ", async () => {
    // The same window on the path every box takes: the read happens whether or
    // not the key turns out to be off, so a guard that sat inside the "it was
    // off" branch left the common case unprotected.
    mockSpawn.mockResolvedValue(rpcError("web login provider is not available"));
    mockEnsurePlugin.mockResolvedValue({ ok: true, installed: false });

    const pairing = new lib.OpenclawWhatsappPairing();
    let finishRead: () => void = () => {};
    // Resolved with the key OFF, which is the case that would otherwise go on to
    // write it: a read that answers "nothing to do" would prove nothing here.
    mockReadConfig.mockImplementation(
      () => new Promise((resolve) => {
        finishRead = () => resolve({ channels: { whatsapp: { enabled: false } } });
      }),
    );

    const started = pairing.start();
    await vi.waitFor(() => expect(mockReadConfig).toHaveBeenCalled());
    pairing.stop();
    finishRead();
    await started;

    // Neither the owner's channel flipped on, nor the gateway bounced.
    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(mockRestart).not.toHaveBeenCalled();
  });

  it("leaves the channel key alone on a box that never configured the channel", async () => {
    // ABSENT is not `false`. A box that has never had WhatsApp configured is
    // `/whatsapp/configure`'s business, and a repair entered from a refusal must
    // not decide it — the only key this touches is one that is explicitly off,
    // written by our own unpair route.
    mockReadConfig.mockResolvedValue({ channels: { telegram: { enabled: true } } });
    mockSpawn.mockResolvedValueOnce(rpcError("web login provider is not available"));
    mockSpawn.mockResolvedValueOnce(rpcOk({ qrDataUrl: QR_A }));
    mockEnsurePlugin.mockResolvedValue({ ok: true, installed: true });

    await new lib.OpenclawWhatsappPairing().start();

    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(mockRestart).toHaveBeenCalled();
  });

  it("still reloads when the channel key cannot be written", async () => {
    // FALSE FAILURE refused: an older core never gated loading on that key, so
    // a write that fails must not cost the repair its reload.
    mockReadConfig.mockResolvedValue({ channels: { whatsapp: { enabled: false } } });
    mockConfigSet.mockRejectedValue(new Error("config set exited 1"));
    mockSpawn.mockResolvedValueOnce(rpcError("web login provider is not available"));
    mockSpawn.mockResolvedValueOnce(rpcOk({ qrDataUrl: QR_A }));
    mockEnsurePlugin.mockResolvedValue({ ok: true, installed: true });

    const snap = await new lib.OpenclawWhatsappPairing().start();

    expect(mockRestart).toHaveBeenCalled();
    expect(snap.qrImage).toBe(QR_A);
  });

  it("recognises the refusal in the shape the CLI really rejects with", async () => {
    // On a box the CLI exits 1 and the spawn rejects with its raw error payload
    // as text, not with an exit-0 `{ok:false}` body — which the module's own
    // comment calls the belt-and-braces path. This is the one the device
    // produced, so the remedy has to fire on it too.
    mockSpawn.mockRejectedValueOnce(
      new Error(
        '{\n "ok": false,\n "error": {\n  "code": "INVALID_REQUEST",\n' +
          '  "message": "web login provider is not available"\n }\n}',
      ),
    );
    mockSpawn.mockResolvedValueOnce(rpcOk({ qrDataUrl: QR_A }));
    mockEnsurePlugin.mockResolvedValue({ ok: true, installed: true });

    const snap = await new lib.OpenclawWhatsappPairing().start();

    expect(mockEnsurePlugin).toHaveBeenCalledWith("whatsapp");
    expect(snap.phase).toBe("waiting");
  });

  it("reports an install that failed as an install failure, not as a missing plugin", async () => {
    // The panel has words for this one — "check the network connection" — and
    // they are the true ones: the plugin is an npm download on a device.
    mockSpawn.mockResolvedValueOnce(rpcError("web login provider is not available"));
    mockEnsurePlugin.mockResolvedValue({ ok: false, reason: "install_failed" });

    const snap = await new lib.OpenclawWhatsappPairing().start();

    expect(snap.phase).toBe("error");
    expect(snap.error).toBe("install_failed");
    // Nothing was installed, so there is nothing for a gateway restart to load.
    expect(mockRestart).not.toHaveBeenCalled();
  });

  it("names a missing plugin only once the install and the reload have both run", async () => {
    // Still refused after OpenClaw installed its own plugin and the gateway
    // reloaded: this box really has no WhatsApp bridge, and saying so is the
    // one honest answer left.
    mockSpawn.mockResolvedValueOnce(rpcError("web login provider is not available"));
    mockSpawn.mockResolvedValueOnce(rpcError("web login provider is not available"));
    mockEnsurePlugin.mockResolvedValue({ ok: true, installed: true });

    const snap = await new lib.OpenclawWhatsappPairing().start();

    expect(snap.phase).toBe("error");
    expect(snap.error).toBe("plugin_missing");
  });

  it("ignores a second press while the install is running", async () => {
    // Without this the second press rewrites the phase back to `starting`, so
    // the first panel's poller reads "Starting the bridge…" with minutes of npm
    // still to run, and spends a whole `web.login.start` budget on a call that
    // is certain to be refused.
    mockSpawn.mockResolvedValue(rpcError("web login provider is not available"));
    mockEnsurePlugin.mockReturnValue(new Promise(() => {}));

    const pairing = new lib.OpenclawWhatsappPairing();
    void pairing.start();
    await vi.waitFor(() => expect(mockEnsurePlugin).toHaveBeenCalled());
    const callsDuringInstall = mockSpawn.mock.calls.length;

    expect((await pairing.start()).phase).toBe("preparing");
    expect(mockSpawn.mock.calls.length).toBe(callsDuringInstall);
  });

  it("runs one install behind two starts that overlap inside it", async () => {
    // The epoch discards the RESULT of a start a newer one replaced; it does
    // not cancel an npm install already in flight. `force` is the one press the
    // guard above lets through, so two clients forcing a relink would otherwise
    // drive `plugins install` into the same plugin store twice, concurrently —
    // which is how a store ends up half-written.
    mockSpawn.mockResolvedValue(rpcError("web login provider is not available"));
    let finishInstall: (result: { ok: true; installed: boolean }) => void = () => {};
    mockEnsurePlugin.mockReturnValue(
      new Promise((resolve) => {
        finishInstall = resolve;
      }),
    );

    const pairing = new lib.OpenclawWhatsappPairing();
    const first = pairing.start();
    // The first refusal has landed and the install is running.
    await vi.waitFor(() => expect(mockEnsurePlugin).toHaveBeenCalled());
    const second = pairing.start({ force: true });
    await vi.waitFor(() => expect(mockSpawn.mock.calls.length).toBeGreaterThan(1));

    finishInstall({ ok: true, installed: true });
    await Promise.all([first, second]);

    expect(mockEnsurePlugin).toHaveBeenCalledTimes(1);
    expect(mockRestart).toHaveBeenCalledTimes(1);
  });

  it("does not reinstall and re-restart the box on every Retry press", async () => {
    // `restartGateway` clears the unit's start limit before each restart, so
    // nothing downstream would stop this: an unlatched repair turns the red
    // box's own Retry button into "bounce the gateway, drop Telegram and every
    // open session, report the same failure" — once per press, for a failure
    // that is now a fact about the box.
    mockSpawn.mockResolvedValue(rpcError("web login provider is not available"));
    mockEnsurePlugin.mockResolvedValue({ ok: true, installed: true });
    const pairing = new lib.OpenclawWhatsappPairing();

    expect((await pairing.start()).error).toBe("plugin_missing");
    expect(mockRestart).toHaveBeenCalledTimes(1);

    // The owner presses Retry twice.
    expect((await pairing.start()).error).toBe("plugin_missing");
    expect((await pairing.start()).error).toBe("plugin_missing");

    expect(mockEnsurePlugin).toHaveBeenCalledTimes(1);
    expect(mockRestart).toHaveBeenCalledTimes(1);
  });

  it("repairs again once a login has actually started", async () => {
    // The latch is about what we know, not a permanent verdict: a login that
    // started proves the provider is there, so a later refusal deserves the
    // remedy again.
    mockEnsurePlugin.mockResolvedValue({ ok: true, installed: true });
    const pairing = new lib.OpenclawWhatsappPairing();

    mockSpawn.mockResolvedValueOnce(rpcError("web login provider is not available"));
    mockSpawn.mockResolvedValueOnce(rpcError("web login provider is not available"));
    expect((await pairing.start()).error).toBe("plugin_missing");

    mockSpawn.mockResolvedValueOnce(rpcOk({ qrDataUrl: QR_A }));
    expect((await pairing.start({ force: true })).phase).toBe("waiting");

    mockSpawn.mockResolvedValueOnce(rpcError("web login provider is not available"));
    mockSpawn.mockResolvedValueOnce(rpcOk({ qrDataUrl: QR_B }));
    expect((await pairing.start({ force: true })).phase).toBe("waiting");
    expect(mockEnsurePlugin).toHaveBeenCalledTimes(2);
  });

  it("does not answer for the rest of the process from one refused repair", async () => {
    // The other half of the same rule. A refusal that survived an install and a
    // reload is a measurement, not a fact about the box: correct the plugin on
    // disk — a compatible version installed by hand, a core the box has since
    // been given — and the gateway still needs the reload only this remedy
    // performs, so a verdict kept for the life of the web server is a box that
    // can never be repaired from its own panel. Probe-once, one press wide.
    vi.useFakeTimers();
    try {
      mockSpawn.mockResolvedValue(rpcError("web login provider is not available"));
      mockEnsurePlugin.mockResolvedValue({ ok: true, installed: true });
      const pairing = new lib.OpenclawWhatsappPairing();

      expect((await pairing.start()).error).toBe("plugin_missing");
      expect(mockEnsurePlugin).toHaveBeenCalledTimes(1);

      // Pressed again straight away: still answered from what was just measured,
      // so Retry cannot bounce the gateway once per press.
      expect((await pairing.start()).error).toBe("plugin_missing");
      expect(mockEnsurePlugin).toHaveBeenCalledTimes(1);

      // Still pressing five minutes later: the measurement is fresh enough, and
      // this is the half that keeps a flurry of presses down to one repair.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect((await pairing.start()).error).toBe("plugin_missing");
      expect(mockEnsurePlugin).toHaveBeenCalledTimes(1);

      // An hour after the refusal the measurement is old enough that the owner
      // may have changed the box under it, and the press is owed a real attempt.
      // Deliberately a wall-clock contract rather than the module's own constant:
      // a test that reads REPAIR_REFUSAL_TTL_MS would follow any future change to
      // it and stop asserting the policy — that a press soon after is answered
      // from the measurement and a press much later is not.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect((await pairing.start()).error).toBe("plugin_missing");
      expect(mockEnsurePlugin).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not skip the reload a cancelled install still owes", async () => {
    // The DELETE that reaps a cancelled session cannot reach an npm install
    // already in flight. Restarting the gateway minutes after the owner closed
    // the card would drop the Telegram conversation they went back to, with
    // nothing anywhere saying why — and the package is on disk, so the next
    // start pays that restart with someone watching.
    mockSpawn.mockResolvedValue(rpcError("web login provider is not available"));
    let finishInstall: (result: { ok: true; installed: boolean }) => void = () => {};
    mockEnsurePlugin.mockReturnValue(
      new Promise((resolve) => {
        finishInstall = resolve;
      }),
    );

    const pairing = new lib.OpenclawWhatsappPairing();
    const started = pairing.start();
    await vi.waitFor(() => expect(mockEnsurePlugin).toHaveBeenCalled());

    pairing.stop();
    finishInstall({ ok: true, installed: true });
    expect((await started).phase).toBe("idle");

    expect(mockRestart).not.toHaveBeenCalled();
  });

  it("does not start a login the owner cancelled while the gateway was coming back", async () => {
    // The catch-up loop SLEEPS between attempts, and a cancel lands inside that
    // sleep. `web.login.start` is not a read — it stops the running channel to
    // take the socket over, and with `force` it would tear down a login a later
    // press has just begun — so waking up to issue one is a login started after
    // the owner closed the card, with the answer discarded upstream and the
    // keepalive already gone: nothing left to reap it.
    vi.useFakeTimers();
    try {
      mockEnsurePlugin.mockResolvedValue({ ok: true, installed: true });
      mockRestart.mockRejectedValue(new GatewayNotReadyError("gateway did not come back"));
      let starts = 0;
      mockSpawn.mockImplementation(async (args: readonly string[]) => {
        if (args[2] !== "web.login.start") return rpcOk({});
        starts += 1;
        if (starts === 1) throw new Error("web login provider is not available");
        throw new Error("connect ECONNREFUSED 127.0.0.1:18789");
      });

      const pairing = new lib.OpenclawWhatsappPairing();
      const started = pairing.start();
      // The repair has run and the first post-reload attempt has hit a port
      // nobody is listening on yet, so the loop is now in its catch-up gap.
      await vi.advanceTimersByTimeAsync(1);
      expect(starts).toBe(2);

      pairing.stop();
      await vi.advanceTimersByTimeAsync(lib.TICK_MS * 2);

      expect((await started).phase).toBe("idle");
      expect(starts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not ask a gateway that is not listening yet for a QR as well", async () => {
    // The catch-up window runs in `starting`, which is a phase the keepalive
    // works in — so it spent that whole window (up to ~115 s, entered precisely
    // because the port does not answer) firing a `web.login.wait` per tick, each
    // a 10-12 s CLI cold start certain to fail, on a Jetson that has just
    // finished an npm install. The retries own that conversation.
    vi.useFakeTimers();
    try {
      mockEnsurePlugin.mockResolvedValue({ ok: true, installed: true });
      mockRestart.mockRejectedValue(new GatewayNotReadyError("gateway did not come back"));
      let starts = 0;
      let waits = 0;
      // Only the waits issued INSIDE the catch-up window are the defect: once a
      // QR exists the keepalive is doing its job and is supposed to ask.
      let waitsBeforeQr: number | null = null;
      mockSpawn.mockImplementation(async (args: readonly string[]) => {
        if (args[2] === "web.login.wait") {
          waits += 1;
          throw new Error("connect ECONNREFUSED 127.0.0.1:18789");
        }
        starts += 1;
        if (starts === 1) throw new Error("web login provider is not available");
        if (starts < 3) throw new Error("connect ECONNREFUSED 127.0.0.1:18789");
        waitsBeforeQr ??= waits;
        return rpcOk({ qrDataUrl: QR_A });
      });

      const pairing = new lib.OpenclawWhatsappPairing();
      const started = pairing.start();
      await vi.advanceTimersByTimeAsync(lib.TICK_MS * 3);

      expect((await started).phase).toBe("waiting");
      expect(waitsBeforeQr).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the keepalive once the session has nowhere left to go", async () => {
    // `ensureTicking` is cleared by `stop()`, and a start that ends in `error`
    // never calls it — so on a box that cannot be repaired, which is exactly
    // where the new error paths lead, the interval woke every TICK_MS for the
    // life of the web server only to return immediately.
    vi.useFakeTimers();
    try {
      mockSpawn.mockResolvedValue(rpcError("web login provider is not available"));
      mockEnsurePlugin.mockResolvedValue({ ok: true, installed: true });
      const pairing = new lib.OpenclawWhatsappPairing();

      expect((await pairing.start()).error).toBe("plugin_missing");
      // One tick to notice there is nothing to keep alive.
      await vi.advanceTimersByTimeAsync(lib.TICK_MS + 1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks again while the gateway is still coming back, instead of calling the repair a failure", async () => {
    // `restartGateway` gives up on its readiness wait after its own budget; a
    // Jetson that has just spent three minutes on npm can take longer to bind.
    // One immediate shot at a closed port is a connection error, not a verdict
    // on the repair, and reporting it handed the owner the least informative
    // sentence the card has over a plugin that was about to work.
    vi.useFakeTimers();
    try {
      mockEnsurePlugin.mockResolvedValue({ ok: true, installed: true });
      mockRestart.mockRejectedValue(new GatewayNotReadyError("gateway did not come back"));
      // Keyed on the METHOD, not on call order: the keepalive fires its own
      // `web.login.wait` while the catch-up waits, and a queue would hand the
      // QR to whichever call happened to arrive first.
      let starts = 0;
      mockSpawn.mockImplementation(async (args: readonly string[]) => {
        if (args[2] !== "web.login.start") return rpcOk({});
        starts += 1;
        if (starts === 1) throw new Error("web login provider is not available");
        // The gateway took the restart and has not finished binding yet.
        if (starts === 2) throw new Error("connect ECONNREFUSED 127.0.0.1:18789");
        return rpcOk({ qrDataUrl: QR_A });
      });

      const pairing = new lib.OpenclawWhatsappPairing();
      const started = pairing.start();
      await vi.advanceTimersByTimeAsync(lib.TICK_MS * 3);
      const snap = await started;

      expect(snap.phase).toBe("waiting");
      expect(snap.qrImage).toBe(QR_A);
    } finally {
      vi.useRealTimers();
    }
  });


  it("does not reap the login it spent the whole install getting to", async () => {
    // The keepalive reaps a login nobody is watching, and "watching" is a GET
    // that renews it. A plugin install can run for minutes, during which the
    // only thing the panel does is stay blocked on this POST — so the window
    // has to start again when the install ends, or the first tick afterwards
    // stops the login this very call is about to hand back.
    vi.useFakeTimers();
    try {
      mockSpawn.mockResolvedValueOnce(rpcError("web login provider is not available"));
      let finishRetry: (out: string) => void = () => {};
      mockSpawn.mockReturnValueOnce(
        new Promise<string>((resolve) => {
          finishRetry = resolve;
        }),
      );
      // Whatever the keepalive asks while the retry is in flight.
      mockSpawn.mockResolvedValue(rpcOk({}));
      let finishInstall: (result: { ok: true; installed: boolean }) => void = () => {};
      mockEnsurePlugin.mockReturnValue(
        new Promise((resolve) => {
          finishInstall = resolve;
        }),
      );

      const pairing = new lib.OpenclawWhatsappPairing();
      const started = pairing.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(mockEnsurePlugin).toHaveBeenCalled();

      // An npm install on a Jetson outlasts the reap window several times over.
      await vi.advanceTimersByTimeAsync(lib.REAP_AFTER_MS + lib.TICK_MS * 2);
      finishInstall({ ok: true, installed: true });
      // One tick lands between the retry being issued and its answer arriving.
      await vi.advanceTimersByTimeAsync(lib.TICK_MS + 1);
      finishRetry(rpcOk({ qrDataUrl: QR_A }));

      const snap = await started;
      expect(snap.phase).toBe("waiting");
      expect(snap.qrImage).toBe(QR_A);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not install anything over a failure that is not the missing provider", async () => {
    // A gateway that is down is not a plugin that is absent, and an npm install
    // plus a service restart is not what a socket error asks for.
    mockSpawn.mockResolvedValueOnce(rpcError("connect ECONNREFUSED"));

    const snap = await new lib.OpenclawWhatsappPairing().start();

    expect(snap.error).toBe("start_failed");
    expect(mockEnsurePlugin).not.toHaveBeenCalled();
    expect(mockRestart).not.toHaveBeenCalled();
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
    // The gateway could not be asked at all. Same null row as the case below,
    // and the opposite fact: the panel must be told this "not_configured" is
    // nobody answering, or it draws "Not configured" over a paired phone
    // whenever the gateway is restarting.
    mockChannelResult.mockResolvedValue({ answered: false, row: null });
    expect(await lib.readOpenclawWhatsappStatus()).toEqual({
      state: "not_configured",
      enabled: false,
      paired: false,
      connected: false,
      verified: false,
    });
  });

  it("reports a gateway that answered 'no such channel' as a real answer", async () => {
    // The DEFAULT state of an OpenClaw box: gateway healthy, WhatsApp never set
    // up. Reading this as "could not check" would give the whole SKU a
    // permanent unreachable row with a retry that can never clear it.
    mockChannelResult.mockResolvedValue({ answered: true, row: null });
    expect(await lib.readOpenclawWhatsappStatus()).toEqual({
      state: "not_configured",
      enabled: false,
      paired: false,
      connected: false,
      verified: true,
    });
  });
});
