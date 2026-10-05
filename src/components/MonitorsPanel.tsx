"use client";

/**
 * Settings → Monitors (monitor mode, src/lib/monitors.ts).
 *
 * The row of monitors the desktop is spread over, drawn to scale and in order:
 * drag one left or right (or select it and use the arrows) to say where it
 * stands, pick the main monitor (the shelf, the chat and the icons live there),
 * and set each one's resolution, refresh rate, scale, rotation and variable
 * refresh — or turn it off, or show the same picture on every monitor. Apply
 * puts the layout on screen ON TRIAL: unless Keep is pressed it reverts on its
 * own, so a resolution a monitor cannot show never strands the owner. Identify
 * shows each monitor's number on the monitor itself.
 *
 * Brightness is the one setting outside the layout: where a monitor answers
 * DDC/CI it gets a slider that acts at once (src/lib/monitor-brightness.ts),
 * and where it does not there is simply no slider.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "@/lib/i18n";
import { MONITORS_CHANGED_EVENT, identifyMonitors } from "@/lib/desktop-screens";
import { useDeskScreens } from "@/lib/use-desk-screens";
import { MONITOR_SCALES, logicalSize, type MonitorMode, type MonitorSetting, type MonitorTransform } from "@/lib/monitors-layout";
import type { MonitorStatus, MonitorView } from "@/lib/monitors";

type Draft = { order: string[]; main: string | null; monitors: Record<string, MonitorSetting>; mirror: boolean };
type Brightness = Record<string, { value: number; max: number }>;

/** How often an idle panel looks again, so a monitor plugged in shows up. */
const STATUS_POLL_MS = 5_000;
/** The slowest a dragged brightness slider writes. */
const BRIGHTNESS_THROTTLE_MS = 200;
/** Past a trial's deadline, how often the panel asks whether the box has put the old layout back yet. */
const TRIAL_RECHECK_MS = 1_000;
/**
 * How far this browser's clock may be from the box's before the countdown
 * corrects for it. The box's clock arrives in a response's `Date` header,
 * which is cut to the second, so anything closer than this is noise.
 */
const CLOCK_SKEW_TOLERANCE_MS = 2_000;

/** The four the panel offers. */
const ROTATIONS: MonitorTransform[] = ["normal", "90", "180", "270"];
/**
 * Every transform's name — the mirrored four too, which the panel never offers
 * but the compositor can report (a hand-edited saved layout, a wlr-randr run
 * from a terminal), and which must then be named, not printed as a token.
 */
const ROTATION_KEYS: Record<MonitorTransform, string> = {
  normal: "settings.monitors.rotationNormal",
  "90": "settings.monitors.rotation90",
  "180": "settings.monitors.rotation180",
  "270": "settings.monitors.rotation270",
  flipped: "settings.monitors.rotationMirrored",
  "flipped-90": "settings.monitors.rotation90Mirrored",
  "flipped-180": "settings.monitors.rotation180Mirrored",
  "flipped-270": "settings.monitors.rotation270Mirrored",
};

/**
 * The route's refusal codes, each to the sentence that words it. A fixed table
 * rather than `error.${code}`: the codes are snake_case and the catalogue's
 * keys are camelCase, and a code nobody worded here falls back to the generic
 * sentence instead of to a raw key.
 */
const ERROR_KEYS = new Map<string, string>([
  ["none_enabled", "settings.monitors.error.noneEnabled"],
  ["main_disabled", "settings.monitors.error.mainDisabled"],
  ["unknown_mode", "settings.monitors.error.unknownMode"],
  ["unknown_monitor", "settings.monitors.error.unknownMonitor"],
  ["unavailable", "settings.monitors.error.unavailable"],
  ["apply_failed", "settings.monitors.error.applyFailed"],
  ["apply_uncertain", "settings.monitors.error.applyUncertain"],
  ["save_failed", "settings.monitors.error.saveFailed"],
  ["revert_failed", "settings.monitors.error.revertFailed"],
  ["nothing_pending", "settings.monitors.error.nothingPending"],
  // The brightness route's.
  ["write_failed", "settings.monitors.error.writeFailed"],
  ["unsupported", "settings.monitors.error.unsupported"],
  ["invalid_value", "settings.monitors.error.invalidValue"],
]);

function settingOf(m: MonitorView): MonitorSetting {
  const mode = m.current ?? m.modes.find((x) => x.preferred) ?? m.modes[0];
  const s: MonitorSetting = {
    enabled: m.enabled,
    width: mode?.width ?? 0,
    height: mode?.height ?? 0,
    refresh: mode?.refresh ?? 0,
    scale: m.scale,
    transform: m.transform,
  };
  if (m.adaptiveSync !== null && m.adaptiveSync !== undefined) s.adaptiveSync = m.adaptiveSync;
  return s;
}

function draftOf(status: MonitorStatus): Draft {
  const monitors: Record<string, MonitorSetting> = {};
  for (const m of status.monitors) monitors[m.id] = settingOf(m);
  return { order: [...status.order], main: status.main, monitors, mirror: status.mirror === true };
}

const sameDraft = (a: Draft | null, b: Draft | null) => JSON.stringify(a) === JSON.stringify(b);
const sizeKey = (m: { width: number; height: number }) => `${m.width}x${m.height}`;

/** One entry per resolution, the preferred mode standing for its size. */
function sizesOf(m: MonitorView): MonitorMode[] {
  const seen = new Map<string, MonitorMode>();
  for (const mode of m.modes) {
    const k = sizeKey(mode);
    const had = seen.get(k);
    if (!had || mode.preferred) seen.set(k, mode);
  }
  return [...seen.values()];
}

/** The mode of `m` at `size` whose refresh is closest to `refresh` (its preferred one first). */
function modeAt(m: MonitorView, size: { width: number; height: number }, refresh: number): MonitorMode | null {
  const rates = m.modes.filter((x) => x.width === size.width && x.height === size.height);
  if (rates.length === 0) return null;
  const near = rates
    .filter((x) => Math.abs(x.refresh - refresh) < 0.5)
    .sort((a, b) => Math.abs(a.refresh - refresh) - Math.abs(b.refresh - refresh));
  return near[0] ?? rates.find((x) => x.preferred) ?? rates[0];
}

/**
 * The scale that makes a monitor's text about the size it is on a 24" 1080p
 * screen, from its physical size; null when the monitor does not say.
 */
export function recommendedScale(m: Pick<MonitorView, "physicalSize">, width: number): number | null {
  const mm = m.physicalSize?.width ?? 0;
  if (mm < 100 || width <= 0) return null;
  const dpi = width / (mm / 25.4);
  const want = dpi / 110;
  return MONITOR_SCALES.reduce((best, s) => (Math.abs(s - want) < Math.abs(best - want) ? s : best), MONITOR_SCALES[0]);
}

/** A refusal code from the route, as the owner's words. */
function errorText(t: (k: string) => string, code: string | undefined): string {
  return t((code && ERROR_KEYS.get(code)) || "settings.monitors.error.generic");
}

/**
 * The box's clock minus this browser's, read off a response's `Date` header;
 * 0 when the header is missing or the two agree within the header's own grain.
 * A trial's deadline is the box's time, and a laptop on the LAN whose clock
 * runs half a minute ahead would otherwise count it down to zero at once.
 */
function clockSkew(res: Response): number {
  const header = res.headers?.get?.("date");
  const box = header ? Date.parse(header) : NaN;
  if (!Number.isFinite(box)) return 0;
  // Cut to the second: the box's clock was somewhere in the 1000 ms after it.
  const skew = box + 500 - Date.now();
  return Math.abs(skew) > CLOCK_SKEW_TOLERANCE_MS ? skew : 0;
}

/** A GET answer the panel can draw; anything else (a refusal's `{ error }`, an HTML page) is a failed read. */
function isStatus(body: unknown): body is MonitorStatus {
  const b = body as Partial<MonitorStatus> | null;
  return !!b && typeof b === "object" && typeof b.available === "boolean" && Array.isArray(b.monitors) && Array.isArray(b.order);
}

export default function MonitorsPanel() {
  const { t, locale } = useT();
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  /** The last read failed (network, a refusal, a page that is not JSON) — said only while there is nothing to draw. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<Draft | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** The trial's deadline on THIS browser's clock; null while no layout is on trial. */
  const [trialEnd, setTrialEnd] = useState<number | null>(null);
  const [brightness, setBrightness] = useState<Brightness>({});
  /** See `clockSkew`. */
  const skew = useRef(0);
  /** The layout on trial as the box shows it — what the end of the trial is compared with. */
  const trial = useRef<Draft | null>(null);
  /** Set by an Apply that put a layout on trial: Keep takes the focus once the panel is not busy. */
  const focusKeep = useRef(false);
  // Identify can only reach the monitors from the window spread over them.
  const deskScreens = useDeskScreens();

  const label = useCallback((m: MonitorView | undefined) => (m ? (m.builtIn ? t("settings.monitors.builtIn") : m.label) : ""), [t]);
  const fmt = useMemo(() => ({
    rate: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }),
    percent: new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }),
  }), [locale]);

  /**
   * The box's answer becomes what the panel shows: the status, and a draft and
   * baseline made from it (an unsaved draft is replaced — the callers that
   * adopt over one mean to). Every piece is kept as the SAME object when its
   * contents are what the panel already holds, so the idle panel's look every
   * 5 s, which almost always brings back the same monitors, changes no state
   * and draws nothing: the whole panel (and the canvas's measuring effect, keyed
   * on the status) used to re-render for an identical answer. Equal contents
   * are the only thing skipped — a draft that differs from the answer is still
   * replaced, and an answer that differs in anything at all still lands.
   */
  const adopt = useCallback((next: MonitorStatus) => {
    setStatus((cur) => (cur && JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
    const d = draftOf(next);
    setDraft((cur) => (sameDraft(cur, d) ? cur : d));
    setBaseline((cur) => (sameDraft(cur, d) ? cur : d));
    setSelected((cur) => (cur && next.monitors.some((m) => m.id === cur) ? cur : next.main ?? next.order[0] ?? null));
    if (next.pending) {
      // Fresh with the status, so the first frame of a countdown counts from
      // now. Only a countdown reads `now`, so only a trial's answer sets it.
      setNow(Date.now());
      trial.current = d;
      setTrialEnd(next.pending.deadline - skew.current);
      return;
    }
    if (trial.current) {
      // The trial ended — Keep or Revert here, the box's own timer, or another
      // window. What is on screen now says which, so the notice never claims a
      // revert that did not happen.
      setNotice(t(sameDraft(d, trial.current) ? "settings.monitors.kept" : "settings.monitors.reverted"));
      trial.current = null;
    }
    setTrialEnd(null);
  }, [t]);

  const load = useCallback(async (): Promise<MonitorStatus | null> => {
    try {
      const res = await fetch("/setup-api/monitors", { cache: "no-store" });
      if (!res.ok) throw new Error(`monitors: ${res.status}`);
      const body: unknown = await res.json();
      if (!isStatus(body)) throw new Error("monitors: not a status");
      skew.current = clockSkew(res);
      adopt(body);
      setLoadFailed(false);
      return body;
    } catch {
      // A panel already drawing the monitors keeps them: one missed look is
      // not worth a sentence, and the next one tries again.
      setLoadFailed(true);
      return null;
    } finally {
      setLoading(false);
    }
  }, [adopt]);

  useEffect(() => { void load(); }, [load]);

  const retry = () => {
    setLoading(true);
    void load();
  };

  // An idle panel follows the monitors: one plugged in, unplugged, or changed
  // from another screen shows up without reopening Settings. Never while the
  // owner has unsaved changes, a write is under way, or a layout is on trial.
  const dirty = !sameDraft(draft, baseline);
  const idle = !dirty && !busy && !status?.pending && status?.available === true;
  useEffect(() => {
    if (!idle) return;
    const look = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = setInterval(look, STATUS_POLL_MS);
    window.addEventListener(MONITORS_CHANGED_EVENT, look);
    return () => {
      clearInterval(timer);
      window.removeEventListener(MONITORS_CHANGED_EVENT, look);
    };
  }, [idle, load]);

  // Brightness, read once per set of monitors that are on (a DDC read is slow).
  const onKey = useMemo(() => (status?.monitors ?? []).filter((m) => m.enabled).map((m) => m.id).sort().join(","), [status]);
  useEffect(() => {
    if (!onKey) return;
    let alive = true;
    fetch("/setup-api/monitors/brightness", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { monitors?: Brightness } | null) => {
        if (alive && body?.monitors) setBrightness(body.monitors);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [onKey]);

  // The countdown of a layout on trial. At zero the box puts the old one back,
  // so read it again — and keep reading until the box says the trial is over,
  // since a clock even a little ahead of the box's gets there first.
  useEffect(() => {
    if (trialEnd === null) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    const look = () => {
      void load();
      window.dispatchEvent(new Event(MONITORS_CHANGED_EVENT));
    };
    let recheck: ReturnType<typeof setInterval> | null = null;
    const done = setTimeout(() => {
      look();
      recheck = setInterval(look, TRIAL_RECHECK_MS);
    }, Math.max(0, trialEnd - Date.now()) + 600);
    return () => {
      clearInterval(tick);
      clearTimeout(done);
      if (recheck) clearInterval(recheck);
    };
  }, [trialEnd, load]);

  // Keep, where the owner is: Apply sits at the foot of a panel taller than
  // Settings' window, and the question it raises is at the top.
  const pendingRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (busy || !focusKeep.current) return;
    focusKeep.current = false;
    // Guarded: jsdom ships an Element without it.
    pendingRef.current?.scrollIntoView?.({ block: "nearest" });
    keepRef.current?.focus({ preventScroll: true });
  }, [busy, trialEnd]);

  const post = useCallback(async (body: { action: "apply" | "keep" | "revert"; layout?: Draft }, okNotice: string | null) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/setup-api/monitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const answer = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = (answer as { code?: string }).code;
        if (code === "nothing_pending") {
          // The trial had already ended: its time ran out, or another window
          // decided. Show what is on screen now (`adopt` words what became of
          // the trial); only a Keep that came too late is a failure.
          const before = trial.current;
          const after = await load();
          if (!after) setError(errorText(t, undefined));
          else if (body.action === "keep" && before && !after.pending && !sameDraft(draftOf(after), before)) setError(errorText(t, code));
          return;
        }
        setError(errorText(t, code));
        // A Keep or Revert the box refused leaves the trial where the box
        // says it is (a revert it will try again has a new deadline): read
        // it. Not after a refused Apply, whose answer would replace the draft
        // the owner is still holding — but after one that ran out of time the
        // layout may be on screen ON TRIAL, and only a read shows its Keep.
        if (body.action !== "apply" || code === "apply_uncertain") await load();
        return;
      }
      skew.current = clockSkew(res);
      adopt(answer as MonitorStatus);
      if (body.action === "apply" && (answer as MonitorStatus).pending) focusKeep.current = true;
      if (okNotice) setNotice(okNotice);
      // The layout landed, but a monitor said no to variable refresh.
      if ((answer as MonitorStatus).refusedAdaptiveSync?.length) setError(t("settings.monitors.error.adaptiveSyncRefused"));
      window.dispatchEvent(new Event(MONITORS_CHANGED_EVENT));
    } catch {
      setError(t("settings.monitors.error.generic"));
    } finally {
      setBusy(false);
    }
  }, [adopt, load, t]);

  // ── Brightness: immediate, throttled while the slider moves ──
  const pendingBrightness = useRef<{ id: string; value: number } | null>(null);
  const brightnessTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushBrightness = useCallback(() => {
    brightnessTimer.current = null;
    const p = pendingBrightness.current;
    if (!p) return;
    pendingBrightness.current = null;
    void fetch("/setup-api/monitors/brightness", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ monitor: p.id, value: p.value }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const answer = (await res.json().catch(() => ({}))) as { code?: string };
          setError(errorText(t, answer.code));
        }
      })
      .catch(() => setError(t("settings.monitors.error.writeFailed")));
  }, [t]);
  const changeBrightness = (id: string, value: number, final: boolean) => {
    setBrightness((b) => (b[id] ? { ...b, [id]: { ...b[id], value } } : b));
    pendingBrightness.current = { id, value };
    if (final) {
      if (brightnessTimer.current) clearTimeout(brightnessTimer.current);
      flushBrightness();
    } else if (!brightnessTimer.current) {
      brightnessTimer.current = setTimeout(flushBrightness, BRIGHTNESS_THROTTLE_MS);
    }
  };
  // A move still waiting on the throttle when the panel goes (Settings closed,
  // another section opened) is the owner's last word on the slider, and the
  // monitor must still get it: dropped with the timer, the slider said 70%
  // and the screen stayed where it was. Read through a ref so the cleanup,
  // installed once, calls the newest flush rather than the one from mount.
  const flushBrightnessRef = useRef(flushBrightness);
  useEffect(() => { flushBrightnessRef.current = flushBrightness; }, [flushBrightness]);
  useEffect(() => () => {
    if (!brightnessTimer.current) return;
    clearTimeout(brightnessTimer.current);
    flushBrightnessRef.current();
  }, []);

  const byId = useMemo(() => new Map((status?.monitors ?? []).map((m) => [m.id, m])), [status]);
  const onIds = useMemo(() => (draft ? draft.order.filter((id) => draft.monitors[id]?.enabled && byId.has(id)) : []), [draft, byId]);
  const offIds = useMemo(() => (draft ? draft.order.filter((id) => !draft.monitors[id]?.enabled && byId.has(id)) : []), [draft, byId]);
  const mirror = draft?.mirror === true && onIds.length > 1;
  const sel = selected ? byId.get(selected) ?? null : null;
  const selSetting = selected && draft ? draft.monitors[selected] : null;

  /** Resolutions every monitor that is on can show, biggest first (mirror mode). */
  const commonSizes = useMemo(() => {
    const ons = onIds.map((id) => byId.get(id)).filter((m): m is MonitorView => !!m);
    if (ons.length === 0) return [];
    return sizesOf(ons[0])
      .filter((size) => ons.every((m) => m.modes.some((x) => x.width === size.width && x.height === size.height)))
      .sort((a, b) => b.width * b.height - a.width * a.height);
  }, [onIds, byId]);

  /**
   * An edit begins. Refused while a write is under way: its answer replaces
   * the draft, so an edit made meanwhile would vanish without a word (the
   * controls are disabled then too; this is the keyboard's and the drag's
   * half).
   */
  const touch = () => {
    if (busy) return false;
    setNotice(null);
    setError(null);
    return true;
  };

  const update = (id: string, patch: Partial<MonitorSetting>) => {
    if (!touch()) return;
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d, monitors: { ...d.monitors, [id]: { ...d.monitors[id], ...patch } } };
      // Turned off: it leaves the row (and stops being the main one).
      if (patch.enabled === false && next.main === id) {
        next.main = next.order.find((o) => o !== id && next.monitors[o]?.enabled) ?? null;
      }
      return next;
    });
  };

  /** Mirror mode: one resolution for every monitor that is on. */
  const setMirrorSize = (size: { width: number; height: number }) => {
    if (!touch()) return;
    setDraft((d) => {
      if (!d) return d;
      const monitors = { ...d.monitors };
      for (const id of onIds) {
        const m = byId.get(id);
        const mode = m ? modeAt(m, size, monitors[id].refresh) : null;
        if (mode) monitors[id] = { ...monitors[id], width: mode.width, height: mode.height, refresh: mode.refresh };
      }
      return { ...d, monitors };
    });
  };

  const setMirror = (on: boolean) => {
    if (!touch()) return;
    setDraft((d) => (d ? { ...d, mirror: on } : d));
    // Mirrored monitors show one picture best at one resolution: the biggest
    // they all have.
    if (on && commonSizes[0]) setMirrorSize(commonSizes[0]);
  };

  const move = (id: string, dir: -1 | 1) => {
    if (!touch()) return;
    setDraft((d) => {
      if (!d) return d;
      const on = d.order.filter((o) => d.monitors[o]?.enabled);
      const i = on.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= on.length) return d;
      [on[i], on[j]] = [on[j], on[i]];
      return { ...d, order: [...on, ...d.order.filter((o) => !d.monitors[o]?.enabled)] };
    });
  };

  // ── The row, drawn to scale ──
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasW, setCanvasW] = useState(600);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // A canvas with no width (a hidden pane) keeps the last one it had.
    const measure = () => { if (el.clientWidth > 0) setCanvasW(el.clientWidth); };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [status]);
  const CANVAS_H = 190;
  const sizes = onIds.map((id) => {
    const s = draft!.monitors[id];
    return { id, ...logicalSize(s.width, s.height, s.scale, s.transform) };
  });
  const totalW = mirror ? Math.max(1, ...sizes.map((s) => s.width)) : sizes.reduce((a, s) => a + s.width, 0) || 1;
  const maxH = Math.max(1, ...sizes.map((s) => s.height));
  const factor = Math.min((canvasW - 32) / totalW, (CANVAS_H - 32) / maxH);
  const rowW = totalW * factor;
  let cursor = (canvasW - rowW) / 2;
  const blocks = sizes.map((s, i) => {
    // Mirrored: the monitors are drawn stacked, each a little offset.
    const left = mirror ? (canvasW - s.width * factor) / 2 + i * 10 : cursor;
    const b = { ...s, left, w: s.width * factor - 6, h: s.height * factor, offsetY: mirror ? i * 10 - ((sizes.length - 1) * 10) / 2 : 0 };
    if (!mirror) cursor += s.width * factor;
    return b;
  });
  // Drawn in the order the box last showed, not the draft's: the place is in
  // `left` alone. Re-ordered in the DOM, the block being dragged past its
  // neighbour would be moved out from under the pointer and lose its capture,
  // and a release off the blocks would then never end the drag.
  const shownOrder = status?.order ?? [];
  const drawRank = (id: string, n: number) => {
    const i = shownOrder.indexOf(id);
    return i < 0 ? shownOrder.length + n : i;
  };
  const drawn = blocks
    .map((b, i) => ({ ...b, n: i + 1 }))
    .sort((a, b) => drawRank(a.id, a.n) - drawRank(b.id, b.n));

  // Drag a monitor along the row: it follows the pointer, and the order
  // changes as its centre crosses a neighbour's.
  const drag = useRef<{ id: string; startX: number; pointer: number } | null>(null);
  const [dragDx, setDragDx] = useState<{ id: string; dx: number } | null>(null);
  const onPointerUp = () => {
    drag.current = null;
    setDragDx(null);
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (busy) return;
    setSelected(id);
    if (mirror) return;
    drag.current = { id, startX: e.clientX, pointer: e.pointerId };
    // Guarded: jsdom ships an Element without it.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || !draft) return;
    // No button held: the release landed somewhere this block never heard
    // of. The drag is over, not a hover that goes on moving the monitor.
    if (e.buttons === 0) {
      onPointerUp();
      return;
    }
    const dx = e.clientX - d.startX;
    if (Math.abs(dx) < 4 && !dragDx) return;
    const me = blocks.find((b) => b.id === d.id);
    if (!me) return;
    const centre = me.left + me.w / 2 + dx;
    const others = blocks.filter((b) => b.id !== d.id);
    const index = others.filter((b) => b.left + b.w / 2 < centre).length;
    const current = onIds.indexOf(d.id);
    if (index !== current) {
      if (!touch()) return;
      const on = onIds.filter((o) => o !== d.id);
      on.splice(index, 0, d.id);
      setDraft({ ...draft, order: [...on, ...offIds] });
      // Re-anchor: the block jumped to its new slot.
      const newLeft = (() => {
        let x = (canvasW - rowW) / 2;
        for (const id of on) {
          if (id === d.id) return x;
          x += (sizes.find((s) => s.id === id)?.width ?? 0) * factor;
        }
        return x;
      })();
      d.startX = e.clientX - (me.left + dx - newLeft);
      setDragDx({ id: d.id, dx: e.clientX - d.startX });
      return;
    }
    setDragDx({ id: d.id, dx });
  };

  if (loading) {
    return <div className="text-sm text-[var(--text-secondary)] py-8" data-testid="monitors-loading">{t("settings.monitors.loading")}</div>;
  }
  if (!status && loadFailed) {
    // The box could not be asked (a dropped connection, a session that ran
    // out, a server restarting) — which is not the same as "no monitors".
    return (
      <div className="py-8 space-y-3" data-testid="monitors-load-error">
        <div className="text-sm text-red-300" role="alert">{t("settings.monitors.error.unavailable")}</div>
        <button type="button" onClick={retry} data-testid="monitors-retry"
          className="px-3 py-1.5 rounded-lg text-sm bg-white/10 hover:bg-white/15 text-white border-none cursor-pointer">
          {t("settings.monitors.retry")}
        </button>
      </div>
    );
  }
  if (!status?.available || !draft) {
    return <div className="text-sm text-[var(--text-secondary)] py-8" data-testid="monitors-unavailable">{t("settings.monitors.unavailable")}</div>;
  }

  const preferredSize = (m: MonitorView) => m.modes.find((x) => x.preferred);
  const remaining = trialEnd !== null ? Math.max(0, Math.ceil((trialEnd - now) / 1000)) : 0;
  const recScale = sel && selSetting ? recommendedScale(sel, selSetting.width) : null;
  const selBrightness = sel ? brightness[sel.id] : undefined;
  const selectClass = "mt-1 w-full rounded-lg bg-black/30 border border-white/10 text-sm text-white px-2 py-2";

  return (
    <div className="space-y-5" data-testid="monitors-panel">
      <div>
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">{t("settings.monitors.title")}</h3>
        <p className="text-sm text-[var(--text-secondary)] mt-1 leading-relaxed">{t("settings.monitors.intro")}</p>
      </div>

      {trialEnd !== null && (
        <div ref={pendingRef} className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-4 flex flex-wrap items-center gap-3" data-testid="monitors-pending" role="alertdialog" aria-labelledby="monitors-keep-title" aria-describedby="monitors-keep-body">
          <div className="flex-1 min-w-[200px]">
            <div id="monitors-keep-title" className="text-sm font-semibold text-white">{t("settings.monitors.keepTitle")}</div>
            <div id="monitors-keep-body" className="text-xs text-white/70 mt-0.5">{t("settings.monitors.keepBody").replace("{seconds}", String(remaining))}</div>
          </div>
          <button type="button" disabled={busy} onClick={() => void post({ action: "revert" }, t("settings.monitors.reverted"))}
            className="px-3 py-1.5 rounded-lg text-sm bg-white/10 hover:bg-white/15 text-white border-none cursor-pointer disabled:opacity-50" data-testid="monitors-revert">
            {t("settings.monitors.revert")}
          </button>
          <button type="button" ref={keepRef} disabled={busy} onClick={() => void post({ action: "keep" }, t("settings.monitors.kept"))}
            className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-[var(--coral-bright)] hover:brightness-110 text-white border-none cursor-pointer disabled:opacity-50" data-testid="monitors-keep">
            {t("settings.monitors.keep")}
          </button>
        </div>
      )}

      {/* Disabled while a write is under way: its answer replaces the draft. */}
      <fieldset disabled={busy} className="min-w-0 space-y-5" data-testid="monitors-editor">
        <section className="bg-white/5 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-white">{t("settings.monitors.arrangement")}</div>
              <div className="text-xs text-white/50">{mirror ? t("settings.monitors.mirrorHint") : t("settings.monitors.arrangementHint")}</div>
            </div>
            {/* Only where the numbers can appear — the window spread over two or
                more monitors; a phone, a tab on the LAN, one monitor or a mirror
                would press it to no effect. The monitors are numbered as the
                blocks are (this draft's order, applied or not), so the number
                on a screen is the number on its block. */}
            {deskScreens && (
              <button type="button" onClick={() => identifyMonitors(onIds)}
                className="px-3 py-1.5 rounded-lg text-sm bg-white/10 hover:bg-white/15 text-white border-none cursor-pointer disabled:opacity-40 disabled:cursor-default flex items-center gap-1.5" data-testid="monitors-identify">
                <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">tag</span>
                {t("settings.monitors.identify")}
              </button>
            )}
          </div>
          <div ref={canvasRef} className="relative rounded-lg bg-black/30" style={{ height: CANVAS_H }} data-testid="monitors-canvas" data-mirror={mirror ? "true" : undefined}>
            {drawn.map((b) => {
              const m = byId.get(b.id)!;
              const isSel = selected === b.id;
              const isMain = draft.main === b.id;
              const s = draft.monitors[b.id];
              const dx = dragDx?.id === b.id ? dragDx.dx : 0;
              return (
                <button
                  key={b.id}
                  type="button"
                  data-testid={`monitors-block-${b.n}`}
                  data-monitor-id={b.id}
                  aria-pressed={isSel}
                  aria-label={`${b.n} · ${label(m)} · ${m.name}${isMain ? ` · ${t("settings.monitors.main")}` : ""}`}
                  onPointerDown={(e) => onPointerDown(e, b.id)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                  onLostPointerCapture={onPointerUp}
                  onClick={() => setSelected(b.id)}
                  onKeyDown={(e) => {
                    if (mirror) return;
                    if (e.key === "ArrowLeft") { e.preventDefault(); move(b.id, -1); }
                    if (e.key === "ArrowRight") { e.preventDefault(); move(b.id, 1); }
                  }}
                  className={`absolute flex flex-col items-center justify-center rounded-md border-2 text-white select-none touch-none ${mirror ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"} ${isSel ? "border-[var(--coral-bright)] bg-[var(--coral-bright)]/20" : "border-white/25 bg-white/10 hover:bg-white/15"}`}
                  style={{
                    left: b.left + 3 + dx,
                    top: (CANVAS_H - b.h) / 2 + b.offsetY,
                    width: Math.max(40, b.w),
                    height: b.h,
                    zIndex: dx ? 3 : isSel ? 2 : 1,
                    transition: dx ? "none" : "left 0.15s ease-out, top 0.15s ease-out",
                  }}
                >
                  <span className="text-2xl font-bold leading-none">{b.n}</span>
                  <span className="text-[11px] text-white/80 mt-1 px-1 truncate max-w-full">{label(m)}</span>
                  <span className="text-[10px] text-white/50 px-1 truncate max-w-full">{m.name} · {s.width}×{s.height}</span>
                  {isMain && <span className="mt-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-[var(--coral-bright)] text-white truncate max-w-full">{t("settings.monitors.main")}</span>}
                </button>
              );
            })}
          </div>
          {offIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-2" data-testid="monitors-off">
              <span className="text-xs text-white/50">{t("settings.monitors.offList")}</span>
              {offIds.map((id) => (
                <button key={id} type="button" onClick={() => setSelected(id)} aria-pressed={selected === id}
                  className={`px-2.5 py-1 rounded-full text-xs border cursor-pointer ${selected === id ? "border-[var(--coral-bright)] text-white bg-[var(--coral-bright)]/15" : "border-white/15 text-white/70 bg-white/5"}`}>
                  {label(byId.get(id))} · {byId.get(id)?.name} · {t("settings.monitors.off")}
                </button>
              ))}
            </div>
          )}
          {onIds.length > 1 && (
            <label className="flex items-center justify-between gap-3 cursor-pointer pt-1">
              <span>
                <span className="block text-sm text-white">{t("settings.monitors.mirror")}</span>
                <span className="block text-xs text-white/50">{t("settings.monitors.mirrorDetail")}</span>
              </span>
              <input type="checkbox" role="switch" checked={mirror} data-testid="monitors-mirror"
                onChange={(e) => setMirror(e.target.checked)} className="w-5 h-5 accent-[var(--coral-bright)] cursor-pointer" />
            </label>
          )}
        </section>

        {sel && selSetting ? (
          <section className="bg-white/5 rounded-xl p-4 space-y-4" data-testid="monitors-detail">
            <div className="flex flex-wrap items-center gap-2">
              <span className="material-symbols-rounded text-white/70" style={{ fontSize: 22 }} aria-hidden="true">desktop_windows</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-white truncate">{label(sel)}</div>
                <div className="text-xs text-white/50">{t("settings.monitors.port").replace("{port}", sel.name)}</div>
              </div>
              {selSetting.enabled && onIds.length > 1 && !mirror && (
                <div className="flex gap-1">
                  <button type="button" aria-label={t("settings.monitors.moveLeft")} title={t("settings.monitors.moveLeft")} disabled={onIds.indexOf(sel.id) <= 0}
                    onClick={() => move(sel.id, -1)} className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/15 text-white border-none cursor-pointer disabled:opacity-30 flex items-center justify-center" data-testid="monitors-move-left">
                    <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">arrow_back</span>
                  </button>
                  <button type="button" aria-label={t("settings.monitors.moveRight")} title={t("settings.monitors.moveRight")} disabled={onIds.indexOf(sel.id) >= onIds.length - 1}
                    onClick={() => move(sel.id, 1)} className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/15 text-white border-none cursor-pointer disabled:opacity-30 flex items-center justify-center" data-testid="monitors-move-right">
                    <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">arrow_forward</span>
                  </button>
                </div>
              )}
            </div>

            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <span className="text-sm text-white">{t("settings.monitors.use")}</span>
              <input type="checkbox" role="switch" checked={selSetting.enabled} data-testid="monitors-enabled"
                onChange={(e) => update(sel.id, { enabled: e.target.checked })} className="w-5 h-5 accent-[var(--coral-bright)] cursor-pointer" />
            </label>

            {selSetting.enabled && selBrightness && (
              <label className="block" data-testid="monitors-brightness-row">
                <span className="flex items-center justify-between text-xs text-white/60">
                  <span>{t("settings.monitors.brightness")}</span>
                  <span>{fmt.percent.format(selBrightness.max > 0 ? selBrightness.value / selBrightness.max : 0)}</span>
                </span>
                <input type="range" min={0} max={selBrightness.max} step={1} value={selBrightness.value} data-testid="monitors-brightness"
                  aria-label={t("settings.monitors.brightness")}
                  onChange={(e) => changeBrightness(sel.id, Number(e.target.value), false)}
                  onPointerUp={(e) => changeBrightness(sel.id, Number((e.target as HTMLInputElement).value), true)}
                  onKeyUp={(e) => changeBrightness(sel.id, Number((e.target as HTMLInputElement).value), true)}
                  className="mt-2 w-full accent-[var(--coral-bright)] cursor-pointer" />
              </label>
            )}

            {selSetting.enabled && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm text-white">{draft.main === sel.id ? t("settings.monitors.isMain") : t("settings.monitors.makeMain")}</div>
                    <div className="text-xs text-white/50">{t("settings.monitors.mainHint")}</div>
                  </div>
                  {draft.main !== sel.id && (
                    <button type="button" onClick={() => { if (touch()) setDraft({ ...draft, main: sel.id }); }}
                      className="px-3 py-1.5 rounded-lg text-sm bg-white/10 hover:bg-white/15 text-white border-none cursor-pointer" data-testid="monitors-make-main">
                      {t("settings.monitors.makeMain")}
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs text-white/60">{t("settings.monitors.resolution")}</span>
                    {mirror ? (
                      <select value={sizeKey(selSetting)} data-testid="monitors-resolution"
                        onChange={(e) => {
                          const [w, h] = e.target.value.split("x").map(Number);
                          setMirrorSize({ width: w, height: h });
                        }}
                        className={selectClass}>
                        {!commonSizes.some((m) => sizeKey(m) === sizeKey(selSetting)) && (
                          <option value={sizeKey(selSetting)}>{`${selSetting.width} × ${selSetting.height}`}</option>
                        )}
                        {commonSizes.map((m) => (
                          <option key={sizeKey(m)} value={sizeKey(m)}>{`${m.width} × ${m.height}`}</option>
                        ))}
                      </select>
                    ) : (
                      <select value={sizeKey(selSetting)} data-testid="monitors-resolution"
                        onChange={(e) => {
                          const [w, h] = e.target.value.split("x").map(Number);
                          const pick = modeAt(sel, { width: w, height: h }, selSetting.refresh);
                          if (pick) update(sel.id, { width: pick.width, height: pick.height, refresh: pick.refresh });
                        }}
                        className={selectClass}>
                        {sizesOf(sel).map((m) => {
                          const size = `${m.width} × ${m.height}`;
                          const pref = preferredSize(sel);
                          const isPref = pref && pref.width === m.width && pref.height === m.height;
                          return <option key={sizeKey(m)} value={sizeKey(m)}>{isPref ? t("settings.monitors.recommended").replace("{size}", size) : size}</option>;
                        })}
                      </select>
                    )}
                    {mirror && commonSizes.length === 0 && (
                      <span className="block text-xs text-amber-200/80 mt-1">{t("settings.monitors.mirrorNoCommon")}</span>
                    )}
                  </label>
                  <label className="block">
                    <span className="text-xs text-white/60">{t("settings.monitors.refresh")}</span>
                    <select value={String(selSetting.refresh)} data-testid="monitors-refresh"
                      onChange={(e) => update(sel.id, { refresh: Number(e.target.value) })}
                      className={selectClass}>
                      {sel.modes.filter((m) => m.width === selSetting.width && m.height === selSetting.height).map((m) => (
                        <option key={m.refresh} value={String(m.refresh)}>{t("settings.monitors.hz").replace("{rate}", fmt.rate.format(m.refresh))}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs text-white/60">{t("settings.monitors.scale")}</span>
                    <select value={String(selSetting.scale)} data-testid="monitors-scale"
                      onChange={(e) => update(sel.id, { scale: Number(e.target.value) })}
                      className={selectClass}>
                      {[...new Set<number>([...MONITOR_SCALES, selSetting.scale])].sort((a, b) => a - b).map((s) => {
                        const pct = fmt.percent.format(s);
                        return <option key={s} value={String(s)}>{s === recScale ? t("settings.monitors.recommended").replace("{size}", pct) : pct}</option>;
                      })}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs text-white/60">{t("settings.monitors.rotation")}</span>
                    <select value={selSetting.transform} data-testid="monitors-rotation"
                      onChange={(e) => update(sel.id, { transform: e.target.value as MonitorTransform })}
                      className={selectClass}>
                      {ROTATIONS.map((r) => <option key={r} value={r}>{t(ROTATION_KEYS[r])}</option>)}
                      {!ROTATIONS.includes(selSetting.transform) && (
                        <option value={selSetting.transform}>{ROTATION_KEYS[selSetting.transform] ? t(ROTATION_KEYS[selSetting.transform]) : selSetting.transform}</option>
                      )}
                    </select>
                  </label>
                </div>

                {selSetting.adaptiveSync !== undefined && (
                  <label className="flex items-center justify-between gap-3 cursor-pointer">
                    <span>
                      <span className="block text-sm text-white">{t("settings.monitors.adaptiveSync")}</span>
                      <span className="block text-xs text-white/50">{t("settings.monitors.adaptiveSyncHint")}</span>
                    </span>
                    <input type="checkbox" role="switch" checked={selSetting.adaptiveSync} data-testid="monitors-adaptive-sync"
                      onChange={(e) => update(sel.id, { adaptiveSync: e.target.checked })} className="w-5 h-5 accent-[var(--coral-bright)] cursor-pointer" />
                  </label>
                )}
              </>
            )}
          </section>
        ) : (
          <div className="text-sm text-[var(--text-secondary)]">{t("settings.monitors.selectHint")}</div>
        )}
      </fieldset>

      {error && <div className="text-sm text-red-300" role="alert" data-testid="monitors-error">{error}</div>}
      {notice && !error && <div className="text-sm text-emerald-300" role="status" data-testid="monitors-notice">{notice}</div>}

      <div className="flex flex-wrap justify-end gap-2">
        {dirty && (
          <button type="button" disabled={busy} onClick={() => { setDraft(baseline); setError(null); }}
            className="px-3 py-2 rounded-lg text-sm bg-white/10 hover:bg-white/15 text-white border-none cursor-pointer disabled:opacity-50" data-testid="monitors-undo">
            {t("settings.monitors.undo")}
          </button>
        )}
        <button type="button" disabled={!dirty || busy}
          onClick={() => void post({ action: "apply", layout: draft }, null)}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--coral-bright)] hover:brightness-110 text-white border-none cursor-pointer disabled:opacity-40 disabled:cursor-default" data-testid="monitors-apply">
          {busy ? t("settings.monitors.applying") : t("settings.monitors.apply")}
        </button>
      </div>
    </div>
  );
}
