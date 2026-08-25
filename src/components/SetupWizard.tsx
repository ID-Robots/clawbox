"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import Image from "next/image";
import ProgressBar from "./ProgressBar";
import WifiStep from "./WifiStep";
import UpdateStep from "./UpdateStep";
import CredentialsStep from "./CredentialsStep";
import AIModelsStep from "./AIModelsStep";
import TelegramStep from "./TelegramStep";
import StatusMessage from "./StatusMessage";
import ReconnectingOverlay from "./ReconnectingOverlay";
import { useT, I18nProvider, LANGUAGES, type Locale } from "@/lib/i18n";
import { DISCORD_INVITE_URL } from "@/lib/community";
import { cachedEdition, resolveEdition } from "@/lib/client-harness";

const SETUP_COMPLETION_MAX_HEALTH_CHECKS = 6;

async function extractErrorMessage(res: Response, fallback: string) {
  const data = await res.json().catch(() => ({}));
  return typeof data.error === "string" ? data.error : fallback;
}

function applyStatusData(
  data: Record<string, unknown>,
  setCurrentStep: (v: number) => void,
  beginCompletion: () => void,
  onComplete?: () => void
) {
  const persistedProgressStep = typeof data.setup_progress_step === "number"
    ? data.setup_progress_step
    : Number(data.setup_progress_step ?? 0);

  let resumeStep = 1;
  if (data.wifi_configured) resumeStep = Math.max(resumeStep, 2);
  if (data.update_completed) resumeStep = Math.max(resumeStep, 3);
  if (data.password_configured) resumeStep = Math.max(resumeStep, 4);
  if (data.ai_model_configured) resumeStep = Math.max(resumeStep, 5);
  if (Number.isFinite(persistedProgressStep)) {
    // Clamp to the new 5-step wizard. A persisted step of 6 from before
    // the Local-AI-step removal collapses to step 5 (Telegram) — the
    // closest equivalent in the new flow.
    resumeStep = Math.max(resumeStep, Math.min(5, Math.max(1, Math.floor(persistedProgressStep))));
  }

  if (data.setup_complete) {
    if (onComplete) onComplete();
    else window.location.href = "/";
    return;
  }
  if (data.telegram_configured) {
    setCurrentStep(6);
    beginCompletion();
    return;
  }

  setCurrentStep(resumeStep);
}

/* ── Power menu ── */

function PowerMenu({ onClose, onRestart, t }: { onClose: () => void; onRestart: () => void; t: (key: string) => string }) {
  const [confirming, setConfirming] = useState<"restart" | "shutdown" | null>(null);
  const [acting, setActing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const execute = async (action: "restart" | "shutdown") => {
    setActing(true);
    // For a restart, hand off to the full-screen reconnecting overlay so the
    // customer stays in an animated loop while the connection drops and comes
    // back — rather than being stranded on a dying page. Fire-and-forget the
    // request: the device may tear down the connection before it responds.
    if (action === "restart") {
      void fetch("/setup-api/system/power", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }).catch(() => {});
      onRestart();
      return;
    }
    try {
      await fetch("/setup-api/system/power", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
    } catch {}
  };

  return (
    <div ref={ref} className="absolute right-0 top-full mt-1 min-w-[160px] max-w-[calc(100vw-1rem)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-lg shadow-xl z-50 overflow-hidden">
      {acting ? (
        <div className="flex items-center gap-2 px-4 py-3 text-xs text-[var(--text-secondary)]">
          <span className="inline-block w-3 h-3 border-2 border-[var(--coral-bright)] border-t-transparent rounded-full animate-spin" />
          {confirming === "shutdown" ? t("wizard.shuttingDown") : t("wizard.restarting")}
        </div>
      ) : confirming ? (
        <div className="p-3">
          <p className="text-xs text-[var(--text-secondary)] mb-2">
            {confirming === "shutdown" ? t("wizard.shutdownConfirm") : t("wizard.restartConfirm")}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => execute(confirming)}
              className="flex-1 px-3 py-1.5 bg-red-500/20 text-red-400 border border-red-500/30 rounded text-xs font-semibold cursor-pointer hover:bg-red-500/30 transition-colors"
            >
              {t("confirm")}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              className="flex-1 px-3 py-1.5 bg-[var(--bg-deep)] text-[var(--text-secondary)] border border-[var(--border-subtle)] rounded text-xs cursor-pointer hover:bg-[var(--bg-surface)] transition-colors"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setConfirming("restart")}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs text-[var(--text-secondary)] bg-transparent border-none cursor-pointer hover:bg-[var(--bg-deep)] transition-colors text-left"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>restart_alt</span>
            {t("wizard.restart")}
          </button>
          <button
            type="button"
            onClick={() => setConfirming("shutdown")}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs text-red-400 bg-transparent border-none cursor-pointer hover:bg-[var(--bg-deep)] transition-colors text-left"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>power_settings_new</span>
            {t("wizard.shutdown")}
          </button>
        </>
      )}
    </div>
  );
}

/* ── Help popover ── */

function HelpPopover({ step, onClose, t }: { step: number; onClose: () => void; t: (key: string) => string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const tips: Record<number, { title: string; body: string }> = {
    1: {
      title: t("wizard.help1Title"),
      body: t("wizard.help1Body"),
    },
    2: {
      title: t("wizard.help2Title"),
      body: t("wizard.help2Body"),
    },
    3: {
      title: t("wizard.help3Title"),
      body: t("wizard.help3Body"),
    },
    4: {
      title: t("wizard.help4Title"),
      body: t("wizard.help4Body"),
    },
    5: {
      title: t("wizard.help5Title"),
      body: t("wizard.help5Body"),
    },
  };

  const tip = tips[step] ?? tips[1];

  return (
    <div ref={ref} className="absolute right-0 top-full mt-1 w-[min(280px,calc(100vw-1rem))] bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-lg shadow-xl z-50 p-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1.5">{tip.title}</h3>
      <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{tip.body}</p>
    </div>
  );
}

/* ── Language menu ──
   Language is a device setting, not a step of setup. Living inside the card it
   made the card's first rows chrome instead of content and it only existed on
   step 1's choice screen — so a customer who realised on step 3 that they were
   reading the wrong language had nowhere to go. In the header actions it is
   reachable from every step and the card opens on its headline. */

function LanguageMenu({
  onClose,
  locale,
  setLocale,
}: {
  onClose: () => void;
  locale: Locale;
  setLocale: (l: Locale) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 w-[min(220px,calc(100vw-1rem))] max-h-[280px] overflow-y-auto bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-lg shadow-xl z-50 py-1"
      role="menu"
    >
      {LANGUAGES.map((lang) => (
        <button
          key={lang.code}
          type="button"
          role="menuitemradio"
          aria-checked={locale === lang.code}
          onClick={() => { setLocale(lang.code); onClose(); }}
          className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-left border-none cursor-pointer transition-colors text-sm ${
            locale === lang.code
              ? "bg-[var(--coral-tint)] text-[var(--text-primary)]"
              : "bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-deep)]"
          }`}
        >
          <span className="text-base leading-none">{lang.flag}</span>
          <span className="flex-1">{lang.label}</span>
          {locale === lang.code && (
            <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 16 }}>check</span>
          )}
        </button>
      ))}
    </div>
  );
}

function SetupCompletionOverlay({
  phase,
  completed,
  hermes,
  t,
}: {
  phase: number;
  completed: boolean;
  /** Hermes edition: this device ships without the OpenClaw gateway. */
  hermes: boolean;
  t: (key: string) => string;
}) {
  // A Hermes-edition box has no OpenClaw gateway installed at all (the unit is
  // masked), so gateway copy would name a service that does not exist on the
  // device — and the customer would be watching a spinner for it.
  const steps = hermes
    ? [
        t("wizard.completionHermesSaving"),
        t("wizard.completionHermesStarting"),
        t("ai.almostReady"),
      ]
    : [
        t("ai.restartingGateway"),
        t("telegram.waitingGateway"),
        t("ai.almostReady"),
      ];

  return (
    <div className="w-full max-w-[520px]" data-testid="setup-completion-overlay">
      <div className="card-surface rounded-2xl p-8 relative overflow-hidden">
        <style>{`
          @keyframes setup-finish-check-draw { to { stroke-dashoffset: 0 } }
          @keyframes setup-finish-check-circle { to { stroke-dashoffset: 0 } }
          @keyframes setup-finish-fade-in { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: translateY(0) } }
          @keyframes setup-finish-pulse-ring { 0% { transform: scale(0.85); opacity: 0.55 } 50% { transform: scale(1.15); opacity: 0 } 100% { transform: scale(0.85); opacity: 0.55 } }
          @keyframes setup-finish-orbit { from { transform: rotate(0deg) translateX(38px) rotate(0deg) } to { transform: rotate(360deg) translateX(38px) rotate(-360deg) } }
          .setup-finish-fade-in { animation: setup-finish-fade-in 0.4s ease-out both }
        `}</style>

        <div className="flex flex-col items-center gap-6 px-4 py-4">
          <div className="relative w-24 h-24 flex items-center justify-center">
            <div className="absolute inset-0 rounded-full border-2 border-[var(--coral-bright)]/20" style={{ animation: "setup-finish-pulse-ring 2s ease-in-out infinite" }} />
            <div className="absolute inset-2 rounded-full border border-[var(--coral-bright)]/10" style={{ animation: "setup-finish-pulse-ring 2s ease-in-out infinite 0.45s" }} />

            {!completed && [0, 1, 2].map((i) => (
              <div
                key={i}
                className="absolute inset-0 flex items-center justify-center"
                style={{ animation: `setup-finish-orbit ${3 + i * 0.45}s linear infinite`, animationDelay: `${i * 0.35}s` }}
              >
                <div className="w-2 h-2 rounded-full bg-[var(--coral-bright)]" style={{ opacity: 0.35 + i * 0.2 }} />
              </div>
            ))}

            {completed ? (
              <svg width="48" height="48" viewBox="0 0 56 56" fill="none" className="setup-finish-fade-in">
                <circle cx="28" cy="28" r="25" stroke="#22c55e" strokeWidth="3" strokeDasharray="157" strokeDashoffset="157" style={{ animation: "setup-finish-check-circle 0.6s ease-out 0.1s forwards" }} />
                <path d="M17 28l7 7 15-15" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="35" strokeDashoffset="35" style={{ animation: "setup-finish-check-draw 0.4s ease-out 0.5s forwards" }} />
              </svg>
            ) : (
              <div className="relative z-10 flex h-16 w-16 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] setup-finish-fade-in">
                <Image
                  src="/clawbox-crab.png"
                  alt="ClawBox"
                  width={100}
                  height={100}
                  className="h-[100px] w-[100px] object-contain"
                  priority
                />
              </div>
            )}
          </div>

          <div className="text-center setup-finish-fade-in" style={{ animationDelay: "0.2s" }}>
            <h2 className="text-lg font-bold text-[var(--text-primary)] mb-1">
              {completed
                ? t("connected")
                : hermes
                  ? t("wizard.completionHermesTitle")
                  : t("openclaw.connecting")}
            </h2>
            <p className="text-sm text-[var(--text-muted)]">
              {completed ? t("ai.almostReady") : t("ai.pleaseDontClose")}
            </p>
          </div>

          <div className="w-full max-w-[280px] space-y-2.5 mt-1">
            {steps.map((step, index) => (
              <div
                key={step}
                className={`flex items-center gap-2.5 text-xs transition-all duration-300 ${
                  completed || index <= phase ? "opacity-100" : "opacity-0 translate-y-1"
                }`}
              >
                {completed || index < phase ? (
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 shrink-0">
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check</span>
                  </span>
                ) : index === phase ? (
                  <span className="flex items-center justify-center w-5 h-5 shrink-0">
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-[var(--coral-bright)] border-t-transparent animate-spin" />
                  </span>
                ) : (
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-gray-700/50 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-600" />
                  </span>
                )}
                <span className={completed || index <= phase ? (completed || index < phase ? "text-emerald-400" : "text-[var(--text-primary)]") : "text-[var(--text-muted)]"}>
                  {step}
                </span>
              </div>
            ))}
          </div>

          {!completed && (
            <p className="text-xs text-[var(--text-muted)] text-center mt-2 setup-finish-fade-in" style={{ animationDelay: "0.3s" }}>
              {hermes ? t("wizard.completionHermesWait") : t("telegram.pleaseWait")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Main wizard ── */

interface SetupWizardProps {
  onComplete?: () => void;
}

function SetupWizardInner({ onComplete }: SetupWizardProps = {}) {
  const { t, locale, setLocale } = useT();
  // Hold a live reference to t so the completion effect can translate without
  // re-running (and re-POSTing) on every locale change.
  const tRef = useRef(t);
  tRef.current = t;
  const [currentStep, setCurrentStep] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [completionStarted, setCompletionStarted] = useState(false);
  const [completionPhase, setCompletionPhase] = useState(0);
  const [completionComplete, setCompletionComplete] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [showPower, setShowPower] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showLang, setShowLang] = useState(false);
  const [restarting, setRestarting] = useState(false);
  // Device edition. Seeded from the process-wide cache (the edition is baked
  // into a root-owned env file and cannot change under a live page), so on a
  // resume it is already known and the completion overlay never paints the
  // wrong product's copy for a frame.
  const [edition, setEdition] = useState<string | null>(() => cachedEdition());
  const isHermesEdition = edition === "hermes";

  useEffect(() => {
    if (edition !== null) return;
    let alive = true;
    void resolveEdition().then((value) => { if (alive) setEdition(value); });
    return () => { alive = false; };
    // Runs once: `edition` is only read to skip a redundant fetch and it never
    // returns to null.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistSetupProgress = useCallback(async (step: number) => {
    try {
      await fetch("/setup-api/setup/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step }),
      });
    } catch {
      // Best effort only: local resume is still preserved in-memory for this session.
    }
  }, []);

  const goToStep = useCallback((step: number) => {
    setCurrentStep(step);
    void persistSetupProgress(step);
  }, [persistSetupProgress]);

  const startCompletion = useCallback(() => {
    void persistSetupProgress(6);
    setCompletionError(null);
    setShowHelp(false);
    setShowPower(false);
    setCompletionPhase(0);
    setCompletionComplete(false);
    setCompletionStarted(true);
  }, [persistSetupProgress]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    fetch("/setup-api/setup/status", { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Status check failed (${r.status})`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) applyStatusData(data, setCurrentStep, startCompletion, onComplete);
      })
      .catch((err) => {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) return;
        console.error("[SetupWizard] Failed to fetch setup status:", err);
        setSetupError(err instanceof Error ? err.message : "Failed to load setup status");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; controller.abort(); };
  }, [onComplete, retryCount, startCompletion]);

  useEffect(() => {
    if (!completionStarted) return;

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    function delay(ms: number): Promise<void> {
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timers.push(timer);
      });
    }

    async function pollGatewayHealth() {
      for (let attempt = 0; attempt < SETUP_COMPLETION_MAX_HEALTH_CHECKS; attempt += 1) {
        if (cancelled) return false;
        try {
          const res = await fetch("/setup-api/gateway/health");
          if (res.ok) {
            const data = await res.json();
            if (data.available) return true;
          }
        } catch {
          // Gateway is still booting.
        }
        await delay(2000);
      }
      return false;
    }

    /**
     * Readiness on a Hermes-edition device.
     *
     * There is no OpenClaw gateway to poll here — it is not installed and its
     * unit is masked, so /setup-api/gateway/health could only ever run out its
     * attempts. What DOES have to come up is the Hermes dashboard
     * (clawbox-hermes-dashboard.service, which the proxy unit fronts), and the
     * models route reports exactly that: `stale` is false only when the live
     * dashboard answered — every fallback source (the on-disk catalog, a cold
     * start) is flagged stale. See src/lib/hermes-model-options.ts.
     *
     * The route is one the wizard already calls from the AI-models step, and by
     * this point /setup/complete has issued the session cookie — so this adds no
     * new surface and needs no new carve-out.
     */
    async function pollHermesReady() {
      for (let attempt = 0; attempt < SETUP_COMPLETION_MAX_HEALTH_CHECKS; attempt += 1) {
        if (cancelled) return false;
        try {
          // Unlike the gateway's TCP probe this route talks to the dashboard,
          // so it gets its own deadline: a socket that accepts and then hangs
          // must not stall the loop past the attempt budget.
          const res = await fetch("/setup-api/hermes/models", {
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.stale === false) return true;
          }
        } catch {
          // The agent's dashboard is still coming up.
        }
        await delay(2000);
      }
      return false;
    }

    async function postCompleteWithRetry(): Promise<Response> {
      // The POST can fail transiently if the gateway restart from the AI
      // step is still settling, or the browser's connection is briefly
      // degraded after the hotspot reconfig in step 3. Retry on both
      // network errors and non-OK HTTP responses.
      const backoffs = [0, 2_000, 4_000];
      let lastErr: unknown = null;
      let lastRes: Response | null = null;
      for (const delayMs of backoffs) {
        if (cancelled) throw new Error("cancelled");
        if (delayMs > 0) await delay(delayMs);
        if (cancelled) throw new Error("cancelled");
        try {
          const res = await fetch("/setup-api/setup/complete", {
            method: "POST",
            signal: AbortSignal.timeout(15_000),
          });
          if (res.ok) return res;
          lastRes = res;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastRes) {
        throw new Error(await extractErrorMessage(lastRes, `Failed to complete setup (${lastRes.status})`));
      }
      throw lastErr instanceof Error ? lastErr : new Error("Failed to complete setup");
    }

    async function runCompletion() {
      try {
        const res = await postCompleteWithRetry();
        if (!res.ok) {
          throw new Error(await extractErrorMessage(res, `Failed to complete setup (${res.status})`));
        }
        if (cancelled) return;

        await delay(900);
        if (cancelled) return;
        setCompletionPhase(1);

        // Resolve the edition inside the run rather than reading the state
        // above it: the completion effect must never poll a harness this
        // device does not ship, even on the resume path where the overlay is
        // mounted before the mount effect has landed. The lookup is cached, so
        // this costs nothing on the normal path.
        const activeEdition = await resolveEdition();
        if (cancelled) return;
        setEdition(activeEdition);

        const agentAvailable = activeEdition === "hermes"
          ? await pollHermesReady()
          : await pollGatewayHealth();
        if (!agentAvailable) {
          console.warn("[SetupWizard] The agent did not report ready during setup completion; continuing offline.");
        }
        if (cancelled) return;

        setCompletionPhase(2);
        setCompletionComplete(true);
        await delay(2000);
        if (cancelled) return;

        if (onComplete) onComplete();
        else window.location.href = "/";
      } catch (err) {
        if (cancelled) return;
        setCompletionStarted(false);
        setCompletionComplete(false);
        setCompletionPhase(0);
        const fallback = tRef.current("wizard.completionUnreachable");
        const isNetworkError = err instanceof TypeError;
        setCompletionError(
          isNetworkError || !(err instanceof Error) ? fallback : err.message
        );
      }
    }

    runCompletion();

    return () => {
      cancelled = true;
      timers.forEach((timer) => clearTimeout(timer));
    };
  }, [completionStarted, onComplete]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="spinner" role="status" aria-label="Loading" />
      </div>
    );
  }

  if (setupError) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <p className="text-[var(--coral-bright)] text-sm mb-4">{setupError}</p>
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-6 py-2.5 btn-gradient text-white rounded-lg text-sm font-semibold cursor-pointer transition transform hover:scale-105"
          >
            {t("retry")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {restarting && <ReconnectingOverlay redirectTo="/setup" />}
      {/* The SURFACE is full-bleed and the MEASURE is a child. Capping the
          element that also paints the scrim is what turns a header into an
          opaque slab with two hard vertical edges on the wallpaper. This bar
          carries no border either: its bottom boundary is the progress rail,
          so the edge states where the customer is instead of drawing a line. */}
      <header className="setup-chrome">
        <div className="setup-chrome-inner">
          <Link href="/" className="setup-brand" aria-label="ClawBox">
            <Image
              src="/clawbox-icon.png"
              alt=""
              width={28}
              height={28}
              className="setup-brand-mark"
              priority
            />
            <span className="setup-brand-word title-gradient">ClawBox</span>
            {/* Hermes is a byline in the metadata slot, never a second lockup.
                Lit by [data-agent="hermes"] on an ancestor. */}
            <span className="setup-cobrand">
              <span className="setup-caduceus" aria-hidden="true">&#9877;</span>
              <span className="setup-cobrand-name">Hermes Agent</span>
            </span>
          </Link>

          <ProgressBar currentStep={currentStep} />

          <div className="setup-actions">
            <div className="relative">
              <button
                type="button"
                onClick={() => { setShowHelp((v) => !v); setShowPower(false); setShowLang(false); }}
                aria-label="Need help?"
                aria-expanded={showHelp}
                className="setup-icon-btn"
              >
                {/* `help_outline` is not in the subset the device actually
                    ships (public/fonts/material-symbols-rounded.ttf is a
                    static font with no FILL axis and no outline aliases), so
                    it rendered as its own name. `help` is the real glyph. */}
                <span className="material-symbols-rounded" style={{ fontSize: 20 }}>help</span>
              </button>
              {showHelp && <HelpPopover step={currentStep} onClose={() => setShowHelp(false)} t={t} />}
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => { setShowPower((v) => !v); setShowHelp(false); setShowLang(false); }}
                aria-label="Power options"
                aria-expanded={showPower}
                className="setup-icon-btn"
              >
                <span className="material-symbols-rounded" style={{ fontSize: 20 }}>power_settings_new</span>
              </button>
              {showPower && (
                <PowerMenu
                  onClose={() => setShowPower(false)}
                  onRestart={() => { setShowPower(false); setRestarting(true); }}
                  t={t}
                />
              )}
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => { setShowLang((v) => !v); setShowHelp(false); setShowPower(false); }}
                aria-label={t("wifi.language")}
                aria-expanded={showLang}
                aria-haspopup="menu"
                className="setup-icon-btn"
              >
                <span className="material-symbols-rounded" style={{ fontSize: 20 }}>language</span>
              </button>
              {showLang && (
                <LanguageMenu
                  onClose={() => setShowLang(false)}
                  locale={locale}
                  setLocale={setLocale}
                />
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Top-anchored, not centred: the steps range from ~430px to ~700px
          tall, so a centred card slides its own H1 up and down on every
          advance. Anchored, all five screens share one horizon.

          The welcome screen is the one exception; the why lives with the rule,
          at `.setup-main[data-welcome]` in globals.css. */}
      <main className="setup-main" data-welcome={currentStep === 1 ? "" : undefined}>
        <div className="w-full flex flex-col items-center">
        {completionStarted ? (
          <SetupCompletionOverlay
            phase={completionPhase}
            completed={completionComplete}
            hermes={isHermesEdition}
            t={t}
          />
        ) : (
          <>
            {/* Completion failed and is no longer in flight (we're in the
                !completionStarted branch). Show it regardless of step — the
                resume path lands on step 6, which has no body, so gating on
                step 5 would leave a blank card. */}
            {completionError && (
              <div className="w-full max-w-[520px] mb-4">
                <StatusMessage type="error" message={completionError} />
                <button
                  type="button"
                  onClick={startCompletion}
                  className="mt-3 px-5 py-2 btn-gradient text-white rounded-lg text-sm font-semibold cursor-pointer transition transform hover:scale-105"
                >
                  {t("retry")}
                </button>
              </div>
            )}
            {currentStep === 1 && (
              <WifiStep onNext={() => goToStep(2)} />
            )}
            {currentStep === 2 && (
              <UpdateStep onNext={() => goToStep(3)} />
            )}
            {currentStep === 3 && (
              <CredentialsStep onNext={() => goToStep(4)} />
            )}
            {currentStep === 4 && (
              <AIModelsStep
                providerIds={["clawai", "openai", "anthropic", "google", "openrouter", "llamacpp"]}
                defaultProviderId="clawai"
                title="Connect AI Provider"
                description={t("ai.description")}
                onNext={() => goToStep(5)}
              />
            )}
            {/* Local AI step removed from initial setup — owners now reach
                it via Settings → Local AI on demand. The wizard ships a
                ClawBox-AI-first happy path; a local fallback is no longer
                a precondition for finishing setup. */}
            {currentStep === 5 && (
              <TelegramStep onNext={startCompletion} />
            )}
          </>
        )}
        </div>
      </main>

      {/* The ClawBox logo link is gone: it was the same mark as the header at
          20px, pointing at a website the box cannot reach at steps 1–2 because
          it is serving a captive portal. Discord keeps its place and gains a
          label — a bare 18px glyph is not a recognisable affordance for
          someone unboxing their first AI appliance. */}
      <footer className="setup-footer">
        <a
          href={DISCORD_INVITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 h-9 px-3 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)] text-xs font-semibold hover:text-[var(--text-primary)] transition-colors"
        >
          <svg width="18" height="14" viewBox="0 0 71 55" fill="currentColor" aria-hidden="true">
            <path d="M60.1 4.9A58.5 58.5 0 0 0 45.4.2a.2.2 0 0 0-.2.1 40.8 40.8 0 0 0-1.8 3.7 54 54 0 0 0-16.2 0A37.4 37.4 0 0 0 25.4.3a.2.2 0 0 0-.2-.1A58.4 58.4 0 0 0 10.6 4.9a.2.2 0 0 0-.1.1C1.5 18.7-.9 32.2.3 45.5v.2a58.9 58.9 0 0 0 17.7 9a.2.2 0 0 0 .3-.1 42 42 0 0 0 3.6-5.9.2.2 0 0 0-.1-.3 38.8 38.8 0 0 1-5.5-2.6.2.2 0 0 1 0-.4l1.1-.9a.2.2 0 0 1 .2 0 42 42 0 0 0 35.8 0 .2.2 0 0 1 .2 0l1.1.9a.2.2 0 0 1 0 .4 36.4 36.4 0 0 1-5.5 2.6.2.2 0 0 0-.1.3 47.2 47.2 0 0 0 3.6 5.9.2.2 0 0 0 .3.1 58.7 58.7 0 0 0 17.7-9 .2.2 0 0 0 .1-.2c1.4-15-2.3-28-9.8-39.6a.2.2 0 0 0-.1 0ZM23.7 37.3c-3.4 0-6.3-3.2-6.3-7s2.8-7 6.3-7 6.4 3.2 6.3 7-2.8 7-6.3 7Zm23.3 0c-3.4 0-6.3-3.2-6.3-7s2.8-7 6.3-7 6.4 3.2 6.3 7-2.8 7-6.3 7Z"/>
          </svg>
          <span>{t("settings.discordCommunity")}</span>
        </a>
      </footer>
    </>
  );
}

export default function SetupWizard(props: SetupWizardProps = {}) {
  return (
    <I18nProvider>
      <SetupWizardInner {...props} />
    </I18nProvider>
  );
}
