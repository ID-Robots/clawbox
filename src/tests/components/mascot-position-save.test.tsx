// What the mascot costs while it moves — the desktop performance pass.
//
//   - Its resting place (`clawbox-crab-pos`) is read once, when the desktop
//     loads. It used to be written on every animation frame of a walk, a frenzy
//     or the retreat from a docked chat, and again on every action's lane
//     measurement: two POSTs a second while it moved (client-kv's throttle),
//     each a rewrite of the whole data/kv.json on the box. It is now written
//     once a movement has settled, never re-sent unchanged, and stored at once
//     when the page goes away mid-walk.
//   - A walk frame that would move the body by less than half a device pixel
//     is not drawn (no style write, no recalc); the walk still ends exactly on
//     its target.
//   - A mascot that is not drawn — hidden by the owner, or still waiting on
//     /setup-api/pets — runs no walk loop at all, and starts acting once shown.
//   - The root asks the browser for a transform layer only, not a filter one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@/tests/helpers/test-utils";
import Mascot from "@/components/Mascot";

vi.mock("@/lib/i18n", () => ({ useT: () => ({ t: (k: string) => k, locale: "en", localeResolved: true }) }));
vi.mock("@/lib/mascot-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mascot-client")>("@/lib/mascot-client");
  const { neutral } = await import("@/lib/mascot-packs/neutral");
  return {
    ...actual,
    fetchUserName: () => Promise.resolve(null),
    initialPhraseSet: () => neutral,
    fetchPhraseSet: async () => neutral,
  };
});

// A working cache, with every write and flush on the record. Plain functions,
// not vi.fn(): the suite's `mockReset` would strip a vi.fn()'s implementation.
const kvState = vi.hoisted(() => ({
  store: new Map<string, string>(),
  sets: [] as { key: string; value: string }[],
  flushes: 0,
}));
vi.mock("@/lib/client-kv", () => ({
  get: (k: string) => kvState.store.get(k) ?? null,
  getJSON: (k: string) => {
    const raw = kvState.store.get(k);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  },
  set: (k: string, v: string) => { kvState.store.set(k, v); kvState.sets.push({ key: k, value: v }); },
  setJSON: (k: string, v: unknown) => {
    const value = JSON.stringify(v);
    kvState.store.set(k, value);
    kvState.sets.push({ key: k, value });
  },
  remove: (k: string) => { kvState.store.delete(k); },
  flush: () => { kvState.flushes++; },
}));

const POS_KEY = "clawbox-crab-pos";
const posWrites = () => kvState.sets.filter((s) => s.key === POS_KEY).map((s) => JSON.parse(s.value).x as number);

// requestAnimationFrame by hand, so a test decides when a frame runs and what
// time it says. Ids far above the fake timers' own: the mascot clears a walk
// with `clearInterval` as well as `cancelAnimationFrame`.
const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1_000_000;
function runFrame(now: number) {
  const due = [...frames.values()];
  frames.clear();
  act(() => { for (const cb of due) cb(now); });
}

function installMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

let clock = 0;

beforeEach(() => {
  kvState.store.clear();
  kvState.sets.length = 0;
  kvState.flushes = 0;
  // Where the crab stood when the page loaded — the value already stored.
  kvState.store.set(POS_KEY, JSON.stringify({ x: 85 }));
  frames.clear();
  installMatchMedia();
  // The pets route is unreachable: the crab, at once.
  vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  clock = 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  // Every random pick lands on the first choice: the action is a walk, of the
  // shortest distance, to the left, and the next action comes soonest.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let React mount and the pets lookup fail over to the crab. */
async function mount(props: Parameters<typeof Mascot>[0] = {}) {
  const view = render(<Mascot {...props} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return view;
}

function advance(ms: number) {
  act(() => { vi.advanceTimersByTime(ms); });
}

function root(container: HTMLElement) {
  return container.querySelector("[data-mascot]") as HTMLElement | null;
}

/** The x (in vw) the root is drawn at right now. */
function drawnX(container: HTMLElement): number {
  const m = /translateX\(calc\(([\d.]+)vw/.exec(root(container)?.style.transform ?? "");
  if (!m) throw new Error(`no x in ${root(container)?.style.transform}`);
  return Number(m[1]);
}

/** Walk frame by frame, `step` ms apart, keeping the timers in step with the clock. */
function walkFrames(untilMs: number, step: number) {
  const start = clock;
  while (clock - start < untilMs) {
    clock += step;
    advance(step);
    runFrame(clock);
  }
}

describe("the mascot's stored position", () => {
  it("is written once a walk has settled, not on every frame of it", async () => {
    const { container, rerender } = await mount();
    expect(root(container)).not.toBeNull();

    // Up to the 2 s action: the crab has not moved — its lane was measured and
    // its facing set, each of which used to store it — and the position
    // already stored is never sent again.
    advance(1999);
    expect(posWrites()).toEqual([]);

    advance(1);
    expect(frames.size).toBe(1); // the walk is under way

    // The whole walk (90 px at 42 px/s, so the 2.5 s floor), at 60 Hz: 160
    // frames that each used to queue the position for the next POST.
    walkFrames(2600, 16);
    expect(frames.size).toBe(0);
    const target = drawnX(container);
    expect(target).toBeLessThan(85);
    expect(posWrites()).toEqual([]);

    // The owner opens the chat, so nothing moves it again; within two settle
    // periods it is stored, once, where it stopped.
    rerender(<Mascot frozen />);
    advance(2000);
    expect(posWrites()).toEqual([target]);
    expect(kvState.store.get(POS_KEY)).toBe(JSON.stringify({ x: target }));
    advance(10_000);
    expect(posWrites()).toEqual([target]);
  });

  it("is written once the retreat from a docked chat has settled", async () => {
    const { container, rerender } = await mount({ frozen: true });
    advance(3000);
    expect(posWrites()).toEqual([]);

    // A wide chat docks on the right: the crab glides out from under it, one
    // position per frame for half a second.
    rerender(<Mascot frozen rightInset={600} />);
    walkFrames(600, 16);
    const resting = drawnX(container);
    expect(resting).toBeLessThan(85);
    expect(posWrites()).toEqual([]);

    advance(2000);
    expect(posWrites()).toEqual([resting]);
  });

  it("is stored at once — and sent — when the page goes away mid-walk", async () => {
    const { container } = await mount();
    advance(2000);
    walkFrames(1200, 16);
    expect(posWrites()).toEqual([]);

    act(() => { window.dispatchEvent(new Event("pagehide")); });
    const [x] = posWrites();
    expect(posWrites()).toHaveLength(1);
    expect(x).toBeLessThan(85);
    expect(x).toBeGreaterThan(drawnX(container) - 0.1);
    expect(kvState.flushes).toBe(1);

    // A page that leaves with nothing settling sends nothing more.
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(kvState.flushes).toBe(1);
  });

  it("is stored when the mascot unmounts while it is still settling", async () => {
    const { unmount } = await mount();
    advance(2000);
    walkFrames(800, 16);
    expect(posWrites()).toEqual([]);
    unmount();
    expect(posWrites()).toHaveLength(1);
  });
});

describe("the walk's frames", () => {
  it("draws no frame that would move the body by less than half a device pixel, and lands exactly", async () => {
    const { container } = await mount();
    advance(2000);
    const startX = drawnX(container);
    const startTransform = root(container)!.style.transform;

    // The walk eases in: its first milliseconds move the body by a sliver of a
    // pixel, and none of those frames is drawn.
    walkFrames(30, 1);
    expect(root(container)!.style.transform).toBe(startTransform);

    // In its stride every 60 Hz frame moves it by more, and every one is drawn.
    walkFrames(1200, 16);
    const mid: string[] = [];
    for (let i = 0; i < 5; i++) {
      walkFrames(16, 16);
      mid.push(root(container)!.style.transform);
    }
    expect(new Set(mid).size).toBe(5);

    // And it ends on its target, not half a pixel short of it.
    walkFrames(2000, 16);
    const vw = window.innerWidth;
    expect(drawnX(container)).toBeCloseTo(Math.max(5, startX - (90 / vw) * 100), 6);
  });
});

describe("a mascot nobody can see", () => {
  it("runs no walk while hidden, and starts acting once shown", async () => {
    kvState.store.set("clawbox-mascot-hidden", "1");
    const { container } = await mount();
    expect(root(container)).toBeNull();

    // Long past several actions' worth of time: no frame loop, no position.
    for (let i = 0; i < 30; i++) {
      advance(1000);
      expect(frames.size).toBe(0);
    }
    expect(posWrites()).toEqual([]);

    act(() => { window.dispatchEvent(new Event("clawbox-show-mascot")); });
    expect(root(container)).not.toBeNull();
    // On the loop's own cadence: the next look, at most one pause away.
    advance(6000);
    expect(frames.size).toBe(1);
  });
});

describe("the mascot's layer", () => {
  it("asks for a transform layer only — the filter only ever switches", async () => {
    const { container } = await mount();
    expect(root(container)!.style.willChange).toBe("transform");
  });
});
