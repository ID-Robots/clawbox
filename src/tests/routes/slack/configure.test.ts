import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * /setup-api/slack/configure on both editions.
 *
 * The rules this file holds, all inherited from the Discord route:
 *   * both tokens are checked with Slack BEFORE anything is written;
 *   * on OpenClaw the official plugin is installed before the config write,
 *     and the save is only a success once the gateway reports the channel
 *     connected;
 *   * on Hermes the tokens go through `hermes config set` under the same names;
 *   * no token ever reaches a log or a response.
 */

vi.mock("@/lib/config-store", () => ({ set: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openclaw-config")>(
    "@/lib/openclaw-config",
  );
  return {
    EnvSecretProviderConflictError: actual.EnvSecretProviderConflictError,
    GatewayNotReadyError: actual.GatewayNotReadyError,
    SLACK_BOT_TOKEN_ENV_VAR: actual.SLACK_BOT_TOKEN_ENV_VAR,
    SLACK_APP_TOKEN_ENV_VAR: actual.SLACK_APP_TOKEN_ENV_VAR,
    isSafeGatewayEnvValue: actual.isSafeGatewayEnvValue,
    setSlackTokens: vi.fn(),
    restartGateway: vi.fn(),
    approveChannelPairing: vi.fn(),
  };
});
vi.mock("@/lib/openclaw-channels", () => ({
  ensureChannelPlugin: vi.fn(),
  invalidateChannelStatus: vi.fn(),
  waitForChannelConnected: vi.fn(),
  readCachedChannelStatus: vi.fn(),
}));
vi.mock("@/lib/hermes-channels", () => ({
  setHermesChannelSecrets: vi.fn(),
  ensureHermesGateway: vi.fn(),
  hermesGatewayStatus: vi.fn(),
  hermesPlatformRegistered: vi.fn(),
  readHermesGatewaySnapshot: vi.fn(),
  approveHermesChannelPairing: vi.fn(),
}));

import { getActiveHarness } from "@/lib/harness";
import {
  EnvSecretProviderConflictError,
  GatewayNotReadyError,
  restartGateway,
  setSlackTokens,
} from "@/lib/openclaw-config";
import {
  ensureChannelPlugin,
  invalidateChannelStatus,
  waitForChannelConnected,
} from "@/lib/openclaw-channels";
import { ensureHermesGateway, setHermesChannelSecrets } from "@/lib/hermes-channels";
import { set } from "@/lib/config-store";
import type { ChannelStatus } from "@/lib/openclaw-channels";

const mockHarness = vi.mocked(getActiveHarness);
const mockSetSlackTokens = vi.mocked(setSlackTokens);
const mockRestart = vi.mocked(restartGateway);
const mockEnsurePlugin = vi.mocked(ensureChannelPlugin);
const mockWait = vi.mocked(waitForChannelConnected);
const mockInvalidate = vi.mocked(invalidateChannelStatus);
const mockHermesSecrets = vi.mocked(setHermesChannelSecrets);
const mockEnsureHermes = vi.mocked(ensureHermesGateway);
const mockSet = vi.mocked(set);

const BOT = ["xoxb", "000000000000", "000000000000", "clawboxtestnotreal"].join("-");
const APP = ["xapp", "1", "A000000000", "000000000000", "clawboxtestnotreal"].join("-");

const CONNECTED: ChannelStatus = {
  configured: true,
  running: true,
  connected: true,
  tokenStatus: "available",
  restartPending: false,
  lastError: null,
} as ChannelStatus;

function slackJson(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const AUTH_OK = { ok: true, team: "Acme", team_id: "T0001", user: "clawbox", user_id: "U0001", bot_id: "B0001" };

let fetchMock: ReturnType<typeof vi.fn>;

function slackAnswers(auth: Record<string, unknown>, connections: Record<string, unknown>) {
  fetchMock.mockImplementation(async (url: string) =>
    String(url).endsWith("/auth.test") ? slackJson(auth) : slackJson(connections),
  );
}

async function post(body: unknown) {
  const { POST } = await import("@/app/setup-api/slack/configure/route");
  const res = await POST(
    new Request("http://localhost/setup-api/slack/configure", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

describe("POST /setup-api/slack/configure", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    slackAnswers(AUTH_OK, { ok: true, url: "wss://example.invalid/socket" });
    mockHarness.mockResolvedValue("openclaw");
    mockEnsurePlugin.mockResolvedValue({ ok: true, installed: true });
    mockSetSlackTokens.mockResolvedValue(undefined);
    mockRestart.mockResolvedValue(undefined);
    mockWait.mockResolvedValue(CONNECTED);
    mockEnsureHermes.mockResolvedValue({ installed: true, running: true, applied: true } as never);
  });

  it("installs the plugin, writes the env references, restarts and reports success once connected", async () => {
    const { status, json } = await post({ botToken: BOT, appToken: APP });
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, restarted: true, team: "Acme", botName: "clawbox" });
    expect(json.code).toBeUndefined();
    expect(mockEnsurePlugin).toHaveBeenCalledWith("slack");
    expect(mockSetSlackTokens).toHaveBeenCalledWith(BOT, APP);
    // `plugins install` rewrites openclaw.json, so it has to come first.
    expect(mockEnsurePlugin.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetSlackTokens.mock.invocationCallOrder[0],
    );
    expect(mockWait).toHaveBeenCalledWith("slack", expect.objectContaining({ attempts: 5 }));
    expect(mockInvalidate).toHaveBeenCalledWith("slack");
    expect(mockSet).toHaveBeenCalledWith("slack_bot_token", BOT);
    expect(mockSet).toHaveBeenCalledWith("slack_app_token", APP);
    expect(JSON.stringify(json)).not.toContain(BOT);
    expect(JSON.stringify(json)).not.toContain(APP);
  });

  it("checks both tokens with Slack using the right token for each call", async () => {
    await post({ botToken: BOT, appToken: APP });
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const auth = calls.find(([url]) => url.endsWith("/auth.test"));
    const open = calls.find(([url]) => url.endsWith("/apps.connections.open"));
    expect((auth?.[1].headers as Record<string, string>).Authorization).toBe(`Bearer ${BOT}`);
    expect((open?.[1].headers as Record<string, string>).Authorization).toBe(`Bearer ${APP}`);
  });

  it("stores the tokens through hermes config set on the Hermes edition", async () => {
    mockHarness.mockResolvedValue("hermes");
    const { json } = await post({ botToken: BOT, appToken: APP });
    expect(json).toMatchObject({ success: true, restarted: true });
    expect(mockHermesSecrets).toHaveBeenCalledWith({ SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP });
    expect(mockEnsurePlugin).not.toHaveBeenCalled();
    expect(mockSetSlackTokens).not.toHaveBeenCalled();
    expect(mockWait).not.toHaveBeenCalled();
  });

  it("does not call a Hermes restart it could not apply a success", async () => {
    mockHarness.mockResolvedValue("hermes");
    mockEnsureHermes.mockResolvedValue({ installed: true, running: true, applied: false } as never);
    const { json } = await post({ botToken: BOT, appToken: APP });
    expect(json).toMatchObject({ success: false, code: "restart_pending", restarted: false });
  });

  it.each([
    [{ botToken: BOT }, "tokens_required"],
    [{ appToken: APP }, "tokens_required"],
    [{ botToken: APP, appToken: BOT }, "token_format"],
    [{ botToken: `${BOT} x`, appToken: APP }, "token_format"],
  ])("refuses %j before asking Slack or writing", async (body, code) => {
    const { status, json } = await post(body);
    expect(status).toBe(400);
    expect(json.code).toBe(code);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON", async () => {
    const { status } = await post("{nope");
    expect(status).toBe(400);
  });

  it("names a dead bot token and writes nothing", async () => {
    slackAnswers({ ok: false, error: "invalid_auth" }, { ok: true });
    const { status, json } = await post({ botToken: BOT, appToken: APP });
    expect(status).toBe(400);
    expect(json.code).toBe("bot_token_rejected");
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockSetSlackTokens).not.toHaveBeenCalled();
  });

  it("names an app-level token without connections:write", async () => {
    slackAnswers(AUTH_OK, { ok: false, error: "missing_scope" });
    const { status, json } = await post({ botToken: BOT, appToken: APP });
    expect(status).toBe(400);
    expect(json.code).toBe("app_token_scope");
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("names a dead app-level token", async () => {
    slackAnswers(AUTH_OK, { ok: false, error: "invalid_auth" });
    const { json } = await post({ botToken: BOT, appToken: APP });
    expect(json.code).toBe("app_token_rejected");
  });

  it("reports Slack being unreachable as 502, never as a bad token", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const { status, json } = await post({ botToken: BOT, appToken: APP });
    expect(status).toBe(502);
    expect(json.code).toBe("slack_unavailable");
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("blocks on a plugin that did not install", async () => {
    mockEnsurePlugin.mockResolvedValue({ ok: false, reason: "install_timeout" });
    const { json } = await post({ botToken: BOT, appToken: APP });
    expect(json).toMatchObject({ success: false, code: "plugin_install_timeout" });
    expect(mockWait).not.toHaveBeenCalled();
  });

  it("refuses a secrets provider it does not own, with nothing to restart", async () => {
    mockSetSlackTokens.mockRejectedValue(new EnvSecretProviderConflictError("default", "file"));
    const { status, json } = await post({ botToken: BOT, appToken: APP });
    expect(status).toBe(200);
    expect(json).toEqual({ success: false, code: "token_unresolved", restarted: false });
    expect(mockRestart).not.toHaveBeenCalled();
  });

  it("reports a channel the gateway never connected", async () => {
    mockWait.mockResolvedValue({ ...CONNECTED, connected: false });
    const { json } = await post({ botToken: BOT, appToken: APP });
    expect(json).toMatchObject({ success: false, code: "not_connected" });
  });

  it("reports an unanswered probe as unverified, not as fine", async () => {
    mockWait.mockResolvedValue(null);
    const { json } = await post({ botToken: BOT, appToken: APP });
    expect(json).toMatchObject({ success: false, code: "channel_unverified" });
  });

  it("reports an unresolvable SecretRef", async () => {
    mockWait.mockResolvedValue({ ...CONNECTED, tokenStatus: "configured_unavailable" } as ChannelStatus);
    const { json } = await post({ botToken: BOT, appToken: APP });
    expect(json).toMatchObject({ success: false, code: "token_unresolved" });
  });

  it("treats a gateway still binding as restarted and lets the probe decide", async () => {
    mockRestart.mockRejectedValue(new GatewayNotReadyError("not yet"));
    const { json } = await post({ botToken: BOT, appToken: APP });
    expect(json).toMatchObject({ success: true, restarted: true });
  });

  it("reports a refused restart as pending and skips the probe", async () => {
    mockRestart.mockRejectedValue(new Error("systemctl refused"));
    const { json } = await post({ botToken: BOT, appToken: APP });
    expect(json).toMatchObject({ success: false, code: "restart_pending", restarted: false });
    expect(mockWait).not.toHaveBeenCalled();
    expect(mockInvalidate).toHaveBeenCalledWith("slack");
  });

  it("scrubs both tokens from a failure it logs", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSetSlackTokens.mockRejectedValue(new Error(`write failed for ${BOT} and ${APP}`));
    const { status, json } = await post({ botToken: BOT, appToken: APP });
    expect(status).toBe(500);
    expect(json).toEqual({ error: "Failed to save" });
    const logged = errSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain(BOT);
    expect(logged).not.toContain(APP);
    expect(logged).toContain("<redacted>");
    errSpy.mockRestore();
  });
});
