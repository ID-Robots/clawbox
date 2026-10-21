import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * /setup-api/msteams/* — a preview, webhook channel.
 *
 *   * 404 on every route until CLAWBOX_PREVIEW_CHANNELS names msteams;
 *   * the three values are checked with Microsoft before anything is written;
 *   * `success` means the gateway is up and LISTENING, never "connected": the
 *     box cannot see whether Teams reaches it, so `receiving` stays unknown;
 *   * the response and the status carry the local endpoint to point at.
 */

vi.mock("@/lib/config-store", () => ({ set: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openclaw-config")>("@/lib/openclaw-config");
  return {
    EnvSecretProviderConflictError: actual.EnvSecretProviderConflictError,
    GatewayNotReadyError: actual.GatewayNotReadyError,
    GATEWAY_PORT: 18789,
    MSTEAMS_WEBHOOK_PATH: actual.MSTEAMS_WEBHOOK_PATH,
    isSafeGatewayEnvValue: actual.isSafeGatewayEnvValue,
    setTeamsCredentials: vi.fn(),
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
vi.mock("@/lib/hermes-env", () => ({ setHermesEnvValues: vi.fn(), getHermesEnvValue: vi.fn() }));

import { get, set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { EnvSecretProviderConflictError, restartGateway, setTeamsCredentials } from "@/lib/openclaw-config";
import {
  ensureChannelPlugin,
  readCachedChannelStatus,
  waitForChannelConnected,
  type ChannelStatus,
} from "@/lib/openclaw-channels";
import { approveHermesChannelPairing, ensureHermesGateway, setHermesChannelSecrets } from "@/lib/hermes-channels";
import { getHermesEnvValue, setHermesEnvValues } from "@/lib/hermes-env";

const APP = "11111111-2222-3333-4444-555555555555";
const TENANT = "66666666-7777-8888-9999-000000000000";
const SECRET = ["clawbox", "test", "not", "a", "real", "secret"].join("~");
const LISTENING = {
  configured: true,
  running: true,
  connected: false,
  tokenStatus: "available",
  restartPending: false,
  lastError: null,
} as ChannelStatus;

const mocks = {
  get: vi.mocked(get),
  set: vi.mocked(set),
  harness: vi.mocked(getActiveHarness),
  setTeams: vi.mocked(setTeamsCredentials),
  restart: vi.mocked(restartGateway),
  plugin: vi.mocked(ensureChannelPlugin),
  wait: vi.mocked(waitForChannelConnected),
  row: vi.mocked(readCachedChannelStatus),
  hermesSecrets: vi.mocked(setHermesChannelSecrets),
  hermesEnv: vi.mocked(setHermesEnvValues),
  hermesEnvGet: vi.mocked(getHermesEnvValue),
  hermesGateway: vi.mocked(ensureHermesGateway),
  hermesApprove: vi.mocked(approveHermesChannelPairing),
};

let fetchMock: ReturnType<typeof vi.fn>;

async function configure(body: unknown) {
  const { POST } = await import("@/app/setup-api/msteams/configure/route");
  const res = await POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}

const VALID = { appId: APP, appPassword: SECRET, tenantId: TENANT };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("CLAWBOX_PREVIEW_CHANNELS", "msteams");
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: "x" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  mocks.harness.mockResolvedValue("openclaw");
  mocks.plugin.mockResolvedValue({ ok: true, installed: true });
  mocks.setTeams.mockResolvedValue(undefined);
  mocks.restart.mockResolvedValue(undefined);
  mocks.wait.mockResolvedValue(LISTENING);
  mocks.hermesGateway.mockResolvedValue({ installed: true, running: true, applied: true } as never);
  mocks.hermesEnvGet.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("preview gate", () => {
  it("answers 404 on every Teams route while the preview is off", async () => {
    vi.stubEnv("CLAWBOX_PREVIEW_CHANNELS", "signal");
    expect((await configure(VALID)).status).toBe(404);
    const status = await import("@/app/setup-api/msteams/status/route");
    expect((await status.GET()).status).toBe(404);
    const pairing = await import("@/app/setup-api/msteams/pairing/route");
    expect((await pairing.POST(new Request("http://localhost/x", { method: "POST", body: "{}" }))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/msteams/configure", () => {
  it("checks with Microsoft, installs the plugin, writes, and reports a listening gateway as success", async () => {
    const { json } = await configure(VALID);
    expect(json).toEqual({
      success: true,
      restarted: true,
      endpoint: { path: "/api/messages", port: 18789 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.plugin).toHaveBeenCalledWith("msteams");
    expect(mocks.setTeams).toHaveBeenCalledWith(APP, SECRET, TENANT);
    expect(mocks.plugin.mock.invocationCallOrder[0]).toBeLessThan(mocks.setTeams.mock.invocationCallOrder[0]);
    expect(mocks.set).toHaveBeenCalledWith("msteams_app_id", APP);
    expect(JSON.stringify(json)).not.toContain(SECRET);
  });

  it("does not call a gateway that logged an error listening", async () => {
    mocks.wait.mockResolvedValue({ ...LISTENING, lastError: "EADDRINUSE" });
    const { json } = await configure(VALID);
    expect(json).toMatchObject({ success: false, code: "not_connected" });
  });

  it.each([
    [{ appId: APP, tenantId: TENANT }, 400, "tokens_required"],
    [{ ...VALID, appId: "nope" }, 400, "id_format"],
    [{ ...VALID, tenantId: "a/b" }, 400, "id_format"],
    [{ ...VALID, appPassword: "a b" }, 400, "token_format"],
  ])("refuses %j before asking Microsoft", async (body, status, code) => {
    const res = await configure(body);
    expect(res.status).toBe(status);
    expect(res.json.code).toBe(code);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("names a rejected secret and writes nothing", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_client", error_codes: [7000215] }), { status: 401 }));
    const { status, json } = await configure(VALID);
    expect(status).toBe(400);
    expect(json.code).toBe("secret_rejected");
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.setTeams).not.toHaveBeenCalled();
  });

  it("reports Microsoft being unreachable as 502", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const { status, json } = await configure(VALID);
    expect(status).toBe(502);
    expect(json.code).toBe("msteams_unavailable");
  });

  it("refuses a secrets provider it does not own", async () => {
    mocks.setTeams.mockRejectedValue(new EnvSecretProviderConflictError("default", "exec"));
    const { json } = await configure(VALID);
    expect(json).toEqual({ success: false, code: "token_unresolved", restarted: false });
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it("stores the secret through hermes config set and the IDs through the env writer on Hermes", async () => {
    mocks.harness.mockResolvedValue("hermes");
    mocks.hermesEnvGet.mockResolvedValue("3999");
    const { json } = await configure(VALID);
    expect(json).toEqual({ success: true, restarted: true, endpoint: { path: "/api/messages", port: 3999 } });
    expect(mocks.hermesSecrets).toHaveBeenCalledWith({ TEAMS_CLIENT_SECRET: SECRET });
    expect(mocks.hermesEnv).toHaveBeenCalledWith({ TEAMS_CLIENT_ID: APP, TEAMS_TENANT_ID: TENANT });
    expect(mocks.plugin).not.toHaveBeenCalled();
  });
});

describe("GET /setup-api/msteams/status", () => {
  it("shows where Teams must deliver even before setup", async () => {
    mocks.get.mockResolvedValue(undefined);
    const { GET } = await import("@/app/setup-api/msteams/status/route");
    expect(await (await GET()).json()).toEqual({ configured: false, endpoint: { path: "/api/messages", port: 18789 } });
  });

  it("calls a running gateway listening, with receiving unknown — never connected", async () => {
    mocks.get.mockResolvedValue(APP);
    mocks.row.mockResolvedValue(LISTENING);
    const { GET } = await import("@/app/setup-api/msteams/status/route");
    const json = await (await GET()).json();
    expect(json).toMatchObject({ configured: true, state: "listening", receiving: null, account: APP });
    expect(mocks.row).toHaveBeenCalledWith("msteams");
  });

  it("uses Hermes' Bot Framework port, 3978 when unset", async () => {
    mocks.harness.mockResolvedValue("hermes");
    mocks.get.mockResolvedValue(undefined);
    const { GET } = await import("@/app/setup-api/msteams/status/route");
    expect((await (await GET()).json()).endpoint).toEqual({ path: "/api/messages", port: 3978 });
  });
});

describe("POST /setup-api/msteams/pairing", () => {
  it("approves on Hermes' teams platform", async () => {
    mocks.harness.mockResolvedValue("hermes");
    mocks.hermesApprove.mockResolvedValue({ userName: "Ada" });
    const { POST } = await import("@/app/setup-api/msteams/pairing/route");
    const res = await POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ code: "ABCD2345" }) }));
    expect(await res.json()).toEqual({ success: true, userName: "Ada" });
    expect(mocks.hermesApprove).toHaveBeenCalledWith("teams", "ABCD2345");
  });
});
