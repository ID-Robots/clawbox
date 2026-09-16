"use client";

import { useEffect, useRef, useState } from "react";
import AIProviderIcon from "./AIProviderIcon";

/**
 * The "setting up <provider>" overlay the AI-provider step shows while a
 * connect is being applied on the box — the provider mark, a checklist whose
 * rows light up over time, an optional percentage bar, and the DONE state.
 * Shared by the OpenClaw step (AIModelsStep) and the Hermes step
 * (HermesProviderConfig), so the two editions cannot drift: the owner saw the
 * Hermes wizard sit on a one-line "Finishing setup on this device…" while the
 * OpenClaw wizard drew this (2026-09-16).
 */

/**
 * When each row of the generic "configuring" overlay lights up, in ms.
 *
 * The LAST entry is deliberately not used by the timer — see the effect that
 * schedules these. Driving the final row off a stopwatch is what made this
 * screen lie: it reached "Almost ready" at 22 s and then sat there, unchanged,
 * for the remaining two minutes the config writes actually took, which reads as
 * a hang on a screen that is also asking the customer not to close the page
 * (TASK-483).
 */
export const CONFIGURING_STEP_DELAYS = [0, 2000, 5000, 12000, 22000];

/** The rows of the generic (cloud provider) checklist, in the customer's language. */
export const GENERIC_CONFIGURING_STEP_KEYS = [
  "ai.credentialsVerified",
  "ai.updatingConfig",
  "ai.restartingGateway",
  "ai.warmingUp",
  "ai.almostReady",
] as const;

export function ConfiguringOverlay({
  provider,
  providerName,
  steps,
  phase,
  detail,
  progressPercent,
  completed,
  t,
}: {
  provider: string;
  /** What the customer calls it — the step knows its own provider table, this component does not. */
  providerName: string;
  steps: string[];
  phase: number;
  detail: string | null;
  progressPercent: number | null;
  completed: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [dots, setDots] = useState("");

  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Trap focus inside overlay
    overlayRef.current?.focus();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setDots((d) => (d.length >= 3 ? "" : d + ".")), 500);
    return () => clearInterval(id);
  }, []);

  return (
    <div ref={overlayRef} tabIndex={-1} className="flex flex-col items-center gap-6 px-2 pt-2 pb-6 outline-none">
      <style>{`
        @keyframes aimodels-check-draw { to { stroke-dashoffset: 0 } }
        @keyframes aimodels-fade-in { from { opacity: 0; transform: translateY(var(--lift)) } to { opacity: 1; transform: translateY(0) } }
        .aimodels-fade-in { animation: aimodels-fade-in var(--d-3) var(--ease-entrance) both }
      `}</style>

      {/* The provider mark, and nothing orbiting it. Two counter-rotating
          dot rings and a pulsing halo ran at the same speed at 0% and at
          99% of a gateway restart — perpetual motion bound to no state,
          while the checklist and the percentage below it were doing the
          actual reporting. The mark sits in the product's own tile
          instead, and turns cyan (DONE) when the work lands. */}
      <div
        className={`flex h-[72px] w-[72px] items-center justify-center rounded-[var(--r-3)] ${
          completed ? "bg-[var(--cyan-wash)]" : "bg-[var(--fill-2)]"
        }`}
        style={{ transition: "background-color var(--d-3) var(--ease-standard)" }}
      >
        {completed ? (
          <svg width="44" height="44" viewBox="0 0 56 56" fill="none" className="aimodels-fade-in">
            <circle cx="28" cy="28" r="25" stroke="var(--cyan-bright)" strokeWidth="3" strokeDasharray="157" strokeDashoffset="157" style={{ animation: "aimodels-check-draw var(--d-5) var(--ease-emphasis) 100ms forwards" }} />
            <path d="M17 28l7 7 15-15" stroke="var(--cyan-bright)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="35" strokeDashoffset="35" style={{ animation: "aimodels-check-draw var(--d-3) var(--ease-entrance) var(--d-5) forwards" }} />
          </svg>
        ) : (
          <AIProviderIcon provider={provider} size={44} className="aimodels-fade-in" />
        )}
      </div>

      {/* Provider name */}
      <div className="text-center aimodels-fade-in" style={{ animationDelay: "var(--stagger)" }}>
        <h2 className="text-[length:var(--t-6)] leading-[1.15] font-bold text-[var(--text-primary)] mb-2">
          {completed ? t("connected") : t("ai.settingUp", { provider: providerName })}
        </h2>
        <p className="text-[length:var(--t-4)] leading-[1.6] text-[var(--text-secondary)]">
          {completed
            ? detail || t("ai.configured")
            : detail || `${t("ai.configuringAssistant")}${dots}`}
        </p>
      </div>

      {/* Progress steps */}
      <ul className="w-full max-w-[280px] space-y-2 list-none">
        {steps.map((step, i) => {
          const stepDone = completed || i < phase;
          const stepNow = !completed && i === phase;
          const reached = completed || i <= phase;
          return (
            <li
              key={i}
              // Which row a customer is actually looking at, stated rather than
              // inferred from a Tailwind class. Every label is in the DOM at all
              // times — an unreached row is rendered at opacity 0 — so "is the
              // last row showing yet" is a question only this attribute can
              // answer (TASK-483).
              data-step-state={stepDone ? "done" : stepNow ? "active" : "pending"}
              className={`flex items-center gap-2 text-[length:var(--t-2)] ${
                reached ? "opacity-100" : "opacity-0 translate-y-1"
              }`}
              style={{
                transition: "opacity var(--d-2) var(--ease-standard), transform var(--d-2) var(--ease-standard)",
                transitionDelay: `calc(${Math.min(i, 3)} * var(--stagger))`,
              }}
            >
              {stepDone ? (
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[var(--cyan-wash)] text-[var(--cyan-bright)] shrink-0">
                  <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14 }}>check</span>
                </span>
              ) : stepNow ? (
                <span className="flex items-center justify-center w-5 h-5 shrink-0">
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-[var(--coral-bright)] border-t-transparent animate-spin" />
                </span>
              ) : (
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[var(--fill-1)] shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--fill-4)]" />
                </span>
              )}
              <span className={stepDone ? "text-[var(--cyan-bright)]" : stepNow ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}>
                {step}
              </span>
            </li>
          );
        })}
      </ul>

      {progressPercent !== null && !completed && (
        <div className="w-full max-w-[280px]">
          <div className="flex items-center justify-between gap-2 text-[length:var(--t-1)] text-[var(--text-muted)] mb-2">
            <span className="truncate">{providerName}</span>
            <span className="tabular-nums shrink-0">{progressPercent}%</span>
          </div>
          {/* Linear, because --ease-truth is the only honest curve for a
              bar that reports someone else's progress: an easing curve
              would invent a velocity the box never reported. */}
          <div className="w-full h-1 bg-[var(--fill-2)] rounded-[var(--r-full)] overflow-hidden">
            <div
              className="h-full bg-[var(--coral-bright)] rounded-[var(--r-full)]"
              style={{ width: `${progressPercent}%`, transition: "width var(--d-3) var(--ease-truth)" }}
            />
          </div>
        </div>
      )}

      {/* Local providers (llama.cpp / Ollama) compile and download multi-GB
         models — can take 10-15 min on Jetson. Cloud providers finish in
         seconds, so they get the shorter generic copy. */}
      {!completed && phase >= 1 && (
        <p className="text-[length:var(--t-2)] leading-[1.5] text-[var(--text-muted)] text-center aimodels-fade-in">
          {provider === "llamacpp" || provider === "ollama"
            ? t("ai.pleaseDontCloseLocal")
            : t("ai.pleaseDontClose")}
        </p>
      )}
    </div>
  );
}

