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
    const { getByLabelText, getByRole, getByText, queryByRole, queryByText } = render(
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
    expect(queryByRole("dialog", { name: /ClawBox AI token setup/i })).not.toBeInTheDocument();

    fireEvent.click(getByRole("button", { name: /Paste token manually instead/i }));

    expect(getByRole("dialog", { name: /ClawBox AI token setup/i })).toBeInTheDocument();
    expect(getByText("Unlock the recommended ClawBox AI experience")).toBeInTheDocument();
    expect(getByRole("link", { name: /Open portal/i })).toHaveAttribute("href", "https://openclawhardware.dev/portal");
    expect(getByLabelText(/Paste your portal token/i, { selector: "input" })).toBeInTheDocument();
    expect(getByRole("button", { name: /Connect to ClawBox AI/i })).toBeInTheDocument();
    expect(getByText("ClawBox owners keep access to extended warranty benefits when using ClawBox services.")).toBeInTheDocument();
    expect(queryByText("llama.cpp Local")).not.toBeInTheDocument();
    expect(queryByText("Ollama Local")).not.toBeInTheDocument();
  });

  it("opens the ClawBox AI popup when requested externally", async () => {
    const { getByRole, getByText } = render(
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

    expect(getByRole("dialog", { name: /ClawBox AI token setup/i })).toBeInTheDocument();
    expect(getByText("Unlock the recommended ClawBox AI experience")).toBeInTheDocument();
  });

  it("closes the ClawBox AI popup when the provider becomes connected", async () => {
    const { getByRole, queryByRole, rerender } = render(
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

    expect(getByRole("dialog", { name: /ClawBox AI token setup/i })).toBeInTheDocument();

    rerender(
      <AIModelsStep
        embedded
        providerIds={["clawai", "openai", "anthropic", "google", "openrouter"]}
        defaultProviderId="openai"
        openClawAIOfferRequest={1}
        currentProviderId="clawai"
        title="Connect AI Provider"
        description="Primary provider"
      />,
    );

    await waitFor(() => {
      expect(queryByRole("dialog", { name: /ClawBox AI token setup/i })).not.toBeInTheDocument();
    });
  });

  it("submits the pasted ClawBox AI token to the configure route", async () => {
    const { getByLabelText, getByRole } = render(
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

    fireEvent.click(getByRole("button", { name: /Paste token manually instead/i }));
    fireEvent.change(getByLabelText(/Paste your portal token/i, { selector: "input" }), {
      target: { value: "portal-token-123" },
    });
    fireEvent.click(getByRole("button", { name: /Connect to ClawBox AI/i }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/setup-api/ai-models/configure",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope: "primary",
            provider: "clawai",
            apiKey: "portal-token-123",
          }),
          signal: expect.any(AbortSignal),
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

    expect(getByRole("button", { name: "Connect to ClawBox AI" })).toBeInTheDocument();

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

    fireEvent.click(getByRole("radio", { name: /OpenAI GPT/i }));
    expect(queryByRole("dialog", { name: /ClawBox AI token setup/i })).not.toBeInTheDocument();

    fireEvent.click(getByRole("button", { name: /Skip/i }));

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(queryByRole("dialog", { name: /ClawBox AI token setup/i })).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => typeof input === "string" && input.includes("/setup-api/ai-models/configure")),
    ).toBe(false);
  });

  it("starts the ClawBox AI portal flow and polls the local callback status", async () => {
    const onConfigured = vi.fn();
    const openMock = vi.fn(() => ({ focus: vi.fn(), close: vi.fn(), closed: false }));
    vi.stubGlobal("open", openMock);
    let pollCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("/setup-api/ai-models/oauth/providers")) {
        return { ok: true, json: async () => ({ providers: [] }) };
      }
      if (url === "/setup-api/ai-models/clawai/start") {
        return {
          ok: true,
          json: async () => ({ url: "https://openclawhardware.dev/portal/connect?state=abc" }),
        };
      }
      if (url === "/setup-api/ai-models/clawai/status") {
        pollCount += 1;
        return {
          ok: true,
          json: async () => (pollCount > 1 ? { status: "complete" } : { status: "pending" }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }));

    const { getByRole } = render(
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

    fireEvent.click(getByRole("button", { name: /^Connect$/i }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/clawai/start", expect.objectContaining({
        method: "POST",
      }));
    });
    expect(openMock).toHaveBeenCalledWith("https://openclawhardware.dev/portal/connect?state=abc", "_blank", "noopener,noreferrer");

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/clawai/status", { cache: "no-store" });
    });
    await waitFor(() => {
      expect(onConfigured).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });
    vi.unstubAllGlobals();
  });
});
