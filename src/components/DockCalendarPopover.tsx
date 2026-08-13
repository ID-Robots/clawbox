"use client";

import { useEffect, useMemo, useRef, useState } from 'react';

interface DockCalendarPopoverProps {
  open: boolean;
  onClose: () => void;
}

interface MonthView {
  year: number;
  month: number;
}

interface SelectedDay {
  year: number;
  month: number;
  day: number;
}

interface DayCell {
  key: string;
  day: number;
  outside: boolean;
}

interface WeekdayLabel {
  short: string;
  long: string;
}

/** Six full weeks keeps the panel height stable while navigating months. */
const TOTAL_CELLS = 42;

const CSS_STRING = `
.dkcal {
  --surface-container: #172030;
  --surface-container-high: #1e2939;
  --surface-container-highest: #253347;
  --on-surface: #f9fafb;
  --on-surface-variant: #9ca3af;
  --outline-variant: #2a3445;
  --primary: #f97316;
  --on-primary: #0a0f1a;
  --primary-container: rgba(249, 115, 22, 0.15);
  --secondary: #9ca3af;

  position: fixed;
  bottom: calc(var(--dock-band, 56px) + 12px);
  right: 12px;
  z-index: 10001;
  width: 328px;
  padding: 14px;
  box-sizing: border-box;
  border: 1px solid var(--outline-variant);
  border-radius: 16px;
  background: var(--surface-container);
  color: var(--on-surface);
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  animation: dkcal-enter 200ms cubic-bezier(0.2, 0, 0, 1) both;
}

.dkcal *,
.dkcal *::before,
.dkcal *::after {
  box-sizing: border-box;
}

.dkcal:focus {
  outline: none;
}

.dkcal:focus-visible,
.dkcal :focus-visible {
  outline: 2px solid var(--secondary);
  outline-offset: 2px;
}

.dkcal .dkcal-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.dkcal .dkcal-clock {
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--surface-container-high);
}

.dkcal .dkcal-time {
  margin: 0;
  font-size: 30px;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--on-surface);
}

.dkcal .dkcal-date {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.3;
  color: var(--on-surface-variant);
}

.dkcal .dkcal-divider {
  height: 1px;
  margin: 14px 0 10px;
  border: 0;
  background: var(--outline-variant);
}

.dkcal .dkcal-nav {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.dkcal .dkcal-month {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--on-surface);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dkcal .dkcal-btn {
  position: relative;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--on-surface);
  font: inherit;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
  -webkit-tap-highlight-color: transparent;
}

.dkcal .dkcal-btn::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: currentColor;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms linear;
}

.dkcal .dkcal-btn:hover::after {
  opacity: 0.08;
}

.dkcal .dkcal-btn:active::after {
  opacity: 0.12;
}

.dkcal .dkcal-nav-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: var(--on-surface-variant);
  font-size: 20px;
  line-height: 1;
}

.dkcal .dkcal-today-btn {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--outline-variant);
  border-radius: 14px;
  background: var(--surface-container-highest);
  color: var(--on-surface);
  font-size: 12px;
  font-weight: 600;
}

.dkcal .dkcal-grid {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.dkcal .dkcal-grid th {
  padding: 6px 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--on-surface-variant);
}

.dkcal .dkcal-grid td {
  padding: 1px 0;
  text-align: center;
}

.dkcal .dkcal-abbr {
  text-decoration: none;
  border: 0;
  cursor: default;
}

.dkcal .dkcal-day {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--on-surface);
}

.dkcal .dkcal-day-selected:not(.dkcal-day-today) {
  background: var(--primary-container);
  font-weight: 600;
}

.dkcal .dkcal-day-today {
  background: var(--primary);
  color: var(--on-primary);
  font-weight: 700;
}

.dkcal .dkcal-outside {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--on-surface-variant);
  opacity: 0.45;
}

@keyframes dkcal-enter {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 420px) {
  .dkcal {
    left: 12px;
    right: 12px;
    width: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dkcal {
    animation: none;
  }
  .dkcal .dkcal-btn::after {
    transition: none;
  }
}
`;

const startOfMonth = (year: number, month: number): MonthView => {
  const normalized = new Date(year, month, 1);
  return { year: normalized.getFullYear(), month: normalized.getMonth() };
};

export default function DockCalendarPopover({ open, onClose }: DockCalendarPopoverProps) {
  // `null` until the first client effect runs — never call new Date() during render.
  const [now, setNow] = useState<Date | null>(null);
  const [view, setView] = useState<MonthView | null>(null);
  const [selected, setSelected] = useState<SelectedDay | null>(null);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);

  // Keep the latest onClose without re-subscribing the document listeners.
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Live clock: only runs while open.
  useEffect(() => {
    if (!open) {
      setNow(null);
      setView(null);
      setSelected(null);
      return;
    }

    const initial = new Date();
    setNow(initial);
    setView(startOfMonth(initial.getFullYear(), initial.getMonth()));

    const intervalId = window.setInterval(() => {
      setNow(new Date());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [open]);

  // Remember the trigger and hand focus back to it on close.
  useEffect(() => {
    if (!open) return;

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    return () => {
      if (previous && document.contains(previous)) {
        previous.focus();
      }
    };
  }, [open]);

  // The panel only exists once the date state is populated.
  const ready = now !== null && view !== null;

  useEffect(() => {
    if (!open || !ready) return;
    panelRef.current?.focus();
  }, [open, ready]);

  // Escape + click-outside dismissal.
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
      }
    };

    const handlePointerDown = (event: MouseEvent) => {
      const panel = panelRef.current;
      const target = event.target;
      if (!panel || !(target instanceof Node)) return;
      if (!panel.contains(target)) {
        onCloseRef.current();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    // Defer so the pointer interaction that opened the popover cannot close it.
    const rafId = window.requestAnimationFrame(() => {
      document.addEventListener('mousedown', handlePointerDown);
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [open]);

  const weekdays = useMemo<WeekdayLabel[]>(() => {
    // 2024-01-07 is a Sunday; the grid is Sunday-first.
    return Array.from({ length: 7 }, (_, index) => {
      const reference = new Date(2024, 0, 7 + index);
      const short = reference.toLocaleDateString(undefined, { weekday: 'short' });
      return {
        short: short.length > 2 ? short.slice(0, 2) : short,
        long: reference.toLocaleDateString(undefined, { weekday: 'long' }),
      };
    });
  }, []);

  const weeks = useMemo<DayCell[][]>(() => {
    if (!view) return [];

    const leading = new Date(view.year, view.month, 1).getDay();
    const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
    const daysInPrevMonth = new Date(view.year, view.month, 0).getDate();

    const cells: DayCell[] = [];

    for (let offset = leading - 1; offset >= 0; offset -= 1) {
      cells.push({ key: `prev-${offset}`, day: daysInPrevMonth - offset, outside: true });
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      cells.push({ key: `day-${day}`, day, outside: false });
    }
    let trailing = 1;
    while (cells.length < TOTAL_CELLS) {
      cells.push({ key: `next-${trailing}`, day: trailing, outside: true });
      trailing += 1;
    }

    const rows: DayCell[][] = [];
    for (let index = 0; index < cells.length; index += 7) {
      rows.push(cells.slice(index, index + 7));
    }
    return rows;
  }, [view]);

  if (!open || !now || !view) return null;

  const timeText = now.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });

  const dateText = now.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const monthLabel = new Date(view.year, view.month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  const dayLabel = (day: number): string =>
    new Date(view.year, view.month, day).toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

  const isToday = (day: number): boolean =>
    now.getFullYear() === view.year && now.getMonth() === view.month && now.getDate() === day;

  const isSelected = (day: number): boolean =>
    selected !== null &&
    selected.year === view.year &&
    selected.month === view.month &&
    selected.day === day;

  const shiftMonth = (delta: number): void => {
    setView((current) => (current ? startOfMonth(current.year, current.month + delta) : current));
  };

  const goToToday = (): void => {
    setView(startOfMonth(now.getFullYear(), now.getMonth()));
  };

  const toggleDay = (day: number): void => {
    setSelected((current) =>
      current && current.year === view.year && current.month === view.month && current.day === day
        ? null
        : { year: view.year, month: view.month, day },
    );
  };

  return (
    <>
      <style>{CSS_STRING}</style>
      <div
        ref={panelRef}
        className="dkcal"
        role="dialog"
        aria-modal="false"
        aria-label="Clock and calendar"
        tabIndex={-1}
      >
        <div className="dkcal-clock">
          <p className="dkcal-time">{timeText}</p>
          <p className="dkcal-date">{dateText}</p>
        </div>

        <hr className="dkcal-divider" />

        <div className="dkcal-nav">
          <span className="dkcal-month">{monthLabel}</span>
          <button
            type="button"
            className="dkcal-btn dkcal-today-btn"
            onClick={goToToday}
          >
            Today
          </button>
          <button
            type="button"
            className="dkcal-btn dkcal-nav-btn"
            aria-label="Previous month"
            onClick={() => shiftMonth(-1)}
          >
            <span aria-hidden="true">&lsaquo;</span>
          </button>
          <button
            type="button"
            className="dkcal-btn dkcal-nav-btn"
            aria-label="Next month"
            onClick={() => shiftMonth(1)}
          >
            <span aria-hidden="true">&rsaquo;</span>
          </button>
        </div>

        <table className="dkcal-grid">
          <caption className="dkcal-sr">{monthLabel}</caption>
          <thead>
            <tr>
              {weekdays.map((weekday) => (
                <th key={weekday.long} scope="col">
                  <abbr className="dkcal-abbr" title={weekday.long}>
                    {weekday.short}
                  </abbr>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, weekIndex) => (
              <tr key={`week-${weekIndex}`}>
                {week.map((cell) => (
                  <td key={cell.key}>
                    {cell.outside ? (
                      <span className="dkcal-outside" aria-hidden="true">
                        {cell.day}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={[
                          'dkcal-btn',
                          'dkcal-day',
                          isToday(cell.day) ? 'dkcal-day-today' : '',
                          isSelected(cell.day) ? 'dkcal-day-selected' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        aria-label={dayLabel(cell.day)}
                        aria-pressed={isSelected(cell.day)}
                        {...(isToday(cell.day) ? { 'aria-current': 'date' as const } : {})}
                        onClick={() => toggleDay(cell.day)}
                      >
                        {cell.day}
                      </button>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
