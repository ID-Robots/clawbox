"use client";

import { useT } from "@/lib/i18n";

/**
 * What Memory Shard does, drawn once: scattered fragments — notes, messages,
 * documents — drift in from the left, gather at a waist, and condense into one
 * faceted shard that pulses as it takes each one in.
 *
 * A deliberate sibling of CodingAgentDelegationArt: same viewBox height, same
 * stroke weights, the same muted palette over the product's coral, and the same
 * restraint — a diagram, not an illustration. Where that one FANS OUT (one run
 * to many sub-agents), this one CONVERGES, which is the whole difference
 * between the two features said in shapes.
 *
 * Every animation lives under `@media (prefers-reduced-motion: no-preference)`
 * in globals.css, so an owner who turned motion off gets the same static
 * diagram. `aria-hidden` because the sentence beneath says this in words —
 * and no `role="img"` beside it, which a hidden element cannot carry anyway.
 */
export default function MemoryShardArt({ className = "" }: { className?: string }) {
  const { t } = useT();

  // The fragments, drifting in on three lanes. `delay` staggers them so the
  // stream reads as a trickle rather than a pulse.
  const fragments = [
    { x: 12, y: 30, delay: 0 },
    { x: 44, y: 66, delay: 0.5 },
    { x: 20, y: 100, delay: 1.0 },
    { x: 74, y: 44, delay: 1.5 },
    { x: 68, y: 92, delay: 2.0 },
  ];

  return (
    <svg
      viewBox="0 0 320 140"
      className={`w-full max-w-[22rem] h-auto ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      {/* The three lanes the fragments travel along. */}
      {[30, 70, 110].map((y, i) => (
        <path
          key={y}
          d={`M16 ${y} C 96 ${y}, 120 70, 186 70`}
          fill="none"
          stroke="var(--text-muted)"
          strokeOpacity="0.30"
          strokeWidth="1.3"
          strokeDasharray="4 7"
          strokeLinecap="round"
          className="ms-art-lane"
          style={{ animationDelay: `${i * 0.4}s` }}
        />
      ))}

      {/* The fragments themselves: small rounded marks, the shape of a note. */}
      {fragments.map((f) => (
        <rect
          key={`${f.x}-${f.y}`}
          x={f.x} y={f.y - 5} width="13" height="10" rx="2.5"
          fill="var(--fill-2)"
          stroke="var(--text-muted)" strokeOpacity="0.5" strokeWidth="1.2"
          className="ms-art-fragment"
          style={{ animationDelay: `${f.delay}s` }}
        />
      ))}

      {/* The shard: a faceted crystal, drawn as one outline plus two inner
          facets so it reads as solid without shading. */}
      <g className="ms-art-shard">
        <path
          d="M232 70 L250 34 L286 44 L292 84 L258 108 Z"
          fill="var(--coral-bright)" fillOpacity="0.12"
          stroke="var(--coral-bright)" strokeOpacity="0.65" strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="M250 34 L262 72 L292 84 M262 72 L258 108 M262 72 L232 70"
          fill="none"
          stroke="var(--coral-bright)" strokeOpacity="0.38" strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </g>

      <text
        x="160" y="132"
        textAnchor="middle"
        className="fill-[var(--text-muted)]"
        style={{ fontSize: 11, fontWeight: 500 }}
      >
        {t("clawkeep.memory.setup.artCaption")}
      </text>
    </svg>
  );
}
