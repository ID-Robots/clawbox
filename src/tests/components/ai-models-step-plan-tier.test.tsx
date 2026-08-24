import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import AIModelsStep from "@/components/AIModelsStep";
import { CLAWAI_TIER_STORAGE_KEY } from "@/lib/clawbox-ai-tiers";

// TASK-468. The plan summary in the AI Provider panel used to be seeded purely
// from local storage, so on a browser that had never stored a tier — every
// customer's first visit — it fell back to the hardcoded "flash" and rendered
// "Pro plan · €9/month" no matter what the account actually was. On a Max box
// that sat directly under the panel's own MAX badge, and the same state is what
// `payload.clawaiTier` writes on save, so it was a silent downgrade waiting to
// happen, not a cosmetic slip.
//
// These tests drive the REAL component against the REAL status route shape, so
// they fail if the reconcile is removed or if the status contract moves.

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => (key === "ai.showMore" ? "Show more providers..." : key) }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useOllamaModels", () => ({
  useOllamaModels: () => ({
    ollamaRunning: false, ollamaModels: [], ollamaSearch: "", ollamaSearchResults: [],
    ollamaSearching: false, ollamaPulling: false, ollamaPullProgress: null, ollamaSaving: false,
    checkOllamaStatus: vi.fn(), handleOllamaSearchChange: vi.fn(), pullOllamaModel: vi.fn(),
    saveOllamaConfig: vi.fn(), deleteOllamaModel: vi.fn(),
    formatOllamaBytes: vi.fn((b: number) => `${b}`), clearSearch: vi.fn(),
  }),
}));

vi.mock("@/hooks/useLlamaCppModels", () => ({
  useLlamaCppModels: () => ({
    llamaCppRunning: false, llamaCppInstalled: false, llamaCppModels: [],
    llamaCppEndpoint: "http://127.0.0.1:8080/v1", llamaCppSaving: false,
    llamaCppProgress: null, checkLlamaCppStatus: vi.fn(), saveLlamaCppConfig: vi.fn(),
  }),
}));

/** The fields of /setup-api/ai-models/status this panel is allowed to read. */
type StatusStub = {
  clawaiConfigured?: boolean;
  tierSource?: "portal" | "picker";
  clawaiAccountTier?: "flash" | "pro" | null;
};

function mockStatus(status: StatusStub | null) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    if (url.includes("/setup-api/ai-models/oauth/providers")) {
      return { ok: true, json: async () => ({ providers: [] }) };
    }
    if (url.includes("/setup-api/ai-models/status")) {
      if (status === null) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => status };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

function renderPanel() {
  return render(
    <AIModelsStep
      embedded
      providerIds={["clawai", "openai"]}
      defaultProviderId="clawai"
      title="Connect AI Provider"
      description="Primary provider"
    />,
  );
}

describe("AIModelsStep — the plan card follows the account, not local storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("shows Max for a portal-confirmed Max account on a browser that stored nothing", async () => {
    // The exact reproduction: a Max box, a first visit, no stored tier.
    mockStatus({ clawaiConfigured: true, tierSource: "portal", clawaiAccountTier: "pro" });
    const { findByText, queryByText } = renderPanel();

    expect(await findByText("Max plan · €49/month")).toBeInTheDocument();
    // The bug was not "Max is missing", it was "Pro is claimed". Assert the
    // wrong answer is gone, or a panel that rendered both would still pass.
    expect(queryByText("Pro plan · €9/month")).not.toBeInTheDocument();
  });

  it("shows Pro for a portal-confirmed Pro account", async () => {
    mockStatus({ clawaiConfigured: true, tierSource: "portal", clawaiAccountTier: "flash" });
    const { findByText, queryByText } = renderPanel();

    expect(await findByText("Pro plan · €9/month")).toBeInTheDocument();
    expect(queryByText("Max plan · €49/month")).not.toBeInTheDocument();
  });

  it("shows Free when the portal reconciled the account down to Free", async () => {
    // mapPortalTier returns null for anything that is not a paid plan, so a
    // paired Free box answers configured + portal + null. Showing "Pro plan
    // €9/month" to someone who is not paying is the other half of this bug.
    mockStatus({ clawaiConfigured: true, tierSource: "portal", clawaiAccountTier: null });
    const { findByText, queryByText } = renderPanel();

    expect(await findByText("Free plan · free forever")).toBeInTheDocument();
    expect(queryByText("Pro plan · €9/month")).not.toBeInTheDocument();
  });

  it("leaves the card alone when the portal did not answer this cycle", async () => {
    // tierSource "picker" means the status route never reached the portal. The
    // stored device tier cannot tell Free from "we never asked", so moving the
    // card off a guess here is how a Free user got shown a paid plan.
    window.localStorage.setItem(CLAWAI_TIER_STORAGE_KEY, "pro");
    mockStatus({ clawaiConfigured: true, tierSource: "picker", clawaiAccountTier: "flash" });
    const { findByText, queryByText } = renderPanel();

    expect(await findByText("Max plan · €49/month")).toBeInTheDocument();
    expect(queryByText("Pro plan · €9/month")).not.toBeInTheDocument();
  });

  it("keeps the stored choice when no ClawBox AI account is paired at all", async () => {
    // The wizard's connect flow: this picker is someone CHOOSING a plan they do
    // not have yet, and there is no account to reconcile against.
    window.localStorage.setItem(CLAWAI_TIER_STORAGE_KEY, "pro");
    mockStatus({ clawaiConfigured: false, tierSource: "picker", clawaiAccountTier: null });
    const { findByText } = renderPanel();

    expect(await findByText("Max plan · €49/month")).toBeInTheDocument();
  });

  it("survives a status route that fails outright", async () => {
    mockStatus(null);
    const { findByText } = renderPanel();
    // No answer, so the stored default stands and nothing blows up.
    expect(await findByText("Pro plan · €9/month")).toBeInTheDocument();
  });

  it("moves the allowance while the panel stays mounted, without a reload", async () => {
    // TASK-516. The desktop never unmounts the Settings window, so a
    // mount-only read froze this line at whatever the page load saw: an owner
    // who had just been refused at 20 of 20 opened Settings and was told
    // "1 of 20 images today" by the very surface built to explain the
    // refusal. The acceptance is the card's own: with the session left open,
    // spend an image and watch the number move.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const status: StatusStub = {
        clawaiConfigured: true,
        tierSource: "portal",
        clawaiAccountTier: "pro",
        clawaiImages: {
          supported: true, model: "gpt-image-1-mini",
          plan: "max", planLabel: "Max", dailyLimit: 20, used: 1,
        },
      };
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("/setup-api/ai-models/oauth/providers")) {
          return { ok: true, json: async () => ({ providers: [] }) };
        }
        if (url.includes("/setup-api/ai-models/status")) {
          return { ok: true, json: async () => ({ ...status, clawaiImages: { ...status.clawaiImages } }) };
        }
        return { ok: true, json: async () => ({}) };
      }));

      const { findByTestId } = renderPanel();
      const line = await findByTestId("clawai-image-allowance");
      await waitFor(() => expect(line.textContent).toContain("ai.imagesUsedToday"));

      // The day moves on the backend — the chat spent the allowance.
      (status.clawaiImages as Record<string, unknown>).used = 20;
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });

      // The line follows without any remount or reload, and flips to the
      // exhausted state (the reset-tomorrow suffix only renders at the wall).
      await waitFor(() =>
        expect((line.textContent ?? "")).toContain("ai.imagesResetTomorrow"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("never overrides a plan the user picked in this session", async () => {
    // A late status answer must not yank the card out from under a click that
    // already happened — the wizard is where someone upgrades.
    let releaseStatus: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    // Resolves once the panel has actually READ the late answer. Asserting on
    // "fetch was called" alone would pass before the response ever came back,
    // which would make this test green for the wrong reason.
    let statusConsumed: (() => void) | null = null;
    const statusRead = new Promise<void>((resolve) => { statusConsumed = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("/setup-api/ai-models/oauth/providers")) {
        return { ok: true, json: async () => ({ providers: [] }) };
      }
      if (url.includes("/setup-api/ai-models/status")) {
        await gate;
        return {
          ok: true,
          json: async () => {
            statusConsumed?.();
            return { clawaiConfigured: true, tierSource: "portal", clawaiAccountTier: "flash" };
          },
        };
      }
      return { ok: true, json: async () => ({}) };
    }));

    const { getByRole, findByText, queryByText } = renderPanel();
    // Open the picker and choose Max before the box has answered.
    fireEvent.click(await findByText("Pro plan · €9/month"));
    fireEvent.click(getByRole("radio", { name: /Max tier/i }));
    await waitFor(() => expect(window.localStorage.getItem(CLAWAI_TIER_STORAGE_KEY)).toBe("pro"));

    expect(fetch).toHaveBeenCalledWith(
      "/setup-api/ai-models/status",
      expect.objectContaining({ cache: "no-store" }),
    );

    releaseStatus?.();
    // Wait until the panel has read the late answer, then let React drain, so
    // this asserts the reconcile DECLINED to move the card rather than that it
    // simply had not run yet.
    await statusRead;
    await act(async () => { await Promise.resolve(); });

    // The account says flash; the user just said Max. The user wins.
    expect(window.localStorage.getItem(CLAWAI_TIER_STORAGE_KEY)).toBe("pro");
    expect(queryByText("Pro plan · €9/month")).not.toBeInTheDocument();
  });
});
