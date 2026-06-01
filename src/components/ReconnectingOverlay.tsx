"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { useT } from "@/lib/i18n";

interface ReconnectingOverlayProps {
  /**
   * Endpoint polled until it responds OK, signalling the device's web server
   * is back after a service/hardware restart. Defaults to the setup status
   * route, which is always reachable while the wizard is up.
   */
  healthUrl?: string;
  /**
   * Where to send the browser once the device is back. When omitted the page
   * is reloaded in place (the setup status route resumes the right step).
   */
  redirectTo?: string;
  /**
   * Grace period before polling begins. The device needs a moment to actually
   * go down — polling immediately would get a stale "still up" response.
   */
  graceMs?: number;
}

type Phase = "restarting" | "reconnecting" | "done";

/**
 * Full-screen overlay shown while the device restarts and the browser's
 * connection drops. Keeps the customer in a friendly animated loop — pulsing
 * rings, orbiting dots, the crab mascot — instead of a dead/erroring page,
 * polls until the web server answers again, then reloads.
 */
export default function ReconnectingOverlay({
  healthUrl = "/setup-api/setup/status",
  redirectTo,
  graceMs = 4000,
}: ReconnectingOverlayProps) {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>("restarting");
  const [dots, setDots] = useState("");
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Animated trailing dots for the "…" affordance.
  useEffect(() => {
    const id = setInterval(() => setDots((d) => (d.length >= 3 ? "" : d + ".")), 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let pollId: ReturnType<typeof setInterval> | null = null;

    const graceTimer = setTimeout(() => {
      if (cancelled) return;
      setPhase("reconnecting");
      pollId = setInterval(async () => {
        try {
          const res = await fetch(healthUrl, {
            cache: "no-store",
            signal: AbortSignal.timeout(3000),
          });
          if (cancelled || !res.ok) return;
          if (pollId) clearInterval(pollId);
          setPhase("done");
          setTimeout(() => {
            if (cancelled) return;
            if (redirectTo) window.location.replace(redirectTo);
            else window.location.reload();
          }, 1600);
        } catch {
          /* device still offline — keep looping */
        }
      }, 2500);
    }, graceMs);

    return () => {
      cancelled = true;
      clearTimeout(graceTimer);
      if (pollId) clearInterval(pollId);
    };
  }, [healthUrl, redirectTo, graceMs]);

  if (!mounted) return null;

  const completed = phase === "done";
  const phaseIndex = phase === "restarting" ? 0 : phase === "reconnecting" ? 1 : 2;

  const steps = [
    t("wizard.restarting"),
    t("settings.waitingOnline"),
    t("settings.backOnline"),
  ];

  const title = completed
    ? t("settings.backOnline")
    : phase === "reconnecting"
      ? `${t("settings.reconnecting")}${dots}`
      : `${t("wizard.restarting")}`;

  const description = completed ? t("ai.almostReady") : t("ai.pleaseDontClose");

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center px-6"
      style={{ zIndex: 2147483647, background: "rgba(13, 17, 23, 1)" }}
      role="status"
      aria-live="polite"
    >
      <style>{`
        @keyframes reconnect-check-draw { to { stroke-dashoffset: 0 } }
        @keyframes reconnect-check-circle { to { stroke-dashoffset: 0 } }
        @keyframes reconnect-fade-in { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes reconnect-pulse-ring { 0% { transform: scale(0.85); opacity: 0.55 } 50% { transform: scale(1.15); opacity: 0 } 100% { transform: scale(0.85); opacity: 0.55 } }
        @keyframes reconnect-orbit { from { transform: rotate(0deg) translateX(38px) rotate(0deg) } to { transform: rotate(360deg) translateX(38px) rotate(-360deg) } }
        @keyframes reconnect-bob { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(-5px) } }
        .reconnect-fade-in { animation: reconnect-fade-in 0.4s ease-out both }
      `}</style>

      <div className="flex flex-col items-center gap-7 max-w-md w-full text-center">
        <div className="relative w-28 h-28 flex items-center justify-center">
          <div className="absolute inset-0 rounded-full border-2 border-[var(--coral-bright)]/20" style={{ animation: "reconnect-pulse-ring 2s ease-in-out infinite" }} />
          <div className="absolute inset-2 rounded-full border border-[var(--coral-bright)]/10" style={{ animation: "reconnect-pulse-ring 2s ease-in-out infinite 0.45s" }} />

          {!completed && [0, 1, 2].map((i) => (
            <div
              key={i}
              className="absolute inset-0 flex items-center justify-center"
              style={{ animation: `reconnect-orbit ${3 + i * 0.45}s linear infinite`, animationDelay: `${i * 0.35}s` }}
            >
              <div className="w-2 h-2 rounded-full bg-[var(--coral-bright)]" style={{ opacity: 0.35 + i * 0.2 }} />
            </div>
          ))}

          {completed ? (
            <svg width="52" height="52" viewBox="0 0 56 56" fill="none" className="reconnect-fade-in">
              <circle cx="28" cy="28" r="25" stroke="#22c55e" strokeWidth="3" strokeDasharray="157" strokeDashoffset="157" style={{ animation: "reconnect-check-circle 0.6s ease-out 0.1s forwards" }} />
              <path d="M17 28l7 7 15-15" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="35" strokeDashoffset="35" style={{ animation: "reconnect-check-draw 0.4s ease-out 0.5s forwards" }} />
            </svg>
          ) : (
            <div
              className="relative z-10 flex h-16 w-16 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] reconnect-fade-in"
              style={{ animation: "reconnect-bob 2.4s ease-in-out infinite" }}
            >
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

        <div className="reconnect-fade-in" style={{ animationDelay: "0.2s" }}>
          <h2 className="text-lg font-bold text-[var(--text-primary)] mb-1">{title}</h2>
          <p className="text-sm text-[var(--text-muted)]">{description}</p>
        </div>

        <div className="w-full max-w-[280px] space-y-2.5 mt-1 text-left">
          {steps.map((step, index) => (
            <div
              key={step}
              className={`flex items-center gap-2.5 text-xs transition-all duration-300 ${
                completed || index <= phaseIndex ? "opacity-100" : "opacity-0 translate-y-1"
              }`}
            >
              {completed || index < phaseIndex ? (
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 shrink-0">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L19 7" /></svg>
                </span>
              ) : index === phaseIndex ? (
                <span className="flex items-center justify-center w-5 h-5 shrink-0">
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-[var(--coral-bright)] border-t-transparent animate-spin" />
                </span>
              ) : (
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-gray-700/50 shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-600" />
                </span>
              )}
              <span className={completed || index <= phaseIndex ? (completed || index < phaseIndex ? "text-emerald-400" : "text-[var(--text-primary)]") : "text-[var(--text-muted)]"}>
                {step}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
