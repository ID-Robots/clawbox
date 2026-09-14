"use client";

/**
 * One agent on a run's page, in the one shape every agent wears.
 *
 * The run page used to hold two unrelated widgets: a list of the run's own
 * Claude Code helpers, and — bolted underneath it — a second list of the
 * team's planner, workers and reviewers, written separately and reading
 * differently. They are all agents working on the same run, so they are all
 * this row: a glyph for how it is doing, its name, what it was asked to do,
 * and the one figure that matters on the right.
 *
 * What the box actually KNOWS about an agent is behind the row rather than
 * spread across it — hover for it, or tap, because the box is used on a
 * touchscreen and a title attribute is not an affordance there. Only fields
 * with an answer are passed: an empty row, or a zero that means "we never
 * recorded this", is worse than silence.
 */

import { useState, type ReactNode } from "react";

/** One line of what is known about an agent. */
export interface RosterField {
  label: string;
  value: string;
  /** An identifier — a model name, a count — rather than a sentence. */
  mono?: boolean;
}

/** The caller writes its fields inline; the falsy ones never reach the panel. */
export type RosterFields = (RosterField | null | false | undefined)[];

export default function CodingAgentRosterRow({
  icon,
  iconClassName,
  name,
  nameClassName = "text-[var(--text-primary)]",
  what,
  meta,
  metaClassName = "text-[var(--text-muted)]",
  fields,
  aside,
  testId,
}: {
  icon: string;
  iconClassName: string;
  name: string;
  nameClassName?: string;
  /** What it was asked to do, on the row itself. */
  what?: string;
  /** The right-hand reading: how long it has been out, or what became of it. */
  meta?: string;
  metaClassName?: string;
  fields: RosterFields;
  /**
   * A control beside the name — a teammate's run id to open.
   *
   * Kept OUT of the disclosure button when there is one: a button inside a
   * button is invalid markup, and the browser's own answer to it is to eat one
   * of the two clicks.
   */
  aside?: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const known = fields.filter((f): f is RosterField => Boolean(f) && Boolean((f as RosterField).value));
  // Hover says it in one breath; the panel below says it in a list. Both come
  // from the same fields, so the two can never drift apart.
  const title = known.map((f) => `${f.label}: ${f.value}`).join("\n");
  const row = "flex items-center gap-2 w-full min-w-0 text-left text-[11px] px-1 -mx-1 py-0.5 rounded-md";
  const body = (withAside: boolean) => (
    <>
      <span className={`material-symbols-rounded shrink-0 ${iconClassName}`} style={{ fontSize: 13 }} aria-hidden="true">{icon}</span>
      <span className={`font-medium shrink-0 ${nameClassName}`}>{name}</span>
      {withAside && aside}
      {what && <span className="text-[var(--text-muted)] truncate min-w-0">{what}</span>}
      {meta && <span className={`ml-auto shrink-0 ${metaClassName}`}>{meta}</span>}
    </>
  );
  // Nothing behind the row, nothing to open: a teammate's role, its run and
  // whether it is at work are ALL of what the board records about it, and a
  // chevron promising more would open on an empty panel.
  if (known.length === 0) return <div className={row} data-testid={testId}>{body(true)}</div>;
  return (
    <>
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${name}${title ? ` — ${title.replaceAll("\n", " · ")}` : ""}`}
          title={title}
          className={`${row} hover:bg-white/[0.04]`}
          data-testid={testId}
        >
          {body(false)}
          <span
            className={`material-symbols-rounded shrink-0 text-[var(--text-muted)] transition-transform ${open ? "rotate-180" : ""} ${meta ? "" : "ml-auto"}`}
            style={{ fontSize: 14 }}
            aria-hidden="true"
          >
            expand_more
          </span>
        </button>
        {aside}
      </div>
      {open && (
        // The timeline's own detail panel, to the pixel: a run page should
        // open one kind of thing, not two.
        <dl className="mt-1 mb-1 ml-6 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-secondary)]" data-testid={testId ? `${testId}-detail` : undefined}>
          {known.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-[var(--text-muted)]">{f.label}</dt>
              <dd className={f.mono ? "font-mono break-words" : "break-words"}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}
