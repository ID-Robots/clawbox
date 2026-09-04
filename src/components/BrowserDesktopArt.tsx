"use client";

import { useT } from "@/lib/i18n";

/**
 * What the built-in browser is, drawn once: a real Chromium window on the
 * device's own screen, with the agent beside it on the same window — the
 * dashes run BOTH ways, because this is the one browser where what the
 * assistant opens is what the owner is looking at.
 *
 * A deliberate sibling of CodingAgentDelegationArt, MemoryShardArt and
 * ClawKeepArt: same viewBox, stroke weights and muted palette over the
 * product's coral, a diagram rather than an illustration. Where the coding
 * agent FANS OUT, the memory shard CONVERGES and ClawKeep PASSES THROUGH,
 * this one goes BACK AND FORTH, and the pointer moving across the page is
 * the part that says "somebody is driving this".
 *
 * Every animation lives under `@media (prefers-reduced-motion: no-preference)`
 * in globals.css (the `br-art-*` block), so an owner who turned motion off
 * gets the same static diagram. `aria-hidden` because the sentence beneath it
 * already says this in words.
 */
export default function BrowserDesktopArt({ className = "" }: { className?: string }) {
  const { t } = useT();

  return (
    <svg
      viewBox="0 0 320 140"
      className={`w-full max-w-[22rem] h-auto ${className}`}
      aria-hidden="true"
      focusable="false"
      data-testid="browser-art"
    >
      {/* The window itself: chrome, address bar, page. */}
      <g className="br-art-window">
        <rect
          x="10" y="22" width="176" height="90" rx="9"
          fill="var(--fill-2)"
          stroke="var(--border-subtle)" strokeWidth="1.4"
        />
        {[24, 34, 44].map((cx) => (
          <circle key={cx} cx={cx} cy="36" r="2.4" fill="var(--text-muted)" fillOpacity="0.55" />
        ))}
        <rect x="58" y="31" width="118" height="10" rx="5" fill="var(--bg-deep)" />
        <rect
          x="20" y="50" width="156" height="52" rx="4"
          fill="var(--bg-deep)"
          stroke="var(--text-muted)" strokeOpacity="0.25" strokeWidth="1"
        />
        {/* A page with something on it: one coral heading, two lines of text. */}
        <rect x="28" y="58" width="54" height="5" rx="2.5" fill="var(--coral-bright)" fillOpacity="0.55" />
        <rect x="28" y="72" width="120" height="4" rx="2" fill="var(--text-muted)" fillOpacity="0.35" />
        <rect x="28" y="82" width="96" height="4" rx="2" fill="var(--text-muted)" fillOpacity="0.35" />
      </g>

      {/* The pointer crossing the page — the agent's hand on the window. The
          group does the placing and the class does the travelling: a CSS
          transform REPLACES a `transform` attribute rather than composing with
          it, so a cursor carrying both would start its journey at the diagram's
          top-left corner. */}
      <g transform="translate(36 60)">
        <path
          d="M0 0 L0 11 L3 8.4 L5 12.4 L7 11.4 L5 7.6 L8.6 7.2 Z"
          fill="var(--coral-bright)"
          stroke="var(--coral-bright)" strokeOpacity="0.9" strokeWidth="1"
          strokeLinejoin="round"
          className="br-art-cursor"
        />
      </g>

      {/* Both directions on purpose: the agent drives the page, and what it
          sees comes back to the same screen the owner is watching. */}
      {[
        { d: "M190 60 C 208 60, 214 60, 236 60", delay: 0 },
        { d: "M236 78 C 214 78, 208 78, 190 78", delay: 0.55 },
      ].map((lane) => (
        <path
          key={lane.d}
          d={lane.d}
          fill="none"
          stroke="var(--text-muted)"
          strokeOpacity="0.4"
          strokeWidth="1.4"
          strokeDasharray="5 6"
          strokeLinecap="round"
          className="br-art-flow"
          style={{ animationDelay: `${lane.delay}s` }}
        />
      ))}

      {/* The agent, holding the other end of the same window. */}
      <g className="br-art-node">
        <rect
          x="240" y="51" width="36" height="36" rx="11"
          fill="var(--fill-2)"
          stroke="var(--border-subtle)" strokeWidth="1.4"
        />
        <circle cx="258" cy="69" r="4" fill="var(--coral-bright)" fillOpacity="0.9" />
      </g>

      <text
        x="160" y="130"
        textAnchor="middle"
        className="fill-[var(--text-muted)]"
        style={{ fontSize: 11, fontWeight: 500 }}
      >
        {t("browser.setup.artCaption")}
      </text>
    </svg>
  );
}
