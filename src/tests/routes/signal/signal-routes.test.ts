import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * /setup-api/signal/* — a preview channel.
 *
 *   * every route is a 404 until CLAWBOX_PREVIEW_CHANNELS names signal: the
 *     flag is a gate, not a hidden row;
 *   * configure checks the number against signal-cli's own accounts before
 *     writing anything;
 *   * OpenClaw gets the plugin and a managed-native transport; Hermes gets
 *     SIGNAL_HTTP_URL / SIGNAL_ACCOUNT, and is told when no daemon answers.
 */

vi.mock("@/lib/config-store", () => ({ set: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openclaw-config")>("@/lib/openclaw-config");
  return {
    GatewayNotReadyError: actual.GatewayNotReadyError,
    setSignalAccount: vi.fn(),
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
  ensureHermesGateway: vi.fn(),
  hermesGatewayStatus: vi.fn(),
  hermesPlatformRegistered: vi.fn(),
  readHermesGatewaySnapshot: vi.fn(),
  approveHermesChannelPairing: vi.fn(),
}));
vi.mock("@/lib/hermes-env", () => ({ setHermesEnvValues: vi.fn() }));
vi.mock("@/lib/signal-cli", async () => {
  const actual = await vi.importActual<typeof import("@/lib/signal-cli")>("@/lib/signal-cli");
  return {
    SIGNAL_DAEMON_URL: actual.SIGNAL_DAEMON_URL,
    isE164: actual.isE164,
    findSignalCli: vi.fn(),
    listSignalAccounts: vi.fn(),
    signalDaemonReachable: vi.fn(),
    startSignalLink: vi.fn(),
    readSignalLink: vi.fn(),
    cancelSignalLink: vi.fn(),
  };
});

import { get, set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { restartGateway, setSignalAccount } from "@/lib/openclaw-config";
import {
  ensureChannelPlugin,
  readCachedChannelStatus,
  waitForChannelConnected,
  type ChannelStatus,
} from "@/lib/openclaw-channels";
import { ensureHermesGateway } from "@/lib/hermes-channels";
import { setHermesEnvValues } from "@/lib/hermes-env";
import {
  cancelSignalLink,
  findSignalCli,
  listSignalAccounts,
  readSignalLink,
  signalDaemonReachable,
  startSignalLink,
} from "@/lib/signal-cli";

const NUMBER = "+15550000001";
const CLI = "/usr/local/bin/signal-cli";
const CONNECTED = {
  configured: true,
  running: true,
  connected: true,
  tokenStatus: "missing",
  restartPending: false,
  lastError: null,
} as ChannelStatus;

const mocks = {
  get: vi.mocked(get),
  set: vi.mocked(set),
  harness: vi.mocked(getActiveHarness),
  setSignalAccount: vi.mocked(setSignalAccount),
  restart: vi.mocked(restartGateway),
  plugin: vi.mocked(ensureChannelPlugin),
  wait: vi.mocked(waitForChannelConnected),
  row: vi.mocked(readCachedChannelStatus),
  hermesGateway: vi.mocked(ensureHermesGateway),
  hermesEnv: vi.mocked(setHermesEnvValues),
  findCli: vi.mocked(findSignalCli),
  accounts: vi.mocked(listSignalAccounts),
  daemon: vi.mocked(signalDaemonReachable),
  startLink: vi.mocked(startSignalLink),
  readLink: vi.mocked(readSignalLink),
  cancelLink: vi.mocked(cancelSignalLink),
};

async function configure(body: unknown) {
  const { POST } = await import("@/app/setup-api/signal/configure/route");
  const res = await POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("CLAWBOX_PREVIEW_CHANNELS", "signal");
  mocks.harness.mockResolvedValue("openclaw");
  mocks.findCli.mockResolvedValue(CLI);
  mocks.accounts.mockResolvedValue([NUMBER]);
  mocks.plugin.mockResolvedValue({ ok: true, installed: true });
  mocks.setSignalAccount.mockResolvedValue(undefined);
  mocks.restart.mockResolvedValue(undefined);
  mocks.wait.mockResolvedValue(CONNECTED);
  mocks.hermesGateway.mockResolvedValue({ installed: true, running: true, applied: true } as never);
  mocks.daemon.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("preview gate", () => {
  it("answers 404 on every Signal route while the preview is off", async () => {
    vi.stubEnv("CLAWBOX_PREVIEW_CHANNELS", "");
    const { status, json } = await configure({ account: NUMBER });
    expect(status).toBe(404);
    expect(json.code).toBe("preview_disabled");
    const statusRoute = await import("@/app/setup-api/signal/status/route");
    expect((await statusRoute.GET()).status).toBe(404);
    const link = await import("@/app/setup-api/signal/link/route");
    expect((await link.POST()).status).toBe(404);
    expect((await link.GET()).status).toBe(404);
    expect((await link.DELETE()).status).toBe(404);
    const pairing = await import("@/app/setup-api/signal/pairing/route");
    expect((await pairing.POST(new Request("http://localhost/x", { method: "POST", body: "{}" }))).status).toBe(404);
    expect(mocks.findCli).not.toHaveBeenCalled();
    expect(mocks.startLink).not.toHaveBeenCalled();
  });

  it("lists the switched-on previews for the hub", async () => {
    const { GET } = await import("@/app/setup-api/channels/preview/route");
    expect(await (await GET()).json()).toEqual({ channels: ["signal"] });
    vi.stubEnv("CLAWBOX_PREVIEW_CHANNELS", "");
    expect(await (await GET()).json()).toEqual({ channels: [] });
  });
});

describe("POST /setup-api/signal/configure", () => {
  it("installs the plugin, writes the account, restarts and reports a live channel", async () => {
    const { json } = await configure({ account: "+1 (555) 000-0001" });
    expect(json).toEqual({ success: true, restarted: true, account: NUMBER });
    expect(mocks.plugin).toHaveBeenCalledWith("signal");
    expect(mocks.setSignalAccount).toHaveBeenCalledWith(NUMBER, CLI);
    expect(mocks.plugin.mock.invocationCallOrder[0]).toBeLessThan(mocks.setSignalAccount.mock.invocationCallOrder[0]);
    expect(mocks.wait).toHaveBeenCalledWith("signal", expect.anything());
    expect(mocks.set).toHaveBeenCalledWith("signal_account", NUMBER);
  });

  it("refuses a number that is not international, before asking signal-cli", async () => {
    const { status, json } = await configure({ account: "5550000001" });
    expect(status).toBe(400);
    expect(json.code).toBe("account_format");
    expect(mocks.findCli).not.toHaveBeenCalled();
  });

  it("says when signal-cli is not on the box", async () => {
    mocks.findCli.mockResolvedValue(null);
    const { status, json } = await configure({ account: NUMBER });
    expect(status).toBe(409);
    expect(json.code).toBe("signal_cli_missing");
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("refuses a number signal-cli holds no account for, and writes nothing", async () => {
    mocks.accounts.mockResolvedValue(["+15559999999"]);
    const { status, json } = await configure({ account: NUMBER });
    expect(status).toBe(400);
    expect(json.code).toBe("signal_account_unknown");
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.setSignalAccount).not.toHaveBeenCalled();
  });

  it("treats an unanswering signal-cli as 'could not ask', not as a wrong number", async () => {
    mocks.accounts.mockResolvedValue(null);
    const { status, json } = await configure({ account: NUMBER });
    expect(status).toBe(502);
    expect(json.code).toBe("signal_cli_unavailable");
  });

  it("reports a channel the gateway never connected", async () => {
    mocks.wait.mockResolvedValue({ ...CONNECTED, connected: false });
    const { json } = await configure({ account: NUMBER });
    expect(json).toMatchObject({ success: false, code: "not_connected" });
  });

  it("writes Hermes' two variables through the env writer on the Hermes edition", async () => {
    mocks.harness.mockResolvedValue("hermes");
    const { json } = await configure({ account: NUMBER });
    expect(json).toEqual({ success: true, restarted: true, account: NUMBER });
    expect(mocks.hermesEnv).toHaveBeenCalledWith({
      SIGNAL_HTTP_URL: "http://127.0.0.1:8080",
      SIGNAL_ACCOUNT: NUMBER,
    });
    expect(mocks.plugin).not.toHaveBeenCalled();
    expect(mocks.setSignalAccount).not.toHaveBeenCalled();
  });

  it("tells a Hermes box that no signal-cli daemon is answering", async () => {
    mocks.harness.mockResolvedValue("hermes");
    mocks.daemon.mockResolvedValue(false);
    const { json } = await configure({ account: NUMBER });
    expect(json).toMatchObject({ success: false, code: "signal_daemon_unreachable" });
  });
});

describe("/setup-api/signal/link", () => {
  it("starts linking as ClawBox and returns the provisioning URI", async () => {
    mocks.startLink.mockReturnValue({ state: "waiting", uri: "sgnl://linkdevice?uuid=x", startedAt: 1 });
    const { POST } = await import("@/app/setup-api/signal/link/route");
    const res = await POST();
    expect(await res.json()).toEqual({ state: "waiting", uri: "sgnl://linkdevice?uuid=x" });
    expect(mocks.startLink).toHaveBeenCalledWith(CLI, "ClawBox");
  });

  it("refuses to link without signal-cli", async () => {
    mocks.findCli.mockResolvedValue(null);
    const { POST } = await import("@/app/setup-api/signal/link/route");
    const res = await POST();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("signal_cli_missing");
  });

  it("reports the outcome and cancels", async () => {
    const route = await import("@/app/setup-api/signal/link/route");
    mocks.readLink.mockReturnValue({ state: "linked", account: NUMBER });
    expect(await (await route.GET()).json()).toEqual({ state: "linked", account: NUMBER });
    mocks.readLink.mockReturnValue({ state: "linked", account: "" });
    expect(await (await route.GET()).json()).toEqual({ state: "linked", account: null });
    mocks.cancelLink.mockReturnValue({ state: "failed", reason: "cancelled" });
    expect(await (await route.DELETE()).json()).toEqual({ state: "failed", reason: "cancelled" });
  });
});

describe("GET /setup-api/signal/status", () => {
  it("is not configured without a stored account, and says whether signal-cli is there", async () => {
    mocks.get.mockResolvedValue(undefined);
    mocks.findCli.mockResolvedValue(null);
    const { GET } = await import("@/app/setup-api/signal/status/route");
    expect(await (await GET()).json()).toEqual({ configured: false, signalCli: false });
  });

  it("reports the gateway's view of the channel with the account", async () => {
    mocks.get.mockResolvedValue(NUMBER);
    mocks.row.mockResolvedValue(CONNECTED);
    const { GET } = await import("@/app/setup-api/signal/status/route");
    expect(await (await GET()).json()).toMatchObject({
      configured: true,
      state: "connected",
      receiving: true,
      account: NUMBER,
      signalCli: true,
    });
    expect(mocks.row).toHaveBeenCalledWith("signal");
  });
});
