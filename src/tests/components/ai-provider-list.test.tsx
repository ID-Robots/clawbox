/**
 * The unified provider list (src/components/AiProviderList.tsx) — every AI
 * provider in one place with a switch each.
 *
 * The two rules pinned here are the ones the route enforces and the list must
 * reflect: a switch flips through POST /setup-api/providers/enabled and
 * re-reads the truth from the box (never an optimistic flip), and the default
 * provider's switch is LOCKED — nothing on this card may re-route the chat
 * behind the owner's back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import { translations } from "@/lib/translations";
import AiProviderList from "@/components/AiProviderList";

vi.mock("@/components/AIProviderIcon", () => ({ default: () => <span data-testid="icon" /> }));

const ROWS = [
  { id: "clawai", label: "ClawBox AI", state: "connected", isDefault: true, section: "ai", enabled: true },
  { id: "openai", label: "OpenAI", state: "connected", isDefault: false, section: "ai", enabled: true },
  { id: "anthropic", label: "Anthropic", state: "connected", isDefault: false, section: "ai", enabled: false },
  { id: "google", label: "Google", state: "disconnected", isDefault: false, section: "ai", enabled: true },
  { id: "llamacpp", label: "Gemma 4", state: "connected", isDefault: false, section: "localAi", enabled: true },
];

let posts: { url: string; body: unknown }[] = [];

function stubFetch(rows = ROWS, opts: { refuse?: { status: number; error: string }; locale?: string } = {}) {
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    // The I18nProvider's one read: which language the owner picked.
    if (url.startsWith("/setup-api/preferences")) {
      return json(opts.locale ? { ui_language: opts.locale } : {});
    }
    if (url.startsWith("/setup-api/providers/status")) {
      return json({ harness: "openclaw", providers: rows, defaultProvider: "clawai", degraded: false });
    }
    if (url === "/setup-api/providers/enabled" && init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (opts.refuse) return json({ error: opts.refuse.error, kind: "is_default" }, opts.refuse.status);
      return json({ harness: "openclaw", providers: rows, defaultProvider: "clawai", degraded: false });
    }
    if (url === "/setup-api/providers/default" && init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ ok: true });
    }
    return json({ error: "unexpected" }, 404);
  }));
}

/** The list as Settings mounts it: inside the app's I18nProvider. */
function renderList() {
  return render(<I18nProvider><AiProviderList /></I18nProvider>);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AiProviderList", () => {
  it("lists the connected cloud providers with the default marked — not the unconnected ones, not the on-device engines", async () => {
    stubFetch();
    renderList();
    for (const row of ROWS.filter((r) => r.state === "connected" && r.section !== "localAi")) {
      expect(await screen.findByTestId(`ai-provider-${row.id}`)).toBeInTheDocument();
    }
    // Connecting a provider is the panel below the list, not a row in it.
    expect(screen.queryByTestId("ai-provider-google")).not.toBeInTheDocument();
    // The on-device model has its own tab.
    expect(screen.queryByTestId("ai-provider-llamacpp")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-provider-default-clawai")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-provider-default-openai")).not.toBeInTheDocument();
    // A switched-off provider says so instead of pretending to be disconnected.
    expect(screen.getByTestId("ai-provider-anthropic").textContent).toContain("Switched off");
  });

  it("flips a provider through the route and re-reads the list", async () => {
    stubFetch();
    renderList();
    const sw = await screen.findByTestId("ai-provider-switch-openai");
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    await waitFor(() => expect(posts).toContainEqual({
      url: "/setup-api/providers/enabled",
      body: { provider: "openai", enabled: false },
    }));
    // Two status reads: the mount and the re-read after the flip.
    await waitFor(() => {
      const statusReads = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .filter((c) => String(c[0]).startsWith("/setup-api/providers/status"));
      expect(statusReads.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("locks the default provider's switch, with the way out as its hint", async () => {
    stubFetch();
    renderList();
    const sw = await screen.findByTestId("ai-provider-switch-clawai");
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute("title", "Make another provider the default first.");
    // Visible on the row too, not only on hover — a phone has no hover — and
    // the switch names it as its description.
    expect(screen.getByTestId("ai-provider-locked-hint-clawai")).toHaveTextContent("Make another provider the default first.");
    expect(sw).toHaveAccessibleDescription("Make another provider the default first.");
    expect(screen.queryByTestId("ai-provider-locked-hint-openai")).not.toBeInTheDocument();
    fireEvent.click(sw);
    expect(posts).toEqual([]);
  });

  it("offers Make default only for a connected, enabled, non-default row", async () => {
    stubFetch();
    renderList();
    await screen.findByTestId("ai-provider-openai");
    expect(screen.getByTestId("ai-provider-make-default-openai")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-provider-make-default-clawai")).not.toBeInTheDocument();
    // Switched off, so not offered as a default either.
    expect(screen.queryByTestId("ai-provider-make-default-anthropic")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ai-provider-make-default-openai"));
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/providers/default", body: { provider: "openai" } }));
  });

  it("shows the box's refusal in its own words", async () => {
    stubFetch(ROWS.map((r) => ({ ...r, isDefault: false })), { refuse: { status: 409, error: "Make another provider the default first." } });
    renderList();
    fireEvent.click(await screen.findByTestId("ai-provider-switch-clawai"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Make another provider the default first.");
  });

  // Every string on this card used to be hardcoded English, so a German box
  // read a German Settings page with one English card in the middle of it.
  // Resolve against the REAL German table rather than a hand-written map, so
  // this breaks if the card stops reading the catalogue.
  it("reads its copy from the catalogue — a German box sees German", async () => {
    stubFetch(ROWS, { locale: "de" });
    const de = translations.de;
    renderList();
    expect(await screen.findByText(de["settings.providers.title"])).toBeInTheDocument();
    expect(screen.getByText(de["settings.providers.hint"])).toBeInTheDocument();
    expect(screen.getByTestId("ai-provider-anthropic")).toHaveTextContent(de["settings.providers.switchedOff"]);
    expect(screen.getByTestId("ai-provider-default-clawai")).toHaveTextContent(de["settings.providers.default"]);
    expect(screen.getByTestId("ai-provider-make-default-openai")).toHaveTextContent(de["settings.providers.makeDefault"]);
    expect(screen.getByTestId("ai-provider-switch-clawai")).toHaveAttribute("title", de["settings.providers.lockedHint"]);
    expect(screen.getByTestId("ai-provider-switch-openai")).toHaveAccessibleName(
      de["settings.providers.enable"].replace("{name}", "OpenAI"),
    );
  });

  it("says so in the owner's language when nothing is connected yet", async () => {
    stubFetch(ROWS.map((r) => ({ ...r, state: "disconnected", isDefault: false })), { locale: "fr" });
    renderList();
    expect(await screen.findByText(translations.fr["settings.providers.empty"])).toBeInTheDocument();
  });
});
