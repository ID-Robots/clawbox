/**
 * The Providers panel at a phone width.
 *
 * Measured with a Playwright screenshot at 390x844 (TASK-632/F-30): the rows
 * read "OpenAI G…", "Anthropic Cla…", "OpenRou…", and the hero card that exists
 * to answer "which brain is my box using?" showed a clipped vendor name over
 * half a model id. There is no horizontal overflow and no console error — the
 * name is simply the only thing in the row that can give, so it gives, while
 * the icon, the Default pill, the Make-default button and the 44 px switch all
 * keep their width.
 *
 * jsdom does no layout, so these are assertions about the CLASS CONTRACT that
 * produces the clipping rather than about measured pixels: in a narrow pane the
 * name must not be `truncate`d, and the controls must not share its line. That
 * is the half a unit test can hold; the pixels are the screenshot on the card.
 *
 * The queries must be the CONTAINER's, not the viewport's, and that is pinned
 * here rather than left to a comment: Settings caps this pane at `max-w-xl`
 * (576 px) and draws it inside a window the owner can drag to 300 px, so a
 * `sm:` breakpoint is answered "wide" on a desktop whose provider rows are
 * 300 px across — the reported clipping, at a width no phone is involved in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import AiProviderList from "@/components/AiProviderList";
import ProviderDefaultHero from "@/components/ProviderDefaultHero";
import type { ProviderStatusRow } from "@/lib/provider-status";

vi.mock("@/components/AIProviderIcon", () => ({ default: () => <span data-testid="icon" /> }));

/** The three labels the screenshot caught mid-word. */
const ROWS = [
  { id: "openai", label: "OpenAI GPT", state: "connected", isDefault: true, section: "ai", enabled: true },
  { id: "anthropic", label: "Anthropic Claude", state: "connected", isDefault: false, section: "ai", enabled: true },
  // One UNBROKEN label, which is the shape `break-words` alone cannot save: on
  // Hermes the label is whatever the dashboard reports.
  { id: "openrouter", label: "OpenRouterUnbrokenVendorName", state: "connected", isDefault: false, section: "ai", enabled: true },
];

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("/setup-api/preferences")) return json({});
    if (url.startsWith("/setup-api/providers/status")) {
      return json({ harness: "openclaw", providers: ROWS, defaultProvider: "openai", degraded: false });
    }
    // Loud, like the sibling suite: a call this fixture does not know about is
    // a change in what the component reads, not something to answer `{}` to.
    return new Response(JSON.stringify({ error: "unexpected" }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  }));
}

/**
 * True when this element clips its text at EVERY width. Tailwind's `truncate`
 * is `overflow-hidden text-ellipsis whitespace-nowrap`; behind a container
 * query (`@md:truncate`) it applies only where the pane is wide enough, which
 * is what lets the name wrap in a narrow one and stay on a line in a wide one.
 */
function clipsAtEveryWidth(el: HTMLElement): boolean {
  return el.className.split(/\s+/).includes("truncate");
}

function hasClass(el: HTMLElement, cls: string): boolean {
  return el.className.split(/\s+/).includes(cls);
}

/**
 * Every responsive class on this element, and whether it asks the CONTAINER
 * (`@md:`) or the VIEWPORT (`sm:`). A viewport query here is the bug: the pane
 * is narrower than `sm` on every desktop.
 */
function viewportQueries(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter((c) => /^(sm|md|lg|xl|2xl):/.test(c));
}

/** The nearest ancestor that declares itself a query container. */
function containerAncestor(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (hasClass(node, "@container")) return node;
  }
  return null;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider rows at phone widths", () => {
  it("does not clip the provider name in the list", async () => {
    stubFetch();
    render(<I18nProvider><AiProviderList /></I18nProvider>);

    for (const row of ROWS) {
      // Found through the row rather than waited for on its own, so a build
      // without the hook fails on the assertion instead of on a timeout.
      const li = await screen.findByTestId(`ai-provider-${row.id}`);
      const name = within(li).queryByTestId(`ai-provider-name-${row.id}`);
      expect(name, `${row.label} has no name element of its own`).not.toBeNull();
      expect(name!).toHaveTextContent(row.label);
      expect(clipsAtEveryWidth(name!), `${row.label} is clipped at every width`).toBe(false);
      // An unbroken label must still be legible rather than hard-clipped by
      // the row's `min-w-0`: on Hermes the label is dashboard data.
      expect(hasClass(name!, "break-words"), `${row.label} must be allowed to break`).toBe(true);
      // `overflow-wrap: break-word` does not reduce a flex item's min-content
      // width, so `break-words` without `min-w-0` still overflows the pane.
      expect(hasClass(name!, "min-w-0"), `${row.label} must be able to shrink`).toBe(true);
      // Still one line where the PANE has room for one.
      expect(hasClass(name!, "@md:truncate"), `${row.label} should truncate in a wide pane`).toBe(true);
      expect(viewportQueries(name!), `${row.label} must not ask the viewport`).toEqual([]);
      expect(containerAncestor(name!), `${row.label} has no query container`).not.toBeNull();
    }
  });

  it("stacks the row's controls under the name in a narrow pane", async () => {
    stubFetch();
    render(<I18nProvider><AiProviderList /></I18nProvider>);

    const li = await screen.findByTestId("ai-provider-anthropic");
    expect(hasClass(li, "flex-col"), "the row stacks in a narrow pane").toBe(true);
    expect(hasClass(li, "@md:flex-row"), "and is one line in a wide one").toBe(true);
    expect(viewportQueries(li), "the row must not ask the viewport").toEqual([]);
    expect(containerAncestor(li), "the row has no query container").not.toBeNull();
    // The switch and Make-default travel together, off the name's line.
    const controls = await screen.findByTestId("ai-provider-controls-anthropic");
    expect(controls).toContainElement(screen.getByTestId("ai-provider-switch-anthropic"));
    expect(controls).toContainElement(screen.getByTestId("ai-provider-make-default-anthropic"));
  });

  it("does not clip the vendor or the model on the hero card", () => {
    // An unbroken label and an unbroken model id: the pair `break-words` alone
    // cannot keep inside a narrow pane.
    const row = { id: "anthropic", label: "AnthropicUnbrokenVendorName", state: "connected", isDefault: true, section: "ai", enabled: true } as unknown as ProviderStatusRow;
    render(
      <I18nProvider>
        <ProviderDefaultHero row={row} model="claude-opus-5-20260401" onChangeModel={() => {}} />
      </I18nProvider>,
    );

    const hero = screen.getByTestId("provider-default-hero");
    expect(hasClass(hero, "flex-col"), "the hero stacks in a narrow pane").toBe(true);
    expect(hasClass(hero, "@md:flex-row"), "and is one line in a wide one").toBe(true);
    expect(viewportQueries(hero), "the hero must not ask the viewport").toEqual([]);
    expect(containerAncestor(hero), "the hero declares no query container").not.toBeNull();

    const name = screen.getByTestId("provider-default-hero-name");
    expect(name).toHaveTextContent("AnthropicUnbrokenVendorName");
    expect(clipsAtEveryWidth(name), "the vendor name is clipped at every width").toBe(false);
    expect(hasClass(name, "break-words"), "the vendor name must be allowed to break").toBe(true);
    expect(hasClass(name, "min-w-0"), "the vendor name must be able to shrink").toBe(true);

    const model = screen.getByTestId("provider-default-hero-model");
    expect(model).toHaveTextContent("claude-opus-5-20260401");
    expect(clipsAtEveryWidth(model), "the model id is clipped at every width").toBe(false);
    // A model id is one long hyphenated token: without the ellipsis it has to
    // be allowed to break, or it pushes the card wider than the phone.
    expect(hasClass(model, "break-words"), "the model id must be allowed to wrap").toBe(true);
    expect(hasClass(model, "min-w-0"), "the model id must be able to shrink").toBe(true);
  });
});
