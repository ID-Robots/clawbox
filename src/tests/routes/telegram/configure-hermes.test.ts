import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * /setup-api/telegram/configure has to drive whichever harness the device
 * actually runs. It used to drive OpenClaw unconditionally: on a Hermes device
 * that meant writing ~/.openclaw/openclaw.json and restarting a masked unit, so
 * the token was stored, nothing ever read it, and the bot never answered while
 * the UI reported success.
 */

vi.mock("@/lib/config-store", () => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({
  // A REAL class: the route narrows on `err instanceof GatewayNotReadyError`
  // to tell a gateway that is still binding apart from one that refused the
  // restart, and `instanceof undefined` throws a TypeError. Unreachable on the
  // Hermes path this file covers — `ensureHermesGateway()` never raises it —
  // but the module is replaced wholesale, so the export has to exist.
  GatewayNotReadyError: class GatewayNotReadyError extends Error {
    constructor(message = "gateway did not come back") {
      super(message);
      this.name = "GatewayNotReadyError";
    }
  },
  setTelegramToken: vi.fn(),
  restartGateway: vi.fn(),
  clearTelegramPairingState: vi.fn(),
}));
vi.mock("@/lib/hermes-telegram", () => ({
  setHermesTelegramToken: vi.fn(),
  ensureHermesGateway: vi.fn(),
  clearHermesTelegramPairingState: vi.fn(),
  readHermesTelegramToken: vi.fn(),
}));

import { get, set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { setTelegramToken, restartGateway, clearTelegramPairingState } from "@/lib/openclaw-config";
import {
  setHermesTelegramToken,
  ensureHermesGateway,
  clearHermesTelegramPairingState,
  readHermesTelegramToken,
} from "@/lib/hermes-telegram";

const mockGet = vi.mocked(get);
const mockSet = vi.mocked(set);
const mockHarness = vi.mocked(getActiveHarness);
const mockSetOpenclawToken = vi.mocked(setTelegramToken);
const mockRestartGateway = vi.mocked(restartGateway);
const mockClearOpenclawPairing = vi.mocked(clearTelegramPairingState);
const mockSetHermesToken = vi.mocked(setHermesTelegramToken);
const mockEnsureGateway = vi.mocked(ensureHermesGateway);
const mockClearHermesPairing = vi.mocked(clearHermesTelegramPairingState);
const mockHermesToken = vi.mocked(readHermesTelegramToken);

const TOKEN = "123456789:ABCDefGHIjklMNOpqrsTUVwxyz";
const NEW_TOKEN = "987654321:ZYXwvuTSRqponMLKjihGFEdcba";

describe("POST /setup-api/telegram/configure — harness routing", () => {
  let POST: (req: Request) => Promise<Response>;

  function req(body: unknown, signal?: AbortSignal): Request {
    return new Request("http://localhost/setup-api/telegram/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockGet.mockResolvedValue(undefined);
    mockSet.mockResolvedValue();
    mockSetOpenclawToken.mockResolvedValue();
    mockRestartGateway.mockResolvedValue();
    mockClearOpenclawPairing.mockResolvedValue();
    mockSetHermesToken.mockResolvedValue();
    mockClearHermesPairing.mockResolvedValue();
    mockHermesToken.mockResolvedValue({ token: null, known: true });
    mockEnsureGateway.mockResolvedValue({ installed: true, running: true, scope: "system", applied: true });

    POST = (await import("@/app/setup-api/telegram/configure/route")).POST;
  });

  describe("on a Hermes device", () => {
    beforeEach(() => {
      mockHarness.mockResolvedValue("hermes");
    });

    it("hands the token to Hermes and brings its gateway up", async () => {
      const res = await POST(req({ botToken: TOKEN }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ success: true, restarted: true });
      expect(mockSet).toHaveBeenCalledWith("telegram_bot_token", TOKEN);
      // One argument, deliberately: no abort signal — see the split-brain test
      // at the bottom of this describe.
      expect(mockSetHermesToken).toHaveBeenCalledWith(TOKEN);
      expect(mockEnsureGateway).toHaveBeenCalled();
    });

    it("never touches the OpenClaw gateway", async () => {
      await POST(req({ botToken: TOKEN }));

      expect(mockSetOpenclawToken).not.toHaveBeenCalled();
      expect(mockRestartGateway).not.toHaveBeenCalled();
      expect(mockClearOpenclawPairing).not.toHaveBeenCalled();
    });

    it("clears Hermes' pairing state when the bot token changes", async () => {
      mockGet.mockResolvedValue(TOKEN);
      mockHermesToken.mockResolvedValue({ token: TOKEN, known: true });
      const res = await POST(req({ botToken: NEW_TOKEN }));
      const body = await res.json();

      expect(body.reset).toBe(true);
      expect(mockClearHermesPairing).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith("telegram_approved_names", undefined);
    });

    it("keeps approvals when the same token is saved again", async () => {
      mockGet.mockResolvedValue(TOKEN);
      mockHermesToken.mockResolvedValue({ token: TOKEN, known: true });
      const res = await POST(req({ botToken: TOKEN }));
      const body = await res.json();

      expect(body.reset).toBe(false);
      expect(mockClearHermesPairing).not.toHaveBeenCalled();
    });

    // The approvals in Hermes' pairing store belong to the bot HERMES holds, and
    // on a box paired out of band ClawBox has no copy of that token at all.
    // Asking its own store therefore saw no previous bot, skipped the reset, and
    // left the old bot's approved senders able to talk to the new one.
    it("clears the old bot's approvals when only Hermes knew the previous token", async () => {
      mockGet.mockResolvedValue(undefined);
      mockHermesToken.mockResolvedValue({ token: TOKEN, known: true });

      const body = await (await POST(req({ botToken: NEW_TOKEN }))).json();

      expect(body.reset).toBe(true);
      expect(mockClearHermesPairing).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith("telegram_approved_names", undefined);
    });

    it("does not let a browser that walked away cancel the half it has already committed to", async () => {
      // A phone locking during the ~1-3 s the CLI takes on a Jetson aborts the
      // fetch. By then ClawBox's own store holds the new token and, on a token
      // change, the previous bot's approvals are gone. `runHermesCli` refuses a
      // call whose signal is already aborted, so handing `request.signal` any
      // further made that a RELIABLE split: token here, absent from
      // ~/.hermes/.env, approvals lost, and a 500 on the way out.
      const controller = new AbortController();
      controller.abort();
      // Model the real library: it goes through `runHermesCli`, which refuses.
      mockSetHermesToken.mockImplementation(async (_token: string, signal?: AbortSignal) => {
        if (signal?.aborted) throw new Error("hermes call cancelled");
      });
      mockEnsureGateway.mockImplementation(async (signal?: AbortSignal) => {
        if (signal?.aborted) throw new Error("hermes call cancelled");
        return { installed: true, running: true, scope: "system" as const, applied: true };
      });

      const res = await POST(req({ botToken: TOKEN }, controller.signal));
      const body = await res.json();

      // The owner is not told the save failed over a box he cannot see.
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ success: true, restarted: true });
      // And both halves of the box agree: ClawBox's store and Hermes' .env.
      expect(mockSet).toHaveBeenCalledWith("telegram_bot_token", TOKEN);
      expect(mockSetHermesToken).toHaveBeenCalledWith(TOKEN);
    });

    it("fails the save with the old token in place when the pairing reset throws", async () => {
      mockGet.mockResolvedValue(TOKEN);
      mockHermesToken.mockResolvedValue({ token: TOKEN, known: true });
      mockClearHermesPairing.mockRejectedValue(new Error("store refused"));
      const res = await POST(req({ botToken: NEW_TOKEN }));

      expect(res.status).toBe(500);
      expect(mockSet).not.toHaveBeenCalledWith("telegram_bot_token", expect.anything());
      expect(mockSetHermesToken).not.toHaveBeenCalled();
      expect(mockEnsureGateway).not.toHaveBeenCalled();
    });

    // The token is already persisted by then, so a gateway that won't come up
    // is a warning about delivery, not a failed save.
    it("still reports the save when the gateway cannot be started, at 502", async () => {
      mockEnsureGateway.mockRejectedValue(new Error("systemd said no"));
      const res = await POST(req({ botToken: TOKEN }));
      const body = await res.json();

      // Both editions answer the same status for the same fact: the token is
      // stored (`success: true`) and nothing is serving it yet. A 200 here made
      // the panel say "configured successfully" over a bot that was not
      // receiving — the OpenClaw leg of this route no longer does that, and
      // this SKU must not be the one left saying it.
      expect(res.status).toBe(502);
      expect(body.success).toBe(true);
      expect(body.restarted).toBe(false);
      expect(body.warning).toBeTruthy();
    });

    // The false success this route used to answer. A restart that sudo refused
    // leaves the OLD gateway process up, and `hermes gateway status` runs
    // unprivileged — so `running` was true, the route said {restarted: true},
    // and the owner's new bot token silently kept not working.
    it("does not claim restarted:true when the restart was refused", async () => {
      mockEnsureGateway.mockResolvedValue({
        installed: true,
        running: true,
        scope: "system",
        applied: false,
      });
      const res = await POST(req({ botToken: TOKEN }));

      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ success: true, restarted: false });
    });

    it("warns when the gateway install returned but nothing is running", async () => {
      mockEnsureGateway.mockResolvedValue({ installed: true, running: false, scope: "system", applied: false });
      const res = await POST(req({ botToken: TOKEN }));

      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ success: true, restarted: false });
    });

    it("fails the save when Hermes rejects the token", async () => {
      mockSetHermesToken.mockRejectedValue(new Error("Hermes rejected the bot token"));
      const res = await POST(req({ botToken: TOKEN }));

      expect(res.status).toBe(500);
      expect(mockEnsureGateway).not.toHaveBeenCalled();
    });
  });

  describe("on an OpenClaw device", () => {
    beforeEach(() => {
      mockHarness.mockResolvedValue("openclaw");
    });

    it("keeps driving the OpenClaw gateway", async () => {
      const body = await (await POST(req({ botToken: TOKEN }))).json();

      expect(body).toMatchObject({ success: true, restarted: true });
      expect(mockSetOpenclawToken).toHaveBeenCalledWith(TOKEN);
      expect(mockRestartGateway).toHaveBeenCalled();
    });

    it("never invokes the Hermes CLI", async () => {
      mockGet.mockResolvedValue(TOKEN);
      await POST(req({ botToken: NEW_TOKEN }));

      expect(mockSetHermesToken).not.toHaveBeenCalled();
      expect(mockEnsureGateway).not.toHaveBeenCalled();
      expect(mockClearHermesPairing).not.toHaveBeenCalled();
      expect(mockClearOpenclawPairing).toHaveBeenCalled();
    });
  });

  it("rejects a malformed token on either harness before doing anything", async () => {
    for (const harness of ["hermes", "openclaw"] as const) {
      vi.clearAllMocks();
      mockHarness.mockResolvedValue(harness);
      const res = await POST(req({ botToken: "not-a-token" }));

      expect(res.status).toBe(400);
      expect(mockSet).not.toHaveBeenCalled();
      expect(mockSetHermesToken).not.toHaveBeenCalled();
      expect(mockSetOpenclawToken).not.toHaveBeenCalled();
    }
  });
});
