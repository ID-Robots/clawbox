"use client";

/**
 * TerminalTabs — several shells in one Terminal window.
 *
 * Every tab is its own TerminalApp on its own PTY, and every tab stays
 * MOUNTED while another is in front: a shell that is running something must
 * not be torn down because the owner looked at a second one. The inactive
 * panels are `hidden`; the one coming back gets its size refitted and the
 * keyboard (TerminalApp's `active`).
 *
 * The first tab carries the window's `initialCommand` — the Coding Agent's
 * `claude-ds --resume …`, a run's live tail — and is named after it; the
 * tabs the owner adds are plain shells named by number. Numbers come from
 * the tab's own id, so closing a tab never renames the others.
 *
 * Clicking anything in the strip keeps the keyboard in the terminal
 * (mousedown's default would move focus to the tab or the button, and
 * clicking the tab that is already in front refocuses nothing).
 */

import { useCallback, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { useTr } from "@/lib/i18n-floor";
import TerminalApp, { type TerminalTabAction } from "./TerminalApp";

export interface TerminalTabsProps {
  /** Typed into the FIRST tab's shell once it is alive — see TerminalApp. */
  initialCommand?: string;
}

interface Tab {
  id: number;
  command?: string;
}

/** The tab's name: what it runs, or its number. */
export function terminalTabTitle(tab: { id: number; command?: string }, t: (key: string, params?: Record<string, string | number>) => string): string {
  const first = tab.command?.trim().split(/\s+/)[0];
  if (first) {
    // `cd '/x' && claude-ds --resume abc` names the thing after the cd.
    const named = tab.command!.match(/&&\s*(\S+)/)?.[1] ?? first;
    const base = named.split("/").pop() ?? named;
    if (base && base !== "cd") return base;
  }
  return t("terminal.tab", { n: tab.id });
}

interface TabState {
  tabs: Tab[];
  activeId: number;
  nextId: number;
}

/**
 * How many shells one window may hold. Every tab is a PTY, a WebSocket and
 * an xterm instance kept alive on an 8 GB board; eight is more than a person
 * uses and far fewer than would hurt.
 */
export const MAX_TERMINAL_TABS = 8;

/** One object, so every change is a pure function of the last state. */
function addTab(state: TabState): TabState {
  if (state.tabs.length >= MAX_TERMINAL_TABS) return state;
  return { tabs: [...state.tabs, { id: state.nextId }], activeId: state.nextId, nextId: state.nextId + 1 };
}

function closeTab(state: TabState, id: number): TabState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const rest = state.tabs.filter((tab) => tab.id !== id);
  if (rest.length === 0) {
    // The window stays a terminal: closing the last tab opens a fresh one
    // rather than leaving an empty frame.
    return { tabs: [{ id: state.nextId }], activeId: state.nextId, nextId: state.nextId + 1 };
  }
  // The neighbour on the left, or the first when the first closed.
  const activeId = id === state.activeId ? rest[Math.max(0, index - 1)].id : state.activeId;
  return { ...state, tabs: rest, activeId };
}

function stepTab(state: TabState, direction: 1 | -1): TabState {
  const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
  if (index < 0 || state.tabs.length < 2) return state;
  return { ...state, activeId: state.tabs[(index + direction + state.tabs.length) % state.tabs.length].id };
}

export default function TerminalTabs({ initialCommand }: TerminalTabsProps) {
  const { t } = useT();
  const tr = useTr();
  const [state, setState] = useState<TabState>(() => ({
    tabs: [{ id: 1, command: initialCommand?.trim() || undefined }],
    activeId: 1,
    nextId: 2,
  }));
  const { tabs, activeId } = state;

  const onTabAction = useCallback((action: TerminalTabAction) => {
    setState((prev) => {
      if (action === "newTab") return addTab(prev);
      if (action === "closeTab") return closeTab(prev, prev.activeId);
      return stepTab(prev, action === "nextTab" ? 1 : -1);
    });
  }, []);
  const onAdd = useCallback(() => setState(addTab), []);
  const onClose = useCallback((id: number) => setState((prev) => closeTab(prev, id)), []);
  const onSelect = useCallback((id: number) => setState((prev) => (prev.activeId === id ? prev : { ...prev, activeId: id })), []);
  // A tab list is one tab stop: the active tab is tabbable and the arrow
  // keys walk the rest (roving tabindex), Home/End go to the ends. Moving
  // selects, so the shell behind the tab comes to the front as the focus
  // moves — the same as a click.
  // Where focus should land after the next state change: on the selected
  // tab, when a tab was closed from the keyboard (the button it was on is
  // gone) — never after a mouse close, which keeps the keyboard in the shell.
  const focusSelectedRef = useRef(false);
  const onTabKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    // Only from a tab itself: an arrow on a close button must not move the
    // selection under a focus that stays on the button.
    if ((e.target as HTMLElement).getAttribute("role") !== "tab") return;
    e.preventDefault();
    setState((prev) => {
      const index = prev.tabs.findIndex((tab) => tab.id === prev.activeId);
      if (index < 0) return prev;
      const next = e.key === "Home" ? 0
        : e.key === "End" ? prev.tabs.length - 1
        : e.key === "ArrowRight" ? (index + 1) % prev.tabs.length
        : (index - 1 + prev.tabs.length) % prev.tabs.length;
      return next === index ? prev : { ...prev, activeId: prev.tabs[next].id };
    });
  }, []);

  return (
    <div className="flex flex-col h-full bg-[var(--win-ground)]" data-testid="terminal-tabs">
      <div
        role="tablist"
        // The strip's accessible name: every other string here is a
        // `terminal.*` key, and this one stayed English on a German desktop.
        aria-label={tr("terminal.tabsLabel", "Terminal tabs")}
        onKeyDown={onTabKeyDown}
        className="flex items-stretch shrink-0 overflow-x-auto border-b"
        style={{ background: "#12122a", borderColor: "rgba(255,255,255,0.06)" }}
      >
        {tabs.map((tab) => {
          const selected = tab.id === activeId;
          return (
            // The tab and its close button are siblings: a control nested
            // inside a role="tab" is flattened away by assistive technology.
            <div
              key={tab.id}
              className={`flex items-stretch border-r max-w-[14rem] ${selected ? "bg-white/[0.06]" : "hover:bg-white/[0.04]"}`}
              style={{ borderColor: "rgba(255,255,255,0.06)" }}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(tab.id); } }}
            >
              <div
                role="tab"
                aria-selected={selected}
                data-testid={`terminal-tab-${tab.id}`}
                data-active={selected ? "true" : "false"}
                tabIndex={selected ? 0 : -1}
                ref={(el) => {
                  if (!selected || !el) return;
                  if (focusSelectedRef.current || document.activeElement?.getAttribute("role") === "tab") {
                    focusSelectedRef.current = false;
                    el.focus();
                  }
                }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSelect(tab.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(tab.id); } }}
                className={`flex items-center gap-1.5 pl-3 pr-1 py-1.5 text-xs font-mono cursor-pointer select-none min-w-0 ${
                  selected ? "text-white" : "text-white/50 hover:text-white/80"
                }`}
              >
                <span className="material-symbols-rounded shrink-0" style={{ fontSize: 14, color: selected ? "var(--coral-bright)" : "rgba(255,255,255,0.35)" }} aria-hidden="true">terminal</span>
                <span className="truncate">{terminalTabTitle(tab, t)}</span>
              </div>
              <button
                type="button"
                aria-label={t("terminal.closeTab")}
                title={t("terminal.closeTab")}
                data-testid={`terminal-tab-close-${tab.id}`}
                onMouseDown={(e) => e.preventDefault()}
                // `detail === 0`: a click the keyboard made (Enter, Space).
                onClick={(e) => { if (e.detail === 0) focusSelectedRef.current = true; onClose(tab.id); }}
                className="my-1 mr-1.5 w-5 rounded flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 bg-transparent border-none cursor-pointer shrink-0"
              >
                <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">close</span>
              </button>
            </div>
          );
        })}
        <button
          type="button"
          aria-label={t("terminal.newTab")}
          title={`${t("terminal.newTab")} (Alt+Shift+T)`}
          data-testid="terminal-tab-new"
          disabled={tabs.length >= MAX_TERMINAL_TABS}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onAdd}
          className="px-2.5 flex items-center justify-center text-white/50 hover:text-white hover:bg-white/[0.06] disabled:opacity-30 disabled:hover:bg-transparent bg-transparent border-none cursor-pointer disabled:cursor-default shrink-0"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">add</span>
        </button>
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          data-testid={`terminal-panel-${tab.id}`}
          hidden={tab.id !== activeId}
          className="flex-1 min-h-0"
        >
          <TerminalApp initialCommand={tab.command} active={tab.id === activeId} onTabAction={onTabAction} />
        </div>
      ))}
    </div>
  );
}
