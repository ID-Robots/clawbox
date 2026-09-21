'use client';

import { type ReactNode, useId, useState } from 'react';
import { useModalDialog } from '@/hooks/useModalDialog';
import { MAX_FACET_SELECTION } from '@/lib/hermes-skills';
import { useCopy } from './copy';
import { FOCUS_RING, GhostButton } from './primitives';

// The store's filter rail: grouped, multi-select facets with a live count beside
// every option, the ticked ones repeated as removable chips above the grid.
//
// WHY it replaces the two <select>s it grew out of: Browse had NO category
// filter at all and Installed had ONLY one, and neither tab could filter on the
// two attributes that decide whether a customer should install something —
// who published it and what the installer's scanner said about it. A rail also
// lets the counts be seen before a filter is applied, which a <select> cannot
// do without spelling the number into every option label.
//
// Accessibility: each group is a real <fieldset>/<legend> with real checkboxes,
// so grouping, state and keyboard operation are the platform's rather than
// ours. The caller announces the result count politely on change — that lives
// with the results, not with the control that changed them.

export interface FacetOption {
  id: string;
  label: string;
  count: number;
}

export interface FacetGroupSpec {
  /** Stable id, used for the chip that removes a value from this group. */
  id: string;
  legend: string;
  options: FacetOption[];
  selected: string[];
  onToggle: (id: string) => void;
  /** A caveat about this group's counts or coverage, shown under the list. */
  note?: string;
}

/** How many options a group shows before it needs "Show all". */
const VISIBLE_OPTIONS = 8;

export function FacetRail({
  groups,
  activeCount,
  onClearAll,
  footnotes,
  showHeading = true,
}: {
  groups: FacetGroupSpec[];
  activeCount: number;
  onClearAll: () => void;
  /** Caveats about the rail as a whole — scope of the counts, missing groups. */
  footnotes?: string[];
  /**
   * False inside the drawer, which titles itself. Two "Filters" headings one
   * above the other is what it looked like otherwise — and the second one is
   * noise to a screen reader as much as to the eye.
   */
  showHeading?: boolean;
}) {
  const COPY = useCopy();
  const usable = groups.filter((g) => g.options.length > 0);
  return (
    <div className="flex flex-col gap-4 text-[var(--text-primary)]">
      {(showHeading || activeCount > 0) && (
        <div className="flex items-center justify-between gap-2">
          {showHeading && (
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
              {COPY.filtersHeading}
            </h2>
          )}
          {activeCount > 0 && (
            <GhostButton onClick={onClearAll}>{COPY.filtersClearAll}</GhostButton>
          )}
        </div>
      )}
      {usable.length === 0 ? (
        <p className="text-xs text-[var(--text-secondary)]">{COPY.filtersNone}</p>
      ) : (
        usable.map((group) => <FacetGroup key={group.id} group={group} />)
      )}
      {footnotes?.map((line) => (
        <p key={line} className="text-[10px] leading-snug text-[var(--text-secondary)]">
          {line}
        </p>
      ))}
    </div>
  );
}

function FacetGroup({ group }: { group: FacetGroupSpec }) {
  const COPY = useCopy();
  const [expanded, setExpanded] = useState(false);
  const legendId = useId();
  // A ticked value is ALWAYS visible: the option lists are the top N for the
  // current query, so a selection can fall out of the visible slice — and a
  // checkbox the user cannot see is a filter the user cannot untick.
  const visible = expanded
    ? group.options
    : group.options.filter((o, i) => i < VISIBLE_OPTIONS || group.selected.includes(o.id));
  const hidden = group.options.length - visible.length;

  return (
    <fieldset className="min-w-0 border-0 p-0 m-0" aria-labelledby={legendId}>
      <legend
        id={legendId}
        className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-1"
      >
        {group.legend}
      </legend>
      <ul role="list" className="list-none p-0 m-0 space-y-0.5">
        {visible.map((option) => {
          const checked = group.selected.includes(option.id);
          // At the cap, an unticked box cannot be ticked. Said with `disabled`
          // rather than by letting the click through: `toggleFacet` returns the
          // same state, so a controlled checkbox flips in the DOM and React
          // snaps it back — a control that visibly accepts a click and undoes
          // it, with no reason given. The group's note below says why.
          const atLimit = !checked && group.selected.length >= MAX_FACET_SELECTION;
          return (
            <li key={option.id}>
              <label
                className={`flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors ${
                  atLimit ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
                } ${checked ? 'bg-[var(--coral-bright)]/10' : atLimit ? '' : 'hover:bg-[var(--surface-card)]'}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={atLimit}
                  data-testid={`hs-facet-${group.id}-${option.id}`}
                  onChange={() => group.onToggle(option.id)}
                  className={`h-3.5 w-3.5 shrink-0 accent-[var(--coral-bright)] rounded ${FOCUS_RING}`}
                />
                <span className={`flex-1 min-w-0 truncate text-xs ${checked ? 'font-semibold' : ''}`}>
                  {option.label}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-secondary)]">
                  {option.count.toLocaleString()}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {(hidden > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className={`mt-1 px-1.5 text-[11px] text-[var(--coral-bright)] hover:underline rounded ${FOCUS_RING}`}
        >
          {expanded ? COPY.filtersShowFewer : COPY.filtersShowAll(hidden)}
        </button>
      )}
      {group.selected.length >= MAX_FACET_SELECTION && (
        <p className="mt-1 px-1.5 text-[10px] leading-snug text-[var(--text-secondary)]" role="status">
          {COPY.facetLimit(MAX_FACET_SELECTION)}
        </p>
      )}
      {group.note && (
        <p className="mt-1 px-1.5 text-[10px] leading-snug text-[var(--text-secondary)]">{group.note}</p>
      )}
    </fieldset>
  );
}

export interface ActiveChip {
  groupId: string;
  groupLabel: string;
  id: string;
  label: string;
}

/**
 * The ticked values of every group, in rail order. Reads its labels back out of
 * the option lists, which is why a selected value is always appended to them —
 * otherwise a chip for a value that fell out of the top N would show a raw
 * registry id where the rail shows a name.
 */
export function chipsFromGroups(groups: FacetGroupSpec[]): ActiveChip[] {
  const chips: ActiveChip[] = [];
  for (const group of groups) {
    for (const id of group.selected) {
      const option = group.options.find((o) => o.id === id);
      chips.push({ groupId: group.id, groupLabel: group.legend, id, label: option?.label ?? id });
    }
  }
  return chips;
}

/** The ticked values, repeated above the grid so they are visible AND removable. */
export function ActiveFilterChips({
  chips,
  onRemove,
  onClearAll,
}: {
  chips: ActiveChip[];
  onRemove: (groupId: string, id: string) => void;
  onClearAll: () => void;
}) {
  const COPY = useCopy();
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="hs-active-filters">
      {chips.map((chip) => (
        <button
          key={`${chip.groupId}:${chip.id}`}
          type="button"
          data-testid={`hs-chip-${chip.groupId}-${chip.id}`}
          onClick={() => onRemove(chip.groupId, chip.id)}
          aria-label={COPY.filterChipRemove(chip.groupLabel, chip.label)}
          className={`inline-flex items-center gap-1 max-w-full rounded-full bg-[var(--coral-bright)]/15 text-[var(--coral-bright)] pl-2 pr-1.5 py-0.5 text-[11px] font-medium hover:bg-[var(--coral-bright)]/25 transition-colors ${FOCUS_RING}`}
        >
          <span className="truncate">
            {chip.groupLabel}: {chip.label}
          </span>
          <span className="material-symbols-rounded shrink-0" style={{ fontSize: 13 }} aria-hidden="true">
            close
          </span>
        </button>
      ))}
      <button
        type="button"
        data-testid="hs-clear-all"
        onClick={onClearAll}
        className={`rounded-full px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-card)] transition-colors ${FOCUS_RING}`}
      >
        {COPY.filtersClearAll}
      </button>
    </div>
  );
}

/**
 * The narrow-viewport form of the rail.
 *
 * A 384 px-wide store already could not fit a search box beside two <select>s
 * (the input ended up under 100 px with its placeholder, icon and clear button
 * overlapping), so a 224 px column beside a card grid is out of the question
 * there. Below the breakpoint the rail becomes one button and opens as a modal
 * drawer over the grid instead of squeezing it.
 */
export function FacetDrawerButton({
  activeCount,
  children,
}: {
  activeCount: number;
  children: ReactNode;
}) {
  const COPY = useCopy();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="hs-filters-button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 shrink-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-deep)] px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-card)] transition-colors ${FOCUS_RING}`}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">
          tune
        </span>
        {activeCount > 0 ? COPY.filtersButtonWithCount(activeCount) : COPY.filtersButton}
      </button>
      {open && <FacetDrawer onClose={() => setOpen(false)}>{children}</FacetDrawer>}
    </>
  );
}

function FacetDrawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const COPY = useCopy();
  const titleId = useId();
  const panelRef = useModalDialog<HTMLDivElement>({ onClose });
  return (
    <div className="fixed inset-0 z-[9999] flex bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="hs-filters-drawer"
        className="w-[19rem] max-w-[85vw] h-full overflow-y-auto bg-[var(--bg-deep)] border-r border-[var(--border-subtle)] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 mb-3">
          <h2 id={titleId} className="text-sm font-semibold text-[var(--text-primary)]">
            {COPY.filtersHeading}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={COPY.filtersClose}
            className={`w-7 h-7 flex items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-card)] transition-colors ${FOCUS_RING}`}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">
              close
            </span>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
