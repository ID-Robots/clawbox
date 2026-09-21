"use client";

import { useId, type ReactNode } from "react";
import AIProviderIcon from "./AIProviderIcon";

/**
 * One provider, as a row in the AI Providers radio group.
 *
 * WHY IT IS SHARED. Both editions drew this row, and they had drifted: the
 * OpenClaw wizard had been moved onto the design tokens while the Hermes panel
 * (and the ClawBox AI row lifted out of OpenClaw before the token pass) still
 * painted `border-gray-800` / `bg-orange-500/5` / `text-gray-200` by hand. Two
 * hand-typed dialects of one row is exactly the drift #547 collapsed for the
 * grounds, so the row itself is now ONE component and there is no second
 * dialect to keep in step.
 *
 * COLOUR IS EDITION-NEUTRAL. Every value here comes from the shared ladder in
 * globals.css. No `hermes*` token, no raw hex, nothing an edition can re-point.
 *
 * THE THREE STATES A ROW CAN BE IN, and why they layer the way they do:
 *
 *   • DEFAULT (`isDefault`) — the provider that is actually answering. Painted
 *     in `--cyan-veil`, the lightest rung of the DONE hue. It OUTRANKS the
 *     selection wash: the two are usually the same row, and when they are not,
 *     "what is running" is the more useful of the two to be able to find again.
 *   • SELECTED — the row the customer is configuring. `--coral-wash` plus a 1px
 *     inset `--coral-bright` border, drawn as a box-shadow rather than a real
 *     border so a selected row is exactly as tall as an unselected one. The
 *     border is the SOLID coral, not one of the coral alphas: --coral-edge
 *     (.30) reads 1.63:1 against the row it sits on and --coral-ring (.60)
 *     only 2.89:1, both under the 3:1 that a border carrying a UI state owes
 *     (WCAG 1.4.11). Solid is 5.73:1.
 *
 *     For the same reason an UNSELECTED radio's ring is --text-muted (3.56:1)
 *     rather than --border-subtle (1.33:1) or the Hermes row's old solid
 *     gray-600 (2.28:1) — neither edition's ring was actually visible against
 *     the list, and unifying the two was the moment to fix it rather than pick
 *     a winner between two failures.
 *   • FOCUSED — a 2px `--coral-bright` ring, from `:focus-visible` on the input
 *     the label wraps. Ring and shadow compose in Tailwind rather than
 *     overwrite, so a focused selected row keeps both and the ring reads on
 *     top.
 *
 * SEMANTICS. A real `<input type="radio">` inside a real `<label>`, one shared
 * `name` per group — which is what gives the group arrow-key navigation, the
 * roving tab stop and the checked state for free, all of which a div with a
 * click handler has to reimplement and usually gets wrong. The input is
 * `sr-only`, i.e. visually hidden but still focusable, so `:focus-visible`
 * fires and the ring above has something to hang on.
 *
 * The one-line description is --text-secondary, not --text-muted: at 11px it
 * needs 4.5:1 and --text-muted gives 3.56:1 on a plain row, 2.67:1 on a hovered
 * one. --text-secondary is 6.79:1 / 5.08:1.
 *
 * The input names the PROVIDER and nothing else (`aria-labelledby` → the name
 * span, `aria-describedby` → the one-line description). Without that split, the
 * accessible name of every row was the whole row read end to end — vendor,
 * badges, sales copy and connection state in one breath.
 */
interface ProviderRadioRowProps {
  /** Radio group name — one per group, shared by every row in it. */
  radioName: string;
  /** The radio's value; also the icon to draw unless `iconId` overrides it. */
  value: string;
  selected: boolean;
  onSelect: () => void;
  /** Icon override, for a row whose id is not the vendor's icon slug. */
  iconId?: string;
  /** Vendor name. Brand names are not translated. */
  name: ReactNode;
  /** The one-line "what is this" under the name. */
  description: ReactNode;
  /** Pills after the name — Recommended, Fully local, Active, … */
  badges?: ReactNode;
  /** Connection state, hard right. Omitted where the surface has none. */
  statusSlot?: ReactNode;
  /** True for the provider the harness config actually names as its default. */
  isDefault?: boolean;
}

export default function ProviderRadioRow({
  radioName,
  value,
  selected,
  onSelect,
  iconId,
  name,
  description,
  badges,
  statusSlot,
  isDefault = false,
}: ProviderRadioRowProps) {
  const uid = useId();
  const nameId = `${uid}-name`;
  const descId = `${uid}-desc`;

  return (
    <label
      className={`flex items-center gap-3 px-4 py-3.5 w-full text-left border-b border-[var(--hair)] last:border-b-0 transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--coral-bright)] has-[:focus-visible]:ring-inset ${
        selected ? "shadow-[inset_0_0_0_1px_var(--coral-bright)]" : ""
      } ${
        isDefault
          ? "bg-[var(--cyan-veil)]"
          : selected
            ? "bg-[var(--coral-wash)]"
            : "hover:bg-[var(--fill-3)]"
      }`}
    >
      <input
        type="radio"
        name={radioName}
        value={value}
        checked={selected}
        onChange={onSelect}
        aria-labelledby={nameId}
        aria-describedby={descId}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={`flex items-center justify-center w-5 h-5 rounded-[var(--r-full)] border-2 shrink-0 transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] ${
          selected ? "border-[var(--coral-bright)]" : "border-[var(--text-muted)]"
        }`}
      >
        {selected && (
          <span className="w-2.5 h-2.5 rounded-[var(--r-full)] bg-[var(--coral-bright)]" />
        )}
      </span>
      <span
        aria-hidden="true"
        className="flex items-center justify-center w-8 h-8 rounded-[var(--r-1)] bg-[var(--fill-2)] shrink-0"
      >
        <AIProviderIcon provider={iconId ?? value} size={22} />
      </span>
      <div className="flex-1 min-w-0">
        <span
          id={nameId}
          className="flex flex-wrap items-center gap-2 text-[length:var(--t-4)] font-semibold text-[var(--text-primary)]"
        >
          {name}
          {badges}
        </span>
        <span
          id={descId}
          className="block text-[length:var(--t-2)] leading-[1.45] text-[var(--text-secondary)]"
        >
          {description}
        </span>
      </div>
      {statusSlot}
    </label>
  );
}
