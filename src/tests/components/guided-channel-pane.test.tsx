/**
 * Settings → Slack (the guided channel pane): set up with two pasted tokens and
 * the app manifest, report a save by what the route says rather than by "the
 * request returned", and approve a new sender's pairing code.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import GuidedChannelPane, {
  type GuidedChannelStatus,
  toGuidedChannelStatus,
} from "@/components/GuidedChannelPane";

vi.mock("@/lib/i18n", () => ({
  LANGUAGES: [{ code: "en", name: "English" }],
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}|${Object.values(params).join("|")}` : key,
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

const MANIFEST = '{\n  "display_information": { "name": "ClawBox" }\n}';
const BOT = ["xoxb", "000000000000", "000000000000", "clawboxtestnotreal"].join("-");
const APP = ["xapp", "1", "A000000000", "000000000000", "clawboxtestnotreal"].join("-");

const NOT_CONFIGURED: GuidedChannelStatus = toGuidedChannelStatus({ configured: false });
const CONNECTED: GuidedChannelStatus = toGuidedChannelStatus({
  configured: true,
  state: "connected",
  receiving: true,
  team: "Acme",
  botName: "clawbox",
});

type Answer = { status?: number; body: unknown };
let answers: Record<string, Answer>;
let fetchMock: ReturnType<typeof vi.fn>;

function respond({ status = 200, body }: Answer) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);
}

beforeEach(() => {
  answers = {
    "/setup-api/slack/manifest": { body: { manifest: MANIFEST, source: "openclaw" } },
    "/setup-api/slack/configure": { body: { success: true, restarted: true } },
    "/setup-api/slack/pairing": { body: { success: true, userName: null } },
  };
  fetchMock = vi.fn((input: string | URL) => {
    const url = input.toString();
    const hit = Object.keys(answers).find((prefix) => url.startsWith(prefix));
    return respond(hit ? answers[hit] : { body: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
});

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { selector: "input" }), { target: { value } });
}

describe("toGuidedChannelStatus", () => {
  it("narrows anything unexpected to not configured / unknown", () => {
    expect(toGuidedChannelStatus(null)).toMatchObject({ configured: false, state: null, receiving: null });
    expect(toGuidedChannelStatus({ configured: true, state: "weird", receiving: "yes", team: " " })).toMatchObject({
      configured: true,
      state: null,
      receiving: null,
      team: null,
    });
  });
});

describe("GuidedChannelPane (Slack)", () => {
  it("shows a skeleton and no setup card before the status is read", () => {
    render(<GuidedChannelPane channel="slack" status={null} onRefresh={vi.fn()} />);
    expect(screen.queryByTestId("slack-setup")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers the steps, the manifest and both token fields when not configured", async () => {
    render(<GuidedChannelPane channel="slack" status={NOT_CONFIGURED} onRefresh={vi.fn()} />);
    expect(screen.getByTestId("slack-setup")).toHaveTextContent("settings.slackGuideTitle");
    expect(screen.getByText("settings.slackOpenApps").closest("a")).toHaveAttribute("href", "https://api.slack.com/apps");
    expect(screen.getByText("settings.slackSocketModeNote")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("slack-manifest")).toHaveTextContent("ClawBox"));
    // Both tokens are needed: one field filled is not a save.
    const connect = screen.getByRole("button", { name: /settings\.connect/ });
    expect(connect).toBeDisabled();
    fill("settings.slackBotToken", BOT);
    expect(connect).toBeDisabled();
    fill("settings.slackAppToken", APP);
    expect(connect).toBeEnabled();
  });

  it("posts both tokens and reports a live save as connected", async () => {
    const onRefresh = vi.fn();
    render(<GuidedChannelPane channel="slack" status={NOT_CONFIGURED} onRefresh={onRefresh} />);
    fill("settings.slackBotToken", BOT);
    fill("settings.slackAppToken", APP);
    fireEvent.click(screen.getByRole("button", { name: /settings\.connect/ }));
    await waitFor(() => expect(screen.getByText("settings.channelSaveConnected")).toBeInTheDocument());
    const call = fetchMock.mock.calls.find(([u]) => String(u) === "/setup-api/slack/configure");
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ botToken: BOT, appToken: APP });
    expect(onRefresh).toHaveBeenCalled();
  });

  it("says a saved-but-not-live channel is not connected yet, by its code", async () => {
    answers["/setup-api/slack/configure"] = { body: { success: false, code: "not_connected", restarted: true } };
    render(<GuidedChannelPane channel="slack" status={NOT_CONFIGURED} onRefresh={vi.fn()} />);
    fill("settings.slackBotToken", BOT);
    fill("settings.slackAppToken", APP);
    fireEvent.click(screen.getByRole("button", { name: /settings\.connect/ }));
    await waitFor(() =>
      expect(screen.getByText("settings.channelSaveNotConnected|settings.slack")).toBeInTheDocument(),
    );
  });

  it("names the token Slack refused, and keeps what was typed", async () => {
    answers["/setup-api/slack/configure"] = { status: 400, body: { error: "x", code: "app_token_scope" } };
    render(<GuidedChannelPane channel="slack" status={NOT_CONFIGURED} onRefresh={vi.fn()} />);
    fill("settings.slackBotToken", BOT);
    fill("settings.slackAppToken", APP);
    fireEvent.click(screen.getByRole("button", { name: /settings\.connect/ }));
    await waitFor(() =>
      expect(screen.getByText("settings.slackAppTokenScope|settings.slack")).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("settings.slackBotToken", { selector: "input" })).toHaveValue(BOT);
  });

  it("falls back to a generic failure for an unknown answer", async () => {
    answers["/setup-api/slack/configure"] = { status: 500, body: { error: "Failed to save" } };
    render(<GuidedChannelPane channel="slack" status={NOT_CONFIGURED} onRefresh={vi.fn()} />);
    fill("settings.slackBotToken", BOT);
    fill("settings.slackAppToken", APP);
    fireEvent.click(screen.getByRole("button", { name: /settings\.connect/ }));
    await waitFor(() => expect(screen.getByText("settings.channelSaveFailed")).toBeInTheDocument());
  });

  it("shows a connected bot with its workspace, and approves a pairing code", async () => {
    render(<GuidedChannelPane channel="slack" status={CONNECTED} onRefresh={vi.fn()} />);
    const card = screen.getByTestId("slack-status-card");
    expect(card).toHaveAttribute("data-state", "connected");
    expect(card).toHaveTextContent("clawbox");
    expect(card).toHaveTextContent("settings.channelInWorkspace|Acme");
    expect(card).toHaveTextContent("settings.channelLive");
    expect(screen.queryByTestId("slack-setup")).toBeNull();
    // The manifest is only asked for while the setup card is on screen.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/manifest"))).toBe(false);

    fireEvent.change(screen.getByLabelText("settings.channelPairingPlaceholder"), { target: { value: "abcd2345" } });
    fireEvent.click(screen.getByRole("button", { name: "settings.channelPairingApprove" }));
    await waitFor(() => expect(screen.getByText("settings.channelPairingApproved")).toBeInTheDocument());
    const call = fetchMock.mock.calls.find(([u]) => String(u) === "/setup-api/slack/pairing");
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ code: "abcd2345" });
  });

  it("explains a refused pairing code", async () => {
    answers["/setup-api/slack/pairing"] = { status: 404, body: { code: "not_found" } };
    render(<GuidedChannelPane channel="slack" status={CONNECTED} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("settings.channelPairingPlaceholder"), { target: { value: "ABCD2345" } });
    fireEvent.click(screen.getByRole("button", { name: "settings.channelPairingApprove" }));
    await waitFor(() => expect(screen.getByText("settings.channelPairingNotFound")).toBeInTheDocument());
  });

  it("surfaces a revoked token and an offline channel with their remedies", () => {
    const { rerender } = render(
      <GuidedChannelPane channel="slack" status={toGuidedChannelStatus({ configured: true, state: "offline", tokenRejected: true })} onRefresh={vi.fn()} />,
    );
    expect(screen.getByTestId("slack-status-card")).toHaveAttribute("data-state", "rejected");
    expect(screen.getByText("settings.channelStateRejected|settings.slack")).toBeInTheDocument();

    rerender(<GuidedChannelPane channel="slack" status={toGuidedChannelStatus({ configured: true, state: "offline" })} onRefresh={vi.fn()} />);
    expect(screen.getByTestId("slack-status-card")).toHaveAttribute("data-state", "offline");
    expect(screen.getByText("settings.channelStateOfflineHint|settings.slack")).toBeInTheDocument();
  });

  it("re-reads the status on request and opens the setup card to reconfigure", async () => {
    const onRefresh = vi.fn();
    render(<GuidedChannelPane channel="slack" status={CONNECTED} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "settings.channelCheckAgain" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "settings.reconfigureBot" }));
    expect(screen.getByTestId("slack-setup")).toBeInTheDocument();
    expect(screen.queryByTestId("slack-pairing")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("slack-manifest")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.queryByTestId("slack-setup")).toBeNull();
  });
});

describe("GuidedChannelPane (Signal, preview)", () => {
  const NUMBER = "+15550000001";
  const SIGNAL_OFF = toGuidedChannelStatus({ configured: false, signalCli: true });

  it("says signal-cli is missing instead of offering a QR code", () => {
    render(
      <GuidedChannelPane channel="signal" status={toGuidedChannelStatus({ configured: false, signalCli: false })} onRefresh={vi.fn()} />,
    );
    expect(screen.getByTestId("signal-prerequisite")).toHaveTextContent("settings.signalCliMissing");
    expect(screen.queryByRole("button", { name: /settings\.signalShowQr/ })).toBeNull();
    expect(screen.queryByLabelText("settings.signalAccount", { selector: "input" })).toBeNull();
    expect(screen.getByText("settings.channelPreviewBadge")).toBeInTheDocument();
  });

  it("links with a QR code and finishes the setup with the number the phone linked", async () => {
    let linkPolls = 0;
    answers["/setup-api/signal/configure"] = { body: { success: true, restarted: true, account: NUMBER } };
    fetchMock.mockImplementation((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/setup-api/signal/link" && init?.method === "POST") {
        return respond({ body: { state: "waiting", uri: "sgnl://linkdevice?uuid=abc" } });
      }
      if (url === "/setup-api/signal/link") {
        linkPolls += 1;
        return respond({ body: linkPolls < 2 ? { state: "waiting", uri: "sgnl://linkdevice?uuid=abc" } : { state: "linked", account: NUMBER } });
      }
      const hit = Object.keys(answers).find((prefix) => url.startsWith(prefix));
      return respond(hit ? answers[hit] : { body: {} });
    });
    render(<GuidedChannelPane channel="signal" status={SIGNAL_OFF} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /settings\.signalShowQr/ }));
    await waitFor(() => expect(screen.getByTestId("signal-link-qr")).toBeInTheDocument());
    expect(screen.getByText("settings.signalWaiting")).toBeInTheDocument();
    await waitFor(
      () => {
        const call = fetchMock.mock.calls.find(([u]) => String(u) === "/setup-api/signal/configure");
        expect(call).toBeDefined();
        expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ account: NUMBER });
      },
      { timeout: 8000 },
    );
    await waitFor(() => expect(screen.getByText("settings.channelSaveConnected")).toBeInTheDocument());
  });

  it("explains a failed link and offers a new code", async () => {
    answers["/setup-api/signal/link"] = { status: 409, body: { code: "signal_cli_missing" } };
    render(<GuidedChannelPane channel="signal" status={SIGNAL_OFF} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /settings\.signalShowQr/ }));
    await waitFor(() => expect(screen.getByText("settings.signalCliMissing|settings.signal")).toBeInTheDocument());
  });

  it("takes a number by hand for an account already linked on the box", async () => {
    answers["/setup-api/signal/configure"] = { status: 400, body: { code: "signal_account_unknown" } };
    render(<GuidedChannelPane channel="signal" status={SIGNAL_OFF} onRefresh={vi.fn()} />);
    expect(screen.getByText("settings.signalManualTitle")).toBeInTheDocument();
    fill("settings.signalAccount", NUMBER);
    fireEvent.click(screen.getByRole("button", { name: /settings\.connect/ }));
    await waitFor(() => expect(screen.getByText("settings.signalAccountUnknown|settings.signal")).toBeInTheDocument());
  });

  it("names the linked number on the status card", () => {
    render(
      <GuidedChannelPane
        channel="signal"
        status={toGuidedChannelStatus({ configured: true, state: "connected", receiving: true, account: NUMBER, signalCli: true })}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByTestId("signal-status-card")).toHaveTextContent(`settings.signalNumber|${NUMBER}`);
    expect(screen.getByTestId("signal-pairing")).toBeInTheDocument();
  });
});

describe("GuidedChannelPane (Microsoft Teams, preview)", () => {
  const APP = "11111111-2222-3333-4444-555555555555";
  const TENANT = "66666666-7777-8888-9999-000000000000";
  const ENDPOINT = { path: "/api/messages", port: 18789 };

  it("shows where Teams must deliver before setup, and asks for all three values", () => {
    render(<GuidedChannelPane channel="msteams" status={toGuidedChannelStatus({ configured: false, endpoint: ENDPOINT })} onRefresh={vi.fn()} />);
    expect(screen.getByTestId("msteams-endpoint")).toHaveTextContent("settings.teamsEndpointHint|18789|/api/messages");
    expect(screen.getByText("settings.teamsOpenPortal").closest("a")).toHaveAttribute(
      "href",
      "https://portal.azure.com/#create/Microsoft.AzureBot",
    );
    const connect = screen.getByRole("button", { name: /settings\.connect/ });
    fill("settings.teamsAppId", APP);
    fill("settings.teamsTenantId", TENANT);
    expect(connect).toBeDisabled();
    fill("settings.teamsAppPassword", "secret-value");
    expect(connect).toBeEnabled();
  });

  it("says a save is listening rather than connected", async () => {
    answers["/setup-api/msteams/configure"] = { body: { success: true, restarted: true, endpoint: ENDPOINT } };
    render(<GuidedChannelPane channel="msteams" status={toGuidedChannelStatus({ configured: false, endpoint: ENDPOINT })} onRefresh={vi.fn()} />);
    fill("settings.teamsAppId", APP);
    fill("settings.teamsTenantId", TENANT);
    fill("settings.teamsAppPassword", "secret-value");
    fireEvent.click(screen.getByRole("button", { name: /settings\.connect/ }));
    await waitFor(() => expect(screen.getByText("settings.teamsSaveListening")).toBeInTheDocument());
    const call = fetchMock.mock.calls.find(([u]) => String(u) === "/setup-api/msteams/configure");
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ appId: APP, tenantId: TENANT, appPassword: "secret-value" });
  });

  it("renders a listening channel without claiming it receives, and keeps the endpoint in view", () => {
    render(
      <GuidedChannelPane
        channel="msteams"
        status={toGuidedChannelStatus({ configured: true, state: "listening", receiving: null, account: APP, endpoint: ENDPOINT })}
        onRefresh={vi.fn()}
      />,
    );
    const card = screen.getByTestId("msteams-status-card");
    expect(card).toHaveAttribute("data-state", "listening");
    expect(card).toHaveTextContent("settings.channelStateListening|settings.msteams");
    expect(card).toHaveTextContent(`settings.teamsAppIdShort|${APP}`);
    expect(card).not.toHaveTextContent("settings.channelLive");
    expect(screen.getByTestId("msteams-endpoint")).toBeInTheDocument();
  });

  it("names a rejected secret", async () => {
    answers["/setup-api/msteams/configure"] = { status: 400, body: { code: "secret_rejected" } };
    render(<GuidedChannelPane channel="msteams" status={toGuidedChannelStatus({ configured: false, endpoint: ENDPOINT })} onRefresh={vi.fn()} />);
    fill("settings.teamsAppId", APP);
    fill("settings.teamsTenantId", TENANT);
    fill("settings.teamsAppPassword", "secret-value");
    fireEvent.click(screen.getByRole("button", { name: /settings\.connect/ }));
    await waitFor(() => expect(screen.getByText("settings.teamsSecretRejected|settings.msteams")).toBeInTheDocument());
  });
});
