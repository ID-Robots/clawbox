import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
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
        "ai.openAuthPage": "Open authorization page",
        "ai.skipClawai": "Skip — set up ClawBox AI with a portal token",
        skip: "Skip",
        recommended: "Recommended",
        "ai.fullyLocal": "Fully local",
        connecting: "Connecting...",
        "settings.connect": "Connect",
        "settings.aiProvider": "AI Provider",
        "settings.providers.radioGroupLabel": "AI Provider",
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

  it("renders only Gemma in Local AI mode and defaults to llama.cpp", async () => {
    const { getByRole, getByText, queryByText } = render(
      <AIModelsStep
        embedded
        providerIds={["llamacpp"]}
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
    // Gemma is now the sole local engine — Ollama is no longer offered.
    expect(queryByText("Ollama")).not.toBeInTheDocument();
    expect(queryByText("ClawBox AI")).not.toBeInTheDocument();
    expect(queryByText("OpenAI GPT")).not.toBeInTheDocument();
    // Gemma carries the "Fully local" badge (not "Recommended").
    expect(getByText("Fully local")).toBeInTheDocument();
    expect(getByText("Gemma 4 is already configured")).toBeInTheDocument();
  });

  it("skips Local AI setup by advancing to the next step", async () => {
    const onNext = vi.fn();
    const fetchMock = vi.mocked(fetch);
    const { getByRole } = render(
      <AIModelsStep
        providerIds={["llamacpp"]}
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
    const { getByRole, getByText, queryByRole, queryByText } = render(
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
    // The list opens on the selected provider; the rest are one tap behind
    // the same toggle, so reach OpenAI the way a customer does.
    expect(getByText("ClawBox AI")).toBeInTheDocument();
    fireEvent.click(getByRole("button", { name: /Show more providers/i }));
    expect(getByText("OpenAI GPT")).toBeInTheDocument();
    expect(getByText("Recommended")).toBeInTheDocument();
    expect(getByText("All-in cloud AI for ClawBox — backups, remote desktop, full support")).toBeInTheDocument();
    // The plan opens as a summary that still states what it costs; the pitch
    // and the feature list sit behind its "Change".
    expect(getByText("Pro plan · €9/month")).toBeInTheDocument();
    fireEvent.click(getByRole("button", { name: /^Plan/ }));
    expect(getByText("Max plan unlocks ClawKeep cloud backups, Remote Desktop, and extended warranty for ClawBox owners.")).toBeInTheDocument();
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
            verification_url: "https://clawbox.com/portal/connect",
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
      "https://clawbox.com/portal/connect",
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
            verification_url: "https://clawbox.com/portal/connect",
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

    // The tier pills live behind the plan summary — open it, then pick Max.
    fireEvent.click(getByRole("button", { name: /^Plan/ }));
    fireEvent.click(getByRole("radio", { name: /^Max tier/ }));
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
    // jump straight to the other providers via Show-more. Picking one
    // closes the list again — so every hop reopens it, exactly as a
    // customer comparing providers would have to.
    const pickProvider = (name: RegExp) => {
      fireEvent.click(getByRole("button", { name: /Show more providers/i }));
      fireEvent.click(getByRole("radio", { name }));
    };

    pickProvider(/OpenAI GPT/i);
    expect(getByRole("button", { name: "Connect to OpenAI GPT" })).toBeInTheDocument();

    pickProvider(/Anthropic Claude/i);
    expect(getByRole("button", { name: "Connect to Anthropic Claude" })).toBeInTheDocument();

    pickProvider(/Google Gemini/i);
    expect(getByRole("button", { name: "Connect to Google Gemini" })).toBeInTheDocument();

    pickProvider(/OpenRouter/i);
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

  it("reserves the redirect OAuth tab before awaiting and offers a blocked-popup recovery link", async () => {
    let resolveStart: (() => void) | null = null;
    const startReady = new Promise<void>((resolve) => { resolveStart = resolve; });
    const authorizationUrl = "https://console.anthropic.com/oauth/authorize?state=test";
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("/setup-api/ai-models/oauth/providers")) {
        return { ok: true, json: async () => ({ providers: ["anthropic"] }) } as Response;
      }
      if (url.includes("/setup-api/ai-models/oauth/start")) {
        await startReady;
        return { ok: true, json: async () => ({ url: authorizationUrl }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    const { getByRole, findByRole } = render(
      <AIModelsStep
        providerIds={["anthropic"]}
        defaultProviderId="anthropic"
        title="Connect AI Provider"
        description="Primary provider"
      />,
    );

    const connect = await findByRole("button", { name: "Connect to Anthropic Claude" });
    fireEvent.click(connect);

    // The popup reservation happens in the click stack, before device I/O can
    // consume browser user activation. This spy returns null to model a browser
    // that still blocks it.
    expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/oauth/start"))).toBe(true);
    expect(getByRole("button", { name: "Connect to Anthropic Claude" })).toBeInTheDocument();

    resolveStart?.();

    const recovery = await findByRole("link", { name: "Open authorization page" });
    expect(recovery).toHaveAttribute("href", authorizationUrl);
    expect(recovery).toHaveAttribute("target", "_blank");
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
            verification_url: "https://clawbox.com/portal/connect",
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
  // TASK-483: the overlay's rows used to be driven entirely off wall-clock
  // timers, so it reached the final row, "Almost ready", 22 seconds in and then
  // sat there unchanged for the two further minutes the config writes actually
  // took. On a screen that also says "Please don't close this page" that reads
  // as a hang. The last row now belongs to the request, not the stopwatch.
  it("does not claim 'Almost ready' until the configure request comes back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let resolveConfigure: ((value: unknown) => void) | null = null;
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("/setup-api/ai-models/oauth/providers")) {
          return { ok: true, json: async () => ({ providers: [] }) } as unknown as Response;
        }
        if (url.includes("/setup-api/ai-models/configure")) {
          await new Promise((resolve) => { resolveConfigure = resolve; });
          return { ok: true, json: async () => ({ success: true }) } as unknown as Response;
        }
        return { ok: true, json: async () => ({}) } as unknown as Response;
      });

      const { getByRole, getByText, container } = render(
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

      fireEvent.click(getByRole("button", { name: /Show more providers/i }));
      fireEvent.click(getByRole("radio", { name: /Anthropic Claude/i }));
      const keyInput = container.querySelector("input[type=password], input[type=text]");
      expect(keyInput).not.toBeNull();
      fireEvent.change(keyInput as HTMLInputElement, { target: { value: "sk-ant-test" } });
      fireEvent.click(getByRole("button", { name: "Connect to Anthropic Claude" }));

      await waitFor(() => {
        expect(getByText("Credentials verified")).toBeInTheDocument();
      });

      // Well past the last timer in CONFIGURING_STEP_DELAYS.
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });

      // Every row's label is in the DOM the whole time — unreached rows are
      // just rendered transparent — so ask each row what state it is in.
      const stepState = (label: string) =>
        getByText(label).closest("li")?.getAttribute("data-step-state");
      expect(stepState("Warming up models")).toBe("active");
      expect(stepState("Almost ready")).toBe("pending");

      await act(async () => {
        resolveConfigure?.(undefined);
      });

      await waitFor(() => {
        expect(stepState("Almost ready")).toBe("done");
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
