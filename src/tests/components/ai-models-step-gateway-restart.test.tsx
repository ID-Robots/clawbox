import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import AIModelsStep from "@/components/AIModelsStep";
import { waitForGatewayAfterRestart } from "@/lib/wait-for-gateway";

/**
 * TASK-1535. A save that still has to restart the gateway (a subscription
 * sign-in's credential migration stops it) is answered as soon as the restart
 * is underway, `gatewayRestarting: true`, instead of after the two minutes that
 * ran the request past what the browser and the tunnel would hold. Settings
 * then waits for the gateway itself: "configured" must still mean the chat can
 * use it.
 */

vi.mock("@/lib/wait-for-gateway", () => ({
  GATEWAY_BACK_WAIT_MS: 180_000,
  waitForGatewayAfterRestart: vi.fn(),
}));

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string) => ({
      "ai.credentialsVerified": "Credentials verified",
      "ai.updatingConfig": "Updating AI configuration",
      "ai.restartingGateway": "Restarting gateway service",
      "ai.warmingUp": "Warming up models",
      "ai.almostReady": "Almost ready",
      "ai.configured": "AI model configured!",
      "ai.showMore": "Show more providers...",
      "settings.connect": "Connect",
      connecting: "Connecting...",
    } as Record<string, string>)[key] ?? key,
  }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useOllamaModels", () => ({
  useOllamaModels: () => ({
    ollamaRunning: true,
    ollamaModels: [],
    ollamaSearch: "",
    ollamaSearchResults: [],
    ollamaSearching: false,
    ollamaPulling: false,
    ollamaPullProgress: null,
    ollamaSaving: false,
    checkOllamaStatus: vi.fn(),
    handleOllamaSearchChange: vi.fn(),
    pullOllamaModel: vi.fn(),
    saveOllamaConfig: vi.fn(),
    deleteOllamaModel: vi.fn(),
    formatOllamaBytes: vi.fn((bytes: number) => `${bytes}`),
    clearSearch: vi.fn(),
  }),
}));

vi.mock("@/hooks/useLlamaCppModels", () => ({
  useLlamaCppModels: () => ({
    llamaCppRunning: false,
    llamaCppInstalled: true,
    llamaCppModels: [],
    llamaCppEndpoint: "http://127.0.0.1:8080/v1",
    llamaCppSaving: false,
    llamaCppProgress: null,
    checkLlamaCppStatus: vi.fn(),
    saveLlamaCppConfig: vi.fn(),
  }),
}));

const RESTARTING_NOTICE = "Saved. The assistant is restarting to apply it and will be back in about a minute.";

function stubConfigure(answer: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    if (url.includes("/setup-api/ai-models/oauth/providers")) {
      return { ok: true, json: async () => ({ providers: [] }) } as Response;
    }
    if (url.includes("/setup-api/ai-models/configure")) {
      return { ok: true, json: async () => answer } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }));
}

async function saveAnthropicKey(embedded: boolean, onConfigured = vi.fn(), onNext = vi.fn()) {
  const utils = render(
    <AIModelsStep
      embedded={embedded}
      providerIds={["clawai", "openai", "anthropic", "google", "openrouter"]}
      defaultProviderId="clawai"
      onConfigured={onConfigured}
      onNext={onNext}
    />,
  );
  await waitFor(() => {
    expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers");
  });
  const more = utils.queryByRole("button", { name: /Show more providers/i });
  if (more) fireEvent.click(more);
  fireEvent.click(utils.getByRole("radio", { name: /Anthropic Claude/i }));
  const keyInput = utils.container.querySelector("input[type=password], input[type=text]");
  expect(keyInput).not.toBeNull();
  fireEvent.change(keyInput as HTMLInputElement, { target: { value: "sk-ant-test" } });
  const connect = utils.getAllByRole("button").find((button) =>
    /^(Connect|Connect to Anthropic Claude)$/.test(button.textContent?.trim() ?? ""));
  expect(connect).toBeDefined();
  fireEvent.click(connect as HTMLElement);
  return utils;
}

describe("AIModelsStep — a save answered while the gateway restarts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("holds Settings until the gateway is back, then reports the save without the notice", async () => {
    let back!: (ok: boolean) => void;
    vi.mocked(waitForGatewayAfterRestart).mockImplementation(
      () => new Promise<boolean>((resolve) => { back = resolve; }),
    );
    stubConfigure({ success: true, gatewayRestarting: true, restartingNotice: RESTARTING_NOTICE });
    const onConfigured = vi.fn();

    const utils = await saveAnthropicKey(true, onConfigured);

    await waitFor(() => expect(waitForGatewayAfterRestart).toHaveBeenCalledTimes(1));
    expect(onConfigured).not.toHaveBeenCalled();
    back(true);
    await waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(utils.queryByText(RESTARTING_NOTICE)).toBeNull();
  });

  it("shows the server's notice when the gateway is not back within the wait", async () => {
    vi.mocked(waitForGatewayAfterRestart).mockResolvedValue(false);
    stubConfigure({ success: true, gatewayRestarting: true, restartingNotice: RESTARTING_NOTICE });
    const onConfigured = vi.fn();

    const utils = await saveAnthropicKey(true, onConfigured);

    await waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(await utils.findByText(RESTARTING_NOTICE)).toBeInTheDocument();
  });

  it("does not wait at all for a save the gateway applied live", async () => {
    stubConfigure({ success: true });
    const onConfigured = vi.fn();

    await saveAnthropicKey(true, onConfigured);

    await waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(waitForGatewayAfterRestart).not.toHaveBeenCalled();
  });

  it("does not hold the first-run wizard on the gateway", async () => {
    stubConfigure({ success: true, gatewayRestarting: true, restartingNotice: RESTARTING_NOTICE });
    const onNext = vi.fn();

    await saveAnthropicKey(false, vi.fn(), onNext);

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(waitForGatewayAfterRestart).not.toHaveBeenCalled();
  });
});
