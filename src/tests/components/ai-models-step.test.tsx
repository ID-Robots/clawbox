import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@/tests/helpers/test-utils";
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
        "ai.claudeModels": "Claude models by Anthropic",
        "ai.gptModels": "GPT models by OpenAI",
        "ai.geminiModels": "Gemini models by Google",
        "ai.multiProvider": "Multi-provider AI gateway",
        "ai.runLocally": "Run AI models locally on device",
        "ai.showMore": "Show more providers...",
        recommended: "Recommended",
        save: "Save",
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ providers: [] }),
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
    expect(getByText("Enable Gemma 4")).toBeInTheDocument();
  });

  it("renders only cloud and ClawBox providers in provider mode", async () => {
    const { getByText, queryByText } = render(
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
    expect(queryByText("llama.cpp Local")).not.toBeInTheDocument();
    expect(queryByText("Ollama Local")).not.toBeInTheDocument();
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
});
