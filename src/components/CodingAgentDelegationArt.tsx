"use client";

import { useT } from "@/lib/i18n";

/**
 * What the coding agent actually does, drawn once: one run fans a task out to
 * sub-agents — a coder, a reviewer, a browser — and their answers come back.
 *
 * Line art on purpose, in the product's coral over the muted text token, so it
 * reads as a diagram rather than as an illustration pasted onto the page. The
 * motion is a dash flowing OUTWARD along each connector (the task going out)
 * and a soft pulse arriving at each node, staggered so the three do not beat in
 * unison.
 *
 * Every animation is defined under `@media (prefers-reduced-motion:
 * no-preference)` in globals.css, so an owner who turned motion off gets the
 * same diagram, still. `aria-hidden` because the sentence beneath it already
 * says this in words — a screen reader should not have to hear the picture too.
 */
export default function CodingAgentDelegationArt({ className = "" }: { className?: string }) {
  const { t } = useT();

  // The three fan-out targets. Y positions are the curve endpoints below.
  const agents = [
    { key: "coder", y: 26, label: t("codingAgent.artCoder") },
    { key: "reviewer", y: 70, label: t("codingAgent.artReviewer") },
    { key: "browser", y: 114, label: t("codingAgent.artBrowser") },
  ];

  return (
    <svg
      viewBox="0 0 320 140"
      className={`w-full max-w-[22rem] h-auto ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      {/* The hub: the run itself. */}
      <g className="ca-art-hub">
        <rect
          x="8" y="52" width="72" height="36" rx="10"
          fill="var(--coral-bright)" fillOpacity="0.10"
          stroke="var(--coral-bright)" strokeOpacity="0.55" strokeWidth="1.5"
        />
        <circle cx="30" cy="70" r="3.5" fill="var(--coral-bright)" />
        <path d="M42 64 L52 70 L42 76" fill="none" stroke="var(--coral-bright)" strokeOpacity="0.8"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M58 76 L64 64" fill="none" stroke="var(--coral-bright)" strokeOpacity="0.8"
          strokeWidth="1.8" strokeLinecap="round" />
      </g>

      {agents.map((agent, i) => (
        <g key={agent.key}>
          {/* Task out — a dash that flows from the hub toward the sub-agent. */}
          <path
            d={`M84 70 C 140 70, 150 ${agent.y}, 214 ${agent.y}`}
            fill="none"
            stroke="var(--text-muted)"
            strokeOpacity="0.45"
            strokeWidth="1.4"
            strokeDasharray="5 6"
            strokeLinecap="round"
            className="ca-art-flow"
            style={{ animationDelay: `${i * 0.45}s` }}
          />
          {/* The sub-agent. */}
          <g className="ca-art-node" style={{ animationDelay: `${i * 0.45 + 0.55}s` }}>
            <rect
              x="216" y={agent.y - 13} width="26" height="26" rx="8"
              fill="var(--fill-2)"
              stroke="var(--border-subtle)" strokeWidth="1.4"
            />
            <circle cx="229" cy={agent.y} r="3" fill="var(--coral-bright)" fillOpacity="0.9" />
          </g>
          <text
            x="252" y={agent.y + 4}
            className="fill-[var(--text-muted)]"
            style={{ fontSize: 11, fontWeight: 500 }}
          >
            {agent.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
