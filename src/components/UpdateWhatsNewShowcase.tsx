"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent, type ReactNode, type TouchEvent } from "react";

/** The panel's `tr`: the catalogue's text, else the English floor — never the raw key. */
export type Floor = (key: string, english: string, params?: Record<string, string>) => string;

/** One highlight of the release, already in the owner's language. */
export interface ShowcaseItem {
  /** The catalogue's title key: what picks the feature's live demo. */
  key: string;
  title: string;
  body: string;
  /** The full-resolution screenshot (`fullImage`, 16:10) from public/. */
  image: string;
}

/** How long one feature stays on screen before the next. */
export const SHOWCASE_ADVANCE_MS = 7500;
/** One letter of the title per this many ms. */
export const SHOWCASE_TYPE_MS = 34;
/** The live demo's timeline, the keyframes' `7s`: it settles before the next feature comes. */
const DEMO_MS = 7000;
/**
 * Below this width of its own the showcase is laid out for a small screen:
 * the text over the screenshot, and the screenshot cropped to the action
 * instead of shrunk whole. Settings → System Update's pane is 672 px; the
 * desktop's /updating panel (728 px) keeps its two columns.
 */
export const SHOWCASE_NARROW_PX = 704;
/** A phone or a small window — a landscape phone too — is laid out narrow whatever the showcase's own width. */
export const SHOWCASE_COMPACT_VIEWPORT = "(max-width: 1023.98px), (max-height: 500px)";
/** A touch that moves less than this is a tap; one that moves at least `SWIPE_PX` sideways is a swipe. */
const TAP_SLOP_PX = 10;
const SWIPE_PX = 40;
/** A touch held longer than this is not a tap. */
const TAP_MS = 600;
/** The mouse events a browser makes up after a tap come within this long of it: they are not a pointer hovering. */
const TOUCH_MOUSE_MS = 1000;

/*
 * Inline SVG only: this panel stays on screen while the box restarts, and an
 * icon font it had not loaded before the server went down could not be
 * fetched then (a ligature without its font draws its literal name).
 */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {children}
    </svg>
  );
}

const ICONS = {
  shot: <Glyph><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Glyph>,
  browser: <Glyph><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></Glyph>,
  link: <Glyph><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></Glyph>,
  grok: <Glyph><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" /></Glyph>,
  talk: <Glyph><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Glyph>,
  chart: <Glyph><rect x="9" y="3" width="6" height="5" rx="1" /><rect x="3" y="16" width="6" height="5" rx="1" /><rect x="15" y="16" width="6" height="5" rx="1" /><path d="M12 8v4M6 16v-2h12v2" /></Glyph>,
  wiki: <Glyph><path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM8 7h7M8 11h5" /></Glyph>,
  sparkle: <Glyph><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></Glyph>,
  speaker: <Glyph><path d="M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" /></Glyph>,
  chat: <Glyph><path d="M4 5h16v11H9l-5 4z" /></Glyph>,
  report: <Glyph><path d="M4 5h16v11H9l-5 4z" /><path d="m9 10.5 2 2 4-4" /></Glyph>,
  wait: <Glyph><path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9" /></Glyph>,
  queue: <Glyph><path d="M4 6h10M4 12h10M4 18h6M18 9v10M15 16l3 3 3-3" /></Glyph>,
  bell: <Glyph><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4" /></Glyph>,
};

/* ── prefers-reduced-motion and the screen's size, live ────────────────── */

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function mediaQuery(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(query) ?? null;
}

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const list = mediaQuery(query);
    list?.addEventListener?.("change", onChange);
    return () => list?.removeEventListener?.("change", onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => mediaQuery(query)?.matches === true, () => false);
}

/**
 * The showcase's own width (its container's, which its CSS lays out by), kept
 * up as it changes; null until it has been laid out, which reads as wide.
 * Measured before the first paint, so a phone never sees the wide layout.
 */
function useOwnWidth(element: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setWidth(element.clientWidth > 0 ? element.clientWidth : null);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

/** How many of `at` (ms since mount) have passed; all of them with motion off. */
function useSteps(at: readonly number[], reduced: boolean): number {
  const [passed, setPassed] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const timers = at.map((ms, index) => setTimeout(() => setPassed(index + 1), ms));
    return () => timers.forEach(clearTimeout);
  }, [at, reduced]);
  return reduced ? at.length : passed;
}

/** Letters of a `length`-letter text typed so far: one per `perMs`, from `startMs`; all of it with motion off. */
function useTyping(length: number, startMs: number, perMs: number, reduced: boolean): number {
  const [typed, setTyped] = useState(0);
  useEffect(() => {
    if (reduced || length === 0) return;
    let interval: ReturnType<typeof setInterval> | undefined;
    let count = 0;
    const start = setTimeout(() => {
      interval = setInterval(() => {
        count += 1;
        setTyped(count);
        if (count >= length) clearInterval(interval);
      }, perMs);
    }, startMs);
    return () => {
      clearTimeout(start);
      clearInterval(interval);
    };
  }, [length, startMs, perMs, reduced]);
  return reduced ? length : Math.min(typed, length);
}

/* ── the live demos, in the screenshot's own % space ───────────────────── */

interface DemoProps {
  tr: Floor;
  reduced: boolean;
}

function Cursor({ className = "", color = "#fff", label, light = false }: { className?: string; color?: string; label?: string; light?: boolean }) {
  return (
    <div className={`wns-o wns-cur ${className}`}>
      <svg viewBox="0 0 12 19" aria-hidden="true">
        <path d="M0 0v16.5l4-3.8 2.6 6 2.6-1.1-2.6-5.9H12z" fill={color} stroke="#000" strokeWidth=".8" />
      </svg>
      {label && <span className={`wns-tag${light ? " wns-tag-w" : ""}`}>{label}</span>}
    </div>
  );
}

/** Screenshot: click Region, drag a region with its size, flash, saved. */
function ShotCam() {
  return (
    <>
      <div className="wns-o wns-dim" />
      <div className="wns-o wns-sel" />
      <div className="wns-o wns-sz">1040 × 504</div>
      <div className="wns-o wns-rip" />
      <Cursor />
      <div className="wns-o wns-flash" />
    </>
  );
}

function ShotFrame({ tr }: DemoProps) {
  return (
    <div className="wns-o wns-toast">
      <b>✓ {tr("update.showcase.shotSaved", "Screenshot saved")}</b>
      <small>{tr("update.showcase.shotPath", "Files › Screenshots › Screenshot 2026-11-03 09-41-12.png")}</small>
    </div>
  );
}

/** Agent Browser: the assistant's cursor types in the docs search while yours watches. */
function BrowserCam({ tr, reduced }: DemoProps) {
  const query = Array.from(tr("update.showcase.browserQuery", "switching editions"));
  // Typed between 24% and 52% of the demo, as the box it types in comes up.
  const typed = useTyping(query.length, DEMO_MS * 0.24, (DEMO_MS * 0.28) / Math.max(1, query.length), reduced);
  return (
    <>
      <div className="wns-o wns-live" />
      <div className="wns-o wns-typed"><span>{query.slice(0, typed).join("")}</span></div>
      <div className="wns-o wns-ring" />
      <Cursor className="wns-cur-a" color="#f97316" label={tr("update.showcase.cursorAssistant", "Assistant")} />
      <Cursor className="wns-cur-y" label={tr("update.showcase.cursorYou", "You")} light />
    </>
  );
}

/** Public link: click "Create public link", the link's dialog, "Copied". */
function LinkCam() {
  return (
    <>
      <div className="wns-o wns-ring" />
      <div className="wns-o wns-rip" />
      <Cursor className="wns-cur-1" />
      <Cursor className="wns-cur-2" />
    </>
  );
}

const COPIED_AT = [DEMO_MS * 0.75];

function LinkFrame({ tr, reduced }: DemoProps) {
  const copied = useSteps(COPIED_AT, reduced) > 0;
  return (
    <div className="wns-o wns-toast">
      <b>{ICONS.browser} {tr("update.showcase.linkTitle", "Public link for {app}", { app: "Recipe Book" })}</b>
      <small>{tr("update.showcase.linkNote", "Anyone with the link reaches only this app.")}</small>
      <div className="wns-urlp">
        <span className="wns-url">https://jade-swan.clawbox.tech/a/recipe-book</span>
        <span className="wns-copy">{copied ? `✓ ${tr("update.showcase.linkCopied", "Copied")}` : tr("update.showcase.linkCopy", "Copy")}</span>
      </div>
      <div className="wns-row"><span>{tr("update.showcase.linkExpires", "Expires")}</span><b>{tr("update.showcase.linkExpiresIn", "in 7 days")}</b></div>
      <div className="wns-row"><span>{tr("update.showcase.linkPassword", "Password")}</span><b>{tr("update.showcase.linkPasswordOn", "On")}</b></div>
    </div>
  );
}

/** Model picker: the highlight walks down to xAI Grok, no restart. */
function GrokCam() {
  return (
    <>
      <div className="wns-o wns-hl" />
      <div className="wns-o wns-rip" />
      <Cursor />
    </>
  );
}

function GrokFrame({ tr }: DemoProps) {
  return (
    <div className="wns-o wns-toast">
      <b>✓ {tr("update.showcase.grokSwitched", "Switched to xAI Grok")}</b>
      <small>{tr("update.showcase.grokNoRestart", "No restart — the chat carries on.")}</small>
    </div>
  );
}

/** Hold to talk: F8 held, the waveform, a ticking timer. */
const RECORDING_TICKS = [DEMO_MS * 0.25, DEMO_MS * 0.45, DEMO_MS * 0.65];

function TalkCam({ tr, reduced }: DemoProps) {
  const seconds = 1 + useSteps(RECORDING_TICKS, reduced);
  return (
    <>
      <div className="wns-o wns-tm"><span>{tr("update.showcase.talkRecording", "Recording {time}", { time: `0:0${seconds}` })}</span></div>
      <div className="wns-o wns-wave">{Array.from({ length: 18 }, (_, index) => <i key={index} />)}</div>
      <div className="wns-o wns-mic" />
    </>
  );
}

function TalkFrame({ tr }: DemoProps) {
  return (
    <>
      <div className="wns-o wns-key">
        <span className="wns-kbd">F8</span> <span className="wns-hint">{tr("update.showcase.talkHint", "hold to talk · release to send")}</span>
      </div>
      <div className="wns-o wns-toast">
        <b>{ICONS.speaker} {tr("update.showcase.talkReadAloud", "Replies read aloud")}</b>
        <small>{tr("update.showcase.talkReadAloudNote", "Settings → Voice · several times smaller downloads")}</small>
      </div>
    </>
  );
}

/** Coding Agent: helpers at work, the tester finishes, the counters and the clock move. */
const CHART_TICKS = [0.14, 0.28, 0.42, 0.57, 0.71, 0.85, 1].map((share) => DEMO_MS * share);

function ChartCam({ tr, reduced }: DemoProps) {
  const seconds = 3 + useSteps(CHART_TICKS, reduced);
  return (
    <>
      <div className="wns-o wns-flow" />
      <div className="wns-o wns-spin wns-s1" />
      <div className="wns-o wns-spin wns-s2" />
      <div className="wns-o wns-spin wns-s3" />
      <div className="wns-o wns-done3">✓</div>
      <div className="wns-o wns-tmr">{tr("update.showcase.chartElapsed", "{minutes}m {seconds}s", { minutes: "4", seconds: String(seconds) })}</div>
      <div className="wns-o wns-cn">
        <span>◌ {tr("update.showcase.chartWorking", "Working")} <b>2</b></span>
        <span>✓ {tr("update.showcase.chartDone", "Done")} <b>3</b></span>
      </div>
    </>
  );
}

function ChartFrame({ tr }: DemoProps) {
  return (
    <div className="wns-o wns-toast">
      <b>{ICONS.chat} {tr("update.showcase.chartMessage", "Message the run")}</b>
      <small>{tr("update.showcase.chartMessageText", "“Use the same card style as the home page.”")}</small>
    </div>
  );
}

/** Prime Radiant: facts land, their confidence fills, one is stamped verified. */
function WikiCam({ tr }: DemoProps) {
  return (
    <>
      <div className="wns-o wns-cover wns-c1" />
      <div className="wns-o wns-cover wns-c2" />
      <div className="wns-o wns-cover wns-c3" />
      <div className="wns-o wns-bar wns-b1"><i /></div>
      <div className="wns-o wns-bar wns-b2"><i /></div>
      <div className="wns-o wns-bar wns-b3"><i /></div>
      <div className="wns-o wns-ring" />
      <div className="wns-o wns-ver"><span>✓ {tr("update.showcase.wikiVerified", "Verified")}</span></div>
      <div className="wns-o wns-cnt"><span>1</span></div>
    </>
  );
}

/** Coding runs report back: the run's milestone reaches the chat, then its ending. */
const REPORT_DONE_AT = [DEMO_MS * 0.55];

function ReportCam() {
  return (
    <>
      <div className="wns-o wns-ring wns-r1" />
      <div className="wns-o wns-ring wns-r2" />
    </>
  );
}

function ReportFrame({ tr, reduced }: DemoProps) {
  const done = useSteps(REPORT_DONE_AT, reduced) > 0;
  return (
    <div className="wns-o wns-toast" data-step={done ? "done" : "milestone"}>
      {done ? (
        <>
          <b>{ICONS.report} {tr("update.showcase.reportsDone", "Run finished")}</b>
          <small>{tr("update.showcase.reportsDoneText", "The chat hears it, and the assistant tells you.")}</small>
        </>
      ) : (
        <>
          <b>{ICONS.chat} {tr("update.showcase.reportsMilestone", "Milestone from the run")}</b>
          <small>{tr("update.showcase.reportsMilestoneText", "“First draft is up: three recipe cards.”")}</small>
        </>
      )}
    </div>
  );
}

/** Updates that ask first: the question comes up over a working run, and Cancel waits. */
function BusyCam() {
  return (
    <>
      <div className="wns-o wns-ring" />
      <div className="wns-o wns-hl" />
      <div className="wns-o wns-rip" />
      <Cursor />
    </>
  );
}

function BusyFrame({ tr }: DemoProps) {
  return (
    <div className="wns-o wns-toast">
      <b>{ICONS.wait} {tr("update.showcase.busyWait", "Cancel waits for them")}</b>
      <small>{tr("update.showcase.busyWaitText", "Nothing is stopped mid-task.")}</small>
    </div>
  );
}

/** Local AI installs wait in line: the first one works on, the second waits its turn. */
const QUEUE_TICKS = [0.15, 0.3, 0.45, 0.6, 0.75].map((share) => DEMO_MS * share);
const QUEUE_PERCENT = [8, 23, 41, 57, 72, 86];

function QueueCam({ reduced }: DemoProps) {
  const percent = QUEUE_PERCENT[useSteps(QUEUE_TICKS, reduced)];
  return (
    <>
      <div className="wns-o wns-bar"><i /></div>
      <div className="wns-o wns-pct">{percent}%</div>
      <div className="wns-o wns-ring wns-q1" />
      <div className="wns-o wns-ring wns-q2" />
    </>
  );
}

function QueueFrame({ tr }: DemoProps) {
  return (
    <div className="wns-o wns-toast">
      <b>{ICONS.queue} {tr("update.showcase.queueStarts", "Starts by itself")}</b>
      <small>{tr("update.showcase.queueStartsText", "when the install before it ends")}</small>
    </div>
  );
}

/** Scheduled job alerts: the notice comes in, and Settings → Harness names the job. */
function AlertCam() {
  return (
    <>
      <div className="wns-o wns-ring wns-a1" />
      <div className="wns-o wns-ring wns-a2" />
      <div className="wns-o wns-dot" />
    </>
  );
}

function AlertFrame({ tr }: DemoProps) {
  return (
    <div className="wns-o wns-toast">
      <b>{ICONS.bell} {tr("jobAlerts.notice.failing", "Scheduled job “{name}” failed {count} times in a row.", { name: "Weekly report", count: "2" })}</b>
      <small>{tr("desktop.toast.openSettings", "Open Settings → {section}", { section: tr("settings.harness", "Harness") })}</small>
    </div>
  );
}

interface Feature {
  /** The CSS scene: `wns-<id>` binds the camera and the demo's keyframes. */
  id: string;
  /** The background glow while this feature is on. */
  glow: string;
  chip: [key: string, english: string] | null;
  icon: ReactNode;
  /** Drawn inside the camera, so it zooms with the screenshot. */
  Cam?: (props: DemoProps) => ReactNode;
  /** Drawn over the frame, at a size the zoom does not change. */
  Frame?: (props: DemoProps) => ReactNode;
}

/** The demo of each catalogue highlight, keyed by its title key. */
export const SHOWCASE_FEATURES: Readonly<Record<string, Feature>> = {
  "whatsNew.screenshotTitle": { id: "shot", glow: "#f97316", chip: ["update.showcase.chipScreenshot", "Screenshots"], icon: ICONS.shot, Cam: ShotCam, Frame: ShotFrame },
  "whatsNew.sharedBrowserTitle": { id: "br", glow: "#2dd4bf", chip: ["update.showcase.chipBrowser", "One browser for you"], icon: ICONS.browser, Cam: BrowserCam },
  "whatsNew.publicLinksTitle": { id: "link", glow: "#38bdf8", chip: ["update.showcase.chipPublicLink", "Share an app with a public link"], icon: ICONS.link, Cam: LinkCam, Frame: LinkFrame },
  "whatsNew.grokTitle": { id: "grok", glow: "#a78bfa", chip: ["update.showcase.chipGrok", "xAI Grok"], icon: ICONS.grok, Cam: GrokCam, Frame: GrokFrame },
  "whatsNew.holdToTalkTitle": { id: "talk", glow: "#ef4444", chip: ["update.showcase.chipHoldToTalk", "Hold to talk"], icon: ICONS.talk, Cam: TalkCam, Frame: TalkFrame },
  "whatsNew.agentChartTitle": { id: "chart", glow: "#f59e0b", chip: ["update.showcase.chipCodingAgent", "The Coding Agent"], icon: ICONS.chart, Cam: ChartCam, Frame: ChartFrame },
  "whatsNew.primeRadiantTitle": { id: "wiki", glow: "#facc15", chip: ["update.showcase.chipPrimeRadiant", "Prime Radiant"], icon: ICONS.wiki, Cam: WikiCam },
  "whatsNew.runReportsTitle": { id: "rep", glow: "#22c55e", chip: ["update.showcase.chipRunReports", "Runs report back"], icon: ICONS.report, Cam: ReportCam, Frame: ReportFrame },
  "whatsNew.updateAsksTitle": { id: "busy", glow: "#eab308", chip: ["update.showcase.chipUpdateAsks", "Updates ask first"], icon: ICONS.wait, Cam: BusyCam, Frame: BusyFrame },
  "whatsNew.installQueueTitle": { id: "queue", glow: "#6366f1", chip: ["update.showcase.chipInstallQueue", "Installs wait in line"], icon: ICONS.queue, Cam: QueueCam, Frame: QueueFrame },
  "whatsNew.jobAlertsTitle": { id: "alert", glow: "#f43f5e", chip: ["update.showcase.chipJobAlerts", "Job alerts"], icon: ICONS.bell, Cam: AlertCam, Frame: AlertFrame },
};

/** A highlight a later catalogue adds before it has a demo: its screenshot, still, and its title as the chip. */
const PLAIN: Feature = { id: "plain", glow: "#f97316", chip: null, icon: ICONS.sparkle };

function featureOf(key: string): Feature {
  return SHOWCASE_FEATURES[key] ?? PLAIN;
}

/*
 * The design's own CSS, scoped under `.wns`: the camera, the floating frame
 * and every demo's keyframes. The overlays are placed in the screenshot's %
 * space and their text is sized from the stage's width (1.15cqw), so a demo
 * reads the same in any window size. With motion off every one-shot keyframe
 * is held at its end (the demo's result), the loops stand still, and the
 * camera, the float and the fade-in are dropped.
 *
 * Narrow (`data-layout="narrow"`: a phone, a small window, Settings' pane) the
 * whole screenshot would be a few hundred pixels wide and its text 3–4 px, so
 * it is drawn 880–960 px wide (`--wns-pz`, its text never under 10 px) on a taller stage (1:1 on a
 * phone, 4:3 up to the two columns) and a camera of its own pans it to where
 * the demo is (`--wns-fx`/`--wns-fy`, the point at the stage's centre, clamped
 * so the picture always covers the stage); the demo's overlays are drawn at
 * that size, no word of them under 10 px, its toasts become a band across the
 * stage's foot (Talk's at its head, over nothing it shows). The link demo's
 * second cursor, which points at the dialog's desktop place, is left out.
 * With motion off that camera stands where the demo ends.
 *
 * On /updating, on a computer's screen, the run view's UPDATE_SCREEN_CSS
 * sizes the wide layout by its `.wns-*` marks to fill the column it is given
 * (TASK-2137): the stage is then the largest 16:10 that fits its cell, so the
 * picture grows with the height as well as the width.
 */
const SHOWCASE_CSS = `
@keyframes wns-up{from{opacity:0;transform:translateY(12px)}}
@keyframes wns-blink{50%{opacity:0}}
@keyframes wns-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
.wns-up{animation:wns-up .8s .8s both}
.wns-caret{display:inline-block;width:3px;height:28px;background:#f97316;vertical-align:-4px;margin-left:3px;animation:wns-blink 1s steps(1) infinite}
.wns-float{animation:wns-float 6s ease-in-out infinite}
.wns-scene{container-type:inline-size}
.wns-scr{position:relative;overflow:hidden;width:100%;aspect-ratio:16/10;border-radius:10px;background:#000;box-shadow:0 24px 60px #0008;font-size:1.15cqw;line-height:1.5;color:#e8edf5}
.wns-cam{position:absolute;inset:0;transform-origin:50% 50%}
.wns-cam>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.wns-o{position:absolute;pointer-events:none}
.wns-cur{width:2.1%;aspect-ratio:12/19;z-index:9;filter:drop-shadow(0 2px 3px #000b)}
.wns-cur svg{width:100%;height:100%;display:block}
.wns-tag{position:absolute;left:85%;top:95%;font-weight:700;font-size:.8em;line-height:1.5;padding:.15em .55em;border-radius:9px;white-space:nowrap;background:#f97316;color:#111}
.wns-tag-w{background:#fff}
.wns-rip{width:4%;aspect-ratio:1;border-radius:50%;border:2px solid #f97316;margin:-2% 0 0 -2%;opacity:0}
.wns-ring{border:2px solid #f97316;border-radius:8px;box-shadow:0 0 0 4px #f9731630,0 0 24px #f9731666;opacity:0}
.wns-toast{z-index:10;background:#151d2b;border:1px solid #33435f;border-radius:10px;box-shadow:0 20px 50px #000c;color:#e8edf5;font-size:.95em;padding:1.4% 1.8%;opacity:0}
.wns-toast b{display:flex;align-items:center;gap:.35em;margin-bottom:3px}
.wns-toast small{display:block;color:#8d99ae;font-size:.85em}
.wns-urlp{display:flex;gap:8px;align-items:center;margin-top:8px;background:#0c1320;border:1px solid #2dd4bf;border-radius:999px;padding:5px 10px;font:.85em ui-monospace,monospace;color:#2dd4bf;white-space:nowrap;overflow:hidden}
.wns-kbd{display:inline-block;border:1px solid #475673;border-bottom-width:3px;border-radius:6px;padding:1px 8px;font:700 .95em ui-monospace,monospace;background:#1b2537;color:#e8edf5}
.wns-hint{color:#cbd3e0}
@keyframes wns-rip{0%,21%{opacity:0;transform:scale(.3)}23%{opacity:1}30%{opacity:0;transform:scale(2.4)}100%{opacity:0}}
@keyframes wns-live{70%{box-shadow:0 0 0 12px #22c55e00}}
@keyframes wns-ringon{0%,78%{opacity:0}82%,100%{opacity:1}}
@keyframes wns-stamp{0%,52%{opacity:0;transform:scale(1.8)}56%,100%{opacity:1;transform:none}}
@keyframes wns-cnt{0%,55%{opacity:0}56%,100%{opacity:1}}
@keyframes wns-tkt{0%,80%{opacity:0;transform:translateY(-20%)}86%,100%{opacity:1;transform:none}}

.wns-shot .wns-cam{animation:wns-shotcam 7s ease-in-out both}
@keyframes wns-shotcam{0%{transform:none}18%,38%{transform:scale(1.35) translate(-14%,15%)}52%,100%{transform:none}}
.wns-shot .wns-cur{left:40%;top:60%;animation:wns-shotcur 7s ease-in-out both}
@keyframes wns-shotcur{0%{left:40%;top:60%}18%,24%{left:70%;top:33%}46%{left:22%;top:20%}60%,100%{left:76%;top:62%}}
.wns-shot .wns-rip{left:70%;top:33%;animation:wns-rip 7s both}
.wns-shot .wns-dim{inset:0;background:#0007;opacity:0;animation:wns-dim 7s both}
@keyframes wns-dim{0%,44%{opacity:0}47%,72%{opacity:1}74%,100%{opacity:0}}
.wns-shot .wns-sel{left:22%;top:20%;width:0;height:0;border:2px solid #f97316;background:#f973160d;box-shadow:0 0 0 9999px #0006;opacity:0;animation:wns-sel 7s both}
@keyframes wns-sel{0%,45%{opacity:0;width:0;height:0}47%{opacity:1}60%,72%{opacity:1;width:54%;height:42%}74%,100%{opacity:0;width:54%;height:42%}}
.wns-shot .wns-sz{left:58%;top:15.5%;background:#f97316;color:#111;font:700 .85em ui-monospace,monospace;padding:2px 7px;border-radius:5px;white-space:nowrap;opacity:0;animation:wns-sz 7s both}
@keyframes wns-sz{0%,58%{opacity:0}61%,72%{opacity:1}74%,100%{opacity:0}}
.wns-shot .wns-flash{inset:0;background:#fff;opacity:0;animation:wns-flash 7s both}
@keyframes wns-flash{0%,73%{opacity:0}74.5%{opacity:.85}82%,100%{opacity:0}}
.wns-shot .wns-toast{right:3%;bottom:4%;width:34%;animation:wns-toast 7s both}
@keyframes wns-toast{0%,78%{opacity:0;transform:translateY(30%)}83%,100%{opacity:1;transform:none}}

.wns-br .wns-cam{animation:wns-brcam 7s ease-in-out both}
@keyframes wns-brcam{0%{transform:none}20%,62%{transform:scale(1.45) translate(0,22%)}80%,100%{transform:none}}
.wns-br .wns-cur-a{left:62%;top:55%;animation:wns-bra 7s ease-in-out both}
@keyframes wns-bra{0%{left:62%;top:55%}20%,64%{left:47%;top:19.4%}80%,100%{left:20%;top:90%}}
.wns-br .wns-cur-y{left:86%;top:70%;animation:wns-bry 7s ease-in-out both}
@keyframes wns-bry{0%{left:86%;top:70%}50%{left:80%;top:52%}100%{left:84%;top:62%}}
.wns-br .wns-typed{left:40.4%;top:17.1%;width:17%;height:4.3%;background:#fff;color:#111;display:flex;align-items:center;padding-left:.4%;white-space:nowrap;overflow:hidden;opacity:0;animation:wns-typedbox 7s both}
@keyframes wns-typedbox{0%,22%{opacity:0}23%,100%{opacity:1}}
.wns-br .wns-typed span{border-right:2px solid #f97316;min-height:1.2em}
.wns-br .wns-ring{left:11%;top:86.6%;width:16.5%;height:4.6%;animation:wns-ringon 7s both}
.wns-br .wns-live{left:12.8%;top:9.8%;width:1%;aspect-ratio:1;border-radius:50%;background:#22c55e;box-shadow:0 0 0 0 #22c55e88;animation:wns-live 1.4s ease-out infinite}

.wns-link .wns-cam{animation:wns-lkcam 7s ease-in-out both}
@keyframes wns-lkcam{0%{transform:scale(1.15) translate(14%,8%)}35%{transform:scale(1.25) translate(18%,0)}55%,100%{transform:none}}
.wns-link .wns-cur-1{left:50%;top:80%;animation:wns-lkcur 7s ease-in-out both}
@keyframes wns-lkcur{0%{left:50%;top:80%}25%,100%{left:25%;top:46.6%}}
.wns-link .wns-ring{left:9.2%;top:42.4%;width:26.4%;height:8.4%;border-radius:4px;animation:wns-lkring 7s both}
@keyframes wns-lkring{0%,24%{opacity:0}27%,44%{opacity:1}48%,100%{opacity:0}}
.wns-link .wns-rip{left:25%;top:46.6%;animation:wns-rip2 7s both}
@keyframes wns-rip2{0%,37%{opacity:0;transform:scale(.3)}39%{opacity:1}46%{opacity:0;transform:scale(2.4)}100%{opacity:0}}
.wns-link .wns-toast{left:46%;top:24%;width:44%;padding:2.2% 2.4%;animation:wns-lkt 7s both}
@keyframes wns-lkt{0%,48%{opacity:0;transform:scale(.94)}54%,100%{opacity:1;transform:none}}
.wns-link .wns-row{display:flex;justify-content:space-between;color:#8d99ae;margin-top:8px;font-size:.92em}
.wns-link .wns-row b{display:inline;color:#e8edf5;margin:0}
.wns-link .wns-copy{margin-left:auto;color:#fff;flex:none}
.wns-url{min-width:0;overflow:hidden;text-overflow:ellipsis}
.wns-link .wns-cur-2{left:92%;top:80%;opacity:0;animation:wns-lkcur2 7s ease-in-out both}
@keyframes wns-lkcur2{0%,52%{left:92%;top:80%;opacity:0}54%{opacity:1}70%,100%{left:84.5%;top:49.5%;opacity:1}}

.wns-grok .wns-cam{animation:wns-gkcam 7s ease-in-out both}
@keyframes wns-gkcam{0%{transform:none}22%,72%{transform:scale(1.55) translate(-24%,-20%)}90%,100%{transform:none}}
.wns-grok .wns-hl{left:76.6%;top:66.5%;width:18.4%;height:4.6%;border-radius:5px;background:#f9731638;outline:1px solid #f97316aa;opacity:0;animation:wns-gkhl 7s ease-in-out both}
@keyframes wns-gkhl{0%,14%{top:66.5%;opacity:0}18%{top:66.5%;opacity:1}30%{top:71.3%;opacity:1}44%{top:76.1%;opacity:1}58%,100%{top:80.9%;opacity:1}}
.wns-grok .wns-cur{left:60%;top:50%;animation:wns-gkcur 7s ease-in-out both}
@keyframes wns-gkcur{0%{left:60%;top:50%}18%{left:88%;top:69%}30%{left:88%;top:73.8%}44%{left:88%;top:78.6%}58%,100%{left:88%;top:83.4%}}
.wns-grok .wns-rip{left:88%;top:83.4%;animation:wns-rip3 7s both}
@keyframes wns-rip3{0%,58%{opacity:0;transform:scale(.3)}60%{opacity:1}67%{opacity:0;transform:scale(2.4)}100%{opacity:0}}
.wns-grok .wns-toast{left:56%;top:24%;width:38%;animation:wns-gkt 7s both}
@keyframes wns-gkt{0%,64%{opacity:0;transform:translateY(-20%)}70%,100%{opacity:1;transform:none}}

.wns-talk .wns-cam{animation:wns-tkcam 7s ease-in-out both}
@keyframes wns-tkcam{0%{transform:none}20%,76%{transform:scale(1.55) translate(-20%,-24%)}92%,100%{transform:none}}
.wns-talk .wns-wave{left:66%;top:77%;width:22%;height:2.6%;display:flex;gap:2.5%;align-items:center;background:#0f1216}
.wns-talk .wns-wave i{flex:1;height:30%;background:#ef4444;border-radius:2px;animation:wns-wv .5s ease-in-out infinite alternate}
.wns-talk .wns-wave i:nth-child(3n){animation-delay:.12s}
.wns-talk .wns-wave i:nth-child(3n+1){animation-delay:.25s}
.wns-talk .wns-wave i:nth-child(4n){animation-delay:.37s}
@keyframes wns-wv{to{height:100%}}
.wns-talk .wns-tm{left:54.6%;top:76.6%;width:10.5%;height:3%;background:#0f1216;color:#f87171;white-space:nowrap;display:flex;align-items:center;gap:6%}
.wns-talk .wns-tm:before{content:"";flex:none;width:9%;aspect-ratio:1;border-radius:50%;background:#ef4444;animation:wns-blink 1s steps(1) infinite}
.wns-talk .wns-mic{left:58.6%;top:91%;width:3.6%;aspect-ratio:1;border-radius:8px;box-shadow:0 0 0 0 #ef444499;animation:wns-micp 1.1s ease-out infinite}
@keyframes wns-micp{70%{box-shadow:0 0 0 14px #ef444400}}
.wns-talk .wns-key{left:30%;top:80%;white-space:nowrap;opacity:0;animation:wns-keyin 7s both}
@keyframes wns-keyin{0%,8%{opacity:0;transform:translateY(20%)}14%,80%{opacity:1;transform:none}86%,100%{opacity:0}}
.wns-talk .wns-toast{left:4%;top:8%;width:34%;animation:wns-tkt 7s both}

.wns-chart .wns-cam{animation:wns-chcam 7s ease-in-out both}
@keyframes wns-chcam{0%{transform:none}20%,78%{transform:scale(1.45) translate(-13%,6%)}95%,100%{transform:none}}
.wns-chart .wns-spin{width:4.7%;aspect-ratio:1;border-radius:50%;border:2px solid transparent;border-top-color:#f97316;border-right-color:#f97316;margin:-2.35% 0 0 -2.35%;animation:wns-spin 1.1s linear infinite}
@keyframes wns-spin{to{transform:rotate(360deg)}}
.wns-chart .wns-s1{left:45.3%;top:36%}
.wns-chart .wns-s2{left:68.3%;top:44.8%}
.wns-chart .wns-s3{left:76.8%;top:44.8%}
.wns-chart .wns-flow{left:61.8%;top:44.7%;width:13%;height:.45%;background:repeating-linear-gradient(90deg,#f97316 0 6px,transparent 6px 12px);opacity:.95;mask:linear-gradient(90deg,#000 0 40%,transparent 40% 60%,#000 60%);animation:wns-flow .6s linear infinite}
@keyframes wns-flow{to{background-position:12px 0}}
.wns-chart .wns-done3{left:77.1%;top:45.7%;width:2%;aspect-ratio:1;border-radius:50%;background:#38bdf8;color:#071019;font-weight:900;font-size:.75em;line-height:1;display:grid;place-items:center;opacity:0;animation:wns-stamp 7s .6s both}
.wns-chart .wns-cn{left:33.2%;top:27%;width:14%;height:3.1%;background:#15171c;font-size:.95em;white-space:nowrap;color:#a5adba;display:flex;gap:14%;align-items:center;opacity:0;animation:wns-cnt 7s steps(1) .6s both}
.wns-chart .wns-tmr{left:55.4%;top:23.3%;width:4.6%;height:2.9%;background:#1f2329;color:#c6ccd6;font-size:.9em;display:flex;align-items:center;border-radius:4px;white-space:nowrap;padding-left:.3%}
.wns-chart .wns-toast{right:4%;top:6%;width:30%;animation:wns-tkt 7s -1.2s both}

.wns-wiki .wns-cam{animation:wns-wkcam 7s ease-in-out both}
@keyframes wns-wkcam{0%{transform:none}25%,70%{transform:scale(1.3) translate(-6%,-12%)}90%,100%{transform:none}}
.wns-wiki .wns-cover{left:12.5%;width:75%;height:11.6%;background:#1a1d22;animation:wns-uncover 7s both}
@keyframes wns-uncover{0%,6%{opacity:1;transform:none}14%,100%{opacity:0;transform:translateY(-30%)}}
.wns-wiki .wns-c1{top:55.2%}
.wns-wiki .wns-c2{top:67.2%;animation-delay:.45s}
.wns-wiki .wns-c3{top:79.2%;animation-delay:.9s}
.wns-wiki .wns-bar{left:64.4%;width:4%;height:.55%;background:#2a2f38}
.wns-wiki .wns-bar i{display:block;height:100%;width:0;background:#facc15;animation:wns-conf 7s both}
@keyframes wns-conf{0%,16%{width:0}30%,100%{width:70%}}
.wns-wiki .wns-b1{top:60.1%}
.wns-wiki .wns-b2{top:72.1%}
.wns-wiki .wns-b2 i{animation-delay:.45s}
.wns-wiki .wns-b3{top:84.1%}
.wns-wiki .wns-b3 i{animation-delay:.9s}
.wns-wiki .wns-ver{left:76.1%;top:59.2%;width:6%;height:2.7%;background:#1a1d22;display:flex;align-items:center;opacity:0;animation:wns-stamp 7s both}
.wns-wiki .wns-ver span{font-weight:700;font-size:.8em;color:#2dd4bf;border:1px solid #2dd4bf88;border-radius:9px;padding:0 6px;background:#2dd4bf14;white-space:nowrap}
.wns-wiki .wns-ring{left:12.6%;top:55%;width:75%;height:11.9%;animation:wns-wring 7s both}
@keyframes wns-wring{0%,44%{opacity:0}48%,66%{opacity:1}72%,100%{opacity:0}}
.wns-wiki .wns-cnt{left:80.2%;top:9.4%;width:3.4%;height:2.8%;background:#1a1d22;font-size:.9em;color:#2dd4bf;font-weight:700;display:flex;align-items:center;opacity:0;animation:wns-cnt 7s steps(1) both}

.wns-busy .wns-cam{animation:wns-bscam 7s ease-in-out both}
@keyframes wns-bscam{0%{transform:none}20%,76%{transform:scale(1.7)}94%,100%{transform:none}}
.wns-busy .wns-ring{left:38%;top:41.3%;width:23.9%;height:17.5%;border-radius:10px;animation:wns-bsring 7s both}
@keyframes wns-bsring{0%,20%{opacity:0}26%,48%{opacity:1}54%,100%{opacity:0}}
.wns-busy .wns-cur{left:68%;top:80%;animation:wns-bscur 7s ease-in-out both}
@keyframes wns-bscur{0%,28%{left:68%;top:80%}52%,100%{left:50.6%;top:54.6%}}
.wns-busy .wns-hl{left:48.6%;top:53.3%;width:4.4%;height:3.6%;border-radius:6px;background:#f9731630;outline:2px solid #f97316;opacity:0;animation:wns-bshl 7s both}
@keyframes wns-bshl{0%,52%{opacity:0}56%,100%{opacity:1}}
.wns-busy .wns-rip{left:50.8%;top:55.1%;animation:wns-rip3 7s both}
.wns-busy .wns-toast{left:4%;top:8%;width:32%;animation:wns-gkt 7s both}

.wns-queue .wns-cam{animation:wns-qucam 7s ease-in-out both}
@keyframes wns-qucam{0%{transform:none}16%,58%{transform:scale(1.5) translate(-3%,-11%)}74%,100%{transform:none}}
.wns-queue .wns-pct{left:47.5%;top:53.4%;height:1.7%;padding:0 .4em;border-radius:5px;background:#6366f133;color:#c7d2fe;font:700 .8em ui-monospace,monospace;display:flex;align-items:center;white-space:nowrap}
.wns-queue .wns-bar{left:51.2%;top:54%;width:12%;height:.5%;border-radius:2px;background:#2a2f38;overflow:hidden}
.wns-queue .wns-bar i{display:block;height:100%;width:8%;background:#6366f1;animation:wns-qubar 7s linear both}
@keyframes wns-qubar{0%{width:8%}100%{width:86%}}
.wns-queue .wns-q1{left:43.3%;top:67.8%;width:9.8%;height:2.6%;border-radius:6px;animation:wns-qur1 7s both}
@keyframes wns-qur1{0%,24%{opacity:0}28%,56%{opacity:1}62%,100%{opacity:0}}
.wns-queue .wns-q2{left:83%;top:1.6%;width:15.8%;height:10.6%;border-radius:10px;animation:wns-qur2 7s both}
@keyframes wns-qur2{0%,74%{opacity:0}78%,100%{opacity:1}}
.wns-queue .wns-toast{left:4%;bottom:6%;width:32%;animation:wns-toast 7s both}

.wns-rep .wns-cam{animation:wns-rpcam 7s ease-in-out both}
@keyframes wns-rpcam{0%{transform:none}16%,80%{transform:scale(1.5) translate(-16.7%,-4%)}96%,100%{transform:none}}
.wns-rep .wns-r1{left:71.8%;top:32.4%;width:26.2%;height:10.4%;animation:wns-rpr1 7s both}
@keyframes wns-rpr1{0%,12%{opacity:0}16%,46%{opacity:1}52%,100%{opacity:0}}
.wns-rep .wns-r2{left:71.8%;top:57.9%;width:26.2%;height:17.8%;animation:wns-rpr2 7s both}
@keyframes wns-rpr2{0%,56%{opacity:0}60%,100%{opacity:1}}
.wns-rep .wns-toast{left:4%;top:8%;width:32%;animation:wns-rpt 7s both}
@keyframes wns-rpt{0%,8%{opacity:0;transform:translateY(-20%)}14%,100%{opacity:1;transform:none}}

.wns-alert .wns-cam{animation:wns-alcam 7s ease-in-out both}
@keyframes wns-alcam{0%{transform:none}12%,34%{transform:scale(1.6) translate(-18.75%,18.75%)}48%,80%{transform:scale(1.6) translate(-6%,-7%)}94%,100%{transform:none}}
.wns-alert .wns-a1{left:82.6%;top:1.2%;width:16.6%;height:7.6%;border-radius:10px;animation:wns-alr1 7s both}
@keyframes wns-alr1{0%,10%{opacity:0}14%,38%{opacity:1}44%,100%{opacity:0}}
.wns-alert .wns-a2{left:43.2%;top:61.6%;width:26.2%;height:6.2%;border-radius:6px;animation:wns-alr2 7s both}
@keyframes wns-alr2{0%,50%{opacity:0}54%,100%{opacity:1}}
.wns-alert .wns-dot{left:43.45%;top:61.9%;width:1.1%;aspect-ratio:1;border-radius:50%;box-shadow:0 0 0 0 #f43f5e99;animation:wns-alp 1.2s ease-out infinite}
@keyframes wns-alp{70%{box-shadow:0 0 0 12px #f43f5e00}}
.wns-alert .wns-toast{left:4%;bottom:6%;width:36%;animation:wns-alt 7s both}
@keyframes wns-alt{0%,56%{opacity:0;transform:translateY(30%)}62%,100%{opacity:1;transform:none}}

.wns[data-motion="reduce"] .wns-scr *,.wns[data-motion="reduce"] .wns-scr *::before{animation-delay:-7s!important;animation-play-state:paused!important}
.wns[data-motion="reduce"] .wns-cam,.wns[data-motion="reduce"] .wns-float,.wns[data-motion="reduce"] .wns-up{animation:none}
.wns[data-motion="reduce"] .wns-talk .wns-wave i{animation:none;height:55%}
.wns[data-motion="reduce"] .wns-talk .wns-wave i:nth-child(2n){height:85%}
.wns[data-motion="reduce"] .wns-talk .wns-wave i:nth-child(3n){height:35%}

@property --wns-fx{syntax:"<number>";inherits:false;initial-value:.5}
@property --wns-fy{syntax:"<number>";inherits:false;initial-value:.5}
@property --wns-pz{syntax:"<number>";inherits:false;initial-value:960}
.wns[data-layout="narrow"] .wns-scr{--wns-ar:.75;aspect-ratio:4/3;font-size:clamp(11px,3.2cqw,13px)}
@container wns (width < 32.5rem){.wns[data-layout="narrow"] .wns-scr{--wns-ar:1;aspect-ratio:1}}
@container wns (width >= 44rem){.wns[data-layout="narrow"] .wns-scr{--wns-ar:.625;aspect-ratio:16/10}}
.wns[data-layout="narrow"] .wns-scr .wns-cam{--wns-pw:max(100cqw,calc(var(--wns-pz) * 1px),calc(160cqw * var(--wns-ar)));inset:auto;left:0;top:0;width:var(--wns-pw);height:calc(var(--wns-pw) * .625);transform-origin:0 0;font-size:calc(var(--wns-pw) * .0115);transform:translate(clamp(calc(100cqw - var(--wns-pw)),calc(50cqw - var(--wns-fx) * var(--wns-pw)),0px),clamp(calc(100cqw * var(--wns-ar) - var(--wns-pw) * .625),calc(50cqw * var(--wns-ar) - var(--wns-fy) * var(--wns-pw) * .625),0px));animation:none}
.wns[data-layout="narrow"] .wns-shot .wns-cam{--wns-fx:.49;--wns-fy:.41;--wns-pz:880;animation:wns-n-shot 7s ease-in-out both}
@keyframes wns-n-shot{0%{--wns-fx:.55;--wns-fy:.42;--wns-pz:880}18%,30%{--wns-fx:.7;--wns-fy:.33;--wns-pz:960}44%{--wns-fx:.33;--wns-fy:.27;--wns-pz:880}60%,100%{--wns-fx:.49;--wns-fy:.41;--wns-pz:880}}
.wns[data-layout="narrow"] .wns-br .wns-cam{--wns-fx:.22;--wns-fy:.86;--wns-pz:960;animation:wns-n-br 7s ease-in-out both}
@keyframes wns-n-br{0%{--wns-fx:.5;--wns-fy:.35;--wns-pz:880}20%,62%{--wns-fx:.5;--wns-fy:.22;--wns-pz:900}80%,100%{--wns-fx:.22;--wns-fy:.86;--wns-pz:960}}
.wns[data-layout="narrow"] .wns-link .wns-cam{--wns-fx:.24;--wns-fy:.46;--wns-pz:960;animation:wns-n-link 7s ease-in-out both}
@keyframes wns-n-link{0%{--wns-fx:.42;--wns-fy:.6;--wns-pz:880}25%,100%{--wns-fx:.24;--wns-fy:.46;--wns-pz:960}}
.wns[data-layout="narrow"] .wns-grok .wns-cam{--wns-fx:.85;--wns-fy:.75;--wns-pz:960;animation:wns-n-grok 7s ease-in-out both}
@keyframes wns-n-grok{0%{--wns-fx:.66;--wns-fy:.55;--wns-pz:880}18%,100%{--wns-fx:.85;--wns-fy:.75;--wns-pz:960}}
.wns[data-layout="narrow"] .wns-talk .wns-cam{--wns-fx:.71;--wns-fy:.82;--wns-pz:900;animation:wns-n-talk 7s ease-in-out both}
@keyframes wns-n-talk{0%{--wns-fx:.6;--wns-fy:.7;--wns-pz:880}20%,100%{--wns-fx:.71;--wns-fy:.82;--wns-pz:900}}
.wns[data-layout="narrow"] .wns-chart .wns-cam{--wns-fx:.71;--wns-fy:.42;--wns-pz:960;animation:wns-n-chart 7s ease-in-out both}
@keyframes wns-n-chart{0%{--wns-fx:.5;--wns-fy:.38;--wns-pz:880}18%,42%{--wns-fx:.42;--wns-fy:.3;--wns-pz:960}58%,100%{--wns-fx:.71;--wns-fy:.42;--wns-pz:960}}
.wns[data-layout="narrow"] .wns-wiki .wns-cam{--wns-fx:.66;--wns-fy:.6;--wns-pz:900;animation:wns-n-wiki 7s ease-in-out both}
@keyframes wns-n-wiki{0%{--wns-fx:.4;--wns-fy:.7;--wns-pz:880}10%,38%{--wns-fx:.36;--wns-fy:.68;--wns-pz:900}50%,100%{--wns-fx:.66;--wns-fy:.6;--wns-pz:900}}
.wns[data-layout="narrow"] .wns-busy .wns-cam{--wns-fx:.5;--wns-fy:.5;--wns-pz:960;animation:wns-n-busy 7s ease-in-out both}
@keyframes wns-n-busy{0%{--wns-fx:.58;--wns-fy:.62;--wns-pz:880}20%,100%{--wns-fx:.5;--wns-fy:.5;--wns-pz:960}}
.wns[data-layout="narrow"] .wns-queue .wns-cam{--wns-fx:.9;--wns-fy:.08;--wns-pz:960;animation:wns-n-queue 7s ease-in-out both}
@keyframes wns-n-queue{0%{--wns-fx:.5;--wns-fy:.5;--wns-pz:880}16%,58%{--wns-fx:.53;--wns-fy:.62;--wns-pz:960}74%,100%{--wns-fx:.9;--wns-fy:.08;--wns-pz:960}}
.wns[data-layout="narrow"] .wns-rep .wns-cam{--wns-fx:.85;--wns-fy:.66;--wns-pz:960;animation:wns-n-rep 7s ease-in-out both}
@keyframes wns-n-rep{0%{--wns-fx:.6;--wns-fy:.5;--wns-pz:880}14%,46%{--wns-fx:.85;--wns-fy:.38;--wns-pz:960}60%,100%{--wns-fx:.85;--wns-fy:.66;--wns-pz:960}}
.wns[data-layout="narrow"] .wns-alert .wns-cam{--wns-fx:.56;--wns-fy:.64;--wns-pz:960;animation:wns-n-alert 7s ease-in-out both}
@keyframes wns-n-alert{0%{--wns-fx:.8;--wns-fy:.2;--wns-pz:880}12%,34%{--wns-fx:.9;--wns-fy:.05;--wns-pz:960}48%,100%{--wns-fx:.56;--wns-fy:.64;--wns-pz:960}}
.wns[data-layout="narrow"][data-motion="reduce"] .wns-scr .wns-cam{animation:none}
.wns[data-layout="narrow"] .wns-scr .wns-toast{left:4%;right:4%;top:auto;bottom:4%;width:auto;padding:2.6% 3.4%}
.wns[data-layout="narrow"] .wns-scr .wns-key{left:4%;top:auto;bottom:5%}
.wns[data-layout="narrow"] .wns-talk .wns-key,.wns[data-layout="narrow"] .wns-talk .wns-toast{top:5%;bottom:auto}
.wns[data-layout="narrow"] .wns-scr :is(.wns-tag,.wns-ver span){font-size:max(10px,.8em)}
.wns[data-layout="narrow"] .wns-scr :is(.wns-sz,.wns-urlp,.wns-toast small){font-size:max(10px,.85em)}
.wns[data-layout="narrow"] .wns-scr :is(.wns-tmr,.wns-cnt,.wns-pct){font-size:max(10px,.9em)}
.wns[data-layout="narrow"] .wns-scr .wns-row{font-size:max(10px,.92em)}
.wns[data-layout="narrow"] .wns-scr :is(.wns-cn,.wns-kbd){font-size:max(10px,.95em)}
.wns[data-layout="narrow"] .wns-link .wns-cur-2{display:none}
.wns-held{position:absolute;right:10px;top:10px;z-index:12;display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:#0a0f19d9;border:1px solid #f9731699;color:#f97316;font-size:14px;pointer-events:none}
`;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The title, typed in a letter at a time; whole at once with motion off.
 * Sized by the whole title from the start — and by every title in `reserve`,
 * so the screenshot under it does not move from one feature to the next.
 */
function TypedTitle({ title, reduced, reserve = [] }: { title: string; reduced: boolean; reserve?: readonly string[] }) {
  const letters = Array.from(title);
  const typed = useTyping(letters.length, 0, SHOWCASE_TYPE_MS, reduced);
  return (
    <span aria-hidden="true" className="grid" data-testid="whats-new-showcase-typed">
      <span className="invisible col-start-1 row-start-1">{title}</span>
      {reserve.map((other, at) => <span key={at} className="invisible col-start-1 row-start-1" data-showcase-reserve="">{other}</span>)}
      <span className="col-start-1 row-start-1">
        {letters.slice(0, typed).join("")}
        {!reduced && <span className="wns-caret" />}
      </span>
    </span>
  );
}

/**
 * One feature's screenshot in its frame. Every feature has one, drawn from
 * the start and kept: the one on show is displayed, the rest are hidden.
 * Each picture is fetched once, the moment the panel is drawn, and never
 * asked for again — a feature reached while the box restarts still has it.
 * Hiding a stage stops its camera; showing it starts it again from the top,
 * and its demo is mounted afresh.
 */
function Stage({ item, feature, active, tr, reduced, onBroken }: { item: ShowcaseItem; feature: Feature; active: boolean; tr: Floor; reduced: boolean; onBroken: () => void }) {
  const { Cam, Frame } = feature;
  return (
    <div className="wns-float" aria-hidden="true" hidden={!active}>
      <div className={`wns-scr wns-${feature.id}`} data-testid={active ? "whats-new-showcase-stage" : undefined} data-feature={feature.id}>
        <div className="wns-cam">
          {/* eslint-disable-next-line @next/next/no-img-element -- a fixed asset from public/, kept loaded for the whole show */}
          <img
            src={item.image}
            alt=""
            width={1920}
            height={1200}
            loading="eager"
            decoding="async"
            draggable={false}
            onError={onBroken}
            data-showcase-image=""
            data-testid={active ? "update-whats-new-image" : undefined}
          />
          {active && Cam && <Cam tr={tr} reduced={reduced} />}
        </div>
        {active && Frame && <Frame tr={tr} reduced={reduced} />}
      </div>
    </div>
  );
}

/**
 * The System Update window's "What's new" (TASK-2121): the release as a
 * cinematic hero — ONE feature at a time, its title typed in beside its real
 * screenshot, a live demo drawn over the screenshot, chips to pick one. It
 * moves on every {@link SHOWCASE_ADVANCE_MS}, and holds while the pointer is
 * over it or the focus is in it; ←/→ (Home/End) turn it.
 *
 * On a phone (narrow, see {@link SHOWCASE_NARROW_PX}) the text sits over a
 * taller, cropped screenshot, the chips are one row that scrolls sideways, a
 * swipe across it turns it and a tap holds it (another tap lets it go on).
 * A touch is never taken for a pointer hovering over it.
 *
 * It must keep working while the box restarts: no font or icon font of its
 * own, every screenshot and the logo loaded the moment it is drawn and kept
 * (see Stage), nothing fetched after that.
 */
export default function UpdateWhatsNewShowcase({
  items,
  release,
  tr,
  headingLevel,
  releaseLink,
}: {
  items: readonly ShowcaseItem[];
  release: string;
  tr: Floor;
  headingLevel: "h3" | "h4";
  releaseLink: ReactNode;
}) {
  const Heading = headingLevel;
  const count = items.length;
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  /** Held by a tap, until the next one. */
  const [held, setHeld] = useState(false);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const reduced = useMediaQuery(REDUCED_MOTION);
  const compactViewport = useMediaQuery(SHOWCASE_COMPACT_VIEWPORT);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const width = useOwnWidth(root);
  const narrow = compactViewport || (width !== null && width < SHOWCASE_NARROW_PX);
  const id = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const tablist = useRef<HTMLDivElement | null>(null);
  const touch = useRef<{ x: number; y: number; at: number } | null>(null);
  const touchedAt = useRef(Number.NEGATIVE_INFINITY);
  const current = Math.max(0, Math.min(index, count - 1));
  const paused = hovered || focused || held;
  const item = items[current] as ShowcaseItem | undefined;
  const feature = featureOf(item?.key ?? "");

  useEffect(() => {
    if (count < 2 || paused) return;
    const timer = setTimeout(() => setIndex((current + 1) % count), SHOWCASE_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [current, count, paused]);

  // The narrow chip row scrolls sideways: keep the chip that is on in sight.
  // The row only, never the page around it.
  useEffect(() => {
    const row = tablist.current;
    const chip = tabs.current[current];
    if (!narrow || !row || !chip || row.scrollWidth <= row.clientWidth) return;
    const left = Math.max(0, chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2);
    row.scrollTo?.({ left, behavior: reduced ? "auto" : "smooth" });
  }, [current, narrow, reduced]);

  const markBroken = (src: string) => setBroken((prev) => (prev.has(src) ? prev : new Set(prev).add(src)));

  const show = (next: number, focusChip: boolean) => {
    const target = (next + count) % count;
    setIndex(target);
    if (focusChip) tabs.current[target]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const next = event.key === "ArrowRight" ? current + 1
      : event.key === "ArrowLeft" ? current - 1
        : event.key === "Home" ? 0
          : event.key === "End" ? count - 1
            : null;
    if (next === null) return;
    event.preventDefault();
    show(next, (event.target as HTMLElement).getAttribute("role") === "tab");
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
  };

  // A swipe across the feature turns it; a tap holds it, or lets it go on.
  // The chips' row scrolls sideways itself and takes its own taps, as does the link.
  const onTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    touchedAt.current = Date.now();
    const start = event.touches[0];
    const own = (event.target as Element).closest?.('[role="tablist"], a, button');
    touch.current = event.touches.length === 1 && start && !own ? { x: start.clientX, y: start.clientY, at: Date.now() } : null;
  };

  const onTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    touchedAt.current = Date.now();
    const start = touch.current;
    const end = event.changedTouches[0];
    touch.current = null;
    if (!start || !end) return;
    const dx = end.clientX - start.x;
    const dy = end.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      show(current + (dx < 0 ? 1 : -1), false);
      return;
    }
    if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX || Date.now() - start.at > TAP_MS) return;
    // Not a click: it neither focuses the panel nor reads as a pointer over it,
    // so the tap alone decides; a chip that had the focus lets it go.
    event.preventDefault();
    const active = document.activeElement;
    if (active instanceof HTMLElement && event.currentTarget.contains(active)) active.blur();
    setHeld((was) => !was);
  };

  const onMouseEnter = () => {
    if (Date.now() - touchedAt.current > TOUCH_MOUSE_MS) setHovered(true);
  };

  if (!item) return null;

  return (
    <>
      {/* Its own container: the two columns follow the hero's width, not the window's. */}
      <div
        ref={setRoot}
        className="wns @container/wns relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[#26334a] bg-[#0a0f19]"
        data-testid="whats-new-showcase"
        data-index={current}
        data-feature={feature.id}
        data-motion={reduced ? "reduce" : "full"}
        data-layout={narrow ? "narrow" : "wide"}
        data-paused={paused ? "true" : "false"}
        data-held={held ? "true" : "false"}
        onMouseEnter={onMouseEnter}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onTouchStart={narrow ? onTouchStart : undefined}
        onTouchEnd={narrow ? onTouchEnd : undefined}
        onTouchCancel={narrow ? () => { touch.current = null; } : undefined}
      >
        <style>{SHOWCASE_CSS}</style>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-[-12%] top-[-25%] h-[80%] w-[60%] rounded-full opacity-[0.38] blur-[100px] transition-[background-color] duration-[1200ms]"
          style={{ backgroundColor: feature.glow }}
          data-testid="whats-new-showcase-glow"
        />

        <div className={`wns-logo relative flex items-center gap-2 ${narrow ? "px-4 pt-4" : "px-[30px] pt-6"}`} aria-hidden="true" data-testid="whats-new-showcase-logo">
          {/* eslint-disable-next-line @next/next/no-img-element -- the box's own crab from public/, loaded with the panel */}
          <img src="/clawbox-icon.png" alt="" width={28} height={28} loading="eager" draggable={false} className="h-7 w-7 object-contain" onError={(event) => { event.currentTarget.style.display = "none"; }} />
          <span className="font-display text-lg font-bold tracking-[-0.01em] text-[#f97316]">ClawBox</span>
        </div>

        <div
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-tab-${current}`}
          tabIndex={0}
          className={`wns-panel relative grid flex-1 grid-cols-1 items-center rounded-xl pb-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-orange-300/70 @min-[44rem]:grid-cols-[minmax(0,330px)_minmax(0,1fr)] ${
            narrow ? "touch-pan-y gap-4 px-4 pt-3" : "gap-[22px] pl-[30px] pr-[26px] pt-[18px]"
          }`}
          data-testid="whats-new-showcase-panel"
        >
          <div className="min-w-0">
            <p className="wns-count m-0 font-mono text-xs font-extrabold uppercase tracking-[0.2em] text-[#8d99ae]" data-testid="whats-new-showcase-count">
              <b className="text-[#e8edf5]">{pad(current + 1)}</b> / {pad(count)} · {tr("update.showcase.newIn", "New in {release}", { release })}
            </p>
            <Heading className={`wns-title font-display font-bold leading-[1.12] tracking-[-0.01em] text-[#e8edf5] ${narrow ? "mb-2 mt-2.5 text-[24px]" : "mb-2.5 mt-3.5 min-h-[68px] text-[30px]"}`}>
              <span className="sr-only">{item.title}</span>
              {/* Narrow, the screenshot sits under the text: it is sized by the
                  longest title and body, so it stays put as the features turn. */}
              <TypedTitle key={`${current}:${item.title}`} title={item.title} reduced={reduced} reserve={narrow ? items.map((entry) => entry.title) : undefined} />
            </Heading>
            {narrow ? (
              <div className="grid text-[13.5px] leading-normal text-[#b9c3d5]">
                {items.map((entry, at) => (
                  <p key={at} aria-hidden="true" className="invisible col-start-1 row-start-1 m-0" data-showcase-reserve="">{entry.body}</p>
                ))}
                <p key={current} className="wns-up col-start-1 row-start-1 m-0">{item.body}</p>
              </div>
            ) : (
              <p key={current} className="wns-body wns-up m-0 text-[13.5px] leading-normal text-[#b9c3d5]">{item.body}</p>
            )}
          </div>
          <div className="wns-scene relative min-w-0">
            {held && (
              <span className="wns-held" aria-hidden="true" data-testid="whats-new-showcase-held">
                <Glyph><path d="M9 5v14M15 5v14" /></Glyph>
              </span>
            )}
            {items.map((entry, at) => !broken.has(entry.image) && (
              <Stage
                key={entry.key}
                item={entry}
                feature={featureOf(entry.key)}
                active={at === current}
                tr={tr}
                reduced={reduced}
                onBroken={() => markBroken(entry.image)}
              />
            ))}
          </div>
        </div>

        {/* Narrow under a thumb, one row it scrolls sideways (inside itself,
            never the page) instead of three wrapped ones; with a mouse, which
            has no sideways swipe, they wrap. */}
        <div
          ref={tablist}
          role="tablist"
          aria-label={tr("update.showcase.label", "New features")}
          className={`wns-chips relative flex gap-1.5 ${
            narrow
              ? "flex-wrap px-4 pb-4 pt-5 pointer-coarse:snap-x pointer-coarse:scroll-px-4 pointer-coarse:flex-nowrap pointer-coarse:overflow-x-auto pointer-coarse:overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              : "flex-wrap pb-[18px] pl-[30px] pr-[26px] pt-[26px]"
          }`}
          data-testid="whats-new-showcase-chips"
        >
          {items.map((entry, at) => {
            const on = at === current;
            const chip = featureOf(entry.key);
            return (
              <button
                key={entry.key}
                ref={(element) => { tabs.current[at] = element; }}
                type="button"
                role="tab"
                id={`${id}-tab-${at}`}
                aria-selected={on}
                aria-controls={`${id}-panel`}
                tabIndex={on ? 0 : -1}
                onClick={(event) => {
                  show(at, false);
                  // A thumb picked it, as a swipe would: the show goes on from
                  // here, not held by the focus a phone's browser gives the chip.
                  if (Date.now() - touchedAt.current <= TOUCH_MOUSE_MS) event.currentTarget.blur();
                }}
                className={`wns-chip inline-flex cursor-pointer items-center gap-[5px] rounded-full border leading-snug focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-300 ${
                  narrow ? "shrink-0 whitespace-nowrap px-3 py-1.5 text-[12px] pointer-coarse:snap-start pointer-coarse:focus-visible:-outline-offset-2" : "px-[9px] py-1 text-[10.5px]"
                } ${
                  on ? "border-[#f97316] bg-[#f97316] font-bold text-[#111]" : "border-[#26334a] bg-[#0d1420cc] text-[#8d99ae] hover:text-[#e8edf5]"
                }`}
                data-testid="whats-new-showcase-chip"
              >
                {chip.icon}
                {chip.chip ? tr(chip.chip[0], chip.chip[1]) : entry.title}
              </button>
            );
          })}
        </div>

        {/* Said once per feature, and only while the owner is driving: a show
            that turns by itself every few seconds would talk over everything. */}
        <p className="sr-only" aria-live={paused ? "polite" : "off"} aria-atomic="true" data-testid="whats-new-showcase-live">
          {item.title}
        </p>

      </div>
      <div className="wns-more mt-3">{releaseLink}</div>
    </>
  );
}
