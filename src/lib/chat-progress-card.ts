"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_MARKDOWN_CHARS } from "@/lib/progress-card-markdown";
import { retryWhileAgentStarting } from "@/lib/chat-gateway-starting";
import { boxAge, type BoxAgeUnit } from "@/lib/box-clock";
import { uuid } from "@/lib/chat-history-cache";

/**
 * The session's progress card, as the OpenClaw gateway serves it (TASK-896).
 *
 * The agent keeps ONE card per session with its `progress_card` tool — an
 * ordered plan checklist, a compact Markdown note, or both — and the gateway
 * stores it as durable session state (OpenClaw 2026.9.x,
 * docs/tools/progress-card.md; `src/gateway/server-methods/progress-card.ts`):
 *
 * - `progressCard.get { sessionKey, agentId? }` answers `{ card }`, where the
 *   card is `{ sessionKey, revision, updatedAt, markdown?, steps? }` or null.
 *   It needs `operator.read`, which the chat's `operator.admin` covers.
 * - `progressCard.changed { sessionKey, revision | null }` is broadcast after
 *   every write and every reset. It is a refresh HINT — the docs say a client
 *   "confirms a removal with a read" — so the chat answers it with a `get`,
 *   never by patching the card from the event. Its `sessionKey` is the
 *   gateway's agent-qualified display key (`agent:<agentId>:<key>`).
 *
 * Every write REPLACES the card; a card with both parts empty is a removal.
 * The transcript carries only a short receipt, so this read is the only way
 * the chat can show what the agent is working on.
 *
 * Putting it away (TASK-2147), the Control UI's three controls:
 *
 * - Dismiss (X) writes nothing to the gateway: the chat remembers the
 *   revision and `updatedAt` it hid, per session, in localStorage, and shows
 *   the card again only once the agent writes a different one.
 * - Clear (trash) is `progressCard.put { sessionKey, expectedRevision }` with
 *   no note and no plan — the Control UI's revision-checked shared clear: the
 *   answer is `{ card: null }` once it is gone, or the newer card when the
 *   agent wrote one in between, which is kept rather than erased.
 * - Refresh is `progressCard.refresh { sessionKey, idempotencyKey }`, which
 *   asks the agent to bring the card up to date. Its `{ revision }` answer
 *   only acknowledges the request; the refresh is done when a newer card is
 *   read, through the usual `progressCard.changed`.
 */

export const PROGRESS_CARD_GET_METHOD = "progressCard.get";
export const PROGRESS_CARD_PUT_METHOD = "progressCard.put";
export const PROGRESS_CARD_REFRESH_METHOD = "progressCard.refresh";
export const PROGRESS_CARD_CHANGED_EVENT = "progressCard.changed";

/** Where the chat keeps whether the owner folded the card, across reloads and both chat surfaces. */
export const PROGRESS_CARD_COLLAPSED_KEY = "clawbox-chat-progress-collapsed";

/** Where the chat keeps the cards the owner dismissed, per session, across reloads and both chat surfaces. */
export const PROGRESS_CARD_DISMISSED_KEY = "clawbox-chat-progress-dismissed";

/** How many sessions' dismissals are remembered; the oldest is forgotten first. */
export const MAX_PROGRESS_CARD_DISMISSALS = 30;

/** How long a refresh waits for the agent's newer card before saying none came yet (the Control UI's two minutes). */
export const PROGRESS_CARD_REFRESH_TIMEOUT_MS = 120_000;

// The gateway's own limits (packages/gateway-protocol/src/schema/progress-card.ts).
export const MAX_PROGRESS_STEPS = 50;
export const MAX_PROGRESS_STEP_CHARS = 512;

export type ProgressStepStatus = "pending" | "in_progress" | "completed";

export interface ProgressCardStep {
  step: string;
  status: ProgressStepStatus;
}

export interface ProgressCard {
  /** The gateway's agent-qualified key for the session the card belongs to. */
  sessionKey: string;
  revision: number;
  /** Epoch milliseconds of the agent's last write, or null when the gateway sent none. */
  updatedAt: number | null;
  markdown: string;
  steps: ProgressCardStep[];
}

export interface ProgressCardChange {
  sessionKey: string;
  revision: number | null;
}

/** The latest time a JavaScript Date can hold. */
const MAX_DATE_MS = 8.64e15;

// Zero-width and bidirectional controls: the gateway strips them before it
// stores a card, and a card written by an older gateway is cleaned here.
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStatus(value: unknown): ProgressStepStatus | null {
  return value === "pending" || value === "in_progress" || value === "completed" ? value : null;
}

/**
 * Validate the plan the way the gateway's schema does, keeping what can be
 * shown: an entry without step text or with an unknown status is dropped, the
 * list stops at 50, and a step is cut at 512 characters. The docs allow at
 * most one `in_progress` step; should a card ever carry more, the first stays
 * the step the agent is on and the others read as pending, so the checklist
 * never claims two things are happening at once.
 */
export function parseProgressSteps(raw: unknown): ProgressCardStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: ProgressCardStep[] = [];
  let active = false;
  for (const entry of raw) {
    if (steps.length >= MAX_PROGRESS_STEPS) break;
    if (!isRecord(entry)) continue;
    const status = parseStatus(entry.status);
    if (status === null || typeof entry.step !== "string") continue;
    const text = entry.step.replace(INVISIBLE_RE, "").replace(/\s+/g, " ").trim().slice(0, MAX_PROGRESS_STEP_CHARS);
    if (text === "") continue;
    if (status === "in_progress") {
      steps.push({ step: text, status: active ? "pending" : "in_progress" });
      active = true;
    } else {
      steps.push({ step: text, status });
    }
  }
  return steps;
}

/**
 * One card from the wire, or null when there is nothing to show — no card,
 * a malformed one, or a card whose note is blank and whose plan is empty
 * (the documented way to clear it).
 */
export function parseProgressCard(raw: unknown): ProgressCard | null {
  if (!isRecord(raw)) return null;
  const steps = parseProgressSteps(raw.steps);
  const markdown = typeof raw.markdown === "string" ? raw.markdown.slice(0, MAX_MARKDOWN_CHARS) : "";
  if (markdown.trim() === "" && steps.length === 0) return null;
  const revision = typeof raw.revision === "number" && Number.isFinite(raw.revision) ? raw.revision : 0;
  // Past 8.64e15 ms a Date is invalid and `toISOString` throws, so such a time is no time at all.
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 && raw.updatedAt <= MAX_DATE_MS
    ? raw.updatedAt
    : null;
  return {
    sessionKey: typeof raw.sessionKey === "string" ? raw.sessionKey : "",
    revision,
    updatedAt,
    markdown,
    steps,
  };
}

/** The card inside a `progressCard.get` answer (`{ card }`). */
export function parseProgressCardResponse(payload: unknown): ProgressCard | null {
  return isRecord(payload) ? parseProgressCard(payload.card) : null;
}

/** A `progressCard.changed` event's payload, or null when it is not one. */
export function parseProgressCardChanged(payload: unknown): ProgressCardChange | null {
  if (!isRecord(payload) || typeof payload.sessionKey !== "string" || payload.sessionKey.trim() === "") return null;
  const revision = typeof payload.revision === "number" && Number.isFinite(payload.revision) ? payload.revision : null;
  return { sessionKey: payload.sessionKey, revision };
}

const AGENT_KEY_RE = /^agent:[^:]+:.+$/i;

/**
 * The gateway's display key for a session (`sessionObserverScopeKey`): an
 * agent-qualified key as it is, anything else qualified with its agent.
 */
export function progressCardScopeKey(sessionKey: string, agentId = "main"): string {
  const key = sessionKey.trim().toLowerCase();
  return AGENT_KEY_RE.test(key) ? key : `agent:${agentId.trim().toLowerCase() || "main"}:${key}`;
}

/**
 * Is a `progressCard.changed` about the session this chat shows?
 *
 * The event names the session by its agent-qualified key; the chat holds
 * whatever key the hello (or a tab) gave it — usually already qualified
 * (`agent:main:main`), but a bare `main` is legal too. The key the gateway
 * returned WITH the last card is the exact answer when there is one; without
 * a card yet, a bare key matches that key under any agent, since the chat
 * does not know which agent owns it. A false match costs one extra read of
 * this chat's own card and nothing else; a missed one leaves a stale card.
 */
export function progressCardEventMatches(eventKey: string, sessionKey: string, knownScopeKey: string | null = null): boolean {
  const event = eventKey.trim().toLowerCase();
  const own = sessionKey.trim().toLowerCase();
  if (event === "" || own === "") return false;
  if (knownScopeKey && event === knownScopeKey.trim().toLowerCase()) return true;
  if (event === own || event === progressCardScopeKey(own)) return true;
  if (AGENT_KEY_RE.test(own)) return false;
  const parts = /^agent:[^:]+:(.+)$/.exec(event);
  return parts !== null && parts[1] === own;
}

/** The step the agent is on — the one `in_progress`, else the next one pending — or null once none is left. */
export function progressCardCurrentStep(card: Pick<ProgressCard, "steps">): ProgressCardStep | null {
  return card.steps.find((s) => s.status === "in_progress") ?? card.steps.find((s) => s.status === "pending") ?? null;
}

export function progressCardCounts(card: Pick<ProgressCard, "steps">): { done: number; total: number } {
  return { done: card.steps.filter((s) => s.status === "completed").length, total: card.steps.length };
}

export type ProgressCardAgeUnit = BoxAgeUnit;

/**
 * How long ago the agent last wrote the card, in the one unit the header
 * says ("Updated 2h ago"), on the box's clock (`now` is `boxNowMs()`, as
 * `updatedAt` is the gateway's): src/lib/box-clock.ts's `boxAge`. A time a
 * little in the future — what is left of the two clocks' disagreement — reads
 * as just now; one far ahead is `ahead`, and the header prints the time.
 */
export function progressCardAge(updatedAt: number | null, now: number): { unit: ProgressCardAgeUnit; n: number } | null {
  if (updatedAt === null) return null;
  return boxAge(updatedAt, now);
}

/** Whether the owner folded the card. Absent or unreadable storage means open. */
export function readProgressCardCollapsed(storage: Pick<Storage, "getItem"> | null | undefined = safeLocalStorage()): boolean {
  try {
    return storage?.getItem(PROGRESS_CARD_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeProgressCardCollapsed(
  collapsed: boolean,
  storage: Pick<Storage, "setItem"> | null | undefined = safeLocalStorage(),
): void {
  try {
    storage?.setItem(PROGRESS_CARD_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* storage unavailable (private mode, quota) — the fold simply lasts for this page */
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The card the owner hid in one session: the write it was, and when it was hidden. */
export interface ProgressCardDismissal {
  revision: number;
  updatedAt: number | null;
  at: number;
}

export type ProgressCardDismissals = Record<string, ProgressCardDismissal>;

/**
 * The session a dismissal is filed under: the card's agent-qualified key, so
 * `main` and `agent:main:main` are one session. A card from a gateway that
 * named no session files under "" — still matched by its revision and time.
 */
export function progressCardDismissKey(card: Pick<ProgressCard, "sessionKey">): string {
  return card.sessionKey.trim() === "" ? "" : progressCardScopeKey(card.sessionKey);
}

/** Every remembered dismissal. Absent, unreadable or malformed storage means none. */
export function readProgressCardDismissals(
  storage: Pick<Storage, "getItem"> | null | undefined = safeLocalStorage(),
): ProgressCardDismissals {
  let raw: unknown;
  try {
    const text = storage?.getItem(PROGRESS_CARD_DISMISSED_KEY);
    raw = text ? JSON.parse(text) : null;
  } catch {
    return {};
  }
  if (!isRecord(raw)) return {};
  const out: ProgressCardDismissals = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!isRecord(entry) || typeof entry.revision !== "number" || !Number.isFinite(entry.revision)) continue;
    const updatedAt = typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : null;
    const at = typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : 0;
    out[key] = { revision: entry.revision, updatedAt, at };
  }
  return out;
}

/**
 * Whether this exact card is one the owner dismissed. Any write by the agent
 * moves the revision and the time, so the next update shows again; the time
 * is compared too because a card created after a clear can start counting
 * revisions over.
 */
export function isProgressCardDismissed(
  card: Pick<ProgressCard, "sessionKey" | "revision" | "updatedAt">,
  dismissals: ProgressCardDismissals,
): boolean {
  const entry = dismissals[progressCardDismissKey(card)];
  return entry !== undefined && entry.revision === card.revision && entry.updatedAt === card.updatedAt;
}

function writeDismissals(dismissals: ProgressCardDismissals, storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined): void {
  try {
    if (Object.keys(dismissals).length === 0) storage?.removeItem(PROGRESS_CARD_DISMISSED_KEY);
    else storage?.setItem(PROGRESS_CARD_DISMISSED_KEY, JSON.stringify(dismissals));
  } catch {
    /* storage unavailable — the dismissal simply lasts for this page */
  }
}

/**
 * Remember that the owner dismissed this card, replacing whatever was
 * dismissed before in its session, and keep only the newest
 * `MAX_PROGRESS_CARD_DISMISSALS` sessions. Returns what is remembered now.
 */
export function writeProgressCardDismissal(
  card: Pick<ProgressCard, "sessionKey" | "revision" | "updatedAt">,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined = safeLocalStorage(),
  now: number = Date.now(),
): ProgressCardDismissals {
  const all = readProgressCardDismissals(storage);
  all[progressCardDismissKey(card)] = { revision: card.revision, updatedAt: card.updatedAt, at: now };
  const kept = Object.fromEntries(
    Object.entries(all).sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_PROGRESS_CARD_DISMISSALS),
  );
  writeDismissals(kept, storage);
  return kept;
}

/** Forget a session's dismissal — its card was cleared, so there is nothing left to hide. */
export function forgetProgressCardDismissal(
  card: Pick<ProgressCard, "sessionKey">,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined = safeLocalStorage(),
): ProgressCardDismissals {
  const all = readProgressCardDismissals(storage);
  const key = progressCardDismissKey(card);
  if (!(key in all)) return all;
  delete all[key];
  writeDismissals(all, storage);
  return all;
}

/**
 * Whether the card on screen is one the owner dismissed, and the X that
 * dismisses it. A dismissal made in another tab (the popup and the full page)
 * applies here at once, through the `storage` event.
 */
export function useProgressCardDismissal(card: ProgressCard): {
  dismissed: boolean;
  dismiss: () => void;
  forget: () => void;
} {
  const [dismissals, setDismissals] = useState<ProgressCardDismissals>(() => readProgressCardDismissals());

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === PROGRESS_CARD_DISMISSED_KEY || event.key === null) setDismissals(readProgressCardDismissals());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const dismiss = useCallback(() => setDismissals(writeProgressCardDismissal(card)), [card]);
  const forget = useCallback(() => setDismissals(forgetProgressCardDismissal(card)), [card]);
  return { dismissed: isProgressCardDismissed(card, dismissals), dismiss, forget };
}

export type ProgressCardRequest = (method: string, params: unknown) => Promise<unknown>;

/**
 * Where a refresh the owner asked for stands: `pending` until the agent's
 * newer card is read, `failed` when the gateway refused the request,
 * `timeout` when no newer card came within two minutes (the request may
 * still be running), and `idle` otherwise.
 */
export type ProgressCardRefreshState = "idle" | "pending" | "failed" | "timeout";

/**
 * The chat's copy of its session's card.
 *
 * Reads the card whenever the socket is (re)connected or the chat moves to
 * another session, and again on every `progressCard.changed` that names this
 * session — the caller hands those events in through `onChanged`. An answer
 * older than the one on screen is never applied, so a slow answer cannot put
 * back a card a later write (or a clear) replaced. A read that fails keeps the card already on screen
 * (the docs' "transient refresh failures retain the last loaded card"); a
 * gateway that predates the method simply never shows one.
 *
 * `clear` and `refresh` are the card's trash and refresh buttons (see the
 * file's header); `refreshState` is where the last refresh of THIS session
 * stands.
 */
export function useGatewayProgressCard({
  request,
  sessionKey,
  enabled,
}: {
  request: ProgressCardRequest;
  sessionKey: string;
  enabled: boolean;
}): {
  card: ProgressCard | null;
  onChanged: (payload: unknown) => void;
  clear: (card: ProgressCard) => Promise<boolean>;
  refresh: () => void;
  refreshState: ProgressCardRefreshState;
} {
  const [loaded, setLoaded] = useState<{ key: string; card: ProgressCard | null }>({ key: "", card: null });
  // `accepted`: the gateway has answered the request with its own baseline;
  // until then no card can count as the refresh done.
  const [refreshing, setRefreshing] = useState<{
    key: string;
    state: ProgressCardRefreshState;
    baseline: number;
    attempt: number;
    accepted: boolean;
  }>({ key: "", state: "idle", baseline: 0, attempt: 0, accepted: false });
  const sequenceRef = useRef(0);
  /** The sequence of the newest answer shown: an older one landing later is never applied. */
  const appliedRef = useRef(0);
  const scopeKeyRef = useRef<string | null>(null);
  const liveRef = useRef({ request, sessionKey, enabled });
  const revisionRef = useRef<number | null>(null);
  /** The read still waiting for a starting agent, if any. */
  const waitRef = useRef<AbortController | null>(null);
  const refreshAttemptRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    liveRef.current = { request, sessionKey, enabled };
  }, [request, sessionKey, enabled]);
  useEffect(() => () => {
    waitRef.current?.abort();
    if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
  }, []);

  /**
   * Show what the gateway answered for `key` — unless a newer answer is on
   * screen already — and settle a refresh it answers.
   */
  const apply = useCallback((sequence: number, key: string, card: ProgressCard | null) => {
    if (sequence <= appliedRef.current || liveRef.current.sessionKey !== key) return;
    appliedRef.current = sequence;
    if (card?.sessionKey) scopeKeyRef.current = card.sessionKey;
    revisionRef.current = card?.revision ?? null;
    setLoaded({ key, card });
    // A card newer than the gateway's baseline is the refresh done (or the
    // agent moving on, which answers it as well); so is a clear. Before the
    // gateway has named its baseline, a newer card may be a write it already
    // had, so a pending refresh waits for that answer.
    setRefreshing((prev) => {
      if (prev.key !== key || prev.state === "idle" || (prev.state === "pending" && !prev.accepted)) return prev;
      return card === null || card.revision > prev.baseline ? { ...prev, state: "idle" } : prev;
    });
  }, []);

  const read = useCallback(() => {
    const { request: send, sessionKey: key, enabled: on } = liveRef.current;
    if (!on || key === "") return;
    const sequence = ++sequenceRef.current;
    // A read on a reconnect can come before the agent has finished starting;
    // that refusal is waited out (bounded) instead of leaving the card unread
    // until the agent next changes it. A newer read calls the wait off.
    waitRef.current?.abort();
    const waiting = new AbortController();
    waitRef.current = waiting;
    retryWhileAgentStarting(() => send(PROGRESS_CARD_GET_METHOD, { sessionKey: key }), { signal: waiting.signal }).then(
      (payload) => apply(sequence, key, parseProgressCardResponse(payload)),
      () => {
        /* keep what is on screen; the next change or reconnect reads again */
      },
    );
  }, [apply]);

  useEffect(() => {
    // A different session's card must never be shown under this one, and its
    // exact key is not this session's either.
    scopeKeyRef.current = null;
    revisionRef.current = null;
    if (!enabled || sessionKey === "") return;
    read();
  }, [enabled, sessionKey, read]);

  const onChanged = useCallback((payload: unknown) => {
    const change = parseProgressCardChanged(payload);
    const { sessionKey: key, enabled: on } = liveRef.current;
    if (!change || !on || !progressCardEventMatches(change.sessionKey, key, scopeKeyRef.current)) return;
    // The card on screen already IS this revision (the event trailed our own read).
    if (change.revision !== null && change.revision === revisionRef.current) return;
    read();
  }, [read]);

  /**
   * Clear the session's saved card, if it is still the one the owner saw.
   * Resolves true once it is gone and false when the agent wrote a newer one
   * in between (shown instead); rejects when the gateway refused, leaving the
   * card on screen.
   */
  const clear = useCallback(async (shown: ProgressCard): Promise<boolean> => {
    const { request: send, sessionKey: key, enabled: on } = liveRef.current;
    if (!on || key === "") throw new Error("Not connected");
    // Never an unchecked clear: without the revision the owner saw, a newer card could be erased.
    if (!Number.isInteger(shown.revision) || shown.revision < 1) throw new Error("The card has no revision to clear");
    // Numbered with the reads: one asked before the clear and answered after it cannot put the card back.
    const sequence = ++sequenceRef.current;
    const payload = await send(PROGRESS_CARD_PUT_METHOD, { sessionKey: key, expectedRevision: shown.revision });
    const card = parseProgressCardResponse(payload);
    apply(sequence, key, card);
    return card === null;
  }, [apply]);

  /** Ask the agent to bring the card up to date; done when a newer card is read. */
  const refresh = useCallback(() => {
    const { request: send, sessionKey: key, enabled: on } = liveRef.current;
    if (!on || key === "") return;
    const attempt = ++refreshAttemptRef.current;
    const baseline = revisionRef.current ?? 0;
    setRefreshing({ key, state: "pending", baseline, attempt, accepted: false });
    if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
    // A timeout does not cancel the agent's work; it only stops the spinner.
    refreshTimerRef.current = setTimeout(() => {
      setRefreshing((prev) => (prev.attempt === attempt && prev.state === "pending" ? { ...prev, state: "timeout" } : prev));
    }, PROGRESS_CARD_REFRESH_TIMEOUT_MS);
    send(PROGRESS_CARD_REFRESH_METHOD, { sessionKey: key, idempotencyKey: uuid() }).then(
      (payload) => {
        // The gateway's own baseline: a card it had that this chat had not read yet is not the refresh.
        const revision = isRecord(payload) && typeof payload.revision === "number" && Number.isFinite(payload.revision) ? payload.revision : 0;
        // What is on screen may already be past it (the agent wrote while this answer travelled).
        const shownKey = liveRef.current.sessionKey;
        const shown = revisionRef.current;
        setRefreshing((prev) => {
          if (prev.attempt !== attempt || prev.state !== "pending") return prev;
          const settled = Math.max(prev.baseline, revision);
          const done = shownKey === prev.key && shown !== null && shown > settled;
          return { ...prev, accepted: true, baseline: settled, state: done ? "idle" : "pending" };
        });
      },
      () => {
        setRefreshing((prev) => (prev.attempt === attempt && prev.state === "pending" ? { ...prev, state: "failed" } : prev));
      },
    );
  }, []);

  const card = enabled && loaded.key === sessionKey ? loaded.card : null;
  const refreshState = enabled && refreshing.key === sessionKey ? refreshing.state : "idle";
  return { card, onChanged, clear, refresh, refreshState };
}
