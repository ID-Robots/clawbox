import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import WhatsNewCard from "@/components/WhatsNewCard";
import { translations } from "@/lib/translations";
import { useWhatsNew, WHATS_NEW_SETTLE_MS } from "@/lib/use-whats-new";
import {
  WHATS_NEW_DOCS_URL,
  WHATS_NEW_HIGHLIGHTS,
  WHATS_NEW_PLANS_URL,
  type WhatsNewPlanCta,
  type WhatsNewState,
} from "@/lib/whats-new";
import { LANGUAGES, type Locale } from "@/lib/i18n";

/**
 * TASK-1059, TASK-1195: the desktop's "What's new in 4.3" card.
 *
 * A dialog with one slide per 4.3 highlight, each over a screenshot of the
 * feature. The last slide links the docs page and offers the plan only for
 * what the box's plan does not cover yet. The Hermes edition is told about
 * switching back to OpenClaw.
 */

let locale: Locale = "en";

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({
    locale,
    localeResolved: true,
    setLocale: () => {},
    t: (key: string, params?: Record<string, string | number>) => {
      let s = translations[locale][key] ?? key;
      for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    },
  }),
}));

const en = translations.en;
/** The 4.2 card's highlight keys, which the 4.3 card replaced. */
const PREVIOUS_HIGHLIGHTS = ["multiUser", "monitorMode", "githubBackup", "kiosk", "editionChoice", "clawkeep", "hardwareFixes"];
/** The 4.1 and 4.0 cards' highlight keys, gone since. */
const OLDER_HIGHLIGHTS = ["phoneFullscreen", "chatRestore", "webappData", "autoMerge", "codingAgent", "hostname", "phoneChat", "modelPills"];

function stateWith(cta: WhatsNewPlanCta, overrides: Partial<WhatsNewState> = {}): WhatsNewState {
  return {
    show: true,
    release: "4.3",
    version: "4.3.0",
    edition: "openclaw",
    cta,
    freeMonthCode: null,
    ...overrides,
  };
}

const FREE_OPENCLAW = stateWith({ paidFeatures: true, editionSwitch: "hermes" });
const PRO_OPENCLAW = stateWith({ paidFeatures: false, editionSwitch: "hermes" });
const MAX = stateWith({ paidFeatures: false, editionSwitch: null });
const FREE_HERMES = stateWith({ paidFeatures: true, editionSwitch: "openclaw" }, { edition: "hermes" });

beforeEach(() => {
  locale = "en";
});

describe("WhatsNewCard", () => {
  /** The slide on screen. */
  const slide = () => screen.getByTestId("whats-new-slide");
  /** Jump to the last slide, where the docs link and the plan section are. */
  const toLastSlide = () => {
    const dots = screen.getAllByTestId("whats-new-dot");
    fireEvent.click(dots[dots.length - 1]);
  };

  it("is a dialog that names the release and the running version", () => {
    render(<WhatsNewCard state={MAX} onDismiss={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "What's new in 4.3" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByText("This box now runs ClawBox 4.3.0.")).toBeInTheDocument();
    expect(within(dialog).getByRole("region", { name: "Highlights of ClawBox 4.3" })).toBeInTheDocument();
  });

  it("pages through the seven 4.3 highlights, one per slide, each over its own screenshot", () => {
    render(<WhatsNewCard state={MAX} onDismiss={() => {}} />);
    expect(WHATS_NEW_HIGHLIGHTS).toHaveLength(7);
    WHATS_NEW_HIGHLIGHTS.forEach((item, i) => {
      const current = slide();
      expect(current).toHaveAttribute("aria-roledescription", "slide");
      expect(current).toHaveAccessibleName(`${i + 1} of 7`);
      expect(within(current).getByRole("heading", { level: 3 })).toHaveTextContent(en[item.title]);
      expect(within(current).getByText(en[item.summary])).toBeInTheDocument();
      expect(within(current).getByTestId("whats-new-image")).toHaveAttribute("src", item.image);
      if (i < WHATS_NEW_HIGHLIGHTS.length - 1) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    });
    // The last slide has no Next: Got it closes the card.
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.getByRole("button", { name: en["whatsNew.gotIt"] })).toBeInTheDocument();
  });

  it("names the highlights in the release notes' order, with a short summary beside the panel's full body", () => {
    expect(WHATS_NEW_HIGHLIGHTS.map((item) => en[item.title])).toEqual([
      "Screenshots, built in",
      "One browser for you and your assistant",
      "Share an app with a public link",
      "xAI Grok, and model changes without a restart",
      "Hold to talk",
      "The Coding Agent, on a live chart",
      "Prime Radiant, a living wiki",
    ]);
    for (const item of WHATS_NEW_HIGHLIGHTS) {
      expect(en[item.body], item.body).toBeTruthy();
      expect(en[item.summary], item.summary).toBeTruthy();
      // One or two lines under the screenshot, never the panel's paragraph.
      expect(en[item.summary].length, item.summary).toBeLessThan(140);
      expect(en[item.summary].length, item.summary).toBeLessThan(en[item.body].length);
    }
  });

  it("every screenshot is a small WebP that ships in public/", () => {
    const seen = new Set<string>();
    for (const { image } of WHATS_NEW_HIGHLIGHTS) {
      expect(image, image).toMatch(/^\/whats-new\/4\.3\/[a-z-]+\.webp$/);
      expect(seen.has(image), `${image} is used twice`).toBe(false);
      seen.add(image);
      const file = path.join(process.cwd(), "public", image);
      const bytes = readFileSync(file);
      // RIFF....WEBP: a real WebP, not a PNG renamed.
      expect(bytes.subarray(0, 4).toString("latin1"), image).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString("latin1"), image).toBe("WEBP");
      expect(bytes.length, `${image} is ${bytes.length} bytes`).toBeLessThan(160 * 1024);
    }
  });

  it("Back, the dots and the arrow keys move between slides, and nothing goes past either end", () => {
    render(<WhatsNewCard state={MAX} onDismiss={() => {}} />);
    const back = screen.getByRole("button", { name: "Back" });
    expect(back).toBeDisabled();
    expect(back.className).toContain("invisible");

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(slide()).toHaveAttribute("data-slide", "0");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(slide()).toHaveAttribute("data-slide", "1");
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(slide()).toHaveAttribute("data-slide", "0");

    const dots = screen.getAllByTestId("whats-new-dot");
    expect(dots).toHaveLength(7);
    expect(dots[0]).toHaveAttribute("aria-current", "step");
    fireEvent.click(screen.getByRole("button", { name: "Show highlight 5" }));
    expect(slide()).toHaveAttribute("data-slide", "4");
    expect(screen.getAllByTestId("whats-new-dot")[4]).toHaveAttribute("aria-current", "step");
    expect(screen.getAllByTestId("whats-new-dot")[0]).not.toHaveAttribute("aria-current");

    toLastSlide();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(slide()).toHaveAttribute("data-slide", "6");
  });

  it("a swipe turns the slide on a touch screen", () => {
    render(<WhatsNewCard state={MAX} onDismiss={() => {}} />);
    const area = screen.getByTestId("whats-new-slides");
    fireEvent.touchStart(area, { touches: [{ clientX: 300 }] });
    fireEvent.touchEnd(area, { changedTouches: [{ clientX: 200 }] });
    expect(slide()).toHaveAttribute("data-slide", "1");
    fireEvent.touchStart(area, { touches: [{ clientX: 100 }] });
    fireEvent.touchEnd(area, { changedTouches: [{ clientX: 220 }] });
    expect(slide()).toHaveAttribute("data-slide", "0");
    // A tap is not a swipe.
    fireEvent.touchStart(area, { touches: [{ clientX: 100 }] });
    fireEvent.touchEnd(area, { changedTouches: [{ clientX: 110 }] });
    expect(slide()).toHaveAttribute("data-slide", "0");
  });

  it("leaves keys typed into a field alone", () => {
    const onDismiss = vi.fn();
    render(
      <>
        <input aria-label="composer" />
        <WhatsNewCard state={MAX} onDismiss={onDismiss} />
      </>,
    );
    const field = screen.getByRole("textbox", { name: "composer" });
    fireEvent.keyDown(field, { key: "ArrowRight" });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(slide()).toHaveAttribute("data-slide", "0");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  describe("a surface drawn over it keeps its own keys", () => {
    const rect = (x: number) =>
      ({ left: x, top: 0, width: 100, height: 100, right: x + 100, bottom: 100, x, y: 0, toJSON: () => ({}) }) as DOMRect;
    /** jsdom has no layout: say what is on top at each point. */
    const topmostAt = (pick: (x: number) => Element) =>
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: (x: number) => pick(x) });
    afterEach(() => {
      delete (document as unknown as Record<string, unknown>).elementFromPoint;
    });

    it("an approval prompt above it, with the focus on its button: Escape, the arrows and Tab are the prompt's", () => {
      const onDismiss = vi.fn();
      render(
        <>
          <button>Deny</button>
          <WhatsNewCard state={MAX} onDismiss={onDismiss} />
        </>,
      );
      const deny = screen.getByRole("button", { name: "Deny" });
      const dialog = screen.getByRole("dialog");
      vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(rect(0));
      vi.spyOn(deny, "getBoundingClientRect").mockReturnValue(rect(500));
      topmostAt((x) => (x >= 500 ? deny : dialog));

      deny.focus();
      fireEvent.keyDown(deny, { key: "Escape" });
      fireEvent.keyDown(deny, { key: "ArrowRight" });
      const tabNotPrevented = fireEvent.keyDown(deny, { key: "Tab" });
      expect(onDismiss).not.toHaveBeenCalled();
      expect(slide()).toHaveAttribute("data-slide", "0");
      expect(tabNotPrevented).toBe(true);
      expect(document.activeElement).toBe(deny);

      // The focus back on the dialog: the keys are its own again.
      dialog.focus();
      fireEvent.keyDown(window, { key: "ArrowRight" });
      expect(slide()).toHaveAttribute("data-slide", "1");
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it("the screenshot overlay covering the screen: its Escape does not dismiss the card", () => {
      const onDismiss = vi.fn();
      render(
        <>
          <div data-testid="overlay" />
          <WhatsNewCard state={MAX} onDismiss={onDismiss} />
        </>,
      );
      const overlay = screen.getByTestId("overlay");
      vi.spyOn(screen.getByRole("dialog"), "getBoundingClientRect").mockReturnValue(rect(0));
      topmostAt(() => overlay);
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.keyDown(window, { key: "ArrowRight" });
      expect(onDismiss).not.toHaveBeenCalled();
      expect(slide()).toHaveAttribute("data-slide", "0");
    });
  });

  it("takes the focus when it opens, keeps Tab inside, and gives the focus back when it closes", () => {
    const { rerender } = render(
      <>
        <button>behind</button>
        <WhatsNewCard state={MAX} onDismiss={() => {}} />
      </>,
    );
    // Rendered fresh: the dialog has the focus.
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);

    const close = screen.getByRole("button", { name: en["whatsNew.dismiss"] });
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    // Shift+Tab from the first control wraps to the last (the last dot).
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    const controls = within(dialog).getAllByRole("button").filter((b) => !(b as HTMLButtonElement).disabled);
    expect(document.activeElement).toBe(controls[controls.length - 1]);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    const behind = screen.getByRole("button", { name: "behind" });
    behind.focus();
    rerender(<button>behind</button>);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "behind" }));
  });

  it("tells the desktop the owner is using it, so it does not leave on its own", () => {
    const onEngage = vi.fn();
    render(<WhatsNewCard state={MAX} onDismiss={() => {}} onEngage={onEngage} />);
    expect(onEngage).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onEngage).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.pointerDown(screen.getByRole("dialog"));
    expect(onEngage.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("fits the screen: never taller than the viewport, the screenshot a share of its height, the slide scrolling inside", () => {
    render(<WhatsNewCard state={FREE_OPENCLAW} onDismiss={() => {}} />);
    // jsdom has no layout; these are the rules the real-browser checks lean on.
    expect(screen.getByTestId("whats-new-backdrop").className).toMatch(/\bfixed\b.*\binset-0\b/);
    expect(screen.getByRole("dialog").className).toContain("max-h-full");
    expect(screen.getByTestId("whats-new-slides").className).toMatch(/min-h-0.*overflow-y-auto/);
    expect(screen.getByTestId("whats-new-image").parentElement?.className).toMatch(/max-h-\[\d+dvh\]/);
  });

  it("no longer carries the 4.2, 4.1 or 4.0 card's highlights", () => {
    for (const key of [...PREVIOUS_HIGHLIGHTS, ...OLDER_HIGHLIGHTS]) {
      expect(en[`whatsNew.${key}Title`]).toBeUndefined();
      expect(en[`whatsNew.${key}Body`]).toBeUndefined();
    }
  });

  it("names only icons the bundled Material Symbols subset carries", () => {
    // A ligature name the subset lacks renders as its literal text.
    const font = readFileSync(path.join(process.cwd(), "public/fonts/material-symbols-rounded.ttf"), "latin1");
    const lines = font.split("\n");
    for (const icon of [...WHATS_NEW_HIGHLIGHTS.map((h) => h.icon), "chevron_left", "chevron_right", "auto_awesome"]) {
      const word = new RegExp(`(^|[^A-Za-z0-9_])${icon}([^A-Za-z0-9_]|$)`);
      expect(lines.some((line) => word.test(line)), icon).toBe(true);
    }
  });

  it("prints a tag-style version without its v", () => {
    render(<WhatsNewCard state={{ ...MAX, version: "v4.3.1" }} onDismiss={() => {}} />);
    expect(screen.getByText("This box now runs ClawBox 4.3.1.")).toBeInTheDocument();
  });

  it("drops the version line rather than print a blank version", () => {
    render(<WhatsNewCard state={{ ...MAX, version: null }} onDismiss={() => {}} />);
    expect(screen.queryByText(/This box now runs/)).toBeNull();
  });

  it("links the docs page in a new tab, on the last slide", () => {
    render(<WhatsNewCard state={MAX} onDismiss={() => {}} />);
    expect(screen.queryByRole("link", { name: new RegExp(en["whatsNew.readMore"]) })).toBeNull();
    toLastSlide();
    const link = screen.getByRole("link", { name: new RegExp(en["whatsNew.readMore"]) });
    expect(link).toHaveAttribute("href", WHATS_NEW_DOCS_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("the plan section and See plans wait for the last slide", () => {
    render(<WhatsNewCard state={FREE_OPENCLAW} onDismiss={() => {}} />);
    expect(screen.queryByTestId("whats-new-plan")).toBeNull();
    expect(screen.queryByRole("link", { name: new RegExp(en["whatsNew.seePlans"]) })).toBeNull();
    toLastSlide();
    expect(within(slide()).getByTestId("whats-new-plan")).toBeInTheDocument();
  });

  it("a box with no paid plan is offered both lines and the tagged portal link", () => {
    render(<WhatsNewCard state={FREE_OPENCLAW} onDismiss={() => {}} />);
    toLastSlide();
    const plan = screen.getByTestId("whats-new-plan");
    expect(within(plan).getByText(en["whatsNew.planTitle"])).toBeInTheDocument();
    expect(within(plan).getByText(en["whatsNew.planPaidFeatures"])).toBeInTheDocument();
    expect(within(plan).getByText(en["whatsNew.planSwitchToHermes"])).toBeInTheDocument();
    expect(within(plan).queryByText(en["whatsNew.planSwitchToOpenclaw"])).toBeNull();

    const cta = screen.getByRole("link", { name: new RegExp(en["whatsNew.seePlans"]) });
    expect(cta).toHaveAttribute("href", WHATS_NEW_PLANS_URL);
    expect(cta.getAttribute("href")).toContain("utm_source=box&utm_medium=update_card&utm_campaign=v4.3#");
    expect(cta).toHaveAttribute("target", "_blank");
  });

  it("a Pro box is offered only the Max-only edition switch", () => {
    render(<WhatsNewCard state={PRO_OPENCLAW} onDismiss={() => {}} />);
    toLastSlide();
    const plan = screen.getByTestId("whats-new-plan");
    expect(within(plan).queryByText(en["whatsNew.planPaidFeatures"])).toBeNull();
    expect(within(plan).getByText(en["whatsNew.planSwitchToHermes"])).toBeInTheDocument();
    expect(screen.getByRole("link", { name: new RegExp(en["whatsNew.seePlans"]) })).toBeInTheDocument();
  });

  it("a Max box is offered nothing: no plan section and no portal link", () => {
    render(<WhatsNewCard state={MAX} onDismiss={() => {}} />);
    toLastSlide();
    expect(screen.queryByTestId("whats-new-plan")).toBeNull();
    expect(screen.queryByRole("link", { name: new RegExp(en["whatsNew.seePlans"]) })).toBeNull();
    expect(screen.getByRole("button", { name: en["whatsNew.gotIt"] })).toBeInTheDocument();
  });

  it("the Hermes edition is told about switching back to OpenClaw", () => {
    render(<WhatsNewCard state={FREE_HERMES} onDismiss={() => {}} />);
    toLastSlide();
    const plan = screen.getByTestId("whats-new-plan");
    expect(within(plan).getByText(en["whatsNew.planSwitchToOpenclaw"])).toBeInTheDocument();
    expect(within(plan).queryByText(en["whatsNew.planSwitchToHermes"])).toBeNull();
  });

  it("draws nothing for a free-month code: the portal publishes none, and the card has no UI for it", () => {
    render(<WhatsNewCard state={{ ...FREE_OPENCLAW, freeMonthCode: "FREEMONTH-123" }} onDismiss={() => {}} />);
    toLastSlide();
    expect(screen.queryByText(/FREEMONTH-123/)).toBeNull();
  });

  it("the close button, Escape and Got it each dismiss the card", () => {
    const onDismiss = vi.fn();
    render(<WhatsNewCard state={FREE_OPENCLAW} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: en["whatsNew.dismiss"] }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("button", { name: en["whatsNew.gotIt"] })).toBeNull();
    toLastSlide();
    fireEvent.click(screen.getByRole("button", { name: en["whatsNew.gotIt"] }));
    expect(onDismiss).toHaveBeenCalledTimes(3);
  });

  describe.each(LANGUAGES.map((l) => l.code).filter((code) => code !== "en"))("in '%s'", (code) => {
    it("renders the locale's own copy and no raw keys", () => {
      locale = code;
      const { container } = render(<WhatsNewCard state={FREE_HERMES} onDismiss={() => {}} />);
      const table = translations[code];
      expect(screen.getByRole("heading", { name: table["whatsNew.title"] })).toBeInTheDocument();
      expect(table["whatsNew.title"]).not.toBe(en["whatsNew.title"]);
      expect(container.textContent).toContain("4.3.0");
      expect(screen.getByRole("button", { name: table["whatsNew.next"] })).toBeInTheDocument();
      expect(screen.getByTestId("whats-new-slide")).toHaveAccessibleName(
        table["whatsNew.slideLabel"].replace("{current}", "1").replace("{total}", "7"),
      );
      expect(container.textContent).not.toMatch(/whatsNew\./);
      toLastSlide();
      expect(screen.getByText(table["whatsNew.planSwitchToOpenclaw"])).toBeInTheDocument();
      expect(container.textContent).not.toMatch(/whatsNew\./);
      for (const key of OLDER_HIGHLIGHTS.flatMap((k) => [`${k}Title`, `${k}Body`])) {
        expect(table[`whatsNew.${key}`], `${code} still carries the 4.1 or 4.0 card's ${key}`).toBeUndefined();
      }
      for (const key of PREVIOUS_HIGHLIGHTS.flatMap((k) => [`${k}Title`, `${k}Body`])) {
        expect(table[`whatsNew.${key}`], `${code} still carries the 4.2 card's ${key}`).toBeUndefined();
      }
      // Every 4.3 highlight in the locale's own words, none left in English.
      for (const { title, body, summary } of WHATS_NEW_HIGHLIGHTS) {
        for (const key of [title, body, summary]) {
          expect(table[key], `${code} ${key}`).toBeTruthy();
          expect(table[key], `${code} ${key}`).not.toBe(en[key]);
        }
      }
      for (const key of ["whatsNew.back", "whatsNew.next", "whatsNew.goToSlide"]) {
        expect(table[key], `${code} ${key}`).not.toBe(en[key]);
      }
      expect(table["whatsNew.goToSlide"]).toContain("{number}");
      expect(table["whatsNew.slideLabel"]).toContain("{current}");
      expect(table["whatsNew.slideLabel"]).toContain("{total}");
    });
  });
});

/** The hook the desktop drives the card with. */
function Harness({ refreshKey, enabled }: { refreshKey?: unknown; enabled?: boolean }) {
  const { state, visible, settled, dismiss, hide } = useWhatsNew(refreshKey, enabled);
  return (
    <div>
      <span data-testid="visible">{String(visible)}</span>
      <span data-testid="settled">{String(settled)}</span>
      <span data-testid="release">{state?.release ?? "none"}</span>
      <button onClick={dismiss}>dismiss</button>
      <button onClick={hide}>hide</button>
    </div>
  );
}

function jsonResponse(data: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(data) });
}

describe("useWhatsNew", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      init?.method === "POST" ? jsonResponse({ ok: true, show: false }) : jsonResponse(FREE_OPENCLAW),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the card when the route says so", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("visible")).toHaveTextContent("true"));
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/whats-new", { cache: "no-store" });
  });

  it("does not show it when the route says no", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ ...FREE_OPENCLAW, show: false }));
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("release")).toHaveTextContent("4.3"));
    expect(screen.getByTestId("visible")).toHaveTextContent("false");
  });

  it("draws nothing from an answer it cannot read, or a failed request", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ show: true }));
    const { unmount } = render(<Harness />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByTestId("visible")).toHaveTextContent("false");
    unmount();

    fetchMock.mockImplementation(() => Promise.reject(new Error("offline")));
    render(<Harness />);
    await act(async () => {});
    expect(screen.getByTestId("visible")).toHaveTextContent("false");
  });

  it("dismiss hides the card and records it on the box, once", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("visible")).toHaveTextContent("true"));
    fireEvent.click(screen.getByText("dismiss"));
    expect(screen.getByTestId("visible")).toHaveTextContent("false");
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe("/setup-api/whats-new");
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toEqual({ release: "4.3" });
  });

  it("an answer still in flight when the owner dismissed cannot bring the card back", async () => {
    let answer!: (value: unknown) => void;
    const { rerender } = render(<Harness refreshKey="free" />);
    await waitFor(() => expect(screen.getByTestId("visible")).toHaveTextContent("true"));

    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse({ ok: true })
        : new Promise((resolve) => { answer = resolve; }),
    );
    rerender(<Harness refreshKey="flash" />);
    fireEvent.click(screen.getByText("dismiss"));
    await act(async () => {
      answer({ ok: true, status: 200, json: () => Promise.resolve(FREE_OPENCLAW) });
    });
    expect(screen.getByTestId("visible")).toHaveTextContent("false");
  });

  it("hide is for this page load only and records nothing", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("visible")).toHaveTextContent("true"));
    fireEvent.click(screen.getByText("hide"));
    expect(screen.getByTestId("visible")).toHaveTextContent("false");
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("is settled once the route has answered, and stays settled while a refresh is asked", async () => {
    let answer!: (value: unknown) => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const { rerender } = render(<Harness refreshKey="free" />);
    expect(screen.getByTestId("settled")).toHaveTextContent("false");
    await act(async () => {
      answer({ ok: true, status: 200, json: () => Promise.resolve({ ...FREE_OPENCLAW, show: false }) });
    });
    expect(screen.getByTestId("settled")).toHaveTextContent("true");
    // A tier change asks again; the desktop's notices are not held for it.
    rerender(<Harness refreshKey="pro" />);
    expect(screen.getByTestId("settled")).toHaveTextContent("true");
  });

  it("is settled by a failed request, and by an answer it cannot read", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("offline")));
    const { unmount } = render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("settled")).toHaveTextContent("true"));
    unmount();
    fetchMock.mockImplementation(() => jsonResponse({ show: true }));
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("settled")).toHaveTextContent("true"));
    expect(screen.getByTestId("visible")).toHaveTextContent("false");
  });

  it("stops holding the desktop for a route that never answers", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(() => new Promise(() => {}));
      render(<Harness />);
      expect(screen.getByTestId("settled")).toHaveTextContent("false");
      await act(async () => { vi.advanceTimersByTime(WHATS_NEW_SETTLE_MS - 1); });
      expect(screen.getByTestId("settled")).toHaveTextContent("false");
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(screen.getByTestId("settled")).toHaveTextContent("true");
      expect(screen.getByTestId("visible")).toHaveTextContent("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks nothing and is settled at once when disabled (a desktop that may not ask)", () => {
    render(<Harness enabled={false} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("settled")).toHaveTextContent("true");
    expect(screen.getByTestId("visible")).toHaveTextContent("false");
  });

  it("asks the route again when the refresh key (the plan tier) changes", async () => {
    const { rerender } = render(<Harness refreshKey={null} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(<Harness refreshKey="flash" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
