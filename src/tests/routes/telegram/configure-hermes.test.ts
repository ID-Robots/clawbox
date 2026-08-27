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
  setTelegramToken: vi.fn(),
  restartGateway: vi.fn(),
  clearTelegramPairingState: vi.fn(),
}));
vi.mock("@/lib/hermes-telegram", () => ({
  setHermesTelegramToken: vi.fn(),
  ensureHermesGateway: vi.fn(),
  clearHermesTelegramPairingState: vi.fn(),
}));

import { get, set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { setTelegramToken, restartGateway, clearTelegramPairingState } from "@/lib/openclaw-config";
import {
  setHermesTelegramToken,
  ensureHermesGateway,
  clearHermesTelegramPairingState,
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

const TOKEN = "123456789:ABCDefGHIjklMNOpqrsTUVwxyz";
const NEW_TOKEN = "987654321:ZYXwvuTSRqponMLKjihGFEdcba";

describe("POST /setup-api/telegram/configure — harness routing", () => {
  let POST: (req: Request) => Promise<Response>;

  function req(body: unknown): Request {
    return new Request("http://localhost/setup-api/telegram/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
      expect(mockSetHermesToken).toHaveBeenCalledWith(TOKEN, expect.anything());
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
      const res = await POST(req({ botToken: NEW_TOKEN }));
      const body = await res.json();

      expect(body.reset).toBe(true);
      expect(mockClearHermesPairing).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith("telegram_approved_names", undefined);
    });

    it("keeps approvals when the same token is saved again", async () => {
      mockGet.mockResolvedValue(TOKEN);
      const res = await POST(req({ botToken: TOKEN }));
      const body = await res.json();

      expect(body.reset).toBe(false);
      expect(mockClearHermesPairing).not.toHaveBeenCalled();
    });

    // The token is already persisted by then, so a gateway that won't come up
    // is a warning about delivery, not a failed save.
    it("still reports the save when the gateway cannot be started", async () => {
      mockEnsureGateway.mockRejectedValue(new Error("systemd said no"));
      const res = await POST(req({ botToken: TOKEN }));
      const body = await res.json();

      expect(res.status).toBe(200);
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
      const body = await (await POST(req({ botToken: TOKEN }))).json();

      expect(body).toMatchObject({ success: true, restarted: false });
      expect(body.warning).toBeTruthy();
    });

    it("warns when the gateway install returned but nothing is running", async () => {
      mockEnsureGateway.mockResolvedValue({ installed: true, running: false, scope: "system", applied: false });
      const body = await (await POST(req({ botToken: TOKEN }))).json();

      expect(body).toMatchObject({ success: true, restarted: false });
      expect(body.warning).toBeTruthy();
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
