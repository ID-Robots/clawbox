"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { uuid } from "@/lib/chat-history-cache";
import type { ChatAttachment } from "@/lib/chat-attachments";
import type { HarnessAdapter } from "@/lib/harness/transport";
import {
  LOCAL_COMPACTION_DEADLINE_MS,
  compactionFramePhase,
  localTurnPhase,
  tooLongForLocal,
  type LocalTurnPhase,
} from "@/lib/chat-local-fit";

/**
 * The chat's side of a long conversation on Local AI (TASK-2127) — the rules
 * are in src/lib/chat-local-fit.ts, the card in LocalAiLongChatOffer.tsx.
 *
 * While the chat is on Local AI, the conversation on screen is measured (the
 * harness's own numbers, `adapter.conversationSize`) between turns. One too
 * long for the local window gets the card, and a message sent into it waits
 * on the card instead of starting a compaction on the box: "Start a new chat
 * with Local AI" opens a tab and sends it there, "Shorten this conversation
 * first" runs the harness's compaction (bounded) and then sends it here, the
 * × puts it back in the composer and lets the owner carry on as they are.
 *
 * During a local turn it also answers what the status line may say: shortening
 * while a compaction runs (the gateway's compaction frames, or — on a turn sent
 * into a conversation known to be too long — until the first token), loading
 * only while llama-server answers that it is not ready, and it stops a turn
 * still shortening after LOCAL_COMPACTION_DEADLINE_MS with the new-chat offer.
 */

/** A message held for the owner's choice. */
export interface LongChatPending {
  text: string;
  attachments: ChatAttachment[];
  voice?: boolean;
  asked?: boolean;
}

export interface LongChatOffer {
  key: string;
  /** `fit`: too long, both choices. `timeout`/`failed`: shortening did not finish — a new chat. */
  kind: "fit" | "timeout" | "failed";
  tokens: number | null;
  window: number | null;
  pending: LongChatPending | null;
}

interface FitVerdict {
  long: boolean;
  tokens: number | null;
  window: number | null;
  /** The owner closed the card: this conversation is sent as it is from now on. */
  dismissed?: boolean;
}

export interface LocalAiLongChatOptions {
  adapter: HarnessAdapter;
  /** The chat answers on Local AI (`chatOnLocalAi`). */
  onLocalAi: boolean;
  /** …on llama.cpp, whose readiness /setup-api/llamacpp/status can tell. */
  llamaCpp: boolean;
  /** The local model's window, when the harness's size answer does not carry one. */
  localWindow: number | null;
  /**
   * Whether a turn sent into a conversation known to be too long counts as
   * shortening until it is heard from. True for OpenClaw, which compacts such a
   * prompt before the model reads it and whose compaction frames for it arrive
   * under an internal session key. False for Hermes, which reports its own
   * compaction (`status.update` kind `compacting`) and, measured on a board,
   * may instead read the whole history into the local window without
   * compacting — "shortening" would be the wrong word for that wait.
   */
  inferCompaction?: boolean;
  /** The conversation on screen. */
  activeKey: string;
  /** The harness can be asked (the gateway socket is open, where there is one). */
  connected: boolean;
  sending: boolean;
  /**
   * Moves when the transcript on screen changes — its history landed, a turn
   * was added. Hermes learns a conversation's session from its history, so a
   * measure taken the moment its tab opened has nothing to ask about yet.
   */
  historyMark: number;
  turnHeardFrom: boolean;
  turnStartedAt: number;
  sessionKeyRef: MutableRefObject<string>;
  /** Open a new tab and resolve with its key once it is on screen (null when it could not). */
  openNewChat: () => Promise<string | null>;
  /** Send `pending` as the owner's turn in `key` — on screen, or when its tab is next opened. */
  queueSend: (key: string, pending: LongChatPending) => void;
  /** Put a held message back in the composer of `key`. */
  restoreDraft: (key: string, text: string) => void;
  /** A one-line system note in `key`'s transcript. */
  noteSystem: (key: string, text: string) => void;
  /** "Conversation shortened for the local model." in the owner's language. */
  shortenedText: string;
  abortTurn: () => Promise<void> | void;
  fetchImpl?: typeof fetch;
}

export interface LocalAiLongChat {
  /** The card for the conversation on screen, while the chat is on Local AI. */
  offer: LongChatOffer | null;
  /** When the conversation on screen started shortening (0: it is not). */
  shorteningSince: number;
  /** What the status line of the running turn names (see `localTurnPhase`). */
  phase: LocalTurnPhase;
  /**
   * A turn is about to start in `key`. True when it is HELD for the owner's
   * choice instead — the caller must then not send it; false when it may go.
   */
  admitTurn: (key: string, pending: LongChatPending) => boolean;
  /** Every gateway `agent` frame of the conversation on screen. */
  noteAgentFrame: (payload: unknown) => void;
  startNewChat: () => void;
  shorten: () => void;
  dismiss: () => void;
}

export const LLAMACPP_STATUS_ROUTE = "/setup-api/llamacpp/status";
/** How often a local turn waiting for its first token asks whether llama-server is up. */
export const LLAMACPP_READY_POLL_MS = 2500;
/** How long the measure after a shorten may take before its answer counts as unknown. */
export const SHORTEN_REMEASURE_MS = 15_000;

function bounded<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function joinPending(prev: LongChatPending | null, next: LongChatPending): LongChatPending {
  if (!prev) return next;
  return {
    text: [prev.text, next.text].filter(Boolean).join("\n\n"),
    attachments: [...prev.attachments, ...next.attachments],
    voice: prev.voice || next.voice,
    asked: prev.asked || next.asked,
  };
}

export function useLocalAiLongChat(options: LocalAiLongChatOptions): LocalAiLongChat {
  const { adapter, onLocalAi, llamaCpp, localWindow, activeKey, connected, sending, historyMark, turnHeardFrom, turnStartedAt } = options;
  // Everything a callback needs at call time, never a closure's copy.
  const optsRef = useRef(options);
  useEffect(() => { optsRef.current = options; });

  const fitRef = useRef(new Map<string, FitVerdict>());
  const [offers, setOffers] = useState<Record<string, LongChatOffer>>({});
  const offersRef = useRef(offers);
  useEffect(() => { offersRef.current = offers; }, [offers]);
  const [shortening, setShortening] = useState<{ key: string; since: number } | null>(null);
  const shorteningRef = useRef(shortening);
  useEffect(() => { shorteningRef.current = shortening; }, [shortening]);
  const [measureEpoch, setMeasureEpoch] = useState(0);

  // The running turn.
  const [compactingSince, setCompactingSince] = useState(0);
  const [framesSeen, setFramesSeen] = useState(false);
  const [turnLong, setTurnLong] = useState(false);
  const [serverReady, setServerReady] = useState<boolean | null>(null);
  const turnRef = useRef<{ key: string; pending: LongChatPending } | null>(null);
  const sendingRef = useRef(sending);
  useEffect(() => { sendingRef.current = sending; }, [sending]);
  useEffect(() => {
    if (sending) return;
    setCompactingSince(0);
    setFramesSeen(false);
    setTurnLong(false);
    setServerReady(null);
  }, [sending]);

  // Measure the conversation on screen between turns while on Local AI: on the
  // switch, on a tab change, once the socket is up, after every turn (whose
  // compaction may have made it fit) and after a shorten.
  useEffect(() => {
    if (!onLocalAi || !connected || !activeKey || sending || !adapter.conversationSize) return;
    if (fitRef.current.get(activeKey)?.dismissed) return;
    let cancelled = false;
    void adapter.conversationSize(activeKey).then((size) => {
      // Unknown is not "fits": nothing is recorded, and the next mark asks again.
      if (cancelled || !size) return;
      const window = size?.window ?? localWindow;
      const long = tooLongForLocal(size, window);
      const tokens = size?.tokens ?? null;
      // What the card names as the local model's room: the harness's own line
      // when it gives one (Hermes compresses at half its 64k window, so "reads
      // up to 65k" over a 52k conversation called too long would contradict
      // itself), the window otherwise.
      const room = size?.limit ?? window ?? null;
      const prevVerdict = fitRef.current.get(activeKey);
      if (prevVerdict?.dismissed) return;
      fitRef.current.set(activeKey, { long, tokens, window: room });
      setOffers((prev) => {
        const current = prev[activeKey];
        if (long) {
          if (current && current.kind !== "fit") return prev;
          return { ...prev, [activeKey]: { key: activeKey, kind: "fit", tokens, window: room, pending: current?.pending ?? null } };
        }
        // It fits now: a plain card goes; one holding a message stays for its choice.
        return current && current.kind === "fit" && !current.pending ? without(prev, activeKey) : prev;
      });
    });
    return () => { cancelled = true; };
  }, [adapter, onLocalAi, connected, activeKey, sending, historyMark, localWindow, measureEpoch]);

  const admitTurn = useCallback((key: string, pending: LongChatPending): boolean => {
    if (!optsRef.current.onLocalAi) {
      turnRef.current = null;
      setTurnLong(false);
      return false;
    }
    const verdict = fitRef.current.get(key);
    const held = shorteningRef.current?.key === key || Boolean(verdict?.long && !verdict.dismissed);
    if (!held) {
      turnRef.current = { key, pending };
      setTurnLong(Boolean(verdict?.long));
      return false;
    }
    setOffers((prev) => {
      const current = prev[key] ?? {
        key, kind: "fit" as const, tokens: verdict?.tokens ?? null, window: verdict?.window ?? null, pending: null,
      };
      return { ...prev, [key]: { ...current, pending: joinPending(current.pending, pending) } };
    });
    return true;
  }, []);

  const noteAgentFrame = useCallback((payload: unknown) => {
    const phase = compactionFramePhase(payload);
    // A compaction after the reply (the core's post-turn maintenance) is not
    // this turn's, and must not leave a stale "since" for the next one.
    if (!phase || !sendingRef.current) return;
    setFramesSeen(true);
    setCompactingSince(phase === "start" ? Date.now() : 0);
  }, []);

  // Is llama-server ready? Asked while a local turn waits for its first token;
  // latched once it says yes, since a server does not unload mid-request.
  const readyLatched = serverReady === true;
  useEffect(() => {
    if (!sending || !onLocalAi || !llamaCpp || turnHeardFrom || readyLatched) return;
    let stopped = false;
    const doFetch = optsRef.current.fetchImpl ?? fetch;
    const probe = async () => {
      try {
        const res = await doFetch(LLAMACPP_STATUS_ROUTE, { cache: "no-store" });
        const body = res.ok ? await res.json() as { running?: unknown } : null;
        if (!stopped && typeof body?.running === "boolean") setServerReady(body.running);
      } catch {
        /* unknown stays unknown: never read as "loading" */
      }
    };
    void probe();
    const id = setInterval(() => { void probe(); }, LLAMACPP_READY_POLL_MS);
    return () => { stopped = true; clearInterval(id); };
  }, [sending, onLocalAi, llamaCpp, turnHeardFrom, readyLatched]);

  // Shortening without a frame to say so: a turn sent into a conversation
  // known to be too long, until the harness is heard from.
  const inferred = options.inferCompaction !== false && turnLong && !framesSeen && !turnHeardFrom;
  const compacting = compactingSince > 0 || inferred;
  const phase = onLocalAi && sending
    ? localTurnPhase({ compacting, serverReady, llamaCpp, heardFrom: turnHeardFrom })
    : null;

  // The bound: a local turn still shortening after the deadline is stopped,
  // and the owner gets the new chat — with the question they asked.
  const deadlineFrom = onLocalAi && sending ? (compactingSince || (inferred ? turnStartedAt : 0)) : 0;
  useEffect(() => {
    if (!deadlineFrom) return;
    const timer = setTimeout(() => {
      const opts = optsRef.current;
      const turn = turnRef.current;
      const key = turn?.key ?? opts.sessionKeyRef.current;
      void opts.abortTurn();
      const verdict = fitRef.current.get(key);
      fitRef.current.set(key, { long: true, tokens: verdict?.tokens ?? null, window: verdict?.window ?? null });
      setOffers((prev) => ({
        ...prev,
        [key]: {
          key, kind: "timeout", tokens: verdict?.tokens ?? null, window: verdict?.window ?? null,
          pending: turn?.key === key ? turn.pending : null,
        },
      }));
    }, Math.max(0, LOCAL_COMPACTION_DEADLINE_MS - (Date.now() - deadlineFrom)));
    return () => clearTimeout(timer);
  }, [deadlineFrom]);

  const startNewChat = useCallback(() => {
    const opts = optsRef.current;
    const key = opts.activeKey;
    const pending = offersRef.current[key]?.pending ?? null;
    setOffers((prev) => without(prev, key));
    void opts.openNewChat().then((newKey) => {
      if (newKey && pending) optsRef.current.queueSend(newKey, pending);
    });
  }, []);

  const shorten = useCallback(() => {
    const opts = optsRef.current;
    const key = opts.activeKey;
    const compact = opts.adapter.compactConversation?.bind(opts.adapter);
    if (!offersRef.current[key] || !compact || shorteningRef.current) return;
    setShortening({ key, since: Date.now() });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), LOCAL_COMPACTION_DEADLINE_MS);
    });
    void Promise.race([compact(key).then(() => "done" as const), deadline])
      .then(async (outcome) => {
        if (outcome === "timeout") {
          // A card the owner closed (×, or a new chat) meanwhile stays closed.
          setOffers((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], kind: "timeout" } } : prev));
          return;
        }
        // A compaction can fold a little and still leave more than the local
        // model reads (a board: Hermes folded one exchange of seven, 53k → 50k
        // tokens over its 32k line). Measured again, that is not "shortened for
        // the local model": the card says it could not be, and keeps the message.
        // A measure that does not answer in time is unknown, as before.
        const size = await bounded(
          opts.adapter.conversationSize?.(key).catch(() => null) ?? Promise.resolve(null),
          SHORTEN_REMEASURE_MS,
          null,
        );
        const sizeWindow = size?.window ?? optsRef.current.localWindow;
        if (size && tooLongForLocal(size, sizeWindow)) {
          const tokens = size.tokens ?? null;
          const room = size.limit ?? sizeWindow ?? null;
          if (!fitRef.current.get(key)?.dismissed) fitRef.current.set(key, { long: true, tokens, window: room });
          setOffers((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], kind: "failed", tokens, window: room } } : prev));
          return;
        }
        const pending = offersRef.current[key]?.pending ?? null;
        fitRef.current.set(key, { long: false, tokens: null, window: null });
        setOffers((prev) => without(prev, key));
        optsRef.current.noteSystem(key, optsRef.current.shortenedText);
        if (pending) optsRef.current.queueSend(key, pending);
        setMeasureEpoch((n) => n + 1);
      })
      .catch(() => {
        setOffers((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], kind: "failed" } } : prev));
      })
      .finally(() => {
        clearTimeout(timer);
        setShortening(null);
      });
  }, []);

  const dismiss = useCallback(() => {
    const opts = optsRef.current;
    const key = opts.activeKey;
    const pending = offersRef.current[key]?.pending ?? null;
    setOffers((prev) => without(prev, key));
    const verdict = fitRef.current.get(key);
    fitRef.current.set(key, { long: verdict?.long ?? true, tokens: verdict?.tokens ?? null, window: verdict?.window ?? null, dismissed: true });
    if (pending?.text) opts.restoreDraft(key, pending.text);
  }, []);

  return {
    offer: onLocalAi ? offers[activeKey] ?? null : null,
    shorteningSince: shortening && shortening.key === activeKey ? shortening.since : 0,
    phase,
    admitTurn,
    noteAgentFrame,
    startNewChat,
    shorten,
    dismiss,
  };
}
