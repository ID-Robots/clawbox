import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import AIModelsStep from "@/components/AIModelsStep";

/**
 * "Skip — I'll use only local AI" is a CHOICE of provider, not a decline, and
 * it used to only advance the wizard. The box that left behind had
 * `agents.defaults.model.primary` on `llamacpp/gemma4-e2b-it-q4_0` with
 * `models.providers` EMPTY, so every chat turn failed with "Unknown model:
 * llamacpp/gemma4-e2b-it-q4_0" — with the GGUF sitting on disk the whole time.
 *
 * These pin the two halves of the fix: the button configures local AI BEFORE it
 * advances, and a failed configure does NOT advance. The request that configure
 * sends is pinned separately, on the hook, in
 * src/tests/unit/use-llamacpp-activate-local-only.test.ts.
 */

const hookState = vi.hoisted(() => ({
  callbacks: null as null | {
    onSaveSuccess: (model: string) => void;
    onSaveError: (message: string) => void;
    onClearStatus?: () => void;
  },
  scope: null as string | null,
  activateLocalOnly: vi.fn(async () => {}),
  saveLlamaCppConfig: vi.fn(async () => {}),
}));

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        "ai.title": "Connect AI Model",
        "ai.description": "Select your AI provider.",
        "ai.skipUseLocalOnly": "Skip — I'll use only local AI",
        skip: "Skip",
        "ai.runLocally": "Run AI models locally on device",
        "ai.fullyLocal": "Fully local",
        "ai.showMore": "Show more providers...",
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
    ollamaRunning: false,
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
  useLlamaCppModels: (
    callbacks: {
      onSaveSuccess: (model: string) => void;
      onSaveError: (message: string) => void;
      onClearStatus?: () => void;
    },
    configureScope: string,
  ) => {
    // Captured so a test can drive the terminal callback the real hook would
    // fire, which is what decides whether the wizard moves.
    hookState.callbacks = callbacks;
    hookState.scope = configureScope;
    return {
      llamaCppRunning: false,
      llamaCppInstalled: true,
      llamaCppModels: [],
      llamaCppEndpoint: "http://127.0.0.1:8080/v1",
      llamaCppSaving: false as const,
      llamaCppProgress: null,
      checkLlamaCppStatus: vi.fn(),
      saveLlamaCppConfig: hookState.saveLlamaCppConfig,
      activateLocalOnly: hookState.activateLocalOnly,
    };
  },
}));

function renderStep(props: Record<string, unknown> = {}) {
  return render(
    <AIModelsStep
      providerIds={["clawai", "anthropic", "llamacpp"]}
      defaultProviderId="clawai"
      title="Connect AI Provider"
      description="Pick a provider"
      testId="wizard-ai"
      {...props}
    />,
  );
}

describe("the wizard's \"use only local AI\" button", () => {
  beforeEach(() => {
    hookState.callbacks = null;
    hookState.scope = null;
    hookState.activateLocalOnly.mockClear();
    hookState.saveLlamaCppConfig.mockClear();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("/setup-api/ai-models/oauth/providers")) {
        return { ok: true, json: async () => ({ providers: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
  });

  it("configures local AI, and does not advance until that succeeds", async () => {
    const onNext = vi.fn();
    const { findByRole } = renderStep({ onNext });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers"));

    await act(async () => {
      fireEvent.click(await findByRole("button", { name: /use only local AI/i }));
    });

    // The whole bug: this used to be zero calls and an advanced wizard.
    expect(hookState.activateLocalOnly).toHaveBeenCalledTimes(1);
    // Nothing has reported success yet, so the wizard has NOT moved.
    expect(onNext).not.toHaveBeenCalled();

    await act(async () => {
      hookState.callbacks?.onSaveSuccess("gemma4-e2b-it-q4_0");
    });

    // The success overlay holds for 900 ms before handing over to the wizard.
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), { timeout: 4000 });
  });

  it("does not advance when the activation fails, and says why", async () => {
    const onNext = vi.fn();
    const { findByRole, findByText } = renderStep({ onNext });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers"));

    await act(async () => {
      fireEvent.click(await findByRole("button", { name: /use only local AI/i }));
    });
    await act(async () => {
      hookState.callbacks?.onSaveError("Failed to provision the local Gemma 4 runtime");
    });

    expect(await findByText(/Failed to provision the local Gemma 4 runtime/i)).toBeInTheDocument();
    // Advancing here would hand the owner a finished wizard and a box that
    // cannot answer — the failure this fix exists to stop being silent.
    expect(onNext).not.toHaveBeenCalled();
  });

  it("stays a plain skip on a step that was never offered the local provider", async () => {
    const onNext = vi.fn();
    const { findByRole } = renderStep({
      onNext,
      providerIds: ["clawai", "anthropic"],
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers"));

    await act(async () => {
      fireEvent.click(await findByRole("button", { name: /use only local AI/i }));
    });

    // This step is not configuring llamacpp, so the button cannot honour the
    // promise its label makes — it must not install a provider this screen
    // does not offer, and it must still let the customer past.
    expect(hookState.activateLocalOnly).not.toHaveBeenCalled();
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("stays a plain skip in the embedded Local AI scope", async () => {
    const onNext = vi.fn();
    const { findByRole } = renderStep({
      onNext,
      configureScope: "local",
      providerIds: ["llamacpp"],
      defaultProviderId: "llamacpp",
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers"));

    await act(async () => {
      fireEvent.click(await findByRole("button", { name: /^Skip$/i }));
    });

    // Here the label is a plain "Skip" and claims nothing about configuring, so
    // it must keep advancing immediately and touch no config.
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(hookState.activateLocalOnly).not.toHaveBeenCalled();
  });
});
