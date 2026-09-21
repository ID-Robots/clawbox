import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import AIModelsStep from "@/components/AIModelsStep";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string) => {
      const strings: Record<string, string> = {
        "ai.configured": "Configured",
        "ai.model": "Model",
        "settings.connect": "Connect",
        "ai.modelChange": "Change model",
        "settings.providers.radioGroupLabel": "AI Provider",
      };
      return strings[key] ?? key;
    },
  }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

/**
 * Re-opening Settings must show the model the owner actually chose.
 *
 * The ChatGPT row's catalogue id is `codex` while OpenClaw 2 writes its models
 * as `openai/<id>`. The seeding effect compared the two verbatim, read "not
 * this catalogue's model", and fell through to the catalogue DEFAULT — so a
 * box configured for GPT-5.4 Mini showed GPT-5.5 selected, and the next save
 * on that screen wrote GPT-5.5 over the owner's pick.
 */
describe("the Settings model picker on a ChatGPT-subscription box", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/setup-api/ai-models/oauth/providers")) {
        return { ok: true, json: async () => ({ providers: ["openai"] }) };
      }
      // No catalog answer: the hook falls back to the curated cold-start
      // list, which is exactly what a box with no enumeration yet renders.
      return { ok: true, json: async () => ({}) };
    }));
  });

  it("seeds the picker from the configured openai/<id>, not the catalogue default", async () => {
    const { getByText, queryByText } = render(
      <AIModelsStep
        embedded
        providerIds={["openai"]}
        defaultProviderId="openai"
        currentProviderId="openai"
        currentModel="openai/gpt-5.4-mini"
        title="Connect AI Provider"
        description="Primary provider"
      />,
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers");
    });

    await waitFor(() => {
      expect(getByText("GPT-5.4 Mini")).toBeInTheDocument();
    });
    // gpt-5.5 is the catalogue default; showing it here is the silent
    // downgrade — the save that follows writes it.
    expect(queryByText("GPT-5.5")).toBeNull();
  });

  it("still flips to custom-model mode for an id outside the ChatGPT catalogue", async () => {
    const { getByDisplayValue } = render(
      <AIModelsStep
        embedded
        providerIds={["openai"]}
        defaultProviderId="openai"
        currentProviderId="openai"
        currentModel="openai/gpt-5.9-experimental"
        title="Connect AI Provider"
        description="Primary provider"
      />,
    );

    await waitFor(() => {
      expect(getByDisplayValue("gpt-5.9-experimental")).toBeInTheDocument();
    });
  });
});

/**
 * A configure that SUCCEEDS but could not record the OpenAI auth-order
 * preference answers 200 with a `warning`. Nothing read it, so the owner was
 * told the save worked and never that the part which decides WHICH OpenAI
 * credential chat uses did not.
 */
describe("a configure that succeeds with a warning", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/setup-api/ai-models/oauth/providers")) {
        return { ok: true, json: async () => ({ providers: [] }) };
      }
      if (url.includes("/setup-api/ai-models/configure")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            warning: "Saved, but OpenClaw did not record which OpenAI credential to prefer.",
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }));
  });

  it("shows the warning instead of a bare 'Configured'", async () => {
    const { container, getByRole, findByText, queryByText } = render(
      <AIModelsStep
        embedded
        providerIds={["openrouter"]}
        defaultProviderId="openrouter"
        title="Connect AI Provider"
        description="Primary provider"
      />,
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers");
    });

    const keyField = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(keyField, { target: { value: "sk-or-v1-test" } });
    fireEvent.click(getByRole("button", { name: /Connect/i }));

    expect(await findByText(/did not record which OpenAI credential/i, undefined, { timeout: 4000 }))
      .toBeInTheDocument();
    // Not both: "Configured" beside the thing that did not happen is how a
    // non-fatal failure stays invisible.
    expect(queryByText("Configured")).toBeNull();
  });
});
