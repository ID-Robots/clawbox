"use client";

import { CLAWBOX_CRAB_DATA_URI } from "@/lib/clawbox-crab-inline";

export interface CrabWaitMarkProps {
  /** Diameter of the whole mark in px — rings included. */
  size?: number;
  /** Swap the crab for the drawn success check. */
  completed?: boolean;
  /**
   * Hermes edition: the ambient accent takes the agent's sanctioned green
   * (`--agent-live`) instead of coral. Coral means ACTION on every edition, so
   * only the ambient identity of a wait changes here — never a button.
   */
  hermes?: boolean;
  /** The done hue, matching ReconnectStage's own `doneTone`. */
  doneTone?: "emerald" | "cyan";
}

/**
 * The bobbing crab in its pulsing rings — the device's "something is happening"
 * mark, on its own.
 *
 * Lifted out of ReconnectStage so it can be used at any SIZE and inside any
 * container. That shell is a full-screen `createPortal` onto document.body with
 * a step checklist, which is right for a whole-device wait (an update, an
 * AP-to-LAN handoff) and wrong for anything smaller: an app window that borrowed
 * it to say "loading" would black out the entire desktop. Every full-screen wait
 * on the box already shares the shell; this is what the in-window ones can share.
 *
 * The crab is an inline data URI, NOT `next/image` or `/clawbox-crab.png`, and
 * that is load-bearing rather than fussy: this mark is on screen exactly while
 * the box's own server is restarting, so any src pointing back at the server —
 * above all the `/_next/image?url=…` request `next/image` rewrites it to —
 * fetches from a dead socket and leaves a broken-image placeholder in the ring.
 * See src/lib/clawbox-crab-inline.ts.
 *
 * Pure presentation: no polling, no timers, no state. The screens that show it
 * own the waiting.
 */
export default function CrabWaitMark({
  size = 112,
  completed = false,
  hermes = false,
  doneTone = "emerald",
}: CrabWaitMarkProps) {
  const checkStroke = doneTone === "cyan" ? "var(--cyan-bright)" : "#22c55e";

  // Full literal class strings on both branches so Tailwind's scanner sees
  // them; the #4ade80 fallback mirrors --agent-live for safety only.
  const ringOuter = hermes
    ? "border-[var(--agent-live,#4ade80)]/20"
    : "border-[var(--coral-bright)]/20";
  const ringInner = hermes
    ? "border-[var(--agent-live,#4ade80)]/10"
    : "border-[var(--coral-bright)]/10";
  const orbitDot = hermes
    ? "bg-[var(--agent-live,#4ade80)]"
    : "bg-[var(--coral-bright)]";

  // Everything inside scales with the mark, so one component serves a 112px
  // full-screen wait and a 72px in-window one without a second set of numbers.
  const inner = Math.round(size * 0.57);
  const crab = Math.round(size * 0.46);
  const orbitRadius = Math.round(size * 0.34);
  const dot = Math.max(5, Math.round(size * 0.07));

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: size, height: size }}
      data-testid="crab-wait-mark"
    >
      <style>{`
        @keyframes crab-wait-draw { to { stroke-dashoffset: 0 } }
        @keyframes crab-wait-fade-in { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes crab-wait-pulse-ring { 0% { transform: scale(0.85); opacity: 0.55 } 50% { transform: scale(1.15); opacity: 0 } 100% { transform: scale(0.85); opacity: 0.55 } }
        @keyframes crab-wait-orbit { from { transform: rotate(0deg) translateX(var(--crab-orbit)) rotate(0deg) } to { transform: rotate(360deg) translateX(var(--crab-orbit)) rotate(-360deg) } }
        @keyframes crab-wait-bob { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(-5px) } }
        .crab-wait-fade-in { animation: crab-wait-fade-in 0.4s ease-out both }
        @media (prefers-reduced-motion: reduce) {
          .crab-wait-mark-animated * { animation: none !important }
        }
      `}</style>

      <div
        className="crab-wait-mark-animated absolute inset-0"
        style={{ ["--crab-orbit" as string]: `${orbitRadius}px` }}
      >
        <div className={`absolute inset-0 rounded-full border-2 ${ringOuter}`} style={{ animation: "crab-wait-pulse-ring 2s ease-in-out infinite" }} />
        <div className={`absolute inset-2 rounded-full border ${ringInner}`} style={{ animation: "crab-wait-pulse-ring 2s ease-in-out infinite 0.45s" }} />

        {!completed && [0, 1, 2].map((i) => (
          <div
            key={i}
            className="absolute inset-0 flex items-center justify-center"
            style={{ animation: `crab-wait-orbit ${3 + i * 0.45}s linear infinite`, animationDelay: `${i * 0.35}s` }}
          >
            <div className={`rounded-full ${orbitDot}`} style={{ width: dot, height: dot, opacity: 0.35 + i * 0.2 }} />
          </div>
        ))}
      </div>

      {completed ? (
        <svg width={crab} height={crab} viewBox="0 0 56 56" fill="none" className="crab-wait-fade-in relative z-10">
          <circle cx="28" cy="28" r="25" stroke={checkStroke} strokeWidth="3" strokeDasharray="157" strokeDashoffset="157" style={{ animation: "crab-wait-draw 0.6s ease-out 0.1s forwards" }} />
          <path d="M17 28l7 7 15-15" stroke={checkStroke} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="35" strokeDashoffset="35" style={{ animation: "crab-wait-draw 0.4s ease-out 0.5s forwards" }} />
        </svg>
      ) : (
        <div
          className="relative z-10 flex items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] crab-wait-fade-in"
          style={{ width: inner, height: inner, animation: "crab-wait-bob 2.4s ease-in-out infinite" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={CLAWBOX_CRAB_DATA_URI}
            alt="ClawBox"
            width={crab}
            height={crab}
            className="object-contain"
            style={{ width: crab, height: crab }}
            data-testid="reconnect-logo"
          />
        </div>
      )}
    </div>
  );
}
