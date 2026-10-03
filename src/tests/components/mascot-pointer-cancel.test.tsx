// A press on the mascot the SYSTEM ends — `pointercancel` (a touch the browser
// claims for a pan or a gesture, a rejected palm, a pen leaving range) or a
// pointer capture lost on its own — instead of the owner letting go.
//
// The press stops everything: the next action's timer, the stroll, a throw in
// the air. It takes the pointer, and only `pointerup` ever let it go. A
// cancelled press left the drag flag set with nothing to clear it, so the
// mascot stood frozen where it was until it was touched again, and a mouse
// merely hovering over it dragged it about.
//
//   - A press that had moved is dropped exactly as a release drops it: physics
//     carries it to the floor, the landing stores the position and resumes the
//     action loop.
//   - One that had not moved is NOT a tap (the chat stays shut): only the loop
//     it interrupted is put back — the next action, or, during a nap, the
//     nap's own end.
//   - A normal release, which fires `lostpointercapture` right after
//     `pointerup`, is handled once, exactly as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@/tests/helpers/test-utils";
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

// A working cache, with every write on the record. Plain functions, not
// vi.fn(): the suite's `mockReset` would strip a vi.fn()'s implementation.
const kvState = vi.hoisted(() => ({
  store: new Map<string, string>(),
  sets: [] as { key: string; value: string }[],
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
  flush: () => {},
}));

const POS_KEY = "clawbox-crab-pos";
const SLEEP_KEY = "clawbox-mascot-sleep";
const posWrites = () => kvState.sets.filter((s) => s.key === POS_KEY).map((s) => JSON.parse(s.value).x as number);

// requestAnimationFrame by hand. Ids far above the fake timers' own: the
// mascot clears a walk with `clearInterval` as well as `cancelAnimationFrame`.
// jsdom has no Web Animations, so every stroll here walks in frames — a live
// frame is how a test sees that the mascot is moving.
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
  // shortest distance, and the next action comes soonest.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function advance(ms: number) {
  act(() => { clock += ms; vi.advanceTimersByTime(ms); });
}

/** Advance in slices, so each timer that fires reads its own time. */
function advanceStepwise(ms: number, slice = 100) {
  for (let done = 0; done < ms; done += slice) advance(Math.min(slice, ms - done));
}

/**
 * The mascot, with ONE action loop under way and a stroll in progress.
 *
 * A fresh page arms two action timers (the unfreeze at 1 s, the mount at
 * 2 s), and each action re-arms its own, so for a while two loops run — and a
 * press clears only the one in `stateTimeout`, which would let the other hide
 * a mascot left frozen. Mounted with the chat open, the mount's timer finds
 * nothing to do and that loop never starts; closing the chat starts the one.
 */
async function mountWalking(props: Parameters<typeof Mascot>[0] = {}) {
  const view = render(<Mascot frozen {...props} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  advance(2500);
  view.rerender(<Mascot {...props} />);
  advance(1100);
  expect(frames.size).toBe(1); // the stroll
  return view;
}

function root(container: HTMLElement) {
  return container.querySelector("[data-mascot]") as HTMLElement;
}

/** The x (in vw) the root is drawn at right now. */
function drawnX(container: HTMLElement): number {
  const m = /translateX\(calc\(([\d.]+)vw/.exec(root(container).style.transform);
  if (!m) throw new Error(`no x in ${root(container).style.transform}`);
  return Number(m[1]);
}

/** How far above its floor the root is drawn (px). */
function drawnLift(container: HTMLElement): number {
  const m = /translateY\((-?[\d.]+)px\)/.exec(root(container).style.transform);
  if (!m) throw new Error(`no y in ${root(container).style.transform}`);
  // `translateY(0.00px)` is a lift of 0, not -0.
  return -Number(m[1]) || 0;
}

const asleep = (container: HTMLElement) =>
  [...container.querySelectorAll("div")].filter((d) => d.textContent === "Z").length === 3;

/** A press, then a drag up and to the right that comes to rest before it ends. */
function pressAndDrag(el: HTMLElement) {
  fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 500, clientY: 740 });
  advance(50);
  fireEvent.pointerMove(el, { pointerId: 1, clientX: 600, clientY: 300 });
  // Held still for a moment: no velocity, so the drop is a straight fall.
  advance(100);
  fireEvent.pointerMove(el, { pointerId: 1, clientX: 600, clientY: 300 });
}

/** Run the physics frames until the body has come to rest. */
function settlePhysics() {
  for (let i = 0; i < 2000 && frames.size > 0; i++) {
    clock += 16;
    act(() => { vi.advanceTimersByTime(16); });
    runFrame(clock);
  }
  expect(frames.size).toBe(0);
}

describe("a press the system cancels mid-drag", () => {
  for (const ending of ["pointerCancel", "lostPointerCapture"] as const) {
    it(`drops the mascot through physics, stores where it lands and resumes acting (${ending})`, async () => {
      const onTap = vi.fn();
      const { container } = await mountWalking({ onTap });
      pressAndDrag(root(container));
      expect(frames.size).toBe(0); // held in the air, nothing running
      const x = drawnX(container);
      expect(drawnLift(container)).toBeGreaterThan(400);

      fireEvent[ending](root(container), { pointerId: 1 });
      // The throw starts, exactly as a release starts it.
      expect(frames.size).toBe(1);
      // A browser follows a cancel with `lostpointercapture`: the drop is
      // already under way, and is not started a second time.
      fireEvent.lostPointerCapture(root(container), { pointerId: 1 });
      expect(frames.size).toBe(1);

      settlePhysics();
      expect(drawnLift(container)).toBe(0);
      expect(drawnX(container)).toBeCloseTo(x, 9);
      expect(onTap).not.toHaveBeenCalled();

      // Stored where it landed, once the landing has settled — before the
      // next action moves it again.
      advance(1500);
      expect(posWrites().at(-1)).toBeCloseTo(x, 9);

      // The landing resumes the action loop: the next stroll.
      advance(600);
      expect(frames.size).toBe(1);

      // And a mouse merely passing over it no longer drags it.
      const walking = drawnX(container);
      fireEvent.pointerMove(root(container), { pointerId: 1, clientX: 900, clientY: 200 });
      expect(drawnX(container)).toBe(walking);
    });
  }

  it("wakes a sleeping mascot it drops, as a drag-and-drop does", async () => {
    kvState.store.set(SLEEP_KEY, JSON.stringify(Date.now() + 10 * 60_000));
    const { container } = render(<Mascot />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    advance(600);
    expect(asleep(container)).toBe(true);

    pressAndDrag(root(container));
    fireEvent.pointerCancel(root(container), { pointerId: 1 });
    expect(asleep(container)).toBe(false);
    expect(kvState.store.has(SLEEP_KEY)).toBe(false);
    settlePhysics();
    advance(2100);
    expect(frames.size).toBe(1); // acting again
  });

  it("ignores the cancel of a pointer the press is not following", async () => {
    const { container } = await mountWalking();
    pressAndDrag(root(container));
    // A second finger, cancelled: the first is still dragging.
    fireEvent.pointerCancel(root(container), { pointerId: 2 });
    expect(frames.size).toBe(0);
    fireEvent.pointerMove(root(container), { pointerId: 1, clientX: 700, clientY: 300 });
    const x = drawnX(container);
    expect(x).toBeCloseTo((200 / window.innerWidth) * 100, 9);
    fireEvent.pointerUp(root(container), { pointerId: 1, clientX: 700, clientY: 300 });
    expect(frames.size).toBe(1);
  });
});

describe("a press the system cancels before it moved", () => {
  for (const ending of ["pointerCancel", "lostPointerCapture"] as const) {
    it(`does not open the chat, and the mascot acts again (${ending})`, async () => {
      const onTap = vi.fn();
      const { container } = await mountWalking({ onTap });
      fireEvent.pointerDown(root(container), { button: 0, pointerId: 1, clientX: 500, clientY: 740 });
      expect(frames.size).toBe(0); // the stroll stopped where it stood
      const x = drawnX(container);

      fireEvent[ending](root(container), { pointerId: 1 });
      fireEvent.lostPointerCapture(root(container), { pointerId: 1 });
      // Not a tap: no chat, no line of sass, and no throw.
      expect(onTap).not.toHaveBeenCalled();
      expect(container.querySelector('[data-speech="1"]')).toBeNull();
      expect(frames.size).toBe(0);

      // A mouse merely passing over it does not drag it.
      fireEvent.pointerMove(root(container), { pointerId: 1, clientX: 900, clientY: 200 });
      expect(drawnX(container)).toBe(x);

      // The action loop it interrupted is back: the next stroll.
      advance(1900);
      expect(frames.size).toBe(0);
      advance(200);
      expect(frames.size).toBe(1);
    });
  }

  it("lets a mascot caught mid-throw finish its fall instead of hanging in the air", async () => {
    // A press stops the throw's physics where the mascot is; re-arming only the
    // action loop left it in the air for two seconds and then stepped it off
    // THROUGH whatever it would have landed on.
    const onTap = vi.fn();
    const { container } = await mountWalking({ onTap });
    pressAndDrag(root(container));
    fireEvent.pointerUp(root(container), { button: 0, pointerId: 1, clientX: 600, clientY: 300 });
    // A few frames into the fall: still well off the ground.
    for (let i = 0; i < 5; i++) {
      clock += 16;
      act(() => { vi.advanceTimersByTime(16); });
      runFrame(clock);
    }
    expect(drawnLift(container)).toBeGreaterThan(50);

    fireEvent.pointerDown(root(container), { button: 0, pointerId: 1, clientX: 600, clientY: 300 });
    expect(frames.size).toBe(0); // caught: the physics stopped
    fireEvent.pointerCancel(root(container), { pointerId: 1 });
    // The fall resumes at once, as a release would resume it — not a tap.
    expect(frames.size).toBe(1);
    expect(onTap).not.toHaveBeenCalled();
    settlePhysics();
    expect(drawnLift(container)).toBe(0);
  });

  it("keeps a sleeping mascot asleep, and it still wakes when its nap ends", async () => {
    // The press clears the nap's end — that is what `stateTimeout` holds
    // during a nap — and the action loop does not run while asleep, so
    // re-arming it would have left the mascot asleep for good.
    kvState.store.set(SLEEP_KEY, JSON.stringify(Date.now() + 10 * 60_000));
    const onTap = vi.fn();
    const { container } = render(<Mascot onTap={onTap} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    advance(1000);
    expect(asleep(container)).toBe(true);

    fireEvent.pointerDown(root(container), { button: 0, pointerId: 1, clientX: 500, clientY: 740 });
    fireEvent.pointerCancel(root(container), { pointerId: 1 });
    expect(onTap).not.toHaveBeenCalled();
    expect(asleep(container)).toBe(true);

    // Still asleep just short of the nap's end…
    advanceStepwise(10 * 60_000 - 1000 - 200, 10_000);
    expect(asleep(container)).toBe(true);
    // …and awake right after it, acting a second later.
    advance(400);
    expect(asleep(container)).toBe(false);
    expect(kvState.store.has(SLEEP_KEY)).toBe(false);
    advance(1100);
    expect(frames.size).toBe(1);
  });
});

describe("a normal release", () => {
  it("is a tap, handled once, when the press did not move", async () => {
    const onTap = vi.fn();
    const { container } = await mountWalking({ onTap });
    fireEvent.pointerDown(root(container), { button: 0, pointerId: 1, clientX: 500, clientY: 740 });
    fireEvent.pointerUp(root(container), { button: 0, pointerId: 1, clientX: 500, clientY: 740 });
    // What the browser fires next, once the release has let the capture go.
    fireEvent.lostPointerCapture(root(container), { pointerId: 1 });

    expect(onTap).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-speech="1"]')).not.toBeNull();
    expect(frames.size).toBe(0);
    // The tap's own pause before the next action — 3.5 s — and not a second
    // one armed by the capture going.
    advance(2100);
    expect(frames.size).toBe(0);
    advance(1500);
    expect(frames.size).toBe(1);
  });

  it("drops a dragged mascot once", async () => {
    const onTap = vi.fn();
    const { container } = await mountWalking({ onTap });
    pressAndDrag(root(container));
    const x = drawnX(container);
    fireEvent.pointerUp(root(container), { button: 0, pointerId: 1, clientX: 600, clientY: 300 });
    expect(frames.size).toBe(1);
    fireEvent.lostPointerCapture(root(container), { pointerId: 1 });
    expect(frames.size).toBe(1);

    settlePhysics();
    expect(drawnLift(container)).toBe(0);
    expect(drawnX(container)).toBeCloseTo(x, 9);
    expect(onTap).not.toHaveBeenCalled();
    advance(1500);
    expect(posWrites().at(-1)).toBeCloseTo(x, 9);
    advance(600);
    expect(frames.size).toBe(1);
  });
});

describe("a long touch on the crab", () => {
  it("is the mascot's own press, never the system's image menu or drag", async () => {
    // iOS opens its image sheet (or lifts the picture for a drag) on a held
    // picture, and that cancels the press mid-hold.
    const { container } = await mountWalking();
    const img = container.querySelector('img[src="/clawbox-crab.png"]') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute("draggable")).toBe("false");
    // jsdom drops vendor-prefixed style properties, so the callout is pinned
    // in the source the browser gets.
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const src = fs.readFileSync(`${process.cwd()}/src/components/Mascot.tsx`, "utf8");
    expect(src).toMatch(/touchAction: 'none',\s*(?:\/\/[^\n]*\n\s*)*WebkitTouchCallout: 'none',/);
  });
});
