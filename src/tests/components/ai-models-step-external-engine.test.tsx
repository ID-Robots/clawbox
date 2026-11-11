import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import AIModelsStep from "@/components/AIModelsStep";

/**
 * The first-boot wizard's AI step on a box whose external AI engine is already
 * connected (TASK-2376, found on a cluster: the step showed the engine as the
 * default but left ClawBox AI selected, and its only way forward without a
 * cloud sign-in was "Skip — I'll use only local AI", which installs and starts
 * llama.cpp). With an engine connected the step offers IT, selected; Continue
 * makes it the chat's model through /setup-api/local-ai/external/select and
 * installs or starts nothing. A box with no engine, and Settings, are as they
 * were.
 */

const llama = vi.hoisted(() => ({
  saveLlamaCppConfig: vi.fn(async () => {}),
  activateLocalOnly: vi.fn(async () => {}),
  checkLlamaCppStatus: vi.fn(),
}));
const edition = vi.hoisted(() => ({ value: "openclaw" as string | null }));

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const translations: Record<string, string> = {
        "localModels.external.subtitle": "{model} (external engine)",
        "localModels.external.wizard.connected": "External AI engine, connected",
        "localModels.external.wizard.continue": "Continue with {model}",
        "localModels.external.wizard.useOther": "Connect a different AI provider instead",
        "localModels.external.wizard.backToEngine": "Use {model} (external engine) instead",
        "localModels.external.wizard.failed": "{model} could not be made the chat's model.",
        "ai.skipUseLocalOnly": "Skip — I'll use only local AI",
        "settings.providers.radioGroupLabel": "AI Provider",
      };
      let text = translations[key] ?? key;
      for (const [k, v] of Object.entries(params ?? {})) text = text.replace(`{${k}}`, v);
      return text;
    },
  }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/client-harness", () => ({
  cachedEdition: () => edition.value,
  fetchHarness: async () => ({ active: edition.value, edition: edition.value }),
}));

vi.mock("@/components/HermesProviderConfig", () => ({
  default: ({ testId }: { testId?: string }) => <div data-testid={`${testId}-hermes-panel`}>Hermes providers</div>,
}));

vi.mock("@/hooks/useOllamaModels", () => ({
  useOllamaModels: () => ({
    ollamaRunning: false, ollamaModels: [], ollamaSearch: "", ollamaSearchResults: [], ollamaSearching: false,
    ollamaPulling: false, ollamaPullProgress: null, ollamaSaving: false,
    checkOllamaStatus: vi.fn(), handleOllamaSearchChange: vi.fn(), pullOllamaModel: vi.fn(), saveOllamaConfig: vi.fn(),
    deleteOllamaModel: vi.fn(), formatOllamaBytes: vi.fn((b: number) => `${b}`), clearSearch: vi.fn(),
  }),
}));

vi.mock("@/hooks/useLlamaCppModels", () => ({
  useLlamaCppModels: () => ({
    llamaCppRunning: false, llamaCppInstalled: true, llamaCppModels: [], llamaCppEndpoint: "http://127.0.0.1:8080/v1",
    llamaCppSaving: false, llamaCppProgress: null,
    checkLlamaCppStatus: llama.checkLlamaCppStatus,
    saveLlamaCppConfig: llama.saveLlamaCppConfig,
    activateLocalOnly: llama.activateLocalOnly,
  }),
}));

type Call = { url: string; method: string };
let calls: Call[] = [];

const ENGINE = { configured: true, displayName: "echo-1", modelRef: "clawext/nano-ci/echo-1", activeHarness: "openclaw" };

function stub({ engine = ENGINE as unknown, engineStatus = 200, selectStatus = 200 } = {}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    calls.push({ url, method: init?.method ?? "GET" });
    const j = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url === "/setup-api/local-ai/external/select") return j({ success: true, modelRef: ENGINE.modelRef }, selectStatus);
    if (url === "/setup-api/local-ai/external") return j(engine, engineStatus);
    if (url.includes("/setup-api/providers/status")) {
      return j({ harness: "openclaw", defaultProvider: "clawext", unrunnable: [], degraded: false, providers: [
        { id: "clawai", label: "ClawBox AI", state: "disconnected", isDefault: false, section: "ai", enabled: true },
        { id: "clawext", label: "echo-1 (external engine)", state: "connected", isDefault: true, section: "localAi", enabled: true },
      ] });
    }
    if (url.includes("/setup-api/ai-models/oauth/providers")) return j({ providers: [] });
    return j({});
  }));
}

function wizard(onNext = vi.fn()) {
  const view = render(
    <AIModelsStep
      providerIds={["clawai", "openai", "anthropic", "google", "openrouter", "xai", "llamacpp"]}
      defaultProviderId="clawai"
      title="Connect AI Provider"
      description="Pick one"
      onNext={onNext}
    />,
  );
  return { ...view, onNext };
}

const neverInstalled = () => {
  expect(llama.saveLlamaCppConfig).not.toHaveBeenCalled();
  expect(llama.activateLocalOnly).not.toHaveBeenCalled();
  expect(calls.some((c) => /llamacpp|ollama|ai-models\/configure/.test(c.url) && c.method === "POST")).toBe(false);
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  edition.value = "openclaw";
});

describe("the wizard's AI step with an external engine connected", () => {
  it("keeps the engine selected and continues without installing or starting anything", async () => {
    stub();
    const { findByTestId, getByRole, onNext } = wizard();
    const choice = await findByTestId("setup-external-engine-choice");
    expect(choice.getAttribute("aria-checked")).toBe("true");
    expect(choice.textContent).toContain("echo-1 (external engine)");
    // No other provider is offered as selected, Gemma least of all.
    expect(getByRole("radiogroup", { name: "AI Provider" }).querySelectorAll('[role="radio"]')).toHaveLength(1);

    fireEvent.click(await findByTestId("setup-external-engine-continue"));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/setup-api/local-ai/external/select"]);
    neverInstalled();
  });

  it("stays on the step and says so when the engine cannot be selected", async () => {
    stub({ selectStatus: 502 });
    const { findByTestId, findByRole, onNext } = wizard();
    fireEvent.click(await findByTestId("setup-external-engine-continue"));
    expect((await findByRole("alert")).textContent).toContain("echo-1 could not be made the chat's model");
    expect(onNext).not.toHaveBeenCalled();
    neverInstalled();
  });

  it("offers the other providers on request, without the llama.cpp skip, and a way back", async () => {
    stub();
    const { findByTestId, queryByText, queryByTestId, onNext } = wizard();
    fireEvent.click(await findByTestId("setup-external-engine-use-other"));
    await findByTestId("setup-external-engine-back");
    expect(queryByText("Skip — I'll use only local AI")).toBeNull();
    expect(queryByTestId("setup-external-engine-choice")).toBeNull();
    fireEvent.click(await findByTestId("setup-external-engine-back"));
    expect((await findByTestId("setup-external-engine-choice")).getAttribute("aria-checked")).toBe("true");
    expect(onNext).not.toHaveBeenCalled();
    neverInstalled();
  });

  it("does the same on the Hermes edition, ahead of Hermes' own panel", async () => {
    edition.value = "hermes";
    stub();
    const { findByTestId, queryByTestId, onNext } = wizard();
    expect((await findByTestId("setup-external-engine-choice")).getAttribute("aria-checked")).toBe("true");
    expect(queryByTestId("setup-step-ai-models-hermes-panel")).toBeNull();
    fireEvent.click(await findByTestId("setup-external-engine-continue"));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    neverInstalled();
  });

  it("on Hermes, a different provider means Hermes' own panel, with the way back", async () => {
    edition.value = "hermes";
    stub();
    const { findByTestId, queryByTestId } = wizard();
    fireEvent.click(await findByTestId("setup-external-engine-use-other"));
    expect(await findByTestId("setup-step-ai-models-hermes-panel")).toBeTruthy();
    fireEvent.click(await findByTestId("setup-external-engine-back"));
    expect((await findByTestId("setup-external-engine-choice")).getAttribute("aria-checked")).toBe("true");
    expect(queryByTestId("setup-step-ai-models-hermes-panel")).toBeNull();
  });
});

describe("the wizard's AI step with no external engine (unchanged)", () => {
  it.each([
    ["the route says none", { engine: { configured: false } }],
    ["the route fails", { engineStatus: 500 }],
  ])("opens on the provider list with the llama.cpp skip, as before, when %s", async (_label, opts) => {
    stub(opts as Parameters<typeof stub>[0]);
    const { findByText, queryByTestId } = wizard();
    expect(await findByText("Skip — I'll use only local AI")).toBeTruthy();
    expect(queryByTestId("setup-external-engine-choice")).toBeNull();
    expect(queryByTestId("setup-external-engine-back")).toBeNull();
  });

  it("Settings (embedded) never asks for the engine and never shows the wizard choice", async () => {
    stub();
    const { findByRole, queryByTestId } = render(
      <AIModelsStep embedded providerIds={["clawai", "openai"]} testId="settings-ai" />,
    );
    await findByRole("radiogroup", { name: "AI Provider" });
    expect(queryByTestId("setup-external-engine-choice")).toBeNull();
    expect(calls.some((c) => c.url === "/setup-api/local-ai/external")).toBe(false);
  });
});
