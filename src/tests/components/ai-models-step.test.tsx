import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import AIModelsStep from "@/components/AIModelsStep";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        "ai.credentialsVerified": "Credentials verified",
        "ai.updatingConfig": "Updating AI configuration",
        "ai.restartingGateway": "Restarting gateway service",
        "ai.warmingUp": "Warming up models",
        "ai.almostReady": "Almost ready",
        "ai.title": "Connect AI Model",
        "ai.description": "Select your AI provider and enter your API key or subscription token.",
        "ai.clawaiDesc": "Most affordable - start for free",
        "ai.clawaiHint": "ClawBox AI is pre-configured and ready to go. Just click below to get started — no API key or account needed.",
        "ai.useClawai": "Start for free",
        "ai.claudeModels": "Claude models by Anthropic",
        "ai.gptModels": "GPT models by OpenAI",
        "ai.geminiModels": "Gemini models by Google",
        "ai.multiProvider": "Multi-provider AI gateway",
        "ai.runLocally": "Run AI models locally on device",
        "ai.showMore": "Show more providers...",
        "ai.skipClawai": "Skip — set up ClawBox AI with a portal token",
        skip: "Skip",
        recommended: "Recommended",
        connecting: "Connecting...",
        "settings.connect": "Connect",
        "settings.aiProvider": "AI Provider",
      };
      return translations[key] ?? key;
    },
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

describe("AIModelsStep variants", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("/setup-api/ai-models/oauth/providers")) {
        return {
          ok: true,
          json: async () => ({ providers: [] }),
        };
      }

      if (url.includes("/setup-api/ai-models/configure")) {
        return {
          ok: true,
          json: async () => ({ success: true }),
        };
      }

      return {
        ok: true,
        json: async () => ({}),
      };
    }));
  });

  it("renders only local providers in Local AI mode and defaults to llama.cpp", async () => {
    const { getByRole, getByText, queryByText } = render(
      <AIModelsStep
        embedded
        providerIds={["llamacpp", "ollama"]}
        defaultProviderId="llamacpp"
        title="Set Up Local AI"
        description="Local models first"
        configureScope="local"
        testId="local-ai-test"
        // Gemma is currently the active chat provider — required for the
        // panel to render the "configured" pill rather than the orange
        // "Switch to Gemma 4" call-to-action (which appears when Gemma is
        // on disk but some other provider is primary).
        currentProviderId="llamacpp"
      />,
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers");
    });

    expect(getByText("Set Up Local AI")).toBeInTheDocument();
    const providerGroup = getByRole("radiogroup", { name: "AI Provider" });
    expect(providerGroup).toHaveTextContent("Gemma 4");
    expect(providerGroup).toHaveTextContent("Ollama");
    expect(queryByText("ClawBox AI")).not.toBeInTheDocument();
    expect(queryByText("OpenAI GPT")).not.toBeInTheDocument();
    expect(getByText("Recommended")).toBeInTheDocument();
    expect(getByText("Gemma 4 is already configured")).toBeInTheDocument();
  });

  it("skips Local AI setup by advancing to the next step", async () => {
    const onNext = vi.fn();
    const fetchMock = vi.mocked(fetch);
    const { getByRole } = render(
      <AIModelsStep
        providerIds={["llamacpp", "ollama"]}
        defaultProviderId="llamacpp"
        title="Set Up Local AI"
        description="Local models first"
        configureScope="local"
        onNext={onNext}
        testId="local-ai-test"
      />,
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers");
    });

    fireEvent.click(getByRole("button", { name: /Skip/i }));

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(([input]) => typeof input === "string" && input.includes("/setup-api/ai-models/configure")),
    ).toBe(false);
  });

  it("renders only cloud and ClawBox providers in provider mode", async () => {
    const { getByText, queryByRole, queryByText } = render(
      <AIModelsStep
        embedded
        providerIds={["clawai", "openai", "anthropic", "google", "openrouter"]}
        defaultProviderId="clawai"
        title="Connect AI Provider"
        description="Primary provider"
      />,
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers");
    });

    expect(getByText("Connect AI Provider")).toBeInTheDocument();
    expect(getByText("ClawBox AI")).toBeInTheDocument();
    expect(getByText("OpenAI GPT")).toBeInTheDocument();
    expect(getByText("Recommended")).toBeInTheDocument();
    expect(getByText("Recommended ClawBox AI service with simple token setup and owner benefits")).toBeInTheDocument();
    expect(getByText("ClawBox AI is the recommended cloud experience for owners, with quick token setup and a smoother day-one path.")).toBeInTheDocument();
    expect(getByText("ClawBox owners also get extended warranty benefits when using ClawBox services.")).toBeInTheDocument();
    // The legacy "Paste token manually" dialog has been removed — connection
    // is handled exclusively through the portal handoff. Verify nothing in
    // the surface tries to mount a token-paste dialog.
    expect(queryByRole("dialog", { name: /ClawBox AI token setup/i })).not.toBeInTheDocument();
    expect(queryByText(/Paste token manually instead/i)).not.toBeInTheDocument();
    expect(queryByText("llama.cpp Local")).not.toBeInTheDocument();
    expect(queryByText("Ollama Local")).not.toBeInTheDocument();
  });

  it("kicks off the device-auth flow when an external offer is requested", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("/setup-api/ai-models/oauth/providers")) {
        return { ok: true, json: async () => ({ providers: [] }) } as Response;
      }
      if (url.includes("/setup-api/ai-models/clawai/start")) {
        return {
          ok: true,
          json: async () => ({
            user_code: "ABCD-1234",
            verification_url: "https://openclawhardware.dev/portal/connect",
            interval: 5,
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    const { findByText, getByRole } = render(
      <AIModelsStep
        embedded
        providerIds={["clawai", "openai", "anthropic", "google", "openrouter"]}
        defaultProviderId="openai"
        openClawAIOfferRequest={1}
        title="Connect AI Provider"
        description="Primary provider"
      />,
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers");
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/setup-api/ai-models/clawai/start",
        expect.objectContaining({ method: "POST" }),
      );
    });
    // The Subscription tab now renders the user_code on the device — the
    // user copies it and types it on the portal — instead of opening a
    // popup that navigates to a state-stamped URL.
    expect(await findByText("ABCD-1234")).toBeInTheDocument();
    expect(getByRole("link", { name: /Open authorization page/i })).toHaveAttribute(
      "href",
      "https://openclawhardware.dev/portal/connect",
    );
  });

  it("forwards the selected ClawBox AI tier to the start endpoint", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("/setup-api/ai-models/oauth/providers")) {
        return { ok: true, json: async () => ({ providers: [] }) } as Response;
      }
      if (url.includes("/setup-api/ai-models/clawai/start")) {
        return {
          ok: true,
          json: async () => ({
            user_code: "ABCD-1234",
            verification_url: "https://openclawhardware.dev/portal/connect",
            interval: 5,
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    const { getByRole } = render(
      <AIModelsStep
        embedded
        providerIds={["clawai", "openai", "anthropic", "google", "openrouter"]}
        defaultProviderId="clawai"
        title="Connect AI Provider"
        description="Primary provider"
      />,
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers");
    });

    fireEvent.click(getByRole("radio", { name: /^Pro tier/ }));
    fireEvent.click(getByRole("button", { name: /Get device code/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/setup-api/ai-models/clawai/start",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ scope: "primary", tier: "pro" }),
        }),
      );
    });
  });

  it("selects the currently configured provider alias in settings mode", async () => {
    const { getByRole } = render(
      <AIModelsStep
        embedded
        providerIds={["clawai", "openai", "anthropic", "google", "openrouter"]}
        defaultProviderId="clawai"
        currentProviderId="openai-codex"
        currentModel="openai-codex/gpt-5.4"
        title="Connect AI Provider"
        description="Primary provider"
      />,
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers");
    });

    await waitFor(() => {
      expect(getByRole("radio", { name: /OpenAI GPT/i })).toBeChecked();
    });
  });

  it("uses consistent setup button labels for provider connections", async () => {
    const { getByRole } = render(
      <AIModelsStep
        providerIds={["clawai", "openai", "anthropic", "google", "openrouter"]}
        defaultProviderId="clawai"
        title="Connect AI Provider"
        description="Primary provider"
      />,
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers");
    });

    // ClawBox AI's Subscription tab drives its own "Get device code"
    // button instead of the generic per-provider Connect label, so we
    // jump straight to the other providers via Show-more.
    fireEvent.click(getByRole("button", { name: /Show more providers/i }));
    fireEvent.click(getByRole("radio", { name: /OpenAI GPT/i }));
    expect(getByRole("button", { name: "Connect to OpenAI GPT" })).toBeInTheDocument();

    fireEvent.click(getByRole("radio", { name: /Anthropic Claude/i }));
    expect(getByRole("button", { name: "Connect to Anthropic Claude" })).toBeInTheDocument();

    fireEvent.click(getByRole("radio", { name: /Google Gemini/i }));
    expect(getByRole("button", { name: "Connect to Google Gemini" })).toBeInTheDocument();

    fireEvent.click(getByRole("radio", { name: /OpenRouter/i }));
    expect(getByRole("button", { name: "Connect to OpenRouter" })).toBeInTheDocument();
  });

  it("uses the skip action to continue setup without posting empty credentials", async () => {
    const fetchMock = vi.mocked(fetch);
    const onNext = vi.fn();
    const { getByRole, queryByRole } = render(
      <AIModelsStep
        providerIds={["clawai", "openai", "anthropic", "google", "openrouter"]}
        defaultProviderId="clawai"
        title="Connect AI Provider"
        description="Primary provider"
        onNext={onNext}
      />,
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers");
    });

    fireEvent.click(getByRole("button", { name: /Show more providers/i }));
    fireEvent.click(getByRole("radio", { name: /OpenAI GPT/i }));
    expect(queryByRole("dialog", { name: /ClawBox AI token setup/i })).not.toBeInTheDocument();

    fireEvent.click(getByRole("button", { name: /Skip/i }));

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(queryByRole("dialog", { name: /ClawBox AI token setup/i })).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => typeof input === "string" && input.includes("/setup-api/ai-models/configure")),
    ).toBe(false);
  });

  it("renders the device code and completes once /clawai/poll reports success", async () => {
    const onConfigured = vi.fn();
    let pollCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("/setup-api/ai-models/oauth/providers")) {
        return { ok: true, json: async () => ({ providers: [] }) };
      }
      if (url === "/setup-api/ai-models/clawai/start") {
        return {
          ok: true,
          json: async () => ({
            user_code: "ABCD-1234",
            verification_url: "https://openclawhardware.dev/portal/connect",
            // Sub-second poll interval keeps the test fast on real timers.
            interval: 0.05,
          }),
        };
      }
      if (url === "/setup-api/ai-models/clawai/poll") {
        pollCount += 1;
        return {
          ok: true,
          json: async () => (pollCount > 1 ? { status: "complete" } : { status: "pending" }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }));

    const { findByText, getByRole } = render(
      <AIModelsStep
        embedded
        providerIds={["clawai", "openai", "anthropic", "google", "openrouter"]}
        defaultProviderId="clawai"
        onConfigured={onConfigured}
      />,
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers");
    });

    fireEvent.click(getByRole("button", { name: /Get device code/i }));

    expect(await findByText("ABCD-1234")).toBeInTheDocument();

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/setup-api/ai-models/clawai/poll",
        expect.objectContaining({ method: "POST" }),
      );
    });

    await waitFor(() => {
      expect(onConfigured).toHaveBeenCalledTimes(1);
    }, { timeout: 4000 });

    vi.unstubAllGlobals();
  });
});
