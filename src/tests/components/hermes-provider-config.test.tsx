import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import HermesProviderConfig from "@/components/HermesProviderConfig";

// The Hermes edition's AI-provider step. AIModelsStep hands the whole step to
// this panel on a Hermes box, so the wizard's auto-advance has to live here too
// — otherwise a customer who successfully configures a provider is left sitting
// on a step that has already finished.

// This panel's copy lives in the edition catalogue (`edition-translations/en-provider.ts`, TASK-458), so resolve keys
// against the real English table instead of echoing them back: the assertions
// below stay on the sentence a customer actually reads.
vi.mock("@/lib/i18n", async () => {
  const { providerEn } = await import("@/lib/edition-translations/en-provider");
  const { translations } = await import("@/lib/translations");
  return {
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useT: () => ({
      t: (key: string, params?: Record<string, string | number>) =>
        Object.entries(params ?? {}).reduce(
          (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
          providerEn[key] ?? translations.en[key] ?? key,
        ),
      locale: "en",
      setLocale: vi.fn(),
    }),
  };
});

vi.mock("next/image", () => ({
  default: ({ alt = "" }: { alt?: string }) => <img alt={alt} />,
}));

const refreshModels = vi.fn();

vi.mock("@/hooks/useHermesModelOptions", () => ({
  useHermesModelOptions: () => ({
    scope: {
      provider: "openrouter",
      authenticated: true,
      models: [{ id: "vendor/model-a", description: "" }],
      defaultModel: "vendor/model-a",
      current: "vendor/model-a",
      savedElsewhere: null,
      source: "dashboard",
      stale: false,
      fetchedAt: Date.now(),
    },
    loading: false,
    refresh: refreshModels,
  }),
  // The factory replaces the whole module, so every export the panel imports
  // has to be listed here — a missing one is `undefined` at the call site and
  // throws inside the save path, which reads as "the wizard never advanced".
  notifyHermesModelState: vi.fn(),
}));

/** The panel's backing routes, with a configurable outcome for the save POST. */
function stubFetch({ saveOk = true }: { saveOk?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/setup-api/hermes/clawai") {
      return {
        ok: true,
        json: async () => ({ hasToken: false, tier: "flash", tierStored: null, active: false, model: "" }),
      } as Response;
    }
    if (url === "/setup-api/hermes/oauth") {
      return { ok: true, json: async () => ({ providers: [] }) } as Response;
    }
    if (url === "/setup-api/hermes/models" && method === "POST") {
      return saveOk
        ? { ok: true, json: async () => ({ ok: true, model: "vendor/model-a", provider: "openrouter" }) } as Response
        : { ok: false, status: 502, json: async () => ({ error: "hermes config failed" }) } as Response;
    }
    if (url === "/setup-api/hermes/models") {
      // A box whose OpenRouter key is in place: the wizard opens on that row
      // only because the harness holds a credential for it.
      return {
        ok: true,
        json: async () => ({
          provider: "openrouter",
          current: "vendor/model-a",
          providers: [{ id: "openrouter", authenticated: true, credentialPresent: true }],
        }),
      } as Response;
    }

    return { ok: true, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function saveButton() {
  return await screen.findByRole("button", { name: /Save model & provider/i });
}

describe("HermesProviderConfig auto-advance", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    refreshModels.mockClear();
  });

  it("advances the wizard once a save has actually succeeded", async () => {
    stubFetch();
    const onNext = vi.fn();

    render(<HermesProviderConfig onNext={onNext} testId="hermes-ai" />);

    fireEvent.click(await saveButton());

    // The save runs behind the progress overlay; the wizard advances after
    // the overlay's minimum dwell and DONE beat, not the instant the POST lands.
    expect(await screen.findByText("Setting up OpenRouter")).toBeInTheDocument();
    await waitFor(() => {
      expect(onNext).toHaveBeenCalledTimes(1);
    }, { timeout: 6_000 });
  }, 10_000);

  it("advances exactly once even when the step is saved repeatedly", async () => {
    stubFetch();
    const onNext = vi.fn();

    render(<HermesProviderConfig onNext={onNext} testId="hermes-ai" />);

    const button = await saveButton();
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => {
      expect(onNext).toHaveBeenCalledTimes(1);
    }, { timeout: 6_000 });

    // Give a second timer every chance to fire before declaring it doesn't.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(onNext).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("stays on the step when the save fails", async () => {
    stubFetch({ saveOk: false });
    const onNext = vi.fn();

    render(<HermesProviderConfig onNext={onNext} testId="hermes-ai" />);

    fireEvent.click(await saveButton());

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(onNext).not.toHaveBeenCalled();
  }, 10_000);

  it("never advances when embedded in Settings, which has no next step", async () => {
    stubFetch();
    const onNext = vi.fn();

    render(<HermesProviderConfig embedded onNext={onNext} testId="hermes-ai" />);

    fireEvent.click(await saveButton());

    await waitFor(() => {
      expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(onNext).not.toHaveBeenCalled();
  }, 10_000);
});

describe("HermesProviderConfig ClawBox AI plan on an unpaired box", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("pre-selects Free and sends it on Connect", async () => {
    // First boot: no ClawBox AI account and nothing stored in this browser.
    // The harness holds no credential either, so the wizard opens on ClawBox AI.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/setup-api/hermes/clawai") {
        return {
          ok: true,
          json: async () => ({ hasToken: false, tier: "flash", tierStored: null, active: false, model: "" }),
        } as Response;
      }
      if (url === "/setup-api/hermes/oauth") {
        return { ok: true, json: async () => ({ providers: [] }) } as Response;
      }
      if (url === "/setup-api/hermes/models") {
        return { ok: true, json: async () => ({ provider: "openrouter", current: "", providers: [] }) } as Response;
      }
      if (url === "/setup-api/ai-models/clawai/start") {
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
    vi.stubGlobal("fetch", fetchMock);

    render(<HermesProviderConfig onNext={vi.fn()} testId="hermes-ai" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/setup-api/hermes/clawai", expect.objectContaining({ cache: "no-store" }));
      expect(fetchMock).toHaveBeenCalledWith("/setup-api/hermes/models", expect.objectContaining({ cache: "no-store" }));
    });
    // Let the mount read's answer (hasToken false) re-resolve the plan first, so
    // this reads what that answer leaves selected, not just the initial state.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    fireEvent.click(screen.getByRole("button", { name: /^Plan/ }));
    const freeChecked = screen.getByRole("radio", { name: /^Free tier/ }).getAttribute("aria-checked");
    fireEvent.click(screen.getByRole("button", { name: /Get device code/i }));

    let startCall: Parameters<typeof fetch> | undefined;
    await waitFor(() => {
      startCall = fetchMock.mock.calls.find(([input]) => input === "/setup-api/ai-models/clawai/start") as
        | Parameters<typeof fetch>
        | undefined;
      expect(startCall).toBeDefined();
    });
    expect(JSON.parse(String(startCall![1]!.body)).tier).toBe("free");
    expect(freeChecked).toBe("true");
  });
});
