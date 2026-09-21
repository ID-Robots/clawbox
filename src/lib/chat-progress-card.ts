"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_MARKDOWN_CHARS } from "@/lib/progress-card-markdown";

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
 */

export const PROGRESS_CARD_GET_METHOD = "progressCard.get";
export const PROGRESS_CARD_CHANGED_EVENT = "progressCard.changed";

/** Where the chat keeps whether the owner folded the card, across reloads and both chat surfaces. */
export const PROGRESS_CARD_COLLAPSED_KEY = "clawbox-chat-progress-collapsed";

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
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) && raw.updatedAt > 0
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

export type ProgressCardAgeUnit = "now" | "minutes" | "hours" | "days";

/**
 * How long ago the agent last wrote the card, in the one unit the header
 * says ("Updated 2h ago"). A time in the future — the browser's clock behind
 * the box's — reads as just now rather than as a negative age.
 */
export function progressCardAge(updatedAt: number | null, now: number): { unit: ProgressCardAgeUnit; n: number } | null {
  if (updatedAt === null || !Number.isFinite(updatedAt) || !Number.isFinite(now)) return null;
  const elapsed = Math.max(0, now - updatedAt);
  if (elapsed < 60_000) return { unit: "now", n: 0 };
  if (elapsed < 3_600_000) return { unit: "minutes", n: Math.floor(elapsed / 60_000) };
  if (elapsed < 86_400_000) return { unit: "hours", n: Math.floor(elapsed / 3_600_000) };
  return { unit: "days", n: Math.floor(elapsed / 86_400_000) };
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

export type ProgressCardRequest = (method: string, params: unknown) => Promise<unknown>;

/**
 * The chat's copy of its session's card.
 *
 * Reads the card whenever the socket is (re)connected or the chat moves to
 * another session, and again on every `progressCard.changed` that names this
 * session — the caller hands those events in through `onChanged`. Only the
 * newest read is ever applied, so a slow answer cannot put back a card a
 * later write replaced. A read that fails keeps the card already on screen
 * (the docs' "transient refresh failures retain the last loaded card"); a
 * gateway that predates the method simply never shows one.
 */
export function useGatewayProgressCard({
  request,
  sessionKey,
  enabled,
}: {
  request: ProgressCardRequest;
  sessionKey: string;
  enabled: boolean;
}): { card: ProgressCard | null; onChanged: (payload: unknown) => void } {
  const [loaded, setLoaded] = useState<{ key: string; card: ProgressCard | null }>({ key: "", card: null });
  const sequenceRef = useRef(0);
  const scopeKeyRef = useRef<string | null>(null);
  const liveRef = useRef({ request, sessionKey, enabled });
  const revisionRef = useRef<number | null>(null);

  useEffect(() => {
    liveRef.current = { request, sessionKey, enabled };
  }, [request, sessionKey, enabled]);

  const refresh = useCallback(() => {
    const { request: send, sessionKey: key, enabled: on } = liveRef.current;
    if (!on || key === "") return;
    const sequence = ++sequenceRef.current;
    send(PROGRESS_CARD_GET_METHOD, { sessionKey: key }).then(
      (payload) => {
        if (sequence !== sequenceRef.current || liveRef.current.sessionKey !== key) return;
        const card = parseProgressCardResponse(payload);
        if (card?.sessionKey) scopeKeyRef.current = card.sessionKey;
        revisionRef.current = card?.revision ?? null;
        setLoaded({ key, card });
      },
      () => {
        /* keep what is on screen; the next change or reconnect reads again */
      },
    );
  }, []);

  useEffect(() => {
    // A different session's card must never be shown under this one, and its
    // exact key is not this session's either.
    scopeKeyRef.current = null;
    revisionRef.current = null;
    if (!enabled || sessionKey === "") return;
    refresh();
  }, [enabled, sessionKey, refresh]);

  const onChanged = useCallback((payload: unknown) => {
    const change = parseProgressCardChanged(payload);
    const { sessionKey: key, enabled: on } = liveRef.current;
    if (!change || !on || !progressCardEventMatches(change.sessionKey, key, scopeKeyRef.current)) return;
    // The card on screen already IS this revision (the event trailed our own read).
    if (change.revision !== null && change.revision === revisionRef.current) return;
    refresh();
  }, [refresh]);

  const card = enabled && loaded.key === sessionKey ? loaded.card : null;
  return { card, onChanged };
}
