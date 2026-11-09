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
 * produces the clipping rather than about measured pixels: the name must not be
 * `truncate`d, and the controls must leave it room or leave its line. That is
 * the half a unit test can hold; the pixels are the screenshot on the card.
 *
 * No query may ask the VIEWPORT: Settings caps this pane at `max-w-xl` (576 px)
 * and draws it inside a window the owner can drag to 300 px, so a `sm:`
 * breakpoint is answered "wide" on a desktop whose provider rows are 300 px
 * across — the reported clipping, at a width no phone is involved in. The
 * provider rows ask nothing at all since TASK-2246: with the sign-out among
 * the controls, the Anthropic row's four do not fit beside its name even at
 * 576 px while ClawBox AI's three do, so each row wraps by its own content —
 * the name's column keeps a basis, and the controls take a line of their own
 * under it when they would eat into that.
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
      // Not clipped in a wide pane either: the column keeps room for a name,
      // and a longer one wraps rather than losing its end.
      expect(name!.className, `${row.label} is truncated in some pane`).not.toMatch(/(^|\s|:)truncate(\s|$)/);
      expect(viewportQueries(name!), `${row.label} must not ask the viewport`).toEqual([]);
    }
  });

  it("gives the name a column of its own and moves the controls under it when they do not fit beside it", async () => {
    stubFetch();
    render(<I18nProvider><AiProviderList /></I18nProvider>);

    for (const row of ROWS) {
      const li = await screen.findByTestId(`ai-provider-${row.id}`);
      expect(hasClass(li, "flex-wrap"), `${row.label}: the row wraps rather than squeezing the name`).toBe(true);
      expect(viewportQueries(li), `${row.label}: the row must not ask the viewport`).toEqual([]);
      // The name's column: grows into what the controls leave, and its basis
      // is what decides when they no longer fit beside it.
      const identity = screen.getByTestId(`ai-provider-identity-${row.id}`);
      expect(identity).toContainElement(screen.getByTestId(`ai-provider-name-${row.id}`));
      for (const cls of ["grow", "basis-40", "min-w-0"]) {
        expect(hasClass(identity, cls), `${row.label}: name column lacks ${cls}`).toBe(true);
      }
      // The controls: right-aligned on a line of their own, and wrapping
      // inside it in a 300 px window rather than being clipped.
      const controls = screen.getByTestId(`ai-provider-controls-${row.id}`);
      for (const cls of ["ml-auto", "flex-wrap", "justify-end", "max-w-full"]) {
        expect(hasClass(controls, cls), `${row.label}: controls lack ${cls}`).toBe(true);
      }
      expect(controls).toContainElement(screen.getByTestId(`ai-provider-switch-${row.id}`));
      expect(controls).toContainElement(screen.getByTestId(`ai-provider-sign-out-${row.id}`));
      expect(identity).not.toContainElement(controls);
    }
    expect(screen.getByTestId("ai-provider-controls-anthropic")).toContainElement(screen.getByTestId("ai-provider-make-default-anthropic"));
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
