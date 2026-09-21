"use client";

/**
 * Where you are in the Coding Agent app, and the way back.
 *
 * One row above every page that is not home: an arrow that goes up one
 * level, then the trail — Projects › the project › the run — with every
 * earlier crumb a button. It replaces three different "Back" pills (the
 * settings page's in the header, the project page's and the run page's
 * floating above their cards, each styled on its own) with one shape, and
 * says where Back LEADS instead of only that it exists: a run's arrow goes to
 * its project, a project's to the projects, and the trail shows both.
 *
 * The arrow keeps the test id the page's old Back button carried, because
 * that is the affordance the tests (and a keyboard) reach for; the crumbs are
 * plain buttons a screen reader announces by name, the current one marked
 * `aria-current="page"` and not a button at all.
 */

export interface Crumb {
  label: string;
  /** Absent on the current page. */
  onClick?: () => void;
  testId?: string;
}

interface Props {
  crumbs: Crumb[];
  /** What the arrow does — normally the second-to-last crumb's onClick. */
  onBack: () => void;
  backLabel: string;
  /** Names the navigation landmark — "Breadcrumb", never the back action. */
  navLabel: string;
  backTestId: string;
  /** Anything that sits at the right end of the row — a Live view toggle. */
  trailing?: React.ReactNode;
}

const CRUMB = "max-w-[14rem] truncate rounded-md px-1.5 py-0.5 text-[12px]";

export default function CodingAgentBreadcrumb({ crumbs, onBack, backLabel, navLabel, backTestId, trailing }: Props) {
  return (
    <nav
      aria-label={navLabel}
      data-testid="coding-agent-breadcrumb"
      className="mt-3 flex items-center gap-1 min-w-0"
    >
      <button
        type="button"
        onClick={onBack}
        aria-label={backLabel}
        title={backLabel}
        data-testid={backTestId}
        className="shrink-0 flex items-center justify-center w-7 h-7 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/[0.06] hover:text-white"
      >
        <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">arrow_back</span>
      </button>
      <ol className="flex items-center gap-0.5 min-w-0 overflow-hidden">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${i}-${crumb.label}`} className="flex items-center gap-0.5 min-w-0">
              {i > 0 && (
                <span className="material-symbols-rounded text-[var(--text-muted)] opacity-60 shrink-0" style={{ fontSize: 14 }} aria-hidden="true">
                  chevron_right
                </span>
              )}
              {last || !crumb.onClick ? (
                <span
                  aria-current={last ? "page" : undefined}
                  data-testid={crumb.testId}
                  className={`${CRUMB} ${last ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-muted)]"}`}
                >
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={crumb.onClick}
                  data-testid={crumb.testId}
                  className={`${CRUMB} text-[var(--text-muted)] hover:bg-white/[0.06] hover:text-white`}
                >
                  {crumb.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {trailing && <div className="ml-auto shrink-0 flex items-center gap-1.5">{trailing}</div>}
    </nav>
  );
}
