"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useT } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/useModalDialog";
import { PORTAL_DASHBOARD_URL } from "@/lib/max-subscription";
import { shellScanEn } from "@/lib/edition-translations/en-shell-scan";

interface HarnessEntry {
  id: string;
  label: string;
  healthy: boolean;
}
interface HarnessStatus {
  active: string;
  /** Optional on purpose: this is unvalidated JSON off the status route, and a
      response that omits the list must render an empty picker, not throw. */
  harnesses?: HarnessEntry[];
  /** Single-harness edition (or dual without a premium license) → no switcher. */
  locked?: boolean;
  edition?: string;
  /** Hermes pre-exec shell scanning. Null/absent on a harness that has none. */
  shellScan?: ShellScanRow | null;
}

interface ShellScanRow {
  state?: string;
  reason?: string;
  failOpen?: boolean;
  retrySuppressedUntil?: string | null;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The two single editions a box can be swapped between. */
type SwapHarness = "openclaw" | "hermes";

/**
 * What a GET of `/setup-api/harness/swap` says, after `readSwapStatus` has
 * checked its shape. `swappable` false is the whole answer for a dual or an
 * unknown edition — and for a server that predates the route — and the card
 * then keeps the read-only badge it always had.
 */
interface SwapStatus {
  swappable: boolean;
  target: SwapHarness | null;
  inProgress: boolean;
  inProgressTarget: SwapHarness | null;
  planNameKey: string;
  businessPlanRequired: boolean;
  allowed: boolean;
}

/**
 * The face of each harness on the tiles. Names are the products' own and are
 * not translated; the taglines are. The logos are the OpenClaw mascot the
 * installed core ships and the Hermes picture the desktop already draws.
 */
const HARNESS_FACE: Record<SwapHarness, { name: string; logo: string; taglineKey: string }> = {
  openclaw: { name: "OpenClaw", logo: "/openclaw-logo.svg", taglineKey: "settings.harnessTaglineOpenclaw" },
  hermes: { name: "Hermes", logo: "/hermes-agent.png", taglineKey: "settings.harnessTaglineHermes" },
};

/** The root step's phases, in the order the stream announces them. */
const SWAP_PHASES = ["request", "install", "lock", "provision", "carry", "done"] as const;
type SwapPhase = (typeof SWAP_PHASES)[number];

const PHASE_KEYS: Record<SwapPhase, string> = {
  request: "settings.harnessSwapPhaseRequest",
  install: "settings.harnessSwapPhaseInstall",
  lock: "settings.harnessSwapPhaseLock",
  provision: "settings.harnessSwapPhaseProvision",
  carry: "settings.harnessSwapPhaseCarry",
  done: "settings.harnessSwapPhaseDone",
};

/**
 * What the swap does, one line each, in the order a person needs to hear it.
 * The persona line is said per direction: only the Hermes provisioning step
 * seeds the shared identity from the OpenClaw workspace, while the way back
 * runs no identity sync at all, so OpenClaw wakes with whatever its own
 * workspace held — and a promise the swap does not keep is worse than the
 * fact.
 */
function swapStepKeys(target: SwapHarness): string[] {
  return [
    "settings.harnessSwapStepInstall",
    "settings.harnessSwapStepUnavailable",
    target === "hermes" ? "settings.harnessSwapStepPersona" : "settings.harnessSwapStepPersonaKept",
    "settings.harnessSwapStepCarried",
    "settings.harnessSwapStepPerHarness",
    "settings.harnessSwapStepReload",
    "settings.harnessSwapStepBack",
  ];
}

/** How many of the journal's lines the progress pane keeps on screen. */
const LOG_LINES = 6;

/**
 * How long "Done — reloading…" stays up before the desktop reloads when the
 * closing line carried NO notes. The reload is what lands the desktop on the
 * new harness, so it is not optional. When there ARE notes there is no timer
 * at all: they name what the owner has to do next (approve their Telegram
 * account again, sign in to ClawBox AI again), nothing on the box shows them
 * a second time after the reload, and an owner who walked away while a
 * minutes-long install ran would have come back to a desktop that had
 * already thrown them away — so the reload waits for the Reload button.
 */
const SUCCESS_RELOAD_HOLD_MS = 1500;

/**
 * How often the card re-reads a swap that is running without this tab
 * following it — started from another tab, or one whose stream this tab lost.
 * The row it draws meanwhile is read once at load, and a swap takes minutes:
 * without the poll the owner stayed on "in progress" after the unit had
 * finished, on a page whose cached edition was by then the wrong one.
 */
const IN_PROGRESS_POLL_MS = 5000;

/**
 * The step's own phase markers, which the route forwards as plain status
 * lines when it does not map them (its `done` ends the root step, not the
 * swap). A marker is a signal for the phase list, never a sentence for the
 * pane.
 */
const PHASE_MARKER = /^\[harness-swap\] phase=\w+$/;

/**
 * The route's refusal codes the owner's language has a sentence for. Anything
 * else is answered with the route's own English sentence, so a code this table
 * does not know is still an explanation rather than a blank.
 */
const REFUSAL_KEYS: Record<string, string> = {
  busy: "settings.harnessSwapRefusedBusy",
  coding_run_live: "settings.harnessSwapRefusedCodingRun",
  offline: "settings.harnessSwapRefusedOffline",
  disk: "settings.harnessSwapRefusedDisk",
  memory: "settings.harnessSwapRefusedMemory",
  plan_required: "settings.harnessSwapRefusedPlan",
  // The one route code that says the box may be half-swapped, and the one
  // this component makes itself: both are told in the owner's language
  // because both are the sentences that decide what the owner does next.
  lock_unchanged: "settings.harnessSwapRefusedLockUnchanged",
  stream_lost: "settings.harnessSwapStreamLost",
};

function isSwapHarness(value: unknown): value is SwapHarness {
  return value === "openclaw" || value === "hermes";
}

function isSwapPhase(value: unknown): value is SwapPhase {
  return typeof value === "string" && (SWAP_PHASES as readonly string[]).includes(value);
}

/**
 * The swap route's GET, validated. A body that is not the route's (the tests'
 * one-body fetch stubs, an older server answering 404 HTML) reads as "not
 * swappable", never as a throw: this card sits in Settings, and a render
 * throw here takes the whole desktop tree down with it.
 */
function readSwapStatus(body: unknown): SwapStatus | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const target = isSwapHarness(b.target) ? b.target : null;
  const plan = b.plan && typeof b.plan === "object" ? (b.plan as Record<string, unknown>) : {};
  return {
    swappable: b.swappable === true && target !== null,
    target,
    inProgress: b.inProgress === true,
    inProgressTarget: isSwapHarness(b.inProgressTarget) ? b.inProgressTarget : null,
    planNameKey: typeof plan.planNameKey === "string" ? plan.planNameKey : "ai.planNameFree",
    businessPlanRequired: b.businessPlanRequired === true,
    // Absent means allowed: the constant the field mirrors is false today, and
    // a server from before the field was gating nothing.
    allowed: b.allowed !== false,
  };
}

/**
 * A refusal in the owner's language when the box sent a code for it, the
 * box's own sentence when it did not, and the generic one when it sent
 * nothing readable at all.
 */
function refusalText(t: Translate, body: unknown): string {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const key = typeof b.code === "string" ? REFUSAL_KEYS[b.code] : undefined;
  if (key) return t(key);
  return typeof b.error === "string" && b.error ? b.error : t("settings.harnessSwapFailed");
}

interface SwapEvent {
  phase?: SwapPhase;
  status?: string;
}
type SwapOutcome = { ok: true; notes: string[] } | { ok: false; error?: string; code?: string };

/**
 * Read the swap route's answer. It is not JSON: it streams NDJSON — `phase`
 * and `status` lines while the root step works, then ONE closing line,
 * `success` or `error`. A stream that ends with neither is NOT a failed swap:
 * the web server or the tunnel went away under the swap while the root unit
 * kept running, so it is answered as `stream_lost` — "the swap failed" over a
 * swap that then finished left the owner two contradictory sentences a minute
 * apart. A line that is not JSON is a torn write and is skipped, the way the
 * other install streams skip them.
 */
async function readSwapStream(res: Response, onEvent: (event: SwapEvent) => void): Promise<SwapOutcome> {
  const consume = (line: string): SwapOutcome | null => {
    if (!line) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      return null;
    }
    if (!payload || typeof payload !== "object") return null;
    const p = payload as Record<string, unknown>;
    const event: SwapEvent = {};
    if (isSwapPhase(p.phase)) event.phase = p.phase;
    if (typeof p.status === "string" && p.status && !PHASE_MARKER.test(p.status)) event.status = p.status;
    if (event.phase || event.status) onEvent(event);
    if (typeof p.error === "string") {
      return { ok: false, error: p.error, code: typeof p.code === "string" ? p.code : undefined };
    }
    if (p.success === true) {
      const notes = Array.isArray(p.notes) ? p.notes.filter((n): n is string => typeof n === "string") : [];
      return { ok: true, notes };
    }
    return null;
  };

  const reader = res.body?.getReader();
  if (!reader) {
    // No stream to tail (a response object that only carries text): the
    // verdict is still in the body, read whole.
    const text = typeof res.text === "function" ? await res.text() : "";
    for (const line of text.split("\n")) {
      const outcome = consume(line.trim());
      if (outcome) return outcome;
    }
    return { ok: false, code: "stream_lost" };
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      const outcome = consume(line);
      if (outcome) return outcome;
    }
    if (done) break;
  }
  // The closing line may arrive without its newline; it still decides the
  // outcome.
  return consume(buffer.trim()) ?? { ok: false, code: "stream_lost" };
}

/** m:ss — digits and a colon read the same in every locale the desktop speaks. */
function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * `t`, but this card never renders a raw key.
 *
 * `I18nProvider` serves `t(key) === key` until its dynamic import of the
 * catalogue resolves — and forever if that import fails, which it explicitly
 * contemplates ("the device is offline mid-update"). Everything else on this
 * card is hardcoded English and would look normal beside it, so the one
 * sentence in the product that says a security control is off would be the only
 * thing on screen reading `shellScan.offTitle`. The English table is imported
 * statically, so it cannot be the thing that failed to load.
 */
function scanCopy(t: Translate, key: string, params?: Record<string, string | number>): string {
  const translated = t(key, params);
  if (translated !== key) return translated;
  const english = shellScanEn[key] ?? key;
  return params ? english.replace(/\{(\w+)\}/g, (m, name) => String(params[name] ?? m)) : english;
}

/**
 * What to say about pre-exec shell scanning, or null when there is nothing to
 * say. Returning null for a healthy box is the point: a box whose scanner is
 * installed must not be warned at, or the warning stops meaning anything.
 *
 * `severe` separates the two live regions below. "Off" and "blocked" are a
 * security control not doing its job; "unknown" is only this box failing to
 * read its own settings.
 */
function shellScanWarning(
  scan: ShellScanRow | null | undefined,
  t: Translate,
  locale: string,
): { title: string; detail: string; severe: boolean } | null {
  if (!scan || scan.state === "on") return null;
  if (scan.state === "unknown") {
    return { title: scanCopy(t, "shellScan.unknownTitle"), detail: scanCopy(t, "shellScan.unknownDetail"), severe: false };
  }
  if (scan.reason === "disabled-by-config") {
    return { title: scanCopy(t, "shellScan.offTitle"), detail: scanCopy(t, "shellScan.disabledDetail"), severe: true };
  }
  // Upstream suppresses the re-download for 24 h after a failure, so "connect
  // it to the internet" is not the whole story and the owner has to be told.
  const until = scan.retrySuppressedUntil
    // The UI locale, not the runtime default: the rest of this sentence is
    // already in the owner's language, so the timestamp inside it has to be.
    ? ` ${scanCopy(t, "shellScan.retryAfter", { time: new Date(scan.retrySuppressedUntil).toLocaleString(locale) })}`
    : "";
  // The two outcomes are opposites, not degrees: fail-open runs the command
  // unchecked, fail-closed refuses to run it at all.
  return scan.failOpen
    ? { title: scanCopy(t, "shellScan.offTitle"), detail: `${scanCopy(t, "shellScan.missingDetail")}${until}`, severe: true }
    : { title: scanCopy(t, "shellScan.blockedTitle"), detail: `${scanCopy(t, "shellScan.blockedDetail")}${until}`, severe: true };
}

/**
 * The two harnesses side by side on a locked box: the one this box runs, with
 * its health dot and chip, and the other with the button that swaps to it.
 * Both are always drawn — the swap is a choice between two named things, and
 * a box that only showed the one it has gave the owner nothing to choose.
 */
function HarnessTiles({
  active,
  activeHealthy,
  swap,
  onSwap,
}: {
  active: SwapHarness;
  activeHealthy: boolean;
  swap: SwapStatus;
  onSwap: () => void;
}) {
  const { t } = useT();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {(Object.keys(HARNESS_FACE) as SwapHarness[]).map((id) => {
        const face = HARNESS_FACE[id];
        const isActive = id === active;
        return (
          <div
            key={id}
            data-testid={`harness-tile-${id}`}
            data-active={isActive ? "true" : undefined}
            className={`flex flex-col gap-3 rounded-xl border p-4 ${
              isActive ? "border-[var(--coral-bright)] bg-orange-500/10" : "border-[var(--border-subtle)]"
            }`}
          >
            <div className="flex items-start gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- a static
                  asset the desktop already draws; next/image gains nothing on
                  a box that serves its own files. */}
              <img
                src={face.logo}
                alt=""
                width={48}
                height={48}
                className="shrink-0 rounded-lg object-contain select-none pointer-events-none"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {isActive && (
                    // Same dot convention as the switcher: the status route's
                    // health, never a fixed green, because on a locked box this
                    // is the only health signal the owner gets.
                    <span
                      data-testid="harness-tile-dot"
                      title={!activeHealthy ? t("settings.harnessNotRunning", { name: face.name }) : undefined}
                      className={`w-2 h-2 rounded-full shrink-0 ${activeHealthy ? "bg-emerald-400" : "bg-white/25"}`}
                    />
                  )}
                  <span className="text-sm font-semibold text-[var(--text-primary)]">{face.name}</span>
                  {isActive && (
                    <span
                      data-testid="harness-this-box"
                      className="ml-auto inline-flex items-center rounded-md border border-[var(--coral-bright)]/50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--coral-bright)] whitespace-nowrap"
                    >
                      {t("settings.harnessThisBox")}
                    </span>
                  )}
                </div>
                <p className="m-0 mt-1 text-xs text-[var(--text-muted)] leading-snug">{t(face.taglineKey)}</p>
              </div>
            </div>
            {!isActive && swap.target === id && !swap.inProgress && (
              <button
                type="button"
                onClick={onSwap}
                data-testid="harness-swap-button"
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl btn-gradient text-sm font-medium text-white cursor-pointer"
              >
                <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>
                  swap_horiz
                </span>
                {t("settings.harnessSwapTo", { name: face.name })}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

type SwapStage = "confirm" | "running" | "done" | "failed";

/**
 * The swap's modal: first the question (the plan callout, what the swap does,
 * Cancel / Continue), then — once the owner has said yes — the progress of the
 * root step it started, in the same panel. The panel stays put through the
 * stages because a root step cannot be cancelled: there is nowhere for the
 * owner to go until it has finished or failed.
 */
function SwapDialog({
  target,
  swap,
  onClose,
}: {
  target: SwapHarness;
  swap: SwapStatus;
  /** `aftermath` says the box may have changed under the card (a swap that
      failed part-way), so the caller re-reads it; a Cancel touched nothing. */
  onClose: (aftermath: boolean) => void;
}) {
  const { t } = useT();
  const [stage, setStage] = useState<SwapStage>("confirm");
  const [phase, setPhase] = useState<SwapPhase>("request");
  const [lines, setLines] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const face = HARNESS_FACE[target];
  const plan = t(swap.planNameKey);

  // Escape and the backdrop dismiss the question and the failure notice, and
  // nothing else: a root step in flight cannot be called back, and a finished
  // one is about to reload the desktop.
  const dismiss = () => {
    if (stage === "running" || stage === "done") return;
    onClose(stage === "failed");
  };
  const panelRef = useModalDialog<HTMLDivElement>({ onClose: dismiss });
  // Focus lands on the primary control, as ConfirmDialog's does; the hook
  // puts it on the first control, which here is the callout's Upgrade link.
  // Two refs because the primary is a button on an allowed plan and a link
  // otherwise, and only one of them is ever mounted.
  const continueRef = useRef<HTMLButtonElement>(null);
  const upgradeRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    (continueRef.current ?? upgradeRef.current)?.focus();
  }, []);

  // The control that had focus unmounts with the question, and the trap only
  // pulls focus back on the NEXT Tab — so between Continue and that keystroke
  // the focus sat on <body>, outside a panel that had made everything else
  // inert. Put it on the stage's one control, or on the panel itself (the
  // hook's own convention for a control-less panel) while there is none.
  const closeRef = useRef<HTMLButtonElement>(null);
  const reloadRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (stage === "confirm") return;
    const control = stage === "failed" ? closeRef.current : stage === "done" ? reloadRef.current : null;
    (control ?? panelRef.current)?.focus();
  }, [stage, panelRef]);

  // The clock for the wait: a Hermes install is minutes of pip with long
  // silences, and the follow forwards only the journal's LAST line per poll,
  // so the pane can sit unchanged for a minute with nothing but the pulsing
  // chip to say the box is alive — the Voice tab's counter, for the same
  // reason. Started here, not in `start`: a synchronous setState there would
  // race the stage flip.
  useEffect(() => {
    if (stage !== "running") return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [stage]);

  const start = useCallback(async () => {
    setStage("running");
    setPhase("request");
    setLines([]);
    const fail = (body: unknown) => {
      setMessage(refusalText(t, body));
      setStage("failed");
    };
    try {
      const res = await fetch("/setup-api/harness/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ harness: target }),
      });
      if (!res.ok) {
        fail(await res.json().catch(() => ({})));
        return;
      }
      const outcome = await readSwapStream(res, (event) => {
        if (event.phase) setPhase(event.phase);
        const status = event.status;
        if (status) setLines((prev) => [...prev, status].slice(-LOG_LINES));
      });
      if (!outcome.ok) {
        fail(outcome);
        return;
      }
      setNotes(outcome.notes);
      setStage("done");
      // The desktop chat resolves its harness on mount and stays mounted, and
      // the client caches the edition for the page's life: only a reload
      // lands the whole desktop on the harness the box now runs. With notes
      // to read, the Reload button is that reload (see SUCCESS_RELOAD_HOLD_MS).
      if (outcome.notes.length === 0) window.setTimeout(() => window.location.reload(), SUCCESS_RELOAD_HOLD_MS);
    } catch {
      // A fetch that threw is a connection that went away, before or during
      // the stream; the swap on the box is not what threw.
      fail({ code: "stream_lost" });
    }
  }, [t, target]);

  const calloutBody = swap.businessPlanRequired
    ? swap.allowed
      ? t("settings.harnessSwapBusinessIncluded", { plan })
      : t("settings.harnessSwapBusinessRequired", { plan })
    : t("settings.harnessSwapBusinessBody", { plan });
  const currentIndex = SWAP_PHASES.indexOf(phase);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={dismiss}
    >
      {/* The role sits on the PANEL, where the trap is attached: on the
          backdrop the accessible dialog would be the whole viewport. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="harness-swap-title"
        data-testid="harness-swap-dialog"
        data-stage={stage}
        // Always focusable, so the stage effect above has somewhere to put the
        // focus while a stage has no control; negative, so the trap never
        // counts the panel as one of its Tab boundaries.
        tabIndex={-1}
        className="w-full max-w-lg rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-deep)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 pt-5">
          {/* eslint-disable-next-line @next/next/no-img-element -- same static asset as the tile's */}
          <img src={face.logo} alt="" width={32} height={32} className="shrink-0 rounded-md object-contain" />
          {/* The heading is the dialog's accessible name, so it says the
              stage: "Switching to Hermes…" over a red "the swap failed" was
              announced as exactly that contradiction. */}
          <h2 id="harness-swap-title" className="text-base font-semibold text-gray-100 break-words m-0">
            {stage === "running"
              ? t("settings.harnessSwapWorking", { name: face.name })
              : stage === "done"
                ? t("settings.harnessSwapDoneTitle", { name: face.name })
                : t("settings.harnessSwapTitle", { name: face.name })}
          </h2>
        </div>

        {stage === "confirm" ? (
          <>
            <div className="px-5 pt-4 flex flex-col gap-4">
              {/* The Business-plan callout, in the upgrade banner's own dress:
                  the plan the owner is on and the portal, whether or not the
                  gate is closed today. */}
              <div
                data-testid="harness-swap-callout"
                className="rounded-2xl px-4 py-3 flex items-center justify-between gap-3 bg-gradient-to-r from-fuchsia-500/15 to-pink-500/15 border border-fuchsia-400/30"
              >
                <div className="flex items-center gap-3 text-left">
                  <span aria-hidden="true" className="material-symbols-rounded text-fuchsia-300" style={{ fontSize: 22 }}>
                    redeem
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-[var(--text-primary)]">{t("settings.harnessSwapBusinessTitle")}</div>
                    <div className="text-xs text-[var(--text-muted)]">{calloutBody}</div>
                  </div>
                </div>
                <a
                  href={PORTAL_DASHBOARD_URL}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="harness-swap-upgrade-link"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-gradient-to-r from-fuchsia-500 to-pink-500 text-white shadow-[0_4px_12px_rgba(217,70,239,0.3)] whitespace-nowrap no-underline"
                >
                  {t("settings.harnessSwapUpgrade")}
                  <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 12 }}>open_in_new</span>
                </a>
              </div>
              <div>
                <h3 className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] m-0 mb-2">
                  {t("settings.harnessSwapWhatHappens")}
                </h3>
                <ul
                  data-testid="harness-swap-steps"
                  className="m-0 pl-4 list-disc flex flex-col gap-1 text-sm leading-relaxed text-[var(--text-secondary)]"
                >
                  {swapStepKeys(target).map((key) => (
                    <li key={key}>{t(key, { name: face.name })}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 pb-5 pt-4 mt-4 border-t border-[var(--border-subtle)]">
              <button
                type="button"
                onClick={() => onClose(false)}
                data-testid="harness-swap-cancel"
                className="px-4 py-2 rounded-lg text-sm font-medium border border-[var(--border-subtle)] text-gray-200 hover:bg-white/5 cursor-pointer"
              >
                {t("cancel")}
              </button>
              {swap.allowed ? (
                <button
                  ref={continueRef}
                  type="button"
                  onClick={() => void start()}
                  data-testid="harness-swap-continue"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg btn-gradient text-sm font-semibold text-white cursor-pointer"
                >
                  <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>swap_horiz</span>
                  {t("settings.harnessSwapContinue", { plan })}
                </button>
              ) : (
                // The gate is closed on this plan: the only way forward is the
                // portal, so that is the only primary control offered.
                <a
                  ref={upgradeRef}
                  href={PORTAL_DASHBOARD_URL}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="harness-swap-upgrade"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-gradient-to-r from-fuchsia-500 to-pink-500 no-underline cursor-pointer"
                >
                  <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>open_in_new</span>
                  {t("settings.harnessSwapUpgrade")}
                </a>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="px-5 pt-4 flex flex-col gap-3">
              <ol data-testid="harness-swap-phases" className="m-0 p-0 list-none flex flex-wrap gap-2">
                {SWAP_PHASES.map((p, i) => {
                  const state = stage === "done" || i < currentIndex ? "done" : i === currentIndex && stage === "running" ? "current" : "pending";
                  return (
                    <li
                      key={p}
                      data-testid={`harness-swap-phase-${p}`}
                      data-state={state}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                        state === "current"
                          ? "motion-safe:animate-pulse border-[var(--coral-bright)] text-[var(--text-primary)]"
                          : state === "done"
                            ? "border-emerald-400/40 text-emerald-300"
                            : "border-[var(--border-subtle)] text-[var(--text-muted)]"
                      }`}
                    >
                      <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 13 }}>
                        {state === "done" ? "check" : state === "current" ? "progress_activity" : "radio_button_unchecked"}
                      </span>
                      {t(PHASE_KEYS[p])}
                    </li>
                  );
                })}
              </ol>
              <div
                role="log"
                data-testid="harness-swap-log"
                className="rounded-xl border border-[var(--border-subtle)] bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)] min-h-[4.5rem] max-h-40 overflow-y-auto break-words"
              >
                {lines.map((line, i) => (
                  <div key={`${i}-${line}`}>{line}</div>
                ))}
              </div>
              {stage === "running" && (
                <p className="m-0 flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
                  <span>{t("settings.harnessSwapNoCancel")}</span>
                  <span data-testid="harness-swap-elapsed" className="tabular-nums whitespace-nowrap">
                    {t("settings.harnessSwapElapsed", { time: formatElapsed(elapsed) })}
                  </span>
                </p>
              )}
              {stage === "done" && (
                <div data-testid="harness-swap-done" role="status" className="text-sm text-emerald-300">
                  <p className="m-0 font-medium">
                    {notes.length > 0 ? t("settings.harnessSwapDoneRead") : t("settings.harnessSwapReloading")}
                  </p>
                  {notes.length > 0 && (
                    <ul className="m-0 mt-1 pl-4 list-disc text-xs text-[var(--text-secondary)]">
                      {notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {stage === "failed" && (
                <p data-testid="harness-swap-error" role="alert" className="m-0 text-sm text-red-300">
                  {message}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 px-5 pb-5 pt-4 mt-4 border-t border-[var(--border-subtle)]">
              {stage === "done" && notes.length > 0 && (
                <button
                  ref={reloadRef}
                  type="button"
                  onClick={() => window.location.reload()}
                  data-testid="harness-swap-reload"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg btn-gradient text-sm font-semibold text-white cursor-pointer"
                >
                  <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>refresh</span>
                  {t("settings.harnessSwapReloadNow")}
                </button>
              )}
              {stage === "failed" && (
                <button
                  ref={closeRef}
                  type="button"
                  onClick={() => onClose(true)}
                  data-testid="harness-swap-close"
                  className="px-4 py-2 rounded-lg text-sm font-medium border border-[var(--border-subtle)] text-gray-200 hover:bg-white/5 cursor-pointer"
                >
                  {t("settings.harnessSwapClose")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Lets the user pick which agent harness (OpenClaw / Hermes) backs the device.
// Both share one identity; providers stay per-harness. Self-contained so it
// drops into Settings → System with a single import.
export default function HarnessPicker() {
  const { t, locale } = useT();
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [swap, setSwap] = useState<SwapStatus | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [swapOpen, setSwapOpen] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    // Both reads in flight together, and both set in one go: the swap read is
    // what turns the badge into the tiles, and set on its own it would flash
    // the badge first on every open of the page.
    const swapRead = fetch("/setup-api/harness/swap", { cache: "no-store" })
      .then(async (res) => (res.ok ? readSwapStatus(await res.json()) : null))
      .catch(() => null);
    try {
      const res = await fetch("/setup-api/harness/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = await res.json();
      const swapBody = await swapRead;
      setStatus(body);
      setSwap(swapBody);
    } catch {
      setError("Could not load harness status");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A swap this tab is not following — another tab's, or one whose stream
  // this tab lost — ends without telling this page, and the page's cached
  // edition is wrong from that moment. Ask until it has ended, then reload,
  // for the reason the dialog reloads: nothing short of that lands the
  // desktop on the harness the box now runs. Only the tab that started the
  // swap reads `inProgress` false here, since its own dialog owns the reload.
  const inProgress = swap?.inProgress === true;
  useEffect(() => {
    if (!inProgress) return;
    let settled = false;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch("/setup-api/harness/swap", { cache: "no-store" });
        if (!res.ok) return;
        const next = readSwapStatus(await res.json());
        if (settled || !next || next.inProgress) return;
        settled = true;
        window.clearInterval(timer);
        window.location.reload();
      } catch {
        // The box is mid-swap and may not answer every tick; the next one asks again.
      }
    }, IN_PROGRESS_POLL_MS);
    return () => {
      settled = true;
      window.clearInterval(timer);
    };
  }, [inProgress]);

  const select = useCallback(
    async (id: string) => {
      if (switching || status?.active === id) return;
      setSwitching(id);
      setError("");
      try {
        const res = await fetch("/setup-api/harness/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ harness: id }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || t("settings.harnessSwitchFailed"));
        // The desktop chat resolves its harness on mount and stays mounted, so
        // a live switch wouldn't reach an already-open chat. Reload so the whole
        // desktop re-mounts against the newly-selected harness — a clean, sure
        // apply for a deliberate engine switch.
        window.location.reload();
        return;
      } catch (e) {
        setError(e instanceof Error ? e.message : t("settings.harnessSwitchFailed"));
        setSwitching(null);
      }
    },
    [switching, status, t],
  );

  const closeSwap = useCallback(
    (aftermath: boolean) => {
      setSwapOpen(false);
      // A swap that failed part-way may have left the box the other edition,
      // or with the request still in flight: the card must say what is there
      // now, not what it read before the owner pressed Continue.
      if (aftermath) void load();
    },
    [load],
  );

  const activeEntry = status?.harnesses?.find((h) => h.id === status.active);
  const warning = shellScanWarning(status?.shellScan, t, locale);
  // The tiles need a target to swap to and an active harness they can name;
  // anything else on a locked box is the badge.
  const tiles = status?.locked && swap?.swappable && swap.target && isSwapHarness(status.active) ? { active: status.active, target: swap.target, swap } : null;
  const inProgressName = tiles ? HARNESS_FACE[tiles.swap.inProgressTarget ?? tiles.target].name : "";

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>
          hub
        </span>
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest m-0">
          {t("settings.harnessTitle")}
        </h3>
      </div>
      <p className="text-xs text-[var(--text-muted)] mb-3">
        {t("settings.harnessHint")}
      </p>
      {tiles ? (
        <>
          <HarnessTiles
            active={tiles.active}
            activeHealthy={activeEntry?.healthy ?? false}
            swap={tiles.swap}
            onSwap={() => setSwapOpen(true)}
          />
          {tiles.swap.inProgress && (
            <div
              data-testid="harness-swap-in-progress"
              role="status"
              className="mt-3 flex items-center gap-2 rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-xs text-[var(--text-primary)]"
            >
              <span className="material-symbols-rounded text-amber-400 motion-safe:animate-spin shrink-0" style={{ fontSize: 16 }} aria-hidden="true">
                progress_activity
              </span>
              {t("settings.harnessSwapInProgress", { name: inProgressName })}
            </div>
          )}
          <div data-testid="harness-swap-plan" className="mt-3 text-xs text-[var(--text-muted)]">
            <p className="m-0 text-[var(--text-secondary)]">{t("settings.harnessSwapPlan", { plan: t(tiles.swap.planNameKey) })}</p>
            {/* The note says the gate's state today; once the gate is closed
                it says what opens it, and once the plan opens it there is
                nothing left to note. */}
            {!tiles.swap.businessPlanRequired && <p className="m-0 mt-0.5">{t("settings.harnessSwapPlanNote")}</p>}
            {tiles.swap.businessPlanRequired && !tiles.swap.allowed && (
              <p className="m-0 mt-0.5">{t("settings.harnessSwapRefusedPlan")}</p>
            )}
          </div>
          {swapOpen && <SwapDialog target={tiles.target} swap={tiles.swap} onClose={closeSwap} />}
        </>
      ) : status?.locked ? (
        // Single-harness edition with nothing to swap to (a dual box without
        // its licence, an edition nothing on the box named): no switcher,
        // just a read-only badge for the one agent this device runs.
        <div className="flex items-center justify-between rounded-xl border border-[var(--coral-bright)] bg-orange-500/10 p-3">
          <span className="flex items-center gap-2">
            {/* Same dot convention as the switcher below. A fixed green read
                "online" even when the status route had just reported the one
                harness this edition has as down — and here the badge is the
                only health signal the user gets. */}
            <span
              data-testid="harness-locked-dot"
              title={activeEntry && !activeEntry.healthy ? t("settings.harnessNotRunning", { name: activeEntry.label }) : undefined}
              className={`w-2 h-2 rounded-full ${activeEntry?.healthy ? "bg-emerald-400" : "bg-white/25"}`}
            />
            <span className="text-sm text-[var(--text-primary)] font-medium">
              {activeEntry?.label ?? status.active}
            </span>
          </span>
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
            <span className="material-symbols-rounded" style={{ fontSize: 13 }}>lock</span>
            {t("settings.harnessThisEdition")}
          </span>
        </div>
      ) : (
      <div className="grid grid-cols-2 gap-3">
        {(status?.harnesses ?? []).map((h) => {
          const active = status?.active === h.id;
          const busy = switching === h.id;
          return (
            <button
              key={h.id}
              onClick={() => select(h.id)}
              disabled={!!switching || active || !h.healthy}
              title={!h.healthy ? t("settings.harnessUnavailable", { name: h.label }) : undefined}
              className={`flex items-center justify-between rounded-xl border p-3 text-left transition-colors ${
                active
                  ? "border-[var(--coral-bright)] bg-orange-500/10"
                  : "border-[var(--border-subtle)] hover:border-[var(--coral-bright)]/50"
              }`}
            >
              <span className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${h.healthy ? "bg-emerald-400" : "bg-white/25"}`} />
                <span className="text-sm text-[var(--text-primary)] font-medium">{h.label}</span>
              </span>
              <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                {busy ? "…" : active ? t("settings.harnessActive") : h.healthy ? t("settings.harnessSwitch") : t("settings.harnessOffline")}
              </span>
            </button>
          );
        })}
      </div>
      )}
      {warning && (
        <div
          data-testid="shell-scan-warning"
          role={warning.severe ? "alert" : "status"}
          className="mt-3 flex items-start gap-2 rounded-xl border border-amber-400/40 bg-amber-400/10 p-3"
        >
          <span className="material-symbols-rounded text-amber-400 shrink-0" style={{ fontSize: 16 }} aria-hidden="true">
            warning
          </span>
          <div className="text-xs text-[var(--text-secondary)]">
            <h4 className="text-xs font-medium text-[var(--text-primary)] m-0">{warning.title}</h4>
            <p className="m-0 mt-0.5">{warning.detail}</p>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-red-400 mt-3">{error}</p>}
    </div>
  );
}
