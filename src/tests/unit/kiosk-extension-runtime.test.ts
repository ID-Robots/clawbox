// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import nodePath from "node:path";

/**
 * kiosk/extension, RUN rather than read (kiosk-extension.test.ts pins the
 * source): what keeps the extension cheap on a busy kiosk, each measured by
 * what the script actually does.
 *
 *  - offset.js judges a box again only for an attribute change that can move
 *    one. A header that hides on scroll with `style.transform`, a fade or a
 *    reading-progress bar's `style.width` wrote a style every frame, and each
 *    one took the offset off, forced a layout and wrote it back.
 *  - bar.js redraws its tab strip (and measures it) only when what the chips
 *    show changed, and not at all while its page is hidden.
 *  - background.js sends one broadcast per burst of tab events.
 *
 * Each script is evaluated with its `chrome` passed in as a parameter, so a
 * listener an earlier test left behind talks to that test's stand-in, never
 * to this one's.
 */
const EXT = nodePath.resolve(__dirname, "../../../kiosk/extension");
const source = (f: string) => fs.readFileSync(nodePath.join(EXT, f), "utf-8");
const BAR_H = 40;

type Globals = typeof globalThis & {
  clawboxKioskOffset: { start(barH: number): void };
  clawboxKioskBar: { mount(opts: { startPage?: boolean; desktop?: boolean }): unknown };
};
const g = globalThis as Globals;

// Promise callbacks and MutationObserver deliveries (both microtasks).
async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("offset.js", () => {
  // jsdom has no layout and no typed OM, and its computed style carries only
  // what was declared: the cascade here is the box's inline style over
  // Chrome's initial values, which is all these boxes have.
  const INITIAL: Record<string, string> = {
    display: "block", position: "static", top: "auto", bottom: "auto", height: "auto", minHeight: "0px",
    maxHeight: "none", marginTop: "0px", scrollPaddingTop: "auto", transitionDuration: "0s",
    transform: "none", translate: "none", rotate: "none", scale: "none", perspective: "none", filter: "none",
    backdropFilter: "none", willChange: "auto", contain: "none", containerType: "normal",
    contentVisibility: "visible", overflowX: "visible", overflowY: "visible",
  };
  // Every box whose style the script read: judging a box reads it; a record
  // it skipped reads nothing.
  let reads: Element[] = [];
  const computed = (el: Element) => {
    reads.push(el);
    const inline = (el as HTMLElement).style as unknown as Record<string, string>;
    const out: Record<string, string> = { ...INITIAL };
    for (const k of Object.keys(INITIAL)) if (inline[k]) out[k] = inline[k];
    return out;
  };
  class CSSKeywordValue { constructor(readonly value: string) {} }
  class CSSUnitValue { constructor(readonly value: number, readonly unit: string) {} }
  const camel = (p: string) => p.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

  let frames: FrameRequestCallback[] = [];
  const flushFrames = () => {
    while (frames.length) for (const cb of frames.splice(0)) cb(0);
  };
  const observers: MutationObserver[] = [];

  beforeEach(() => {
    reads = [];
    frames = [];
    vi.stubGlobal("getComputedStyle", computed);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    const Real = window.MutationObserver;
    vi.stubGlobal("MutationObserver", function Tracked(cb: MutationCallback) {
      const mo = new Real(cb);
      observers.push(mo);
      return mo;
    });
    (Element.prototype as unknown as { computedStyleMap: () => unknown }).computedStyleMap = function (this: Element) {
      const cs = computed(this);
      return {
        get: (prop: string) => {
          const v = cs[camel(prop)];
          if (!v || v === "auto") return new CSSKeywordValue("auto");
          return new CSSUnitValue(parseFloat(v), v.endsWith("%") ? "percent" : "px");
        },
      };
    };
  });

  afterEach(() => {
    for (const mo of observers.splice(0)) mo.disconnect();
    delete (Element.prototype as unknown as { computedStyleMap?: unknown }).computedStyleMap;
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("style");
    document.documentElement.removeAttribute("class");
    document.body.removeAttribute("style");
  });

  function startOffset(markup: string) {
    document.body.innerHTML = markup;
    new Function(source("offset.js"))();
    g.clawboxKioskOffset.start(BAR_H);
    flushFrames();
  }

  it("a header written to on scroll is judged again only when the page moves it", async () => {
    startOffset('<div id="h" style="position: fixed; top: 0px;"></div>');
    const h = document.getElementById("h") as HTMLElement;
    expect(h.style.getPropertyValue("top")).toBe("40px");
    expect(h.style.getPropertyPriority("top")).toBe("important");

    // Hidden on scroll, faded, a progress width: nothing a verdict reads.
    reads = [];
    h.style.transform = "translateY(-64px)";
    h.style.opacity = "0.9";
    h.style.width = "50%";
    h.style.boxShadow = "0 1px 2px black";
    await flushMicrotasks();
    expect(frames).toHaveLength(0);
    expect(reads).toHaveLength(0);

    // The page moves the header itself: taken at its word, and put below the
    // bar again — with its own transform left as it wrote it.
    h.style.top = "8px";
    await flushMicrotasks();
    expect(frames).toHaveLength(1);
    flushFrames();
    expect(reads).toContain(h);
    expect(h.style.getPropertyValue("top")).toBe("48px");
    expect(h.style.getPropertyPriority("top")).toBe("important");
    expect(h.style.transform).toBe("translateY(-64px)");
  });

  it("a custom property, a padding or a class the box did not have still counts; the same class again does not", async () => {
    startOffset('<div id="h" style="position: fixed; top: 0px;"></div>');
    const h = document.getElementById("h") as HTMLElement;
    for (const write of [
      () => h.style.setProperty("--header-top", "4px"),
      () => { h.style.paddingTop = "6px"; },
      () => { h.className = "stuck"; },
    ]) {
      write();
      await flushMicrotasks();
      expect(frames).toHaveLength(1);
      flushFrames();
    }
    reads = [];
    h.className = "stuck";
    h.style.setProperty("--header-top", "4px");
    await flushMicrotasks();
    expect(frames).toHaveLength(0);
    expect(reads).toHaveLength(0);
  });

  it("on <body> only what paints is skipped: a transform there contains every fixed box", async () => {
    startOffset('<div id="h" style="position: fixed; top: 0px;"></div>');
    document.body.style.backgroundColor = "black";
    document.body.style.color = "white";
    await flushMicrotasks();
    expect(frames).toHaveLength(0);
    document.body.style.transform = "translateZ(0)";
    await flushMicrotasks();
    expect(frames).toHaveLength(1);
    // Not run: the whole-document pass it asks for waits on a timer this
    // test would leave behind.
    frames = [];
  });

  // HEAVY is "more than HEAVY_SUBTREE (400) descendants": such a box is
  // judged again only for a change of its own, never as a bystander to a
  // class on <html>. The bounded check must draw the line where counting
  // every descendant did.
  it.each([
    [400, true],
    [401, false],
  ])("a box with %i descendants is judged again as a bystander: %s", async (n, again) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    startOffset(`<div id="big" style="position: fixed; top: 0px;">${"<i></i>".repeat(n)}</div>`);
    const big = document.getElementById("big") as HTMLElement;
    expect(big.style.getPropertyValue("top")).toBe("40px");
    // A whole-document pass is due again.
    now = 1_000;
    reads = [];
    document.documentElement.className = "scrolled";
    await flushMicrotasks();
    flushFrames();
    expect(reads).toContain(document.documentElement);
    expect(reads.includes(big)).toBe(again);
  });
});

describe("bar.js", () => {
  type Tab = { id: number; title: string; url: string; favicon: string; active: boolean };
  let hidden = false;

  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.getElementById("clawbox-kiosk-bar")?.remove();
    document.documentElement.removeAttribute("class");
  });

  function mountBar(tabs: Tab[], currentId: number) {
    let list = { tabs, currentId, homeId: 99 };
    const sendMessage = vi.fn(async (msg: { type: string }) => (msg.type === "list" ? list : { ok: true }));
    const onMessage: Array<(msg: unknown) => void> = [];
    const chrome = {
      runtime: {
        getURL: (p: string) => `chrome-extension://kiosk/${p}`,
        sendMessage,
        onMessage: { addListener: (fn: (msg: unknown) => void) => onMessage.push(fn) },
      },
    };
    // The bar's shadow root is closed; keep the one it makes.
    let root: ShadowRoot | null = null;
    const attach = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init: ShadowRootInit) {
      root = attach.call(this, init);
      return root;
    });
    new Function("chrome", source("bar.js"))(chrome);
    g.clawboxKioskBar.mount({ startPage: false });
    const shadow = root as unknown as ShadowRoot;
    // Every measure of the strip: the forced layout a rebuild pays for.
    let measures = 0;
    Object.defineProperty(shadow.querySelector(".tabs"), "clientWidth", {
      configurable: true,
      get: () => { measures++; return 600; },
    });
    return {
      root: shadow,
      sendMessage,
      measures: () => measures,
      setList: (next: typeof list) => { list = next; },
      changed: () => { for (const fn of onMessage) fn({ type: "changed" }); },
      chips: () => [...shadow.querySelectorAll<HTMLButtonElement>(".tab")],
    };
  }

  const TABS: Tab[] = [
    { id: 1, title: "One", url: "https://one.example/", favicon: "https://one.example/favicon.ico", active: true },
    { id: 2, title: "", url: "https://two.example/a", favicon: "javascript:alert(1)", active: false },
  ];

  it("draws the strip once, and again only when what a chip shows changed", async () => {
    const bar = mountBar(TABS, 1);
    await flushMicrotasks();
    const [one, two] = bar.chips();
    expect(bar.chips()).toHaveLength(2);
    expect(one.className).toBe("tab current");
    expect(one.title).toBe("One");
    expect(one.querySelector("img")?.getAttribute("src")).toBe("https://one.example/favicon.ico");
    // No title: the host; a favicon that is not a web image: the globe.
    expect(two.title).toBe("two.example");
    expect(two.querySelector("img")).toBeNull();
    expect(two.querySelector(".globe")).not.toBeNull();
    expect(bar.measures()).toBe(1);

    // A broadcast and the 5 s poll that find the same tabs: same chips, no
    // measure.
    bar.changed();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bar.sendMessage.mock.calls.filter(([m]) => m.type === "list").length).toBeGreaterThanOrEqual(3);
    expect(bar.chips()[0]).toBe(one);
    expect(bar.chips()[1]).toBe(two);
    expect(bar.measures()).toBe(1);

    // A title arrives: drawn again, and measured again.
    bar.setList({ tabs: [TABS[0], { ...TABS[1], title: "Two" }], currentId: 1, homeId: 99 });
    bar.changed();
    await flushMicrotasks();
    expect(bar.chips()[0]).not.toBe(one);
    expect(bar.chips()[1].title).toBe("Two");
    expect(bar.chips()[1].getAttribute("aria-label")).toBeNull();
    expect(bar.chips()[1].querySelector(".x")?.getAttribute("aria-label")).toBe("Close Two");
    expect(bar.measures()).toBe(2);

    // The chips still act on their own tabs.
    bar.sendMessage.mockClear();
    bar.chips()[1].click();
    expect(bar.sendMessage).toHaveBeenCalledWith({ type: "activate", id: 2 });
    bar.sendMessage.mockClear();
    bar.chips()[1].querySelector<HTMLButtonElement>(".x")!.click();
    expect(bar.sendMessage).toHaveBeenCalledWith({ type: "close", id: 2 });
    expect(bar.sendMessage).not.toHaveBeenCalledWith({ type: "activate", id: 2 });
  });

  it("a hidden page refreshes nothing, and catches up once when it is shown", async () => {
    const bar = mountBar(TABS, 1);
    await flushMicrotasks();
    const lists = () => bar.sendMessage.mock.calls.filter(([m]) => m.type === "list").length;
    const before = lists();

    hidden = true;
    bar.changed();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(lists()).toBe(before);

    // While it was hidden another tab became current.
    bar.setList({ tabs: TABS, currentId: 2, homeId: 99 });
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await flushMicrotasks();
    expect(lists()).toBe(before + 1);
    expect(bar.chips()[1].className).toBe("tab current");
  });
});

describe("background.js", () => {
  const DELAY = Number(/const BROADCAST_DELAY_MS = (\d+);/.exec(source("background.js"))?.[1]);

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function loadWorker() {
    const tabs = [{ id: 1, url: "http://localhost/" }, { id: 2, url: "https://a.example/" }, { id: 3, url: "https://b.example/" }];
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const event = (name: string) => ({ addListener: (fn: (...args: unknown[]) => void) => { (listeners[name] ??= []).push(fn); } });
    const sendMessage = vi.fn(() => Promise.resolve());
    const chrome = {
      runtime: { getURL: (p: string) => `chrome-extension://kiosk/${p}`, onMessage: event("message"), onStartup: event("startup"), onInstalled: event("installed") },
      tabs: {
        query: vi.fn(async () => tabs),
        sendMessage,
        remove: vi.fn(async () => undefined),
        onCreated: event("created"),
        onRemoved: event("removed"),
        onUpdated: event("updated"),
        onActivated: event("activated"),
      },
    };
    new Function("chrome", source("background.js"))(chrome);
    const fire = (name: string, ...args: unknown[]) => { for (const fn of listeners[name] ?? []) fn(...args); };
    // One broadcast = one "changed" to each of the three tabs.
    const broadcasts = () => sendMessage.mock.calls.length / tabs.length;
    return { fire, sendMessage, broadcasts };
  }

  it("one page load and a tab switch are ONE broadcast, sent after the last of them", async () => {
    expect(DELAY).toBeGreaterThan(0);
    const w = loadWorker();
    w.fire("created", { id: 4 });
    w.fire("activated", { tabId: 4 });
    w.fire("updated", 4, { status: "loading", url: "https://c.example/" });
    w.fire("updated", 4, { title: "C" });
    w.fire("updated", 4, { favIconUrl: "https://c.example/favicon.ico" });
    w.fire("updated", 4, { status: "complete" });
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(w.broadcasts()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.broadcasts()).toBe(1);
    for (const id of [1, 2, 3]) expect(w.sendMessage).toHaveBeenCalledWith(id, { type: "changed" });

    // A status change the bar cannot show is still no broadcast.
    w.fire("updated", 4, { status: "loading" });
    await vi.advanceTimersByTimeAsync(DELAY * 4);
    expect(w.broadcasts()).toBe(1);

    // The next change after the burst gets its own.
    w.fire("removed", 4);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(w.broadcasts()).toBe(2);
  });

  it("a title that never stops changing still gets one broadcast per window, not none", async () => {
    const w = loadWorker();
    const every = 20;
    const span = DELAY * 6;
    for (let t = 0; t < span; t += every) {
      w.fire("updated", 2, { title: `tick ${t}` });
      await vi.advanceTimersByTimeAsync(every);
    }
    await vi.advanceTimersByTimeAsync(DELAY);
    // Once per DELAY, give or take the edges — against span / every (30) events.
    expect(w.broadcasts()).toBeGreaterThanOrEqual(5);
    expect(w.broadcasts()).toBeLessThanOrEqual(7);
  });
});

describe("newtab.js", () => {
  // The start page's box navigates to what the bar's Enter rule answers, and
  // to nothing but a web address whatever that rule returns: typed text must
  // never become a javascript: or data: URL on a page the kiosk opens.
  let saved: Globals["clawboxKioskBar"];
  beforeEach(() => { saved = g.clawboxKioskBar; });
  afterEach(() => { g.clawboxKioskBar = saved; document.body.innerHTML = ""; });

  function submit(destination: string | null) {
    document.body.innerHTML = '<form class="search"><input id="q" value="typed"></form>';
    const assign = vi.fn();
    g.clawboxKioskBar = { mount: vi.fn(), destinationFor: vi.fn(() => destination) } as unknown as Globals["clawboxKioskBar"];
    new Function("location", source("newtab.js"))({ assign });
    document.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    return assign;
  }

  it("goes to an http(s) address as the bar's rule answered it", () => {
    for (const to of ["https://duckduckgo.com/?q=claw%20box", "http://localhost:3005/app/vnc#x", "https://example.com/a/b?c=d"]) {
      expect(submit(to)).toHaveBeenCalledWith(to);
    }
  });

  it("never navigates to anything that is not a web address", () => {
    for (const to of [null, "", "javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>1</script>", "file:///etc/passwd", "chrome://settings", "not a url"]) {
      expect(submit(to), String(to)).not.toHaveBeenCalled();
    }
  });
});
