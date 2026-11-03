import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@/tests/helpers/test-utils";
import UpdateWhatsNewPanel from "@/components/UpdateWhatsNewPanel";
import UpdateWhatsNewShowcase, {
  SHOWCASE_ADVANCE_MS,
  SHOWCASE_COMPACT_VIEWPORT,
  SHOWCASE_FEATURES,
  SHOWCASE_NARROW_PX,
  SHOWCASE_TYPE_MS,
  type Floor,
} from "@/components/UpdateWhatsNewShowcase";
import { whatsNewEn } from "@/lib/edition-translations/en-whats-new";
import { translations } from "@/lib/translations";
import { releasePageUrl, updateWhatsNewPanel } from "@/lib/update-whats-new";
import { WHATS_NEW_HIGHLIGHTS, WHATS_NEW_RELEASE } from "@/lib/whats-new";

/**
 * The System Update window's "What's new" showcase (TASK-2121): every
 * highlight of the release, ONE at a time — its title typed in beside its
 * real screenshot with a live demo over it — turned by the chips, by ←/→, or
 * by itself every 7.5 s unless the owner is pointing at it or in it.
 */

const TARGET = `${WHATS_NEW_RELEASE}.0`;
const TITLES = WHATS_NEW_HIGHLIGHTS.map((item) => whatsNewEn[item.title]);
const CHIPS = ["Screenshots", "One browser for you", "Share an app with a public link", "xAI Grok", "Hold to talk", "The Coding Agent", "Prime Radiant"];

function mount() {
  render(
    <UpdateWhatsNewPanel
      variant="grid"
      headingLevel="h3"
      panel={updateWhatsNewPanel({ version: TARGET, channel: "beta", source: "none", highlights: [], releaseUrl: releasePageUrl(TARGET) })}
    />,
  );
  return screen.getByTestId("whats-new-showcase");
}

function reducedMotion(on: boolean, { compactScreen = false } = {}) {
  window.matchMedia = ((query: string) => ({
    matches: (on && query === "(prefers-reduced-motion: reduce)") || (compactScreen && query === SHOWCASE_COMPACT_VIEWPORT),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** The title on stage, as a screen reader names its heading. */
function shownTitle(showcase: HTMLElement) {
  return within(showcase).getByRole("heading").textContent;
}

function selectedChip(showcase: HTMLElement) {
  return within(showcase).getByRole("tab", { selected: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  reducedMotion(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("UpdateWhatsNewShowcase", () => {
  it("draws the first highlight of the catalogue, its counter, the logo and a chip for every one", () => {
    const showcase = mount();
    expect(showcase).toHaveAttribute("data-index", "0");
    expect(showcase).toHaveAttribute("data-feature", "shot");
    expect(within(showcase).getByTestId("whats-new-showcase-count")).toHaveTextContent(`01 / 0${WHATS_NEW_HIGHLIGHTS.length} · New in ${WHATS_NEW_RELEASE}`);
    expect(shownTitle(showcase)).toContain(TITLES[0]);
    expect(within(showcase).getByText(whatsNewEn[WHATS_NEW_HIGHLIGHTS[0].body])).toBeInTheDocument();
    expect(within(showcase).getByTestId("whats-new-showcase-logo")).toHaveTextContent("ClawBox");
    const chips = within(showcase).getAllByRole("tab");
    expect(chips.map((chip) => chip.textContent)).toEqual(CHIPS);
    expect(chips.map((chip) => chip.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false", "false", "false", "false"]);
    // One tab stop for the row: the chip that is on.
    expect(chips.map((chip) => chip.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1]);
    // Inline SVG only: nothing on it needs an icon font.
    expect(showcase.querySelector(".material-symbols-rounded")).toBeNull();
  });

  it("types the title in a letter at a time, behind a caret, while the heading already names it whole", () => {
    const showcase = mount();
    const typed = within(showcase).getByTestId("whats-new-showcase-typed");
    const visible = () => typed.lastElementChild?.textContent;
    expect(visible()).toBe("");
    advance(SHOWCASE_TYPE_MS * 3);
    expect(visible()).toBe(TITLES[0].slice(0, 3));
    expect(typed.querySelector(".wns-caret")).not.toBeNull();
    expect(within(showcase).getByRole("heading", { name: TITLES[0] })).toBeInTheDocument();
    advance(SHOWCASE_TYPE_MS * TITLES[0].length);
    expect(visible()).toBe(TITLES[0]);
  });

  it(`moves on every ${SHOWCASE_ADVANCE_MS / 1000} s, through every highlight in the catalogue's order and back to the first`, () => {
    const showcase = mount();
    const glow = within(showcase).getByTestId("whats-new-showcase-glow");
    const firstGlow = glow.style.backgroundColor;
    advance(SHOWCASE_ADVANCE_MS - 1);
    expect(showcase).toHaveAttribute("data-index", "0");
    advance(1);
    expect(showcase).toHaveAttribute("data-index", "1");
    expect(within(showcase).getByRole("heading", { name: TITLES[1] })).toBeInTheDocument();
    expect(selectedChip(showcase)).toHaveTextContent(CHIPS[1]);
    expect(within(showcase).getByTestId("whats-new-showcase-count")).toHaveTextContent(/^02 \//);
    // The glow takes the feature's own colour.
    expect(glow.style.backgroundColor).not.toBe(firstGlow);
    const seen = [0, 1];
    for (let step = 2; step <= WHATS_NEW_HIGHLIGHTS.length; step++) {
      advance(SHOWCASE_ADVANCE_MS);
      seen.push(Number(showcase.getAttribute("data-index")));
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 0]);
    // Each feature's own screenshot, the full-resolution file.
    expect(within(showcase).getByTestId("update-whats-new-image")).toHaveAttribute("src", WHATS_NEW_HIGHLIGHTS[0].fullImage);
  });

  it("puts the feature a chip names on stage, and gives it its full time", () => {
    const showcase = mount();
    advance(4000);
    fireEvent.click(within(showcase).getByRole("tab", { name: CHIPS[6] }));
    expect(showcase).toHaveAttribute("data-index", "6");
    expect(showcase).toHaveAttribute("data-feature", "wiki");
    expect(within(showcase).getByTestId("update-whats-new-image")).toHaveAttribute("src", WHATS_NEW_HIGHLIGHTS[6].fullImage);
    advance(SHOWCASE_ADVANCE_MS - 1);
    expect(showcase).toHaveAttribute("data-index", "6");
    advance(1);
    expect(showcase).toHaveAttribute("data-index", "0");
  });

  it("holds while the pointer is over it, and goes on when it leaves", () => {
    const showcase = mount();
    fireEvent.mouseEnter(showcase);
    expect(showcase).toHaveAttribute("data-paused", "true");
    advance(SHOWCASE_ADVANCE_MS * 4);
    expect(showcase).toHaveAttribute("data-index", "0");
    fireEvent.mouseLeave(showcase);
    expect(showcase).toHaveAttribute("data-paused", "false");
    advance(SHOWCASE_ADVANCE_MS);
    expect(showcase).toHaveAttribute("data-index", "1");
  });

  it("holds while the focus is in it, and goes on once the focus leaves it", () => {
    const showcase = mount();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => selectedChip(showcase).focus());
    expect(showcase).toHaveAttribute("data-paused", "true");
    advance(SHOWCASE_ADVANCE_MS * 3);
    expect(showcase).toHaveAttribute("data-index", "0");
    act(() => outside.focus());
    expect(showcase).toHaveAttribute("data-paused", "false");
    advance(SHOWCASE_ADVANCE_MS);
    expect(showcase).toHaveAttribute("data-index", "1");
    outside.remove();
  });

  it("turns with ← and →, wraps at both ends, jumps with Home and End, and takes the focus along the chips", () => {
    const showcase = mount();
    act(() => selectedChip(showcase).focus());
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(showcase).toHaveAttribute("data-index", "1");
    expect(document.activeElement).toBe(selectedChip(showcase));
    expect(selectedChip(showcase)).toHaveTextContent(CHIPS[1]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(showcase).toHaveAttribute("data-index", String(WHATS_NEW_HIGHLIGHTS.length - 1));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(showcase).toHaveAttribute("data-index", "0");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(showcase).toHaveAttribute("data-index", "6");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(showcase).toHaveAttribute("data-index", "0");
    // A key with a modifier is someone else's shortcut.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight", altKey: true });
    expect(showcase).toHaveAttribute("data-index", "0");
    // The arrows work from the slide itself too; the focus stays where it is.
    const slide = within(showcase).getByRole("tabpanel");
    act(() => slide.focus());
    fireEvent.keyDown(slide, { key: "ArrowRight" });
    expect(showcase).toHaveAttribute("data-index", "1");
    expect(document.activeElement).toBe(slide);
    expect(slide).toHaveAccessibleName(CHIPS[1]);
  });

  it("names the feature in a live region: quiet while it turns by itself, polite while the owner drives it", () => {
    const showcase = mount();
    const live = within(showcase).getByTestId("whats-new-showcase-live");
    expect(live).toHaveTextContent(TITLES[0]);
    expect(live).toHaveAttribute("aria-live", "off");
    advance(SHOWCASE_ADVANCE_MS);
    expect(live).toHaveTextContent(TITLES[1]);
    fireEvent.mouseEnter(showcase);
    expect(live).toHaveAttribute("aria-live", "polite");
    fireEvent.click(within(showcase).getByRole("tab", { name: CHIPS[4] }));
    expect(live).toHaveTextContent(TITLES[4]);
  });

  it("runs each demo on its own clock: the link is copied, the recording and the run's timer tick", () => {
    const showcase = mount();
    fireEvent.mouseEnter(showcase);
    fireEvent.click(within(showcase).getByRole("tab", { name: CHIPS[2] }));
    const stage = () => within(showcase).getByTestId("whats-new-showcase-stage");
    expect(stage()).toHaveTextContent("Public link for Recipe Book");
    const copy = () => stage().querySelector(".wns-copy")?.textContent;
    expect(copy()).toBe("Copy");
    advance(5249);
    expect(copy()).toBe("Copy");
    advance(1);
    expect(copy()).toBe("✓ Copied");

    fireEvent.click(within(showcase).getByRole("tab", { name: CHIPS[4] }));
    expect(stage()).toHaveTextContent("Recording 0:01");
    advance(7000);
    expect(stage()).toHaveTextContent("Recording 0:04");
    expect(stage()).toHaveTextContent("F8");

    fireEvent.click(within(showcase).getByRole("tab", { name: CHIPS[5] }));
    expect(stage()).toHaveTextContent("4m 3s");
    advance(7000);
    expect(stage()).toHaveTextContent("4m 10s");

    fireEvent.click(within(showcase).getByRole("tab", { name: CHIPS[1] }));
    const typed = stage().querySelector(".wns-typed")!;
    expect(typed.textContent).toBe("");
    advance(7000);
    expect(typed.textContent).toBe("switching editions");
    expect(stage()).toHaveTextContent("Assistant");
    expect(stage()).toHaveTextContent("You");
  });

  it("with reduced motion: no typing and no caret, every demo already at its end, and it still turns", () => {
    reducedMotion(true);
    const showcase = mount();
    expect(showcase).toHaveAttribute("data-motion", "reduce");
    const typed = within(showcase).getByTestId("whats-new-showcase-typed");
    expect(typed.lastElementChild?.textContent).toBe(TITLES[0]);
    expect(typed.querySelector(".wns-caret")).toBeNull();
    // The CSS holds each one-shot keyframe at its end and drops the camera.
    const css = showcase.querySelector("style")!.textContent!;
    expect(css).toContain('.wns[data-motion="reduce"] .wns-scr *');
    expect(css).toMatch(/\.wns\[data-motion="reduce"\] \.wns-cam[^{]*\{animation:none\}/);

    fireEvent.click(within(showcase).getByRole("tab", { name: CHIPS[2] }));
    expect(within(showcase).getByTestId("whats-new-showcase-stage")).toHaveTextContent("✓ Copied");
    fireEvent.click(within(showcase).getByRole("tab", { name: CHIPS[4] }));
    expect(within(showcase).getByTestId("whats-new-showcase-stage")).toHaveTextContent("Recording 0:04");
    fireEvent.click(within(showcase).getByRole("tab", { name: CHIPS[1] }));
    expect(within(showcase).getByTestId("whats-new-showcase-stage").querySelector(".wns-typed")?.textContent).toBe("switching editions");

    fireEvent.mouseLeave(showcase);
    advance(SHOWCASE_ADVANCE_MS);
    expect(showcase).toHaveAttribute("data-index", "2");
  });

  it("loads every screenshot and the logo the moment it is drawn, so a restart cannot leave a hole", () => {
    const showcase = mount();
    const pictures = [...showcase.querySelectorAll<HTMLImageElement>("img[data-showcase-image]")];
    expect(pictures.map((img) => img.getAttribute("src"))).toEqual(WHATS_NEW_HIGHLIGHTS.map((item) => item.fullImage));
    expect(pictures.every((img) => img.getAttribute("loading") === "eager")).toBe(true);
    // Only the feature on show is displayed; the others wait, loaded, and are never drawn again from the network.
    expect(pictures.map((img) => img.closest("[hidden]") === null)).toEqual([true, false, false, false, false, false, false]);
    fireEvent.click(within(showcase).getByRole("tab", { name: CHIPS[3] }));
    expect([...showcase.querySelectorAll("img[data-showcase-image]")]).toEqual(pictures);
    expect(pictures.map((img) => img.closest("[hidden]") === null)).toEqual([false, false, false, true, false, false, false]);
    expect(within(showcase).getByTestId("whats-new-showcase-logo").querySelector("img")).toHaveAttribute("src", "/clawbox-icon.png");
  });

  it("draws the text without a frame for a screenshot the box could not serve", () => {
    const showcase = mount();
    fireEvent.error(within(showcase).getByTestId("update-whats-new-image"));
    expect(within(showcase).queryByTestId("whats-new-showcase-stage")).toBeNull();
    expect(within(showcase).getByRole("heading", { name: TITLES[0] })).toBeInTheDocument();
    fireEvent.click(within(showcase).getByRole("tab", { name: CHIPS[1] }));
    expect(within(showcase).getByTestId("whats-new-showcase-stage")).toHaveAttribute("data-feature", "br");
    // One that fails while waiting its turn is gone before it comes up.
    fireEvent.error(showcase.querySelector(`img[src="${WHATS_NEW_HIGHLIGHTS[2].fullImage}"]`)!);
    fireEvent.click(within(showcase).getByRole("tab", { name: CHIPS[2] }));
    expect(within(showcase).queryByTestId("whats-new-showcase-stage")).toBeNull();
  });

  it("shows a highlight with no demo yet as its still screenshot, its title as the chip", () => {
    const tr: Floor = (_key, english, params) => english.replace(/\{(\w+)\}/g, (_, name: string) => params?.[name] ?? "");
    render(
      <UpdateWhatsNewShowcase
        items={[
          { key: "whatsNew.screenshotTitle", title: "Screens", body: "Body one", image: "/a.webp" },
          { key: "whatsNew.someday", title: "Something later", body: "Body two", image: "/b.webp" },
        ]}
        release="9.9"
        tr={tr}
        headingLevel="h4"
        releaseLink={null}
      />,
    );
    const showcase = screen.getByTestId("whats-new-showcase");
    fireEvent.click(within(showcase).getByRole("tab", { name: "Something later" }));
    expect(showcase).toHaveAttribute("data-feature", "plain");
    expect(within(showcase).getByTestId("whats-new-showcase-stage").querySelectorAll(".wns-o")).toHaveLength(0);
    expect(within(showcase).getByTestId("whats-new-showcase-count")).toHaveTextContent("02 / 02 · New in 9.9");
    expect(within(showcase).getByRole("heading", { level: 4, name: "Something later" })).toBeInTheDocument();
  });

  it("lays its two columns out by its own width, and keeps turning when its list gets shorter", () => {
    const tr: Floor = (_key, english, params) => english.replace(/\{(\w+)\}/g, (_, name: string) => params?.[name] ?? "");
    const item = (n: number) => ({ key: `whatsNew.later${n}`, title: `Feature ${n}`, body: `Body ${n}`, image: `/${n}.webp` });
    const { rerender } = render(<UpdateWhatsNewShowcase items={[item(1), item(2), item(3)]} release="9.9" tr={tr} headingLevel="h4" releaseLink={null} />);
    const showcase = screen.getByTestId("whats-new-showcase");
    // A container of its own: the window around it is wider than the hero.
    expect(showcase.className).toContain("@container");
    fireEvent.click(within(showcase).getByRole("tab", { name: "Feature 3" }));
    rerender(<UpdateWhatsNewShowcase items={[item(1), item(2)]} release="9.9" tr={tr} headingLevel="h4" releaseLink={null} />);
    expect(showcase).toHaveAttribute("data-index", "1");
    advance(SHOWCASE_ADVANCE_MS);
    expect(showcase).toHaveAttribute("data-index", "0");
    advance(SHOWCASE_ADVANCE_MS);
    expect(showcase).toHaveAttribute("data-index", "1");
    rerender(<UpdateWhatsNewShowcase items={[]} release="9.9" tr={tr} headingLevel="h4" releaseLink={null} />);
    expect(screen.queryByTestId("whats-new-showcase")).toBeNull();
  });

  it("has a demo for every highlight of the catalogue, and its words in every language", () => {
    for (const item of WHATS_NEW_HIGHLIGHTS) expect(SHOWCASE_FEATURES[item.title], item.title).toBeDefined();
    const keys = Object.keys(translations.en).filter((key) => key.startsWith("update.showcase."));
    expect(keys.length).toBeGreaterThan(30);
    for (const [locale, table] of Object.entries(translations)) {
      for (const key of keys) expect(table[key], `${locale} ${key}`).toBeTruthy();
      // The placeholders survive translation.
      for (const key of keys) {
        const wanted = translations.en[key].match(/\{\w+\}/g) ?? [];
        for (const name of wanted) expect(table[key], `${locale} ${key}`).toContain(name);
      }
    }
  });
});

/*
 * On a phone — the owner watching an update through the box's tunnel — and in
 * Settings' 672 px pane. jsdom lays nothing out, so the showcase's own width
 * is what a ResizeObserver would report, set by hand.
 */
describe("UpdateWhatsNewShowcase — narrow: a phone, a small window, Settings' pane", () => {
  let ownWidth = 0;
  let observers: (() => void)[] = [];

  class FakeResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe() { observers.push(this.callback); }
    disconnect() { observers = observers.filter((callback) => callback !== this.callback); }
  }

  /** The showcase is now `width` px wide, as its ResizeObserver reports it. */
  function layOut(width: number) {
    ownWidth = width;
    act(() => observers.forEach((callback) => callback()));
  }

  function mountAt(width: number) {
    ownWidth = width;
    return mount();
  }

  function touch(element: Element, from: [number, number], to: [number, number] = from) {
    fireEvent.touchStart(element, { touches: [{ clientX: from[0], clientY: from[1] }] });
    return fireEvent.touchEnd(element, { touches: [], changedTouches: [{ clientX: to[0], clientY: to[1] }] });
  }

  function stage(showcase: HTMLElement) {
    return within(showcase).getByTestId("whats-new-showcase-stage");
  }

  beforeEach(() => {
    observers = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "whats-new-showcase" ? ownWidth : 0;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it(`is laid out narrow below ${SHOWCASE_NARROW_PX} px of its own — a phone, Settings' 672 px pane — and keeps the desktop's layout at /updating's 728 px`, () => {
    const showcase = mountAt(360);
    expect(showcase).toHaveAttribute("data-layout", "narrow");
    const chips = within(showcase).getByTestId("whats-new-showcase-chips");
    // Under a thumb one row that scrolls sideways inside itself, not three
    // wrapped ones; a mouse, with no sideways swipe, still has them wrapped.
    expect(chips.className).toContain("pointer-coarse:overflow-x-auto");
    expect(chips.className).toContain("pointer-coarse:flex-nowrap");
    expect(chips.className).toMatch(/(^| )flex-wrap( |$)/);
    // Swipes are the showcase's; the page still scrolls up and down under a thumb.
    expect(within(showcase).getByTestId("whats-new-showcase-panel").className).toContain("touch-pan-y");

    layOut(672);
    expect(showcase).toHaveAttribute("data-layout", "narrow");
    layOut(728);
    expect(showcase).toHaveAttribute("data-layout", "wide");
    expect(chips.className).toContain("flex-wrap");
    expect(chips.className).not.toContain("overflow-x-auto");
    expect(chips.className).not.toContain("pointer-coarse:");
    expect(within(showcase).getByTestId("whats-new-showcase-panel").className).not.toContain("touch-pan-y");
    expect(showcase.querySelectorAll("[data-showcase-reserve]")).toHaveLength(0);
    // Not laid out yet reads as wide: what the desktop has always drawn.
    layOut(0);
    expect(showcase).toHaveAttribute("data-layout", "wide");
  });

  it("is laid out narrow on a phone's screen whatever its own width: a phone held sideways too", () => {
    reducedMotion(false, { compactScreen: true });
    const showcase = mountAt(812);
    expect(showcase).toHaveAttribute("data-layout", "narrow");
  });

  it("keeps the screenshot where it is as the features turn: the text is sized by every title and body", () => {
    const showcase = mountAt(390);
    const typed = within(showcase).getByTestId("whats-new-showcase-typed");
    expect(typed.querySelectorAll("[data-showcase-reserve]")).toHaveLength(WHATS_NEW_HIGHLIGHTS.length);
    expect(showcase.querySelectorAll("p[data-showcase-reserve]")).toHaveLength(WHATS_NEW_HIGHLIGHTS.length);
    for (const body of WHATS_NEW_HIGHLIGHTS.map((item) => whatsNewEn[item.body])) {
      expect([...showcase.querySelectorAll("p[data-showcase-reserve]")].map((p) => p.textContent)).toContain(body);
    }
    // Still one heading and one body a screen reader reads.
    expect(within(showcase).getByRole("heading")).toHaveTextContent(TITLES[0]);
    expect(within(showcase).getAllByText(whatsNewEn[WHATS_NEW_HIGHLIGHTS[0].body]).filter((p) => !p.hasAttribute("aria-hidden"))).toHaveLength(1);
  });

  it("turns with a swipe — to the left the next feature, to the right the one before — and gives it its full time", () => {
    const showcase = mountAt(390);
    touch(stage(showcase), [300, 400], [200, 410]);
    expect(showcase).toHaveAttribute("data-index", "1");
    expect(within(showcase).getByRole("heading", { name: TITLES[1] })).toBeInTheDocument();
    touch(stage(showcase), [100, 400], [220, 390]);
    expect(showcase).toHaveAttribute("data-index", "0");
    // From the first, to the right wraps to the last.
    touch(within(showcase).getByTestId("whats-new-showcase-panel"), [100, 300], [200, 300]);
    expect(showcase).toHaveAttribute("data-index", String(WHATS_NEW_HIGHLIGHTS.length - 1));
    // The swiped-to feature is not cut short.
    advance(SHOWCASE_ADVANCE_MS - 1);
    expect(showcase).toHaveAttribute("data-index", String(WHATS_NEW_HIGHLIGHTS.length - 1));
    advance(1);
    expect(showcase).toHaveAttribute("data-index", "0");
  });

  it("turns nothing for a thumb scrolling the page, a short slide, or a swipe along the chips' own row", () => {
    const showcase = mountAt(390);
    touch(stage(showcase), [200, 500], [180, 300]);
    touch(stage(showcase), [200, 400], [175, 405]);
    touch(within(showcase).getByTestId("whats-new-showcase-chips"), [300, 700], [100, 700]);
    expect(showcase).toHaveAttribute("data-index", "0");
    expect(showcase).toHaveAttribute("data-held", "false");
  });

  it("holds on a tap, with a pause mark on the screenshot, and goes on after the next tap", () => {
    const showcase = mountAt(390);
    // The tap is the showcase's own: no click, no focus, no made-up hover after it.
    expect(touch(stage(showcase), [150, 400])).toBe(false);
    expect(showcase).toHaveAttribute("data-held", "true");
    expect(showcase).toHaveAttribute("data-paused", "true");
    expect(within(showcase).getByTestId("whats-new-showcase-held")).toBeInTheDocument();
    expect(within(showcase).getByTestId("whats-new-showcase-live")).toHaveAttribute("aria-live", "polite");
    advance(SHOWCASE_ADVANCE_MS * 3);
    expect(showcase).toHaveAttribute("data-index", "0");
    // Held, it still turns by hand.
    touch(stage(showcase), [300, 400], [200, 400]);
    expect(showcase).toHaveAttribute("data-index", "1");
    expect(showcase).toHaveAttribute("data-held", "true");

    touch(stage(showcase), [150, 400], [153, 404]);
    expect(showcase).toHaveAttribute("data-held", "false");
    expect(showcase).toHaveAttribute("data-paused", "false");
    expect(within(showcase).queryByTestId("whats-new-showcase-held")).toBeNull();
    advance(SHOWCASE_ADVANCE_MS);
    expect(showcase).toHaveAttribute("data-index", "2");
  });

  it("takes a long press for no tap", () => {
    const showcase = mountAt(390);
    fireEvent.touchStart(stage(showcase), { touches: [{ clientX: 150, clientY: 400 }] });
    advance(700);
    fireEvent.touchEnd(stage(showcase), { touches: [], changedTouches: [{ clientX: 150, clientY: 400 }] });
    expect(showcase).toHaveAttribute("data-held", "false");
  });

  it("never takes a touch for a pointer over it: a chip tapped is picked, the show goes on", () => {
    const showcase = mountAt(390);
    const chip = within(showcase).getByRole("tab", { name: CHIPS[3] });
    fireEvent.touchStart(chip, { touches: [{ clientX: 40, clientY: 700 }] });
    fireEvent.touchEnd(chip, { touches: [], changedTouches: [{ clientX: 40, clientY: 700 }] });
    // What a browser makes up after the tap.
    fireEvent.mouseEnter(showcase);
    fireEvent.click(chip);
    expect(showcase).toHaveAttribute("data-index", "3");
    expect(showcase).toHaveAttribute("data-paused", "false");
    advance(SHOWCASE_ADVANCE_MS);
    expect(showcase).toHaveAttribute("data-index", "4");
    // A real mouse, long after, still holds it.
    advance(1500);
    fireEvent.mouseEnter(showcase);
    expect(showcase).toHaveAttribute("data-paused", "true");
  });

  it("lets a tap decide even when a chip has the focus", () => {
    const showcase = mountAt(390);
    const chip = within(showcase).getByRole("tab", { name: CHIPS[0] });
    act(() => chip.focus());
    expect(showcase).toHaveAttribute("data-paused", "true");
    touch(stage(showcase), [150, 400]);
    expect(document.activeElement).not.toBe(chip);
    expect(showcase).toHaveAttribute("data-held", "true");
    touch(stage(showcase), [150, 400]);
    expect(showcase).toHaveAttribute("data-paused", "false");
  });

  it("keeps the chip that is on in sight by scrolling its own row, and only when the row overflows", () => {
    const showcase = mountAt(390);
    const row = within(showcase).getByTestId("whats-new-showcase-chips");
    const scrollTo = vi.fn();
    Object.defineProperty(row, "scrollTo", { value: scrollTo, configurable: true });
    Object.defineProperty(row, "scrollWidth", { value: 800, configurable: true });
    Object.defineProperty(row, "clientWidth", { value: 300, configurable: true });
    within(showcase).getAllByRole("tab").forEach((chip, at) => {
      Object.defineProperty(chip, "offsetLeft", { value: 16 + at * 110, configurable: true });
      Object.defineProperty(chip, "offsetWidth", { value: 100, configurable: true });
    });
    for (let turn = 0; turn < 3; turn += 1) advance(SHOWCASE_ADVANCE_MS);
    expect(showcase).toHaveAttribute("data-index", "3");
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 16 + 3 * 110 - (300 - 100) / 2, behavior: "smooth" });
    // Back at the first: the row's start, never a negative scroll.
    fireEvent.click(within(showcase).getByRole("tab", { name: CHIPS[0] }));
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: "smooth" });
    // A row that fits is left alone.
    Object.defineProperty(row, "scrollWidth", { value: 300, configurable: true });
    scrollTo.mockClear();
    fireEvent.click(within(showcase).getByRole("tab", { name: CHIPS[5] }));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("with reduced motion: the camera stands where each demo ends, the chips' row jumps, and swipes and taps still work", () => {
    reducedMotion(true);
    const showcase = mountAt(390);
    expect(showcase).toHaveAttribute("data-motion", "reduce");
    expect(showcase).toHaveAttribute("data-layout", "narrow");
    const row = within(showcase).getByTestId("whats-new-showcase-chips");
    const scrollTo = vi.fn();
    Object.defineProperty(row, "scrollTo", { value: scrollTo, configurable: true });
    Object.defineProperty(row, "scrollWidth", { value: 800, configurable: true });
    Object.defineProperty(row, "clientWidth", { value: 300, configurable: true });
    touch(stage(showcase), [300, 400], [200, 400]);
    expect(showcase).toHaveAttribute("data-index", "1");
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "auto" }));
    touch(stage(showcase), [150, 400]);
    expect(showcase).toHaveAttribute("data-held", "true");
    const css = showcase.querySelector("style")!.textContent!;
    expect(css).toContain('.wns[data-layout="narrow"][data-motion="reduce"] .wns-scr .wns-cam{animation:none}');
  });

  it("has a narrow camera for every demo: it starts somewhere, pans to the action and stands where the demo ends", () => {
    const showcase = mountAt(390);
    const css = showcase.querySelector("style")!.textContent!;
    for (const feature of Object.values(SHOWCASE_FEATURES)) {
      const rule = css.match(new RegExp(String.raw`\.wns\[data-layout="narrow"\] \.wns-${feature.id} \.wns-cam\{([^}]*)\}`));
      expect(rule, feature.id).not.toBeNull();
      // Where it stands with motion off, and the picture's legible width.
      expect(rule![1]).toMatch(/--wns-fx:\.\d+;--wns-fy:\.\d+;--wns-pz:\d{3,4}/);
      expect(rule![1]).toContain(`animation:wns-n-${feature.id} 7s`);
      expect(css).toContain(`@keyframes wns-n-${feature.id}{0%{`);
    }
    // Wherever it pans, the picture covers the stage: at least as wide as the stage, and as tall.
    expect(css).toContain("--wns-pw:max(100cqw,calc(var(--wns-pz) * 1px),calc(160cqw * var(--wns-ar)))");
  });
});
