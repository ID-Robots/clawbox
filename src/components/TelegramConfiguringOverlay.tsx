"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { cachedEdition, resolveEdition } from "@/lib/client-harness";

interface TelegramConfiguringOverlayProps {
  onDone: () => void;
  /** Called when the configured harness never reports Telegram readiness. */
  onTimeout: () => void;
  /**
   * Optional promise the overlay awaits before transitioning to the
   * final "ready" phase. When the caller knows the configure request is
   * still in flight (SettingsApp's POST to /telegram/configure), passing
   * its success promise here prevents the overlay from declaring victory
   * while the gateway restart is still happening. The overlay still also
   * polls gateway health — both signals must be ready before phase 4.
   */
  waitFor?: Promise<void>;
  /**
   * Max ms to poll for readiness before giving up. When the poll times
   * out, the overlay calls onTimeout() without transitioning to phase 4 so
   * the parent can surface its own error instead of falsely reporting
   * "ready". Default: 60_000.
   */
  healthTimeoutMs?: number;
}

export default function TelegramConfiguringOverlay({
  onDone,
  onTimeout,
  waitFor,
  healthTimeoutMs = 60_000,
}: TelegramConfiguringOverlayProps) {
  const { t } = useT();

  // Device edition. Seeded from the process-wide cache (immutable for the life
  // of the document) and otherwise resolved by the effect below, well before
  // phase 2 — the step whose label differs — becomes visible.
  const [edition, setEdition] = useState<string | null>(() => cachedEdition());
  const isHermes = edition === "hermes";

  // A Hermes device has no OpenClaw gateway to restart or wait for: the unit is
  // masked and restartGateway() is a documented no-op there. What the configure
  // route actually brings up on this edition is Hermes' own messaging gateway —
  // the process that receives Telegram messages — so that is what the middle
  // two steps name.
  const CONFIGURING_STEPS = [
    { label: t("telegram.tokenVerified") },
    { label: t("telegram.connectingTelegram") },
    { label: isHermes ? t("telegram.hermesStartingService") : t("telegram.restartingGateway") },
    { label: isHermes ? t("telegram.hermesWaitingService") : t("telegram.waitingGateway") },
    { label: t("telegram.readyToChat") },
  ];

  const [phase, setPhase] = useState(0);
  const [dots, setDots] = useState("");
  const overlayRef = useRef<HTMLDivElement>(null);
  const onDoneRef = useRef(onDone);
  const onTimeoutRef = useRef(onTimeout);
  onDoneRef.current = onDone;
  onTimeoutRef.current = onTimeout;

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const requestControllers = new Set<AbortController>();

    function delay(ms: number): Promise<void> {
      return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        timers.push(t);
      });
    }

    const POLL_INTERVAL_MS = 2000;
    // Attach the rejection handler immediately. The visual choreography takes
    // six seconds before readiness polling starts, while the configure POST
    // can fail much earlier; leaving its promise bare until it is awaited below
    // would emit an unhandled rejection in that gap.
    const configureResult = (waitFor ?? Promise.resolve()).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    type ConfigureOutcome = Awaited<typeof configureResult>;

    async function waitForConfigureBeforeDeadline(
      deadline: number,
    ): Promise<ConfigureOutcome | null> {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || cancelled) return null;

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), remainingMs);
        timers.push(timeoutId);
      });
      try {
        const result = await Promise.race([configureResult, timeout]);
        return !cancelled && Date.now() < deadline ? result : null;
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    }

    /** Fetch and parse one readiness response without crossing the shared deadline. */
    async function fetchJsonBeforeDeadline(
      path: string,
      deadline: number,
      maxRequestMs: number,
    ): Promise<Record<string, unknown> | null> {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || cancelled) return null;

      const controller = new AbortController();
      requestControllers.add(controller);
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const request = (async () => {
        try {
          const res = await fetch(path, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!res.ok) return null;
          const data: unknown = await res.json();
          return typeof data === "object" && data !== null
            ? data as Record<string, unknown>
            : null;
        } catch {
          return null;
        }
      })();
      const timeout = new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, Math.min(remainingMs, maxRequestMs));
        timers.push(timeoutId);
      });

      try {
        const data = await Promise.race([request, timeout]);
        return !cancelled && Date.now() < deadline ? data : null;
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        requestControllers.delete(controller);
      }
    }

    async function waitForNextProbe(deadline: number): Promise<boolean> {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || cancelled) return false;
      await delay(Math.min(POLL_INTERVAL_MS, remainingMs));
      return !cancelled && Date.now() < deadline;
    }

    async function pollGatewayHealth(deadline: number): Promise<boolean> {
      while (!cancelled && Date.now() < deadline) {
        const data = await fetchJsonBeforeDeadline(
          "/setup-api/gateway/health",
          deadline,
          POLL_INTERVAL_MS,
        );
        if (data?.available === true) return true;
        if (!(await waitForNextProbe(deadline))) return false;
      }
      return false;
    }

    /**
     * Readiness on a Hermes-edition device.
     *
     * /setup-api/gateway/health is meaningless here — the OpenClaw gateway is
     * not installed and its unit is masked, so polling it burned the whole
     * healthTimeoutMs budget and then timed out having never reached the
     * "ready to chat" phase. The owner saw a minute of spinner and no green
     * check on a save that had actually succeeded.
     *
     * The equivalent signal on this edition is Hermes' messaging gateway, which
     * is what the configure route brings up (ensureHermesGateway) and what
     * decides whether the bot answers at all. /setup-api/telegram/status already
     * reports it: `receiving` is true only when the token is registered with
     * Hermes AND that gateway is running — the same "something is listening"
     * meaning `available` carries on the OpenClaw side.
     *
     * The route caches its Hermes probe for 15 s, so polling every 2 s costs at
     * most one real CLI round-trip per window rather than one per attempt.
     */
    async function pollHermesTelegramReady(deadline: number): Promise<boolean> {
      while (!cancelled && Date.now() < deadline) {
        // The status route shells out to the Hermes CLI, so permit a longer
        // individual probe while still capping it at the shared deadline.
        const data = await fetchJsonBeforeDeadline(
          "/setup-api/telegram/status",
          deadline,
          10_000,
        );
        if (data?.receiving === true) return true;
        if (!(await waitForNextProbe(deadline))) return false;
      }
      return false;
    }

    async function run() {
      // Resolve before the phase machine reaches the steps whose meaning
      // depends on it. Cached, so this is a no-op read in the normal case.
      const activeEdition = await resolveEdition();
      if (cancelled) return;
      setEdition(activeEdition);
      const hermes = activeEdition === "hermes";

      await delay(1500);
      if (cancelled) return;
      setPhase(1);

      await delay(2500);
      if (cancelled) return;
      setPhase(2);

      await delay(2000);
      if (cancelled) return;
      setPhase(3);

      // Wait for BOTH signals before declaring ready:
      //   1. the caller's configure request has succeeded (waitFor)
      //   2. the harness's own messaging path reports it is listening again
      // Both already run concurrently: configureResult is attached above and
      // the readiness poll starts here. Await readiness FIRST so expiry can
      // release the UI even if the configure request itself has stalled. A
      // Promise.all here made its timeout wait forever for that pending request,
      // which meant the parent's abort/retry recovery could never run.
      const readinessDeadline = Date.now() + Math.max(0, healthTimeoutMs);
      const ready = await (hermes
        ? pollHermesTelegramReady(readinessDeadline)
        : pollGatewayHealth(readinessDeadline));
      if (cancelled) return;
      if (!ready) {
        // Nothing reported itself listening within healthTimeoutMs. This is
        // not completion: setup must stay on Telegram, and Settings must show
        // an actionable failure instead of silently hiding the overlay.
        onTimeoutRef.current();
        return;
      }

      const configured = await waitForConfigureBeforeDeadline(readinessDeadline);
      if (cancelled) return;
      if (configured === null) {
        onTimeoutRef.current();
        return;
      }
      if (!configured.ok) throw configured.error;

      setPhase(4);
      await delay(1500);
      if (cancelled) return;
      onDoneRef.current();
    }

    void run().catch((err) => {
      if (cancelled) return;
      console.warn("[telegram] Readiness sequence failed:", err);
      onTimeoutRef.current();
    });

    overlayRef.current?.focus();
    return () => {
      cancelled = true;
      requestControllers.forEach((controller) => controller.abort());
      timers.forEach((t) => clearTimeout(t));
    };
  }, [waitFor, healthTimeoutMs]);

  useEffect(() => {
    const id = setInterval(() => setDots((d) => (d.length >= 3 ? "" : d + ".")), 500);
    return () => clearInterval(id);
  }, []);

  return (
    <div ref={overlayRef} tabIndex={-1} className="flex flex-col items-center gap-6 px-8 pt-4 pb-8 outline-none">
      <style>{`
        @keyframes tg-check-draw { to { stroke-dashoffset: 0 } }
        @keyframes tg-check-circle { to { stroke-dashoffset: 0 } }
        @keyframes tg-fade-in { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes tg-pulse-ring { 0% { transform: scale(0.8); opacity: 0.6 } 50% { transform: scale(1.2); opacity: 0 } 100% { transform: scale(0.8); opacity: 0.6 } }
        @keyframes tg-orbit { from { transform: rotate(0deg) translateX(40px) rotate(0deg) } to { transform: rotate(360deg) translateX(40px) rotate(-360deg) } }
        .tg-fade-in { animation: tg-fade-in 0.4s ease-out both }
        .tg-step-enter { animation: tg-fade-in 0.3s ease-out both }
      `}</style>

      {/* Screen-reader-only live region — announces phase transitions
          without repeating the purely decorative spinner animation. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {phase === 0
          ? t("telegram.botTokenVerified")
          : phase === 4
          ? t("telegram.botReady")
          : `${t("telegram.settingUpTelegram")} — ${CONFIGURING_STEPS[phase]?.label ?? ""}`}
      </div>

      <div className="relative w-24 h-24 flex items-center justify-center" aria-hidden="true">
        <div className="absolute inset-0 rounded-full border-2 border-sky-500/20" style={{ animation: "tg-pulse-ring 2s ease-in-out infinite" }} />
        <div className="absolute inset-2 rounded-full border border-sky-500/10" style={{ animation: "tg-pulse-ring 2s ease-in-out infinite 0.5s" }} />

        {phase >= 1 && [0, 1, 2].map((i) => (
          <div key={i} className="absolute inset-0 flex items-center justify-center" style={{ animation: `tg-orbit ${3 + i * 0.5}s linear infinite`, animationDelay: `${i * 0.4}s` }}>
            <div className="w-2 h-2 rounded-full bg-sky-400" style={{ opacity: 0.4 + i * 0.2 }} />
          </div>
        ))}

        {phase === 0 ? (
          <svg width="48" height="48" viewBox="0 0 56 56" fill="none" className="tg-fade-in">
            <circle cx="28" cy="28" r="25" stroke="#22c55e" strokeWidth="3" strokeDasharray="157" strokeDashoffset="157" style={{ animation: "tg-check-circle 0.6s ease-out 0.1s forwards" }} />
            <path d="M17 28l7 7 15-15" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="35" strokeDashoffset="35" style={{ animation: "tg-check-draw 0.4s ease-out 0.5s forwards" }} />
          </svg>
        ) : (
          <svg width="48" height="48" viewBox="0 0 48 48" className="tg-fade-in">
            <circle cx="24" cy="24" r="22" fill="#2AABEE" />
            <path d="M12.5 23.5l3.6 3.3 1.3 4.5c.2.5.8.7 1.2.4l2.8-2.3a.8.8 0 0 1 1 0l5 3.6c.4.3 1 .1 1.1-.4l3.7-17.8c.1-.6-.4-1-.9-.8L12.5 22.3c-.7.3-.7 1 0 1.2z" fill="white" />
          </svg>
        )}
      </div>

      <div className="text-center tg-fade-in" style={{ animationDelay: "0.3s" }}>
        <h2 className="text-lg font-bold text-[var(--text-primary)] mb-1">
          {phase === 0 ? t("connected") : phase === 4 ? t("telegram.allSet") : t("telegram.settingUpTelegram")}
        </h2>
        <p className="text-sm text-[var(--text-muted)]">
          {phase === 0
            ? t("telegram.botTokenVerified")
            : phase === 4
            ? t("telegram.botReady")
            : `${t("telegram.configuringBot")}${dots}`}
        </p>
      </div>

      <div className="w-full max-w-[280px] space-y-2.5 mt-2">
        {CONFIGURING_STEPS.map((step, i) => (
          <div
            key={i}
            className={`flex items-center gap-2.5 text-xs transition-all duration-300 ${
              i <= phase ? "opacity-100" : "opacity-0 translate-y-1"
            }`}
            style={i <= phase ? { animation: "tg-fade-in 0.3s ease-out both", animationDelay: `${i * 0.1}s` } : undefined}
          >
            {i < phase ? (
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 shrink-0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L19 7" /></svg>
              </span>
            ) : i === phase ? (
              <span className="flex items-center justify-center w-5 h-5 shrink-0">
                <span className="w-3.5 h-3.5 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
              </span>
            ) : (
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-gray-700/50 shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-600" />
              </span>
            )}
            <span className={i <= phase ? (i < phase ? "text-emerald-400" : "text-[var(--text-primary)]") : "text-[var(--text-muted)]"}>
              {step.label}
            </span>
          </div>
        ))}
      </div>

      {phase >= 1 && phase < 4 && (
        <p className="text-xs text-[var(--text-muted)] text-center mt-2 tg-step-enter">
          {isHermes ? t("telegram.hermesPleaseWait") : t("telegram.pleaseWait")}{dots}
        </p>
      )}
    </div>
  );
}
