"use client";

import { useT } from "@/lib/i18n";

/**
 * What ClawKeep does, drawn once: this box on the left, the shield in the
 * middle where every archive is sealed before it leaves, and the cloud on the
 * right where the sealed snapshots stack up. A packet travels the whole way,
 * left to right, and the shield pulses as it takes each one in.
 *
 * A deliberate sibling of CodingAgentDelegationArt and MemoryShardArt: same
 * viewBox, stroke weights and muted palette over the product's coral, a
 * diagram rather than an illustration. Where the coding agent FANS OUT and
 * the memory shard CONVERGES, this one PASSES THROUGH — nothing reaches the
 * cloud that has not gone through the lock.
 *
 * Every animation lives under `@media (prefers-reduced-motion:
 * no-preference)` in globals.css (the `ck-art-*` block), so an owner who
 * turned motion off gets the same static diagram. `aria-hidden` because the
 * sentence beneath says this in words.
 */
export default function ClawKeepArt({ className = "" }: { className?: string }) {
  const { t } = useT();

  return (
    <svg
      viewBox="0 0 320 140"
      className={`w-full max-w-[22rem] h-auto ${className}`}
      aria-hidden="true"
      focusable="false"
      data-testid="clawkeep-art"
    >
      {/* The two lanes: box → shield, shield → cloud. */}
      {[
        "M76 70 C 100 70, 110 70, 132 70",
        "M188 70 C 212 70, 222 70, 244 70",
      ].map((d, i) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke="var(--text-muted)"
          strokeOpacity="0.35"
          strokeWidth="1.4"
          strokeDasharray="5 6"
          strokeLinecap="round"
          className="ck-art-flow"
          style={{ animationDelay: `${i * 0.45}s` }}
        />
      ))}

      {/* This box: a small device with its screen and one live dot. */}
      <g>
        <rect
          x="10" y="50" width="62" height="40" rx="9"
          fill="var(--fill-2)"
          stroke="var(--border-subtle)" strokeWidth="1.4"
        />
        <rect x="20" y="58" width="42" height="18" rx="3" fill="var(--bg-deep)" stroke="var(--text-muted)" strokeOpacity="0.4" strokeWidth="1" />
        <circle cx="41" cy="83" r="2.2" fill="var(--coral-bright)" fillOpacity="0.9" />
      </g>

      {/* The packet: one archive on its way, sealed at the shield. */}
      <rect
        x="80" y="64" width="14" height="11" rx="2.5"
        fill="var(--coral-bright)" fillOpacity="0.22"
        stroke="var(--coral-bright)" strokeOpacity="0.7" strokeWidth="1.2"
        className="ck-art-packet"
      />

      {/* The shield with its keyhole: encryption, on this device. */}
      <g className="ck-art-shield">
        <path
          d="M160 40 L186 50 L186 72 C186 88, 174 98, 160 104 C146 98, 134 88, 134 72 L134 50 Z"
          fill="var(--coral-bright)" fillOpacity="0.12"
          stroke="var(--coral-bright)" strokeOpacity="0.7" strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <circle cx="160" cy="68" r="5" fill="none" stroke="var(--coral-bright)" strokeOpacity="0.85" strokeWidth="1.6" />
        <path d="M160 72 L160 82" stroke="var(--coral-bright)" strokeOpacity="0.85" strokeWidth="1.8" strokeLinecap="round" />
      </g>

      {/* The cloud, with the snapshots stacked inside it. */}
      <g>
        <path
          d="M258 92 C 246 92, 240 84, 244 76 C 238 66, 250 56, 262 60 C 268 46, 292 46, 296 60 C 308 58, 316 68, 312 78 C 318 86, 310 92, 302 92 Z"
          fill="var(--fill-2)"
          stroke="var(--border-subtle)" strokeWidth="1.4"
          strokeLinejoin="round"
        />
        {[72, 79, 86].map((y, i) => (
          <rect
            key={y}
            x="262" y={y - 2} width="30" height="4" rx="2"
            fill="var(--coral-bright)"
            fillOpacity={0.35 + i * 0.2}
          />
        ))}
      </g>

      <text
        x="160" y="128"
        textAnchor="middle"
        className="fill-[var(--text-muted)]"
        style={{ fontSize: 11, fontWeight: 500 }}
      >
        {t("clawkeep.setup.artCaption")}
      </text>
    </svg>
  );
}
