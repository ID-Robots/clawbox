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
 * produces the clipping rather than about measured pixels: below `sm:` the name
 * must not be `truncate`d, and the controls must not share the line with it.
 * That is the half a unit test can hold; the pixels are the screenshot on the
 * card.
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
  { id: "openrouter", label: "OpenRouter", state: "connected", isDefault: false, section: "ai", enabled: true },
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
    return json({});
  }));
}

/**
 * True when this element clips its text at EVERY width. Tailwind's `truncate`
 * is `overflow-hidden text-ellipsis whitespace-nowrap`; prefixed with a
 * breakpoint (`sm:truncate`) it only applies from that width up, which is what
 * lets the name wrap on a phone and stay on one line on a desktop.
 */
function clipsAtEveryWidth(el: HTMLElement): boolean {
  return el.className.split(/\s+/).includes("truncate");
}

function hasClass(el: HTMLElement, cls: string): boolean {
  return el.className.split(/\s+/).includes(cls);
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
      // Still one line where there is room for one.
      expect(hasClass(name!, "sm:truncate"), `${row.label} should still truncate from sm: up`).toBe(true);
    }
  });

  it("stacks the row's controls under the name below sm:", async () => {
    stubFetch();
    render(<I18nProvider><AiProviderList /></I18nProvider>);

    const li = await screen.findByTestId("ai-provider-anthropic");
    expect(hasClass(li, "flex-col"), "the row stacks on a phone").toBe(true);
    expect(hasClass(li, "sm:flex-row"), "and is one line from sm: up").toBe(true);
    // The switch and Make-default travel together, off the name's line.
    const controls = await screen.findByTestId("ai-provider-controls-anthropic");
    expect(controls).toContainElement(screen.getByTestId("ai-provider-switch-anthropic"));
    expect(controls).toContainElement(screen.getByTestId("ai-provider-make-default-anthropic"));
  });

  it("does not clip the vendor or the model on the hero card", () => {
    const row = { id: "anthropic", label: "Anthropic Claude", state: "connected", isDefault: true, section: "ai", enabled: true } as unknown as ProviderStatusRow;
    render(
      <I18nProvider>
        <ProviderDefaultHero row={row} model="claude-opus-5-20260401" onChangeModel={() => {}} />
      </I18nProvider>,
    );

    const hero = screen.getByTestId("provider-default-hero");
    expect(hasClass(hero, "flex-col"), "the hero stacks on a phone").toBe(true);
    expect(hasClass(hero, "sm:flex-row"), "and is one line from sm: up").toBe(true);

    const name = screen.getByTestId("provider-default-hero-name");
    expect(name).toHaveTextContent("Anthropic Claude");
    expect(clipsAtEveryWidth(name), "the vendor name is clipped at every width").toBe(false);

    const model = screen.getByTestId("provider-default-hero-model");
    expect(model).toHaveTextContent("claude-opus-5-20260401");
    expect(clipsAtEveryWidth(model), "the model id is clipped at every width").toBe(false);
    // A model id is one long hyphenated token: without the ellipsis it has to
    // be allowed to break, or it pushes the card wider than the phone.
    expect(hasClass(model, "break-words"), "the model id must be allowed to wrap").toBe(true);
  });
});
