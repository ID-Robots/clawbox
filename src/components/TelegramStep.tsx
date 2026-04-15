"use client";

import { useState, useEffect, useRef } from "react";
import { QRCodeSVG } from "qrcode.react";
import StatusMessage from "./StatusMessage";
import { useT } from "@/lib/i18n";

function ConfiguringOverlay({ onDone, t }: { onDone: () => void; t: (key: string) => string }) {
  const CONFIGURING_STEPS = [
    { label: t("telegram.tokenVerified") },
    { label: t("telegram.connectingTelegram") },
    { label: t("telegram.restartingGateway") },
    { label: t("telegram.waitingGateway") },
    { label: t("telegram.readyToChat") },
  ];

  const [phase, setPhase] = useState(0);
  const [dots, setDots] = useState("");
  const overlayRef = useRef<HTMLDivElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    async function run() {
      // Phase 0: Token verified (immediate)
      // Phase 1: Connecting to Telegram
      await delay(1500);
      if (cancelledRef.current) return;
      setPhase(1);

      // Phase 2: Restarting gateway
      await delay(2500);
      if (cancelledRef.current) return;
      setPhase(2);

      // Phase 3: Waiting for gateway — poll health endpoint
      await delay(2000);
      if (cancelledRef.current) return;
      setPhase(3);

      await pollGatewayHealth();
      if (cancelledRef.current) return;

      // Phase 4: Ready
      setPhase(4);
      await delay(1500);
      if (cancelledRef.current) return;
      onDone();
    }

    function delay(ms: number): Promise<void> {
      return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        timers.push(t);
      });
    }

    async function pollGatewayHealth() {
      const maxAttempts = 30;
      for (let i = 0; i < maxAttempts; i++) {
        if (cancelledRef.current) return;
        try {
          const res = await fetch("/setup-api/gateway/health");
          if (res.ok) {
            const data = await res.json();
            if (data.available) return;
          }
        } catch { /* gateway not ready yet */ }
        await delay(2000);
      }
    }

    run();

    overlayRef.current?.focus();
    return () => {
      cancelledRef.current = true;
      timers.forEach((t) => clearTimeout(t));
    };
  }, [onDone]);

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

      {/* Central icon with orbiting particles */}
      <div className="relative w-24 h-24 flex items-center justify-center">
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

      {/* Status text */}
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

      {/* Progress steps */}
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
          {t("telegram.pleaseWait")}{dots}
        </p>
      )}
    </div>
  );
}

interface TelegramStepProps {
  onNext: () => void;
}

export default function TelegramStep({ onNext }: TelegramStepProps) {
  const { t } = useT();
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const saveControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      saveControllerRef.current?.abort();
    };
  }, []);

  const saveTelegram = async () => {
    if (!token.trim()) {
      setStatus({ type: "error", message: t("telegram.enterToken") });
      return;
    }
    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;

    setSaving(true);
    setConfiguring(true);
    try {
      const res = await fetch("/setup-api/telegram/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: token.trim() }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setConfiguring(false);
        setStatus({
          type: "error",
          message: data.error || "Failed to save",
        });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (!data.success) {
        setConfiguring(false);
        setStatus({
          type: "error",
          message: data.error || "Failed to save",
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setConfiguring(false);
      setStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  };

  return (
    <div className="w-full max-w-[520px]" data-testid="setup-step-telegram">
      <div className="card-surface rounded-2xl p-5 sm:p-8 relative overflow-hidden">
        {configuring && (
          <ConfiguringOverlay onDone={onNext} t={t} />
        )}
        <div className={configuring ? "invisible h-0 overflow-hidden" : ""}>
        <h1 className="text-xl sm:text-2xl font-bold font-display mb-2 flex flex-wrap items-center gap-2.5">
          {t("telegram.title")}
          <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-orange-500/15 text-orange-400 leading-none">{t("recommended")}</span>
        </h1>
        <p className="text-[var(--text-secondary)] mb-5 leading-relaxed">
          {t("telegram.description")}
        </p>

        <div className="flex flex-col sm:flex-row gap-4 sm:gap-5 items-center sm:items-start mb-4">
          <div className="hidden sm:block shrink-0 p-2 bg-white rounded-lg">
            <QRCodeSVG
              value="https://t.me/BotFather"
              size={96}
              level="M"
              bgColor="#ffffff"
              fgColor="#000000"
            />
          </div>
          <ol className="ml-0 pl-5 leading-[1.8] text-sm text-[var(--text-primary)] list-decimal">
            <li>
              {t("telegram.step1")}{" "}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--coral-bright)] hover:text-orange-300 font-semibold"
              >
                @BotFather
              </a>{" "}
              {t("telegram.step1Suffix")}
            </li>
            <li>
              {t("telegram.step2")}{" "}
              <code className="bg-[var(--bg-surface)] px-1.5 py-0.5 rounded text-xs text-[var(--coral-bright)]">
                /newbot
              </code>{" "}
              {t("telegram.step2Suffix")}
            </li>
            <li>
              {t("telegram.step3prefix")}{" "}
              <strong>{t("telegram.step3bold")}</strong>{" "}
              {t("telegram.step3suffix")}
            </li>
          </ol>
        </div>
        <a
          href="https://t.me/BotFather"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 w-full px-4 py-3 mb-5 bg-[#229ED9]/15 hover:bg-[#229ED9]/25 border border-[#229ED9]/40 hover:border-[#229ED9]/60 rounded-lg text-sm font-semibold text-[#5eb8e6] transition-colors no-underline"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>
          {t("telegram.openBotFather")}
        </a>
        <label htmlFor="telegram-bot-token" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5 mt-4">
          {t("telegram.botToken")}
        </label>
        <div className="relative">
          <input
            id="telegram-bot-token"
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
            spellCheck={false}
            autoComplete="off"
            className="w-full px-3.5 py-2.5 pr-10 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
          />
          <button
            type="button"
            onClick={() => setShowToken((v) => !v)}
            aria-label={showToken ? "Hide token" : "Show token"}
            className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-9 h-9 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>
              {showToken ? "visibility_off" : "visibility"}
            </span>
          </button>
        </div>
        {status && (
          <StatusMessage type={status.type} message={status.message} />
        )}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 mt-5">
          <button
            type="button"
            onClick={saveTelegram}
            disabled={saving}
            className="w-full sm:w-auto px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100"
          >
            {saving ? t("connecting") : t("settings.connect")}
          </button>
          <button
            type="button"
            onClick={onNext}
            className="bg-transparent border-none text-[var(--coral-bright)] text-sm underline cursor-pointer p-1 self-center"
          >
            {t("telegram.skipForNow")}
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}
