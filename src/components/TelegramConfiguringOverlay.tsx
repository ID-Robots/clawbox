"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";

interface TelegramConfiguringOverlayProps {
  onDone: () => void;
}

export default function TelegramConfiguringOverlay({ onDone }: TelegramConfiguringOverlayProps) {
  const { t } = useT();

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

    async function run() {
      await delay(1500);
      if (cancelledRef.current) return;
      setPhase(1);

      await delay(2500);
      if (cancelledRef.current) return;
      setPhase(2);

      await delay(2000);
      if (cancelledRef.current) return;
      setPhase(3);

      await pollGatewayHealth();
      if (cancelledRef.current) return;

      setPhase(4);
      await delay(1500);
      if (cancelledRef.current) return;
      onDone();
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
          {t("telegram.pleaseWait")}{dots}
        </p>
      )}
    </div>
  );
}
