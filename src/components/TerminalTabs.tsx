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
 */

import { useCallback, useState } from "react";
import { useT } from "@/lib/i18n";
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

/** One object, so every change is a pure function of the last state. */
function addTab(state: TabState): TabState {
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

  return (
    <div className="flex flex-col h-full" style={{ background: "#0d0d1a" }} data-testid="terminal-tabs">
      <div
        role="tablist"
        aria-label="Terminal tabs"
        className="flex items-stretch shrink-0 overflow-x-auto border-b"
        style={{ background: "#12122a", borderColor: "rgba(255,255,255,0.06)" }}
      >
        {tabs.map((tab) => {
          const selected = tab.id === activeId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={selected}
              data-testid={`terminal-tab-${tab.id}`}
              data-active={selected ? "true" : "false"}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(tab.id); } }}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(tab.id); } }}
              className={`group flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 text-xs font-mono cursor-pointer border-r select-none max-w-[14rem] ${
                selected ? "text-white bg-[#0d0d1a]" : "text-white/50 hover:text-white/80 hover:bg-white/[0.04]"
              }`}
              style={{ borderColor: "rgba(255,255,255,0.06)" }}
            >
              <span className="material-symbols-rounded shrink-0" style={{ fontSize: 14, color: selected ? "#22c55e" : "rgba(255,255,255,0.35)" }} aria-hidden="true">terminal</span>
              <span className="truncate">{terminalTabTitle(tab, t)}</span>
              <button
                type="button"
                aria-label={t("terminal.closeTab")}
                title={t("terminal.closeTab")}
                data-testid={`terminal-tab-close-${tab.id}`}
                onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                className="ml-0.5 w-5 h-5 rounded flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 bg-transparent border-none cursor-pointer shrink-0"
              >
                <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">close</span>
              </button>
            </div>
          );
        })}
        <button
          type="button"
          aria-label={t("terminal.newTab")}
          title={`${t("terminal.newTab")} (Ctrl+Shift+T)`}
          data-testid="terminal-tab-new"
          onClick={onAdd}
          className="px-2.5 flex items-center justify-center text-white/50 hover:text-white hover:bg-white/[0.06] bg-transparent border-none cursor-pointer shrink-0"
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
