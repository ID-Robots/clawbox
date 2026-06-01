"use client";

import { createPortal } from "react-dom";
import Image from "next/image";

export interface ReconnectStageProps {
  /** Ordered step labels shown as a checklist under the animation. */
  steps: string[];
  /** Index of the currently-active step (spinner); earlier steps show a check. */
  phaseIndex: number;
  /** When true, every step is checked and the green success mark is shown. */
  completed: boolean;
  title: string;
  description: string;
  /** Optional highlighted callout (e.g. "reconnect this device to <ssid>"). */
  instruction?: string;
  /** Optional manual fallback link rendered as a button. */
  action?: { label: string; href: string };
}

/**
 * Shared full-screen presentational shell for the setup reconnect/handoff
 * overlays — pulse rings, orbiting dots, the bobbing crab mascot, a title +
 * description, an optional instruction callout, a step checklist, and an
 * optional manual-action button. Pure UI: the polling/redirect logic lives in
 * the wrappers (ReconnectingOverlay, WifiHandoffOverlay).
 */
export default function ReconnectStage({
  steps,
  phaseIndex,
  completed,
  title,
  description,
  instruction,
  action,
}: ReconnectStageProps) {
  // These overlays only render after a client-side interaction, so the portal
  // target is always present; guard against SSR where document is undefined.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center px-6 overflow-y-auto py-8"
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

      <div className="flex flex-col items-center gap-7 max-w-md w-full text-center my-auto">
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

        {instruction && (
          <div className="w-full max-w-[320px] rounded-lg border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-300 reconnect-fade-in" style={{ animationDelay: "0.25s" }}>
            {instruction}
          </div>
        )}

        <div className="w-full max-w-[300px] space-y-2.5 mt-1 text-left">
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

        {action && (
          <a
            href={action.href}
            className="inline-flex items-center justify-center px-6 py-2.5 btn-gradient text-white rounded-lg text-sm font-semibold cursor-pointer transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] reconnect-fade-in"
            style={{ animationDelay: "0.3s" }}
          >
            {action.label}
          </a>
        )}
      </div>
    </div>,
    document.body
  );
}
