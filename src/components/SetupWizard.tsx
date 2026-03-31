"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import ProgressBar from "./ProgressBar";
import WifiStep from "./WifiStep";
import UpdateStep from "./UpdateStep";
import CredentialsStep from "./CredentialsStep";
import AIModelsStep from "./AIModelsStep";
import TelegramStep from "./TelegramStep";

async function completeSetup(onComplete?: () => void) {
  try {
    await fetch("/setup-api/setup/complete", { method: "POST" });
  } catch {}
  if (onComplete) onComplete();
  else window.location.href = "/";
}

function applyStatusData(
  data: Record<string, unknown>,
  setCurrentStep: (v: number) => void,
  onComplete?: () => void
) {
  if (data.setup_complete) {
    if (onComplete) onComplete();
    else window.location.href = "/";
    return;
  }
  if (data.telegram_configured) {
    completeSetup(onComplete);
    return;
  }
  if (data.ai_model_configured) {
    setCurrentStep(5);
  } else if (data.password_configured) {
    setCurrentStep(4);
  } else if (data.update_completed || data.wifi_configured) {
    setCurrentStep(2);
  }
}

/* ── Power menu ── */

function PowerMenu({ onClose }: { onClose: () => void }) {
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
    try {
      await fetch("/setup-api/system/power", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
    } catch {}
  };

  return (
    <div ref={ref} className="absolute right-0 top-full mt-1 min-w-[160px] bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-lg shadow-xl z-50 overflow-hidden">
      {acting ? (
        <div className="flex items-center gap-2 px-4 py-3 text-xs text-[var(--text-secondary)]">
          <span className="inline-block w-3 h-3 border-2 border-[var(--coral-bright)] border-t-transparent rounded-full animate-spin" />
          {confirming === "shutdown" ? "Shutting down..." : "Restarting..."}
        </div>
      ) : confirming ? (
        <div className="p-3">
          <p className="text-xs text-[var(--text-secondary)] mb-2">
            {confirming === "shutdown" ? "Shut down device?" : "Restart device?"}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => execute(confirming)}
              className="flex-1 px-3 py-1.5 bg-red-500/20 text-red-400 border border-red-500/30 rounded text-xs font-semibold cursor-pointer hover:bg-red-500/30 transition-colors"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              className="flex-1 px-3 py-1.5 bg-[var(--bg-deep)] text-[var(--text-secondary)] border border-[var(--border-subtle)] rounded text-xs cursor-pointer hover:bg-[var(--bg-surface)] transition-colors"
            >
              Cancel
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
            Restart
          </button>
          <button
            type="button"
            onClick={() => setConfirming("shutdown")}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs text-red-400 bg-transparent border-none cursor-pointer hover:bg-[var(--bg-deep)] transition-colors text-left"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>power_settings_new</span>
            Shut Down
          </button>
        </>
      )}
    </div>
  );
}

/* ── Help popover ── */

function HelpPopover({ step, onClose }: { step: number; onClose: () => void }) {
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
      title: "Connecting to the Internet",
      body: "Select your country, then plug in an Ethernet cable for the easiest setup — ClawBox will detect it automatically. Or choose WiFi to scan for nearby networks. If your network doesn't appear, tap \"Other network\" to enter the name manually.",
    },
    2: {
      title: "System Update",
      body: "ClawBox is checking for the latest software. This runs automatically — just wait for it to finish. If it fails, check your internet connection and try again.",
    },
    3: {
      title: "Device Security",
      body: "Set a password to protect your ClawBox dashboard. You'll need this password to access ClawBox from your browser. Choose something memorable but secure.",
    },
    4: {
      title: "AI Model Setup",
      body: "Choose an AI provider to power your assistant. ClawAI is free and works instantly. Other providers require an API key or subscription from their website.",
    },
    5: {
      title: "Telegram Bot",
      body: "Connect a Telegram bot to chat with your AI assistant from anywhere. Open Telegram, find @BotFather, create a new bot, and paste the token here.",
    },
  };

  const tip = tips[step] ?? tips[1];

  return (
    <div ref={ref} className="absolute right-0 top-full mt-1 w-[280px] bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-lg shadow-xl z-50 p-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1.5">{tip.title}</h3>
      <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{tip.body}</p>
    </div>
  );
}

/* ── Main wizard ── */

interface SetupWizardProps {
  onComplete?: () => void;
}

export default function SetupWizard({ onComplete }: SetupWizardProps = {}) {
  const [currentStep, setCurrentStep] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [showPower, setShowPower] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    fetch("/setup-api/setup/status", { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Status check failed (${r.status})`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) applyStatusData(data, setCurrentStep, onComplete);
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
  }, [retryCount]);

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
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="px-4 py-2.5 sm:px-6 sm:py-4 flex items-center justify-between gap-3 sticky top-0 z-50">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <Image
            src="/clawbox-icon.png"
            alt="ClawBox"
            width={36}
            height={36}
            className="w-9 h-9 object-contain"
            priority
          />
          <div className="flex flex-col leading-tight">
            <span className="text-xl font-bold font-display title-gradient">
              ClawBox
            </span>
            <span className="text-[10px] text-green-400 -mt-1">
              {process.env.NEXT_PUBLIC_APP_VERSION}
            </span>
          </div>
        </Link>
        <ProgressBar currentStep={currentStep} />
        <div className="flex items-center gap-1 shrink-0">
          <div className="relative">
            <button
              type="button"
              onClick={() => { setShowHelp((v) => !v); setShowPower(false); }}
              aria-label="Need help?"
              className="flex items-center justify-center w-8 h-8 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] bg-transparent border-none cursor-pointer transition-colors"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>help_outline</span>
            </button>
            {showHelp && <HelpPopover step={currentStep} onClose={() => setShowHelp(false)} />}
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => { setShowPower((v) => !v); setShowHelp(false); }}
              aria-label="Power options"
              className="flex items-center justify-center w-8 h-8 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] bg-transparent border-none cursor-pointer transition-colors"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>power_settings_new</span>
            </button>
            {showPower && <PowerMenu onClose={() => setShowPower(false)} />}
          </div>
        </div>
      </header>

      <main
        className="flex-1 flex flex-col items-center justify-start sm:justify-center px-4 pt-2 pb-4 sm:p-6"
      >
        {currentStep === 1 && (
          <WifiStep onNext={() => setCurrentStep(2)} />
        )}
        {currentStep === 2 && (
          <UpdateStep onNext={() => setCurrentStep(3)} />
        )}
        {currentStep === 3 && (
          <CredentialsStep onNext={() => setCurrentStep(4)} />
        )}
        {currentStep === 4 && (
          <AIModelsStep onNext={() => setCurrentStep(5)} />
        )}
        {currentStep === 5 && (
          <TelegramStep onNext={() => completeSetup(onComplete)} />
        )}
      </main>

      <footer className="px-4 py-3 flex items-center justify-center gap-3">
        <a
          href="https://openclawhardware.dev/"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="ClawBox website"
          className="flex items-center justify-center w-9 h-9 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] transition transform hover:scale-105"
        >
          <Image src="/clawbox-logo.png" alt="ClawBox" width={28} height={28} className="w-7 h-7 object-contain" />
        </a>
        <a
          href="https://discord.gg/FbKmnxYnpq"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Join our Discord"
          className="flex items-center justify-center w-9 h-9 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[#5865F2] transition transform hover:scale-105"
        >
          <svg width="18" height="14" viewBox="0 0 71 55" fill="currentColor" aria-hidden="true">
            <path d="M60.1 4.9A58.5 58.5 0 0 0 45.4.2a.2.2 0 0 0-.2.1 40.8 40.8 0 0 0-1.8 3.7 54 54 0 0 0-16.2 0A37.4 37.4 0 0 0 25.4.3a.2.2 0 0 0-.2-.1A58.4 58.4 0 0 0 10.6 4.9a.2.2 0 0 0-.1.1C1.5 18.7-.9 32.2.3 45.5v.2a58.9 58.9 0 0 0 17.7 9a.2.2 0 0 0 .3-.1 42 42 0 0 0 3.6-5.9.2.2 0 0 0-.1-.3 38.8 38.8 0 0 1-5.5-2.6.2.2 0 0 1 0-.4l1.1-.9a.2.2 0 0 1 .2 0 42 42 0 0 0 35.8 0 .2.2 0 0 1 .2 0l1.1.9a.2.2 0 0 1 0 .4 36.4 36.4 0 0 1-5.5 2.6.2.2 0 0 0-.1.3 47.2 47.2 0 0 0 3.6 5.9.2.2 0 0 0 .3.1 58.7 58.7 0 0 0 17.7-9 .2.2 0 0 0 .1-.2c1.4-15-2.3-28-9.8-39.6a.2.2 0 0 0-.1 0ZM23.7 37.3c-3.4 0-6.3-3.2-6.3-7s2.8-7 6.3-7 6.4 3.2 6.3 7-2.8 7-6.3 7Zm23.3 0c-3.4 0-6.3-3.2-6.3-7s2.8-7 6.3-7 6.4 3.2 6.3 7-2.8 7-6.3 7Z"/>
          </svg>
        </a>
      </footer>
    </>
  );
}
