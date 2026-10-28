import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import en from "@/lib/translations-generated/en";
import AIModelsStep from "@/components/AIModelsStep";

/**
 * A ClawBox AI sign-in the box refused, as the panel shows it.
 *
 * Found on a box: the device login's save was refused (another sign-in held
 * the ClawBox AI credential slot) and the panel sat on "Connecting…" for good.
 * Two things are pinned here. The refusal reaches the owner — in their
 * language, naming the slot, with the removal right under it. And the save
 * moving the box's provider to ClawBox AI before the poll has its answer no
 * longer stops that poll and strands the configuring overlay.
 */

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    // The real English catalogue, placeholders and all.
    t: (key: string, params?: Record<string, string | number>) => {
      let text = en[key] ?? key;
      for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value));
      return text;
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

const REFUSAL = {
  status: "error",
  error: "This box already has your own DeepSeek API key saved in the credential slot ClawBox AI signs in to (deepseek:default).",
  code: "clawai_slot_owner_key",
  profileId: "deepseek:default",
};

interface Box {
  /** What `/clawai/poll` answers on its n-th call (1-based). */
  poll: (n: number) => Record<string, unknown>;
  /** What the slot holds until it is removed. */
  slot?: "free" | "owner-key" | "stale";
}

/** A box behind `fetch`: the device flow, the poll, and the ClawBox AI slot. */
function stubBox(box: Box) {
  let polls = 0;
  let slot = box.slot ?? "free";
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
    if (url.includes("/setup-api/ai-models/oauth/providers")) return json({ providers: [] });
    if (url === "/setup-api/ai-models/clawai/start") {
      return json({ user_code: "ABCD-1234", verification_url: "https://clawbox.com/portal/connect", interval: 0.05 });
    }
    if (url === "/setup-api/ai-models/clawai/poll") {
      polls += 1;
      return json(box.poll(polls));
    }
    if (url === "/setup-api/ai-models/clawai/slot") {
      if (init?.method === "POST") {
        slot = "free";
        return json({ removed: true, state: "free", profileId: "deepseek:default" });
      }
      return json({ state: slot, profileId: "deepseek:default" });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The configuring overlay (ConfiguringOverlay's root), not the status line. */
const overlayOf = (container: HTMLElement) => container.querySelector('div[role="status"]');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a refused ClawBox AI sign-in", () => {
  it("says the refusal in the owner's language, names the slot, and offers the removal under it", async () => {
    const fetchMock = stubBox({ poll: (n) => (n === 1 ? { status: "configuring" } : REFUSAL), slot: "owner-key" });
    const { container, findByRole, findByTestId, findByText } = render(
      <AIModelsStep providerIds={["clawai", "openai"]} defaultProviderId="clawai" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers"));

    fireEvent.click(await findByRole("button", { name: en["ai.clawaiGetCode"] }, { timeout: 4000 }));

    const said = en["ai.clawaiSlot.ownerKeyError"].replace("{profileId}", "deepseek:default");
    expect(await findByText(said, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(overlayOf(container)).toBeNull();
    // The wizard is not Settings: the notice links there as well.
    expect(await findByTestId("clawai-slot-notice")).toBeInTheDocument();
    expect(await findByTestId("clawai-slot-open-providers")).toHaveAttribute("href", "/app/settings?section=ai");

    fireEvent.click(await findByTestId("clawai-slot-remove"));

    expect(await findByText(en["ai.clawaiSlot.removed"])).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/ai-models/clawai/slot", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "remove" }),
    }));
    // The refusal it answered is gone with it.
    expect(container.textContent).not.toContain(said);
  }, 20_000);

  it("is still reported when the save moves the box's provider to ClawBox AI before the poll answers", async () => {
    // No code on purpose: what is pinned is that the answer arrives at all.
    const sentence = "Failed to configure AI model. Please check your credentials and try again.";
    let refuse = false;
    const fetchMock = stubBox({ poll: () => (refuse ? { status: "error", error: sentence } : { status: "configuring" }) });
    const props = { embedded: true, providerIds: ["clawai", "openai"], defaultProviderId: "clawai" };
    const { container, findByRole, findByText, rerender } = render(
      <AIModelsStep {...props} currentProviderId={null} />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/setup-api/ai-models/oauth/providers"));
    fireEvent.click(await findByRole("button", { name: en["ai.clawaiGetCode"] }, { timeout: 4000 }));
    await waitFor(() => expect(overlayOf(container)).not.toBeNull(), { timeout: 4000 });

    // Settings re-reads the provider on a providers-changed signal: the
    // configure has already recorded ClawBox AI, the sign-in is not over.
    rerender(<AIModelsStep {...props} currentProviderId="clawai" />);
    refuse = true;

    expect(await findByText(sentence, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(overlayOf(container)).toBeNull();
  }, 20_000);

  it("shows a refusal without a code as the route's own sentence, with no notice", async () => {
    const sentence = "Failed to configure AI model. Please check your credentials and try again.";
    stubBox({ poll: (n) => (n === 1 ? { status: "configuring" } : { status: "error", error: sentence }) });
    const { findByRole, findByText, queryByTestId } = render(
      <AIModelsStep providerIds={["clawai", "openai"]} defaultProviderId="clawai" />,
    );

    fireEvent.click(await findByRole("button", { name: en["ai.clawaiGetCode"] }, { timeout: 4000 }));

    expect(await findByText(sentence, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(queryByTestId("clawai-slot-notice")).toBeNull();
  }, 20_000);
});

describe("the ClawBox AI slot in Settings → Providers", () => {
  it("offers the removal of the owner's key with no refusal on screen, and no link to where it already is", async () => {
    stubBox({ poll: () => ({ status: "pending" }), slot: "owner-key" });
    const { findByTestId, queryByTestId } = render(
      <AIModelsStep embedded providerIds={["clawai", "openai"]} defaultProviderId="clawai" />,
    );

    expect(await findByTestId("clawai-slot-notice")).toHaveTextContent(
      en["ai.clawaiSlot.ownerKeyNotice"].replace("{profileId}", "deepseek:default"),
    );
    expect(queryByTestId("clawai-slot-open-providers")).toBeNull();
  });

  it("says nothing while the slot is ClawBox AI's or empty", async () => {
    const fetchMock = stubBox({ poll: () => ({ status: "pending" }), slot: "free" });
    const { queryByTestId } = render(
      <AIModelsStep embedded providerIds={["clawai", "openai"]} defaultProviderId="clawai" />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/setup-api/ai-models/clawai/slot", expect.anything()));
    expect(queryByTestId("clawai-slot-notice")).toBeNull();
  });
});
