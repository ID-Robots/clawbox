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
        "ai.grokModels": "Grok models by xAI",
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
        // The device-code card is shared with the coding agent's GitHub login
        // now (src/components/DeviceCodeCard.tsx) and speaks through t(),
        // where it used to carry hardcoded English. Same strings, from the
        // real catalogue.
        "ai.thenEnterCode": "Then enter this code:",
        "ai.codeExpires": "Code expires in 15 minutes",
        "ai.waitingAuth": "Waiting for authorization...",
        "ai.getNewCode": "Get a new code",
        copy: "Copy",
        copied: "Copied!",
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

  /**
   * TASK-668. This is the CONNECT list, and it offers every provider it was
   * asked to — including one the Providers strip has dropped because the box
   * can currently run no model from it.
   *
   * That is not an oversight, it is the pair: connecting is the way OUT of that
   * state (saving a cloud provider writes its configured model rows and
   * `models.mode: "merge"`), so the strip may drop such a row only because this
   * list never does. An earlier revision filtered here too and left a box with
   * no door.
   */
  describe("a provider the box can run no model from", () => {
    function stubStatus(unrunnable: string[]) {
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("/setup-api/providers/status")) {
          return {
            ok: true,
            json: async () => ({
              harness: "openclaw",
              defaultProvider: "clawai",
              unrunnable,
              degraded: false,
              providers: [
                { id: "clawai", label: "ClawBox AI", state: "connected", isDefault: true, section: "ai", enabled: true },
              ],
            }),
          };
        }
        if (url.includes("/setup-api/ai-models/oauth/providers")) {
          return { ok: true, json: async () => ({ providers: [] }) };
        }
        return { ok: true, json: async () => ({}) };
      }));
    }

    async function providerGroupText(
      unrunnable: string[],
      selected?: string,
    ): Promise<string> {
      stubStatus(unrunnable);
      const { getByRole, findByText } = render(
        <AIModelsStep
          embedded
          providerIds={["clawai", "anthropic", "google"]}
          {...(selected ? { defaultProviderId: selected } : {})}
          testId="providers-test"
        />,
      );
      // The list opens collapsed onto the selected row; the whole point here is
      // what the EXPANDED list offers.
      const showMore = await findByText("Show more providers...").catch(() => null);
      if (showMore) fireEvent.click(showMore);
      return getByRole("radiogroup", { name: "AI Provider" }).textContent ?? "";
    }

    it("is still offered, because connecting is the way out", async () => {
      const text = await providerGroupText(["google"]);

      expect(text).toContain("Google Gemini");
      expect(text).toContain("Anthropic");
    });

    it("is offered when the panel is currently ON it, too", async () => {
      const text = await providerGroupText(["google"], "google");

      expect(text).toContain("Google Gemini");
    });

    it("is offered exactly as before when the box has said nothing about it", async () => {
      const text = await providerGroupText([]);

      expect(text).toContain("Google Gemini");
      expect(text).toContain("Anthropic");
    });
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
    // The plan opens as a summary; the pitch and the feature list sit behind
    // its "Change". Nothing here has connected an account, so the summary says
    // where the plan comes from rather than naming the seeded default — that
    // default is "flash", and printing it read as "you are on Pro, €9/month"
    // to Max and Free owners alike.
    expect(getByText("Plan is taken from your account")).toBeInTheDocument();
    expect(queryByText("Pro plan · €9/month")).not.toBeInTheDocument();
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

  it("does not pre-fill the custom-model field with the ClawBox AI image id", async () => {
    // The recovery path for a box an older build pinned to
    // `openai/gpt-image-1-mini`: /setup-api/ai-models/status reports that as
    // the model and `openai` as the provider, so Settings opens on the OpenAI
    // panel with it as `currentModel`. It is not in the curated catalog, so
    // the seeding effect used to treat it as a typed custom id — pre-filling
    // the field and then submitting it, which the configure route now refuses
    // 400 BEFORE writing the API key. The owner is handed back an id they
    // never typed and their key is not saved: a dead end on exactly the box
    // this guard exists for.
    const { container, getByRole, findByText } = render(
      <AIModelsStep
        embedded
        providerIds={["clawai", "openai", "anthropic", "google", "openrouter"]}
        defaultProviderId="clawai"
        currentProviderId="openai"
        currentModel="openai/gpt-image-1-mini"
        title="Connect AI Provider"
        description="Primary provider"
      />,
    );

    await waitFor(() => {
      expect(getByRole("radio", { name: /OpenAI GPT/i })).toBeChecked();
    });

    // Settle: the seeding effect runs after the provider radio commits, so an
    // assertion polled with waitFor would pass on its first tick — while the
    // field is still empty — and never see the value the effect writes.
    // Wait for the settled OUTCOME, not a timer: the seeding effect runs after
    // the provider radio commits, so polling a negative assertion would pass
    // on its first tick — while the field is still empty — and never see the
    // value the effect writes. The collapsed summary naming the curated
    // default is the positive end state, and it only appears once the effect
    // has decided this is not a custom id.
    await findByText("GPT-5.4");

    // The custom-model field is expanded only when the panel decided the
    // current id is a typed custom one, so its absence IS the fix.
    expect(container.querySelector("input#ai-provider-model")).toBeNull();
    expect(container.textContent ?? "").not.toContain("gpt-image-1-mini");
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

  // xAI (Grok), API Key tab: saved through the same configure call as Google
  // and OpenRouter, naming the catalogue's cold-start default. The key is an
  // obvious fake.
  it("offers xAI Grok as an API-key provider and saves it through configure", async () => {
    const fetchMock = vi.mocked(fetch);
    const { getByRole, getByText, queryByRole, container } = render(
      <AIModelsStep
        providerIds={["clawai", "openai", "anthropic", "google", "openrouter", "xai"]}
        defaultProviderId="clawai"
        title="Connect AI Provider"
        description="Primary provider"
      />,
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers");
    });

    fireEvent.click(getByRole("button", { name: /Show more providers/i }));
    expect(getByText("Grok models by xAI")).toBeInTheDocument();
    fireEvent.click(getByRole("radio", { name: /xAI Grok/i }));

    // Two tabs: the sign-in opens first, like OpenAI's and Anthropic's, and is
    // offered although the box lists no configured OAuth client — ClawBox's
    // own route serves it.
    expect(getByRole("button", { name: "ai.subscription" })).toBeInTheDocument();
    fireEvent.click(getByRole("button", { name: "ai.apiKey" }));

    expect(getByRole("button", { name: "Connect to xAI Grok" })).toBeInTheDocument();
    // Both modes share one credential slot, and the tab says so.
    expect(getByText("ai.xaiReplacesSignIn")).toBeInTheDocument();
    expect(queryByRole("button", { name: "ai.xaiSignInButton" })).toBeNull();

    const keyInput = container.querySelector("input[type=password], input[type=text]");
    expect(keyInput).not.toBeNull();
    expect((keyInput as HTMLInputElement).placeholder).toBe("xai-...");
    fireEvent.change(keyInput as HTMLInputElement, { target: { value: "xai-test-key-not-real" } });
    fireEvent.click(getByRole("button", { name: "Connect to xAI Grok" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => typeof input === "string" && input.includes("/setup-api/ai-models/configure")),
      ).toBe(true);
    });
    const configureCall = fetchMock.mock.calls.find(
      ([input]) => typeof input === "string" && input.includes("/setup-api/ai-models/configure"),
    );
    const sent = JSON.parse(String((configureCall?.[1] as RequestInit | undefined)?.body ?? "{}"));
    expect(sent).toMatchObject({
      provider: "xai",
      apiKey: "xai-test-key-not-real",
      authMode: "token",
      scope: "primary",
    });
    // The catalogue's cold-start default, bare: the configure route adds the
    // `xai/` prefix itself.
    expect(sent.model).toBe("grok-4.6");
  });

  // xAI (Grok), Subscription tab: the core's own CLI runs the sign-in and the
  // panel relays its link and code. When the CLI finishes, the ordinary
  // subscription save runs — with no credential in it, because there is none
  // for the browser to carry.
  describe("the xAI sign-in", () => {
    type Answer = Record<string, unknown>;

    function mockXaiLogin(answers: { start: Answer; polls?: Answer[] }) {
      const polls = [...(answers.polls ?? [])];
      const actions: string[] = [];
      vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("/setup-api/ai-models/oauth/providers")) {
          return { ok: true, json: async () => ({ providers: [] }) } as unknown as Response;
        }
        if (url.includes("/setup-api/ai-models/xai-login")) {
          const action = String(JSON.parse(String(init?.body ?? "{}")).action);
          actions.push(action);
          if (action === "start") return { ok: true, status: 200, json: async () => answers.start } as unknown as Response;
          if (action === "poll") {
            const next = polls.shift() ?? { status: "pending", verificationUrl: null, userCode: null };
            return { ok: true, status: 200, json: async () => next } as unknown as Response;
          }
          return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
        }
        if (url.includes("/setup-api/ai-models/configure")) {
          return { ok: true, json: async () => ({ success: true }) } as unknown as Response;
        }
        return { ok: true, json: async () => ({}) } as unknown as Response;
      });
      return actions;
    }

    async function openXaiSubscription() {
      const view = render(
        <AIModelsStep
          providerIds={["clawai", "openai", "anthropic", "google", "openrouter", "xai"]}
          defaultProviderId="clawai"
          title="Connect AI Provider"
          description="Primary provider"
        />,
      );
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers");
      });
      fireEvent.click(view.getByRole("button", { name: /Show more providers/i }));
      fireEvent.click(view.getByRole("radio", { name: /xAI Grok/i }));
      return view;
    }

    const configureBodies = () => vi.mocked(fetch).mock.calls
      .filter(([input]) => typeof input === "string" && input.includes("/setup-api/ai-models/configure"))
      .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")));

    it("shows the link and the code, then saves once the sign-in completes", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const actions = mockXaiLogin({
          start: { status: "pending", verificationUrl: "https://example.test/device", userCode: "ABCD-1234", expiresInMinutes: 30 },
          polls: [
            { status: "pending", verificationUrl: "https://example.test/device", userCode: "ABCD-1234", expiresInMinutes: 30 },
            { status: "complete" },
          ],
        });
        const { getByRole, getByText, findByTestId, queryByRole } = await openXaiSubscription();

        // The tab says what signing in does to a saved key, before the click.
        expect(getByText("ai.xaiReplacesKey")).toBeInTheDocument();
        // No generic Connect button under a tab that drives its own.
        expect(queryByRole("button", { name: "Connect to xAI Grok" })).toBeNull();
        fireEvent.click(getByRole("button", { name: "ai.xaiSignInButton" }));

        expect((await findByTestId("xai-user-code")).textContent).toBe("ABCD-1234");
        const link = getByRole("link", { name: "Open authorization page" });
        expect(link.getAttribute("href")).toBe("https://example.test/device");
        expect(link.getAttribute("target")).toBe("_blank");
        expect(getByText("Waiting for authorization...")).toBeInTheDocument();
        // The CLI's own lifetime, not the ChatGPT flow's fixed sentence.
        expect(getByText("ai.xaiCodeExpires")).toBeInTheDocument();
        expect(configureBodies()).toHaveLength(0);

        await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
        await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });

        await waitFor(() => expect(configureBodies()).toHaveLength(1));
        expect(configureBodies()[0]).toMatchObject({
          provider: "xai",
          authMode: "subscription",
          scope: "primary",
          model: "grok-4.6",
        });
        // No credential rides the browser.
        expect(configureBodies()[0].apiKey).toBeUndefined();
        expect(actions).toEqual(["start", "poll", "poll"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows a failure with the CLI's own output, and offers a fresh start", async () => {
      mockXaiLogin({
        start: {
          status: "failed",
          detail: "The sign-in did not show a verification link. This is what OpenClaw printed:",
          output: "? Choose an account",
        },
      });
      const { getByRole, findByRole, getByText } = await openXaiSubscription();
      fireEvent.click(getByRole("button", { name: "ai.xaiSignInButton" }));

      const alert = await findByRole("alert");
      expect(alert.textContent).toContain("did not show a verification link");
      expect(getByText("? Choose an account")).toBeInTheDocument();
      expect(getByRole("button", { name: "Get a new code" })).toBeInTheDocument();
      expect(configureBodies()).toHaveLength(0);
    });

    it("cancels the sign-in on request and goes back to the start button", async () => {
      const actions = mockXaiLogin({
        start: { status: "pending", verificationUrl: "https://example.test/device", userCode: "ABCD-1234" },
      });
      const { getByRole, findByTestId, findByRole } = await openXaiSubscription();
      fireEvent.click(getByRole("button", { name: "ai.xaiSignInButton" }));
      await findByTestId("xai-user-code");

      fireEvent.click(getByRole("button", { name: "cancel" }));

      expect(await findByRole("button", { name: "ai.xaiSignInButton" })).toBeInTheDocument();
      await waitFor(() => expect(actions).toContain("cancel"));
      expect(configureBodies()).toHaveLength(0);
    });

    it("cancels the sign-in when the page itself is left, with a request that outlives the page", async () => {
      const actions = mockXaiLogin({
        start: { status: "pending", verificationUrl: "https://example.test/device", userCode: "ABCD-1234" },
      });
      const { getByRole, findByTestId } = await openXaiSubscription();
      fireEvent.click(getByRole("button", { name: "ai.xaiSignInButton" }));
      await findByTestId("xai-user-code");

      // A reload, a link or a closed tab unmounts nothing; `pagehide` is all
      // the panel hears.
      window.dispatchEvent(new Event("pagehide"));

      await waitFor(() => expect(actions).toContain("cancel"));
      const cancel = vi.mocked(fetch).mock.calls
        .find(([, init]) => String((init as RequestInit | undefined)?.body ?? "").includes('"cancel"'));
      expect((cancel?.[1] as RequestInit).keepalive).toBe(true);
    });

    it("keeps the sign-in open, and says so, when the box did not confirm the cancel", async () => {
      const actions = mockXaiLogin({
        start: { status: "pending", verificationUrl: "https://example.test/device", userCode: "ABCD-1234", expiresInMinutes: 30 },
      });
      const fetchMock = vi.mocked(fetch);
      const base = fetchMock.getMockImplementation()!;
      let refuse = true;
      fetchMock.mockImplementation(async (input, init) => {
        const body = String((init as RequestInit | undefined)?.body ?? "");
        if (refuse && body.includes('"cancel"')) {
          actions.push("cancel");
          return { ok: false, status: 500, json: async () => ({ status: "failed", detail: "boom" }) } as unknown as Response;
        }
        return base(input, init);
      });
      const { getByRole, findByTestId, findByRole, queryByRole } = await openXaiSubscription();
      fireEvent.click(getByRole("button", { name: "ai.xaiSignInButton" }));
      await findByTestId("xai-user-code");

      fireEvent.click(getByRole("button", { name: "cancel" }));
      expect((await findByRole("alert")).textContent).toBe("ai.xaiCancelFailed");
      // Still waiting on the code, and the cancel can be tried again.
      expect(queryByRole("button", { name: "ai.xaiSignInButton" })).toBeNull();

      refuse = false;
      fireEvent.click(getByRole("button", { name: "cancel" }));
      expect(await findByRole("button", { name: "ai.xaiSignInButton" })).toBeInTheDocument();
      expect(actions.filter((a) => a === "cancel").length).toBe(2);
    });

    it("copies the code through the shared helper, which works without navigator.clipboard", async () => {
      // The box serves plain HTTP, where `navigator.clipboard` is undefined.
      const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      const exec = vi.fn(() => true);
      Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
      try {
        mockXaiLogin({
          start: { status: "pending", verificationUrl: "https://example.test/device", userCode: "ABCD-1234", expiresInMinutes: 30 },
        });
        const { getByRole, findByTestId, findByRole } = await openXaiSubscription();
        fireEvent.click(getByRole("button", { name: "ai.xaiSignInButton" }));
        await findByTestId("xai-user-code");

        fireEvent.click(getByRole("button", { name: "Copy" }));

        expect(await findByRole("button", { name: "Copied!" })).toBeInTheDocument();
        expect(exec).toHaveBeenCalledWith("copy");
      } finally {
        if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
        else delete (navigator as unknown as Record<string, unknown>).clipboard;
      }
    });

    it("still shows the link when the CLI printed no separate code", async () => {
      mockXaiLogin({
        start: { status: "pending", verificationUrl: "https://example.test/device?x=1", userCode: null },
      });
      const { getByRole, findByText, queryByTestId } = await openXaiSubscription();
      fireEvent.click(getByRole("button", { name: "ai.xaiSignInButton" }));

      expect(await findByText("ai.xaiSignInNoCode")).toBeInTheDocument();
      expect(queryByTestId("xai-user-code")).toBeNull();
      expect(getByRole("link", { name: "Open authorization page" }).getAttribute("href"))
        .toBe("https://example.test/device?x=1");
    });
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
    // A no-op rather than null: the executor assigns inside a closure, so
    // control-flow analysis otherwise narrows the variable to `null` at the
    // call below and `?.()` becomes a call on `never`.
    let resolveStart: () => void = () => {};
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

    resolveStart();

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
