// What the mascot costs on the main thread — the desktop performance pass,
// round 2.
//
//   - Resting (the idle bob, sleep's breathing and Zs, the power stance's
//     rings and sparks) is stepped by a timer. A step used to ask every
//     animation whether it was paused before writing its time, and reading a
//     CSS animation's state flushes style: with a write between two reads that
//     was one style recalc per animation per step. A step now only WRITES, to
//     the resting animations looked up once per commit — and steps from the
//     moment the mascot is drawn, which on a fresh page and after a reload in
//     the middle of a nap it did not.
//   - A stroll is a Web Animation the compositor runs, not a 60 Hz frame loop.
//     It is built from the stroll's own formula, every interrupt leaves the
//     body where the animation's clock has it, and anything that needs the
//     frames (a resize, a turn, a pet's bubble) hands the stroll to them at the
//     time the animation had reached. jsdom has no Web Animations, so these
//     suites stand one in; mascot-position-save.test.tsx covers the frames.
//   - The context menu draws no backdrop blur under its opaque fill.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@/tests/helpers/test-utils";
import Mascot, { AMBIENT_ANIMATIONS, AMBIENT_FPS, WALK_KEYFRAMES, walkKeyframes, walkXAt, type WalkPlan } from "@/components/Mascot";

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

// requestAnimationFrame by hand. Ids far above the fake timers' own: the
// mascot clears a walk with `clearInterval` as well as `cancelAnimationFrame`.
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

/** Pick the n-th action of MASCOT_ACTIONS: waddle 45, idle 15, jump 5, celebrate 3, sleep 12, … of 105. */
const ACTION_SHARE = { waddle: 0, idle: 50 / 105 } as const;

beforeEach(() => {
  kvState.store.clear();
  kvState.sets.length = 0;
  kvState.flushes = 0;
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
  vi.spyOn(Math, "random").mockReturnValue(ACTION_SHARE.waddle);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations;
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
});

async function mount(props: Parameters<typeof Mascot>[0] = {}) {
  const view = render(<Mascot {...props} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return view;
}

function advance(ms: number) {
  act(() => { clock += ms; vi.advanceTimersByTime(ms); });
}

/** Advance in small slices, so each timer that fires reads its own time. */
function advanceStepwise(ms: number, slice = 10) {
  for (let done = 0; done < ms; done += slice) advance(Math.min(slice, ms - done));
}

function root(container: HTMLElement) {
  return container.querySelector("[data-mascot]") as HTMLElement | null;
}

/** The x (in vw) the root's own style draws it at. */
function drawnX(container: HTMLElement): number {
  const m = /translateX\(calc\(([\d.]+)vw/.exec(root(container)?.style.transform ?? "");
  if (!m) throw new Error(`no x in ${root(container)?.style.transform}`);
  return Number(m[1]);
}

// ── A stand-in for CSS animations, as `getAnimations()` hands them out ──

interface FakeCssAnimation {
  animationName: string;
  readonly playState: string;
  currentTime: number | null;
}

const steps = {
  reads: 0,
  lookups: 0,
  writes: new Map<string, number[]>(),
  /** What the mascot's root carries right now, by animation name. */
  names: [] as string[],
};

function fakeCssAnimation(name: string): FakeCssAnimation {
  return {
    animationName: name,
    // Reading a CSS animation's state flushes style in a browser.
    get playState() { steps.reads++; return "paused"; },
    get currentTime() { return null; },
    set currentTime(v: number | null) {
      const list = steps.writes.get(name) ?? [];
      list.push(v as number);
      steps.writes.set(name, list);
    },
  };
}

function installGetAnimations() {
  steps.reads = 0;
  steps.lookups = 0;
  steps.writes.clear();
  (HTMLElement.prototype as unknown as { getAnimations: (o?: unknown) => unknown[] }).getAnimations = function (this: HTMLElement) {
    if (!this.hasAttribute("data-mascot")) return [];
    steps.lookups++;
    return steps.names.map(fakeCssAnimation);
  };
}

const writesTo = (name: string) => steps.writes.get(name)?.length ?? 0;

describe("the resting mascot's steps", () => {
  beforeEach(() => {
    // Nothing but resting: the first action is idle, and the next one is far off.
    vi.spyOn(Math, "random").mockReturnValue(ACTION_SHARE.idle);
    installGetAnimations();
  });

  it("only writes, to the resting animations, looked up once per commit and never per step", async () => {
    // The body's bob, and two animations that run and must never be seeked:
    // the bubble's pop and a damage number's float.
    steps.names = ["mascot-idle", "speech-pop", "damage-float"];
    const { container } = await mount();
    expect(root(container)).not.toBeNull();

    const lookupsBefore = steps.lookups;
    advanceStepwise(1000);
    // Steps from the moment it is drawn: ~15 of them in a second.
    expect(writesTo("mascot-idle")).toBeGreaterThanOrEqual(AMBIENT_FPS - 1);
    expect(writesTo("speech-pop")).toBe(0);
    expect(writesTo("damage-float")).toBe(0);
    // No state was read, and a second of steps took no new lookup.
    expect(steps.reads).toBe(0);
    expect(steps.lookups).toBe(lookupsBefore);
    // Each step is the time since the rest began, rising.
    const times = steps.writes.get("mascot-idle")!;
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
  });

  it("finds the new animations after a commit — the nap's breathing and its Zs, on a page reloaded mid-nap", async () => {
    // Asleep for another ten minutes when the page loads: the nap resumes
    // half a second in, and its animations replace the bob.
    kvState.store.set("clawbox-mascot-sleep", JSON.stringify(Date.now() + 10 * 60_000));
    steps.names = ["mascot-idle"];
    await mount();
    advance(300);
    expect(writesTo("mascot-idle")).toBeGreaterThan(0);

    steps.names = ["mascot-sleep", "zzz-float", "zzz-float", "zzz-float"];
    advance(400); // the nap resumes at 500 ms
    const sleepAt = writesTo("mascot-sleep");
    const zAt = writesTo("zzz-float");
    advance(1000);
    expect(writesTo("mascot-sleep") - sleepAt).toBeGreaterThanOrEqual(AMBIENT_FPS - 1);
    expect(writesTo("zzz-float") - zAt).toBeGreaterThanOrEqual(3 * (AMBIENT_FPS - 1));
    expect(steps.reads).toBe(0);
  });

  it("seeks nothing once the rest is over", async () => {
    steps.names = ["mascot-idle", "power-ring", "zzz-float"];
    const view = await mount();
    advance(500);
    expect(writesTo("mascot-idle")).toBeGreaterThan(0);

    // Thinking is not resting: the rings and Zs run again, and a step that
    // seeked them would jump them.
    view.rerender(<Mascot thinking />);
    const before = new Map([...steps.writes].map(([k, v]) => [k, v.length]));
    advance(1000);
    for (const [name, n] of before) expect(steps.writes.get(name)!.length, name).toBe(n);
  });

  it("names every animation the render pauses for the rest", async () => {
    // A resting animation missing from the set would sit frozen at its first
    // frame: every `${restPlay}` site's animation, and the resting bodies.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../../components/Mascot.tsx"), "utf8");
    const paused = [...src.matchAll(/animation: `([a-z-]+) [^`]*\$\{restPlay\}`/g)].map((m) => m[1]);
    expect(paused.length).toBeGreaterThanOrEqual(3);
    for (const name of [...paused, "mascot-idle", "mascot-sleep", "mascot-powerup"]) {
      expect(AMBIENT_ANIMATIONS.has(name), name).toBe(true);
    }
    // And nothing the mascot runs while it is NOT resting.
    for (const name of ["mascot-waddle", "mascot-thinking", "speech-pop", "think-dot", "damage-float", "money-rain", "frenzy-ring"]) {
      expect(AMBIENT_ANIMATIONS.has(name), name).toBe(false);
    }
  });
});

// ── A stand-in for Web Animations: what the stroll asks the compositor for ──

class FakeAnimation {
  currentTime: number | null = 0;
  startTime: number | null;
  cancelled = false;
  onfinish: (() => void) | null = null;
  constructor(public keyframes: Keyframe[], public options: KeyframeAnimationOptions, public target: HTMLElement) {
    this.startTime = clock;
  }
  cancel() { this.cancelled = true; }
  /** The browser reaching the end: the clock at the duration, then `finish`. */
  finish() {
    this.currentTime = Number(this.options.duration);
    act(() => { this.onfinish?.(); });
  }
}

let animations: FakeAnimation[] = [];
function installAnimate() {
  animations = [];
  (HTMLElement.prototype as unknown as { animate: (k: Keyframe[], o: KeyframeAnimationOptions) => unknown }).animate = function (this: HTMLElement, k, o) {
    const a = new FakeAnimation(k, o, this);
    animations.push(a);
    return a;
  };
}

/**
 * The stroll the compositor is drawing now. (A fresh page runs two action
 * timers, at 1 s and 2 s — the unfreeze and the mount each arm one — so the
 * first stroll is stopped and a second started from where it stood.)
 */
function liveStroll(): FakeAnimation {
  const live = animations.filter((a) => !a.cancelled);
  expect(live).toHaveLength(1);
  return live[0];
}

/** The x (vw) a keyframe draws. */
const keyframeX = (k: Keyframe) => Number(/translateX\(calc\(([-\d.e]+)vw/.exec(String(k.transform))![1]);

const CRAB_LANE = { min: 5, max: 88 };
/** The first stroll of a fresh page in this suite: 90 px to the left, the 2.5 s floor. */
const firstStroll = (): WalkPlan => ({ startX: 85, target: 85 - (90 / window.innerWidth) * 100, ms: 2500 });

describe("a stroll the compositor draws", () => {
  beforeEach(() => { installAnimate(); });

  it("is one Web Animation through the stroll's own formula, with no frame loop", async () => {
    const { container } = await mount();
    const before = root(container)!.style.transform;
    advance(2000);

    const anim = liveStroll();
    expect(anim.target).toBe(root(container));
    expect(frames.size).toBe(0);
    expect(anim.options).toMatchObject({ duration: 2500, easing: "linear", fill: "forwards" });

    const plan = firstStroll();
    expect(anim.keyframes.length).toBeGreaterThanOrEqual(WALK_KEYFRAMES + 1);
    expect(anim.keyframes[0].offset).toBe(0);
    expect(anim.keyframes.at(-1)!.offset).toBe(1);
    for (const k of anim.keyframes) {
      expect(keyframeX(k)).toBeCloseTo(walkXAt(CRAB_LANE, plan, Number(k.offset) * plan.ms), 9);
      // Facing the way it walks, standing on its floor.
      expect(String(k.transform)).toMatch(/translateY\(0\.00px\) scaleX\(-1\)$/);
    }
    // The element's own style is untouched while the animation draws it…
    advance(1000);
    expect(root(container)!.style.transform).toBe(before.replace("scaleX(1)", "scaleX(-1)"));
    expect(posWrites()).toEqual([]);
  });

  it("ends on its target, written into the element, and is stored once it settles", async () => {
    const { container } = await mount();
    advance(2000);
    const anim = liveStroll();
    anim.finish();

    expect(anim.cancelled).toBe(true);
    expect(drawnX(container)).toBeCloseTo(firstStroll().target, 9);
    expect(frames.size).toBe(0);
    advance(2000);
    expect(posWrites()).toHaveLength(1);
    expect(posWrites()[0]).toBeCloseTo(firstStroll().target, 9);
  });

  it("is not stored while it is still under way", async () => {
    await mount();
    advance(2000);
    // Longer than a settle period: the stroll is still moving.
    advance(1500);
    advance(900);
    expect(posWrites()).toEqual([]);
  });

  it("leaves the body where the animation's clock has it when it is grabbed", async () => {
    const { container } = await mount();
    advance(2000);
    const anim = liveStroll();
    anim.currentTime = 1250;

    fireEvent.pointerDown(root(container)!, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    expect(anim.cancelled).toBe(true);
    // Half-way through the time is half-way along the curve.
    const plan = firstStroll();
    expect(drawnX(container)).toBeCloseTo((plan.startX + plan.target) / 2, 9);
    expect(frames.size).toBe(0);
  });

  it("stops where it is when the chat opens", async () => {
    const view = await mount();
    advance(2000);
    const anim = liveStroll();
    anim.currentTime = 600;
    view.rerender(<Mascot frozen />);
    expect(anim.cancelled).toBe(true);
    expect(drawnX(view.container)).toBeCloseTo(walkXAt(CRAB_LANE, firstStroll(), 600), 9);
    advance(2000);
    expect(posWrites()).toHaveLength(1);
    expect(posWrites()[0]).toBeCloseTo(walkXAt(CRAB_LANE, firstStroll(), 600), 9);
  });

  it("is stored at once — and sent — when the page goes away in the middle of it", async () => {
    await mount();
    advance(2000);
    liveStroll().currentTime = 1000;

    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(posWrites()).toHaveLength(1);
    expect(posWrites()[0]).toBeCloseTo(walkXAt(CRAB_LANE, firstStroll(), 1000), 9);
    expect(kvState.flushes).toBe(1);
  });

  it("is stored when the mascot unmounts in the middle of it", async () => {
    const { unmount } = await mount();
    advance(2000);
    liveStroll().currentTime = 800;
    unmount();
    expect(posWrites()).toHaveLength(1);
    expect(posWrites()[0]).toBeCloseTo(walkXAt(CRAB_LANE, firstStroll(), 800), 9);
  });

  it("tells a keyboard tap where the body is now, not where the stroll began", async () => {
    const onTap = vi.fn();
    const { container } = await mount({ onTap });
    advance(2000);
    liveStroll().currentTime = 2000;
    fireEvent.keyDown(root(container)!, { key: "Enter" });
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap.mock.calls[0][0]).toBeCloseTo(walkXAt(CRAB_LANE, firstStroll(), 2000), 9);
  });

  it("is handed to the frames on a resize, and they carry it on from the animation's own clock", async () => {
    const { container } = await mount();
    advance(2000);
    const anim = liveStroll();
    const plan = firstStroll();
    expect(anim.startTime).toBe(12_000);
    anim.currentTime = 1000;

    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(anim.cancelled).toBe(true);
    expect(drawnX(container)).toBeCloseTo(walkXAt(CRAB_LANE, plan, 1000), 9);
    expect(frames.size).toBe(1);

    // A frame's timestamp is on the animation's timeline: 1.5 s in.
    runFrame(12_000 + 1500);
    expect(drawnX(container)).toBeCloseTo(walkXAt(CRAB_LANE, plan, 1500), 9);
    for (let t = 1516; t <= 2600; t += 16) runFrame(12_000 + t);
    expect(frames.size).toBe(0);
    expect(drawnX(container)).toBeCloseTo(plan.target, 9);
    // And a further resize, with nothing animated, hands nothing over.
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(frames.size).toBe(0);
  });
});

describe("a pet's stroll", () => {
  beforeEach(() => { installAnimate(); });

  it("goes on as frames once its bubble is up — only the frames keep the bubble on screen", async () => {
    const bar = document.createElement("div");
    bar.setAttribute("data-mascot-ground", "");
    bar.getBoundingClientRect = () => ({
      top: 700, bottom: 756, left: 0, right: 1000, width: 1000, height: 56, x: 0, y: 700, toJSON: () => ({}),
    }) as DOMRect;
    document.body.appendChild(bar);
    try {
      vi.stubGlobal("fetch", (url: string) => String(url).startsWith("/setup-api/pets")
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ supported: true, edition: "hermes", enabled: true, active: {
          slug: "boba", displayName: "Boba", submittedBy: "railly", revision: "123:456",
          frameW: 192, frameH: 208, cols: 8, rows: 9, framesPerState: 6, loopMs: 1100,
        } }) } as Response)
        : Promise.reject(new TypeError("offline")));
      const { invalidatePetStatus } = await import("@/lib/pet-client");
      invalidatePetStatus();
      const { container } = await mount();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(container.querySelector("[data-pet]")).not.toBeNull();

      advance(2000);
      const hit = container.querySelector("[data-mascot-hit]") as HTMLElement;
      const live = () => animations.filter((a) => !a.cancelled);
      if (!container.querySelector('[data-speech="1"]')) {
        // Not speaking yet: the compositor has the stroll. Make it speak.
        expect(live()).toHaveLength(1);
        live()[0].currentTime = 900;
        fireEvent.keyDown(root(container)!, { key: "Enter" });
      }
      expect(container.querySelector('[data-speech="1"]')).not.toBeNull();
      expect(animations.length).toBeGreaterThanOrEqual(1);
      expect(live()).toHaveLength(0);
      expect(frames.size).toBeGreaterThanOrEqual(1);
      expect(hit).toBeTruthy();
    } finally {
      bar.remove();
    }
  });
});

describe("walkKeyframes", () => {
  const transformAt = (x: number) => `translateX(calc(${x}vw - 50%)) translateY(0.00px) scaleX(1)`;

  it("follows the curve to within a hundredth of a pixel on the longest stroll", () => {
    // 280 px on a 1920 desktop, over the 12 s ceiling.
    const plan: WalkPlan = { startX: 20, target: 20 + (280 / 1920) * 100, ms: 6667 };
    const ks = walkKeyframes(CRAB_LANE, plan, transformAt);
    let worst = 0;
    for (let i = 0; i <= 10_000; i++) {
      const o = i / 10_000;
      const j = Math.max(0, ks.findIndex((k) => Number(k.offset) >= o) - 1);
      const a = ks[j], b = ks[Math.min(j + 1, ks.length - 1)];
      const f = Number(b.offset) === Number(a.offset) ? 0 : (o - Number(a.offset)) / (Number(b.offset) - Number(a.offset));
      const drawn = keyframeX(a) + (keyframeX(b) - keyframeX(a)) * f;
      worst = Math.max(worst, Math.abs(drawn - walkXAt(CRAB_LANE, plan, o * plan.ms)) * 19.2);
    }
    expect(worst).toBeLessThan(0.01);
  });

  it("holds a body thrown past the lane at its edge, and turns the corner on a keyframe of its own", () => {
    const plan: WalkPlan = { startX: 91, target: 70, ms: 5000 };
    const ks = walkKeyframes(CRAB_LANE, plan, transformAt);
    expect(keyframeX(ks[0])).toBe(88);
    // The moment the curve comes back inside is a keyframe, exactly on the edge.
    const r = (88 - 91) / (70 - 91);
    const corner = ks.find((k) => Math.abs(Number(k.offset) - Math.sqrt(r / 2)) < 1e-12);
    expect(corner).toBeDefined();
    expect(keyframeX(corner!)).toBeCloseTo(88, 9);
    for (const k of ks) expect(keyframeX(k)).toBeCloseTo(walkXAt(CRAB_LANE, plan, Number(k.offset) * plan.ms), 9);
    expect(keyframeX(ks.at(-1)!)).toBe(70);
  });
});

describe("the mascot's context menu", () => {
  it("draws no backdrop blur under its opaque fill", async () => {
    const { container } = await mount();
    fireEvent.contextMenu(root(container)!);
    const menu = document.querySelector('[data-testid="mascot-context-menu"]') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.className).toContain("bg-[#2d2d2d]");
    expect(menu.className).not.toMatch(/backdrop-blur/);
    expect(menu.getAttribute("style") ?? "").not.toMatch(/backdrop/);
  });
});
