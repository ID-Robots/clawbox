"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "@/lib/clipboard";

/**
 * The xAI (Grok) Subscription tab: a SuperGrok / X Premium sign-in.
 *
 * The same interaction as the ChatGPT device flow above it in AIModelsStep —
 * a link, a one-time code to copy, a waiting line — but driven by a different
 * route, `/setup-api/ai-models/xai-login`, because here the core's own CLI
 * runs the sign-in (src/lib/xai-oauth-login.ts) and the browser only relays
 * what it printed. When the CLI finishes, `onSignedIn` hands back to the
 * panel's ordinary subscription save, which posts configure and runs the
 * progress overlay exactly like every other provider.
 *
 * Every terminal state is visible: a failure shows the server's sentence and,
 * when the CLI printed something we could not read, the CLI's own last lines —
 * the output format is assumed, and a wrong assumption must read as an error
 * with evidence, never as a spinner that does not stop.
 */

type LoginAnswer =
  | { status: "starting" }
  | { status: "pending"; verificationUrl: string | null; userCode: string | null; expiresInMinutes?: number }
  | { status: "complete" }
  | { status: "failed"; detail: string; output?: string };

type PanelState =
  | { kind: "idle" }
  | { kind: "starting" }
  // The CLI's own lifetime for the code (30 min on 2026.9.4), not a constant.
  | { kind: "pending"; verificationUrl: string | null; userCode: string | null; expiresInMinutes: number }
  | { kind: "failed"; detail: string; output?: string };

const POLL_MS = 3_000;
const ROUTE = "/setup-api/ai-models/xai-login";

const PRIMARY_ACTION_CLASS =
  "w-full min-h-[48px] px-6 btn-gradient text-white rounded-[var(--r-1)] font-semibold text-[length:var(--t-5)] cursor-pointer flex items-center justify-center gap-2 " +
  "transition-transform duration-[var(--d-1)] ease-[var(--ease-standard)] active:scale-[0.98] " +
  "disabled:bg-none disabled:bg-[var(--fill-2)] disabled:text-[var(--text-muted)] disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100";

const QUIET_LINK_CLASS =
  "bg-transparent border-none p-0 text-[length:var(--t-2)] font-semibold text-[var(--coral-bright)] hover:text-orange-300 cursor-pointer transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)]";

async function callRoute(action: "start" | "poll" | "cancel", signal?: AbortSignal): Promise<LoginAnswer> {
  const res = await fetch(ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
    signal,
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (data && typeof data.status === "string") return data as unknown as LoginAnswer;
  const error = typeof data?.error === "string" ? data.error : "";
  return { status: "failed", detail: error || `The sign-in request failed (${res.status}).` };
}

/** True only when the route CONFIRMED it stopped the sign-in (`{ ok: true }`). */
async function cancelRoute(): Promise<boolean> {
  try {
    const res = await fetch(ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return res.ok && data?.ok === true;
  } catch {
    return false;
  }
}

export default function XaiSignInPanel({
  t,
  startLabel,
  onSignedIn,
}: {
  t: (key: string, params?: Record<string, string | number>) => string;
  startLabel: string;
  onSignedIn: () => void;
}) {
  const [state, setState] = useState<PanelState>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  // `polling` is on from the moment `start` has answered until a terminal
  // answer; `tick` re-arms the timer after each poll that was not terminal.
  const [polling, setPolling] = useState(false);
  const [tick, setTick] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  // Bumped by every cleanup of the poll effect, so a poll answer that comes
  // back after its effect was torn down (a re-render, a stop) is dropped
  // instead of re-arming or ending a sign-in a newer poll already settled.
  const pollGeneration = useRef(0);
  const [cancelling, setCancelling] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);
  const mounted = useRef(true);
  // The parent passes a new callback on every render; read it through a ref so
  // `apply` — and with it the poll effect — stays put across those renders.
  const onSignedInRef = useRef(onSignedIn);
  useEffect(() => { onSignedInRef.current = onSignedIn; }, [onSignedIn]);
  // Is a CLI of ours possibly still running on the box? Read on unmount.
  const inFlight = useRef(false);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPolling(false);
  }, []);

  /** Apply one answer from the route; true when the sign-in is still open. */
  const apply = useCallback((answer: LoginAnswer): boolean => {
    if (!mounted.current) return false;
    if (answer.status === "complete") {
      inFlight.current = false;
      stop();
      setState({ kind: "idle" });
      onSignedInRef.current();
      return false;
    }
    if (answer.status === "failed") {
      inFlight.current = false;
      stop();
      setState({ kind: "failed", detail: answer.detail, output: answer.output });
      return false;
    }
    setState(answer.status === "pending"
      ? {
        kind: "pending",
        verificationUrl: answer.verificationUrl,
        userCode: answer.userCode,
        expiresInMinutes: answer.expiresInMinutes ?? 30,
      }
      : { kind: "starting" });
    return true;
  }, [stop]);

  useEffect(() => {
    if (!polling) return;
    const generation = pollGeneration.current;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      controllerRef.current = controller;
      try {
        const answer = await callRoute("poll", controller.signal);
        if (generation !== pollGeneration.current) return;
        if (apply(answer)) setTick((n) => n + 1);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (generation !== pollGeneration.current) return;
        // A network blip is not the end of a sign-in the CLI is still running.
        if (mounted.current) setTick((n) => n + 1);
      }
    }, POLL_MS);
    return () => {
      pollGeneration.current += 1;
      clearTimeout(timer);
      controller.abort();
    };
  }, [apply, polling, tick]);

  const start = useCallback(async () => {
    stop();
    setCopied(false);
    setState({ kind: "starting" });
    inFlight.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      if (apply(await callRoute("start", controller.signal))) setPolling(true);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      inFlight.current = false;
      setState({ kind: "failed", detail: err instanceof Error ? err.message : String(err) });
    }
  }, [apply, stop]);

  // The CLI keeps running until the route says it stopped it, so the panel
  // does too: `inFlight` (and the unmount cancel it arms) is cleared only on
  // `{ ok: true }`, and a cancel that did not land says so and can be retried.
  const cancel = useCallback(async () => {
    setCancelling(true);
    setCancelFailed(false);
    const confirmed = await cancelRoute();
    if (!mounted.current) return;
    setCancelling(false);
    if (!confirmed) {
      setCancelFailed(true);
      return;
    }
    inFlight.current = false;
    stop();
    setState({ kind: "idle" });
  }, [stop]);

  // Leaving the tab ends the sign-in, so no CLI is left waiting on a code
  // nobody is looking at.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllerRef.current?.abort();
      if (inFlight.current) void cancelRoute();
    };
  }, []);

  const copyCode = useCallback(async (code: string) => {
    // The shared helper: `navigator.clipboard` does not exist on the box's
    // plain-HTTP origin, and the helper falls back to a selected textarea.
    // The code is select-all text either way, so a failed copy still leaves
    // copying by hand.
    if (await copyToClipboard(code)) {
      setCopied(true);
      setTimeout(() => { if (mounted.current) setCopied(false); }, 1500);
    }
  }, []);

  return (
    <div data-testid="xai-sign-in">
      <p className="text-[length:var(--t-2)] text-[var(--text-secondary)] mb-2 leading-[1.6]">
        {t("ai.xaiSignInDesc")}
      </p>
      <p className="text-[length:var(--t-2)] text-[var(--text-muted)] mb-4 leading-[1.5]">
        {t("ai.xaiReplacesKey")}
      </p>

      {(state.kind === "idle" || state.kind === "failed") && (
        <>
          {state.kind === "failed" && (
            <div role="alert" className="mb-4 p-3 rounded-[var(--r-1)] border border-[var(--border-subtle)] bg-[var(--bg-deep)]">
              <p className="text-[length:var(--t-2)] text-[var(--text-primary)]">{state.detail}</p>
              {state.output && (
                <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[length:var(--t-1)] text-[var(--text-muted)]">
                  {state.output}
                </pre>
              )}
            </div>
          )}
          <button type="button" onClick={() => void start()} className={PRIMARY_ACTION_CLASS}>
            {state.kind === "failed" ? t("ai.getNewCode") : startLabel}
          </button>
        </>
      )}

      {state.kind === "starting" && (
        <div className="flex items-center gap-2 text-[length:var(--t-2)] text-[var(--text-secondary)]">
          <span className="inline-block w-3.5 h-3.5 border-2 border-[var(--coral-bright)] border-t-transparent rounded-full animate-spin" />
          {t("ai.xaiSignInStarting")}
          <button type="button" onClick={() => void cancel()} disabled={cancelling} className={`ml-auto ${QUIET_LINK_CLASS}`}>
            {t("cancel")}
          </button>
        </div>
      )}

      {state.kind === "pending" && (
        <div>
          <div className="mb-4 p-4 bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-[var(--r-1)] text-center">
            {state.verificationUrl && (
              <a
                href={state.verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full min-h-[48px] px-4 inline-flex items-center justify-center bg-[var(--coral-bright)] hover:bg-orange-500 text-white font-semibold rounded-[var(--r-1)] transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] text-[length:var(--t-4)]"
              >
                {t("ai.openAuthPage")}
              </a>
            )}
            {state.userCode ? (
              <>
                <p className="text-[length:var(--t-2)] text-[var(--text-secondary)] mt-4 mb-2">{t("ai.thenEnterCode")}</p>
                <div className="px-4 py-3 bg-[var(--bg-surface)] rounded-[var(--r-1)] inline-flex items-center gap-2">
                  <span
                    data-testid="xai-user-code"
                    className="text-[length:var(--t-6)] font-mono font-bold text-[var(--text-primary)] tracking-[0.16em] select-all"
                  >
                    {state.userCode}
                  </span>
                  <button
                    type="button"
                    onClick={() => void copyCode(state.userCode!)}
                    className="ml-1 px-2 py-1 text-[length:var(--t-2)] font-semibold text-[var(--coral-bright)] bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-[var(--r-1)] hover:bg-[var(--bg-surface)] cursor-pointer"
                  >
                    {copied ? t("copied") : t("copy")}
                  </button>
                </div>
                <p className="mt-2 text-[length:var(--t-2)] text-[var(--text-muted)]">{t("ai.xaiCodeExpires", { minutes: state.expiresInMinutes })}</p>
              </>
            ) : (
              <p className="text-[length:var(--t-2)] text-[var(--text-secondary)] mt-4">{t("ai.xaiSignInNoCode")}</p>
            )}
            {state.verificationUrl && (
              // The link as text too: on a phone the owner may need to type it
              // on another device.
              <p className="mt-2 break-all font-mono text-[length:var(--t-1)] text-[var(--text-muted)]">
                {state.verificationUrl}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 text-[length:var(--t-2)] text-[var(--text-secondary)]">
            <span className="inline-block w-3.5 h-3.5 border-2 border-[var(--coral-bright)] border-t-transparent rounded-full animate-spin" />
            {t("ai.waitingAuth")}
          </div>
          {cancelFailed && (
            <p role="alert" className="mt-2 text-[length:var(--t-2)] text-[var(--text-primary)]">
              {t("ai.xaiCancelFailed")}
            </p>
          )}
          <button type="button" onClick={() => void cancel()} disabled={cancelling} className={`mt-2 ${QUIET_LINK_CLASS}`}>
            {t("cancel")}
          </button>
        </div>
      )}
    </div>
  );
}
