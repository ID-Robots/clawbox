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
 * the tab's own id, so closing a tab never renames the others. A double
 * click (or F2, or the tab's right-click menu) renames a tab.
 *
 * The strip is the window's chrome carried on under the title bar
 * (src/lib/window-chrome.ts): the bar's colour, the bar's hairline, and the
 * tab in front in the terminal's own colour so it runs into the page under
 * it. Too many tabs to fit scroll sideways — the wheel, the arrows at the
 * ends — and the one in front is always scrolled into view. The settings
 * gear sits in the title bar beside the window's own controls; on the
 * standalone page, which has no title bar, at the strip's end.
 *
 * Clicking anything in the strip keeps the keyboard in the terminal
 * (mousedown's default would move focus to the tab or the button, and
 * clicking the tab that is already in front refocuses nothing).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";
import { useTr } from "@/lib/i18n-floor";
import { DESKTOP_LAYERS, shelfHeight } from "@/lib/window-snap";
import { WINDOW_CHROME, useWindowChrome } from "@/lib/window-chrome";
import { terminalThemeFor, useTerminalSettings } from "@/lib/terminal-settings";
import { isMacPlatform, shortcutLabel, terminalShortcut } from "@/lib/terminal-keys";
import TerminalApp, { type TerminalTabAction } from "./TerminalApp";
import TerminalSettingsSheet from "./TerminalSettingsSheet";

export interface TerminalTabsProps {
  /** Typed into the FIRST tab's shell once it is alive — see TerminalApp. */
  initialCommand?: string;
}

interface Tab {
  id: number;
  command?: string;
  /** A name the owner gave it; otherwise it is named by what it runs or its number. */
  title?: string;
  /** The shell rang the bell while another tab was in front. */
  bell?: boolean;
}

/** The tab's name: what it runs, or its number. */
export function terminalTabTitle(tab: { id: number; command?: string; title?: string }, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (tab.title?.trim()) return tab.title.trim();
  const first = tab.command?.trim().split(/\s+/)[0];
  if (first) {
    // `cd '/x' && claude-ds --resume abc` names the thing after the cd, and
    // `… && CLAUDE_DS_PROVIDER=anthropic claude-ds …` the program, not the
    // variable set for it.
    const rest = tab.command!.match(/&&\s*(.*)$/)?.[1] ?? tab.command!;
    const named = rest.trim().split(/\s+/).find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? first;
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

/** The longest name a tab may be given. */
export const MAX_TAB_TITLE = 40;

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

function closeOtherTabs(state: TabState, id: number): TabState {
  const keep = state.tabs.find((tab) => tab.id === id);
  if (!keep) return state;
  return { ...state, tabs: [keep], activeId: id };
}

function selectTab(state: TabState, id: number): TabState {
  const tab = state.tabs.find((candidate) => candidate.id === id);
  if (!tab || (state.activeId === id && !tab.bell)) return state;
  return { ...state, activeId: id, tabs: state.tabs.map((candidate) => (candidate.id === id && candidate.bell ? { ...candidate, bell: false } : candidate)) };
}

function stepTab(state: TabState, direction: 1 | -1): TabState {
  const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
  if (index < 0 || state.tabs.length < 2) return state;
  return selectTab(state, state.tabs[(index + direction + state.tabs.length) % state.tabs.length].id);
}

function renameTab(state: TabState, id: number, title: string): TabState {
  const name = title.trim().slice(0, MAX_TAB_TITLE);
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, title: name || undefined } : tab)) };
}

interface TabMenuState { id: number; x: number; y: number }

const TAB_MENU_W = 220;
const TAB_MENU_H = 170;

export default function TerminalTabs({ initialCommand }: TerminalTabsProps) {
  const { t } = useT();
  const tr = useTr();
  const [state, setState] = useState<TabState>(() => ({
    tabs: [{ id: 1, command: initialCommand?.trim() || undefined }],
    activeId: 1,
    nextId: 2,
  }));
  const { tabs, activeId } = state;
  const { settings } = useTerminalSettings();
  const theme = terminalThemeFor(settings.theme);
  const palette = WINDOW_CHROME[theme.tone];
  const light = theme.tone === "light";
  const chrome = useWindowChrome();
  const [mac] = useState(() => isMacPlatform());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  // The window's chrome takes the terminal's face: a light theme gets the
  // light title bar, so bar, strip and page stay one palette.
  const setTone = chrome?.setTone;
  useEffect(() => { setTone?.(theme.tone); }, [setTone, theme.tone]);

  const onTabAction = useCallback((action: TerminalTabAction) => {
    setState((prev) => {
      if (action === "newTab") return addTab(prev);
      if (action === "closeTab") return closeTab(prev, prev.activeId);
      return stepTab(prev, action === "nextTab" ? 1 : -1);
    });
  }, []);
  const onAdd = useCallback(() => setState(addTab), []);
  const onClose = useCallback((id: number) => setState((prev) => closeTab(prev, id)), []);
  const onSelect = useCallback((id: number) => setState((prev) => selectTab(prev, id)), []);
  const onBell = useCallback((id: number) => {
    setState((prev) => (prev.activeId === id ? prev : { ...prev, tabs: prev.tabs.map((tab) => (tab.id === id ? { ...tab, bell: true } : tab)) }));
  }, []);

  const activeIdRef = useRef(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  /** Hand the keyboard back to the shell in front. */
  const focusTerminal = useCallback(() => {
    const panel = rootRef.current?.querySelector<HTMLElement>(`[data-testid="terminal-panel-${activeIdRef.current}"]`);
    panel?.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea")?.focus({ preventScroll: true });
  }, []);

  // The shortcuts again for when the keyboard is on the strip, the gear or the
  // sheet rather than in xterm (xterm answers them itself when it has focus).
  const onRootKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".xterm")) return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const action = terminalShortcut(e, mac);
    if (!action || action === "copy" || action === "paste") return;
    e.preventDefault();
    onTabAction(action);
  }, [mac, onTabAction]);

  // A tab list is one tab stop: the active tab is tabbable and the arrow
  // keys walk the rest (roving tabindex), Home/End go to the ends. Moving
  // selects, so the shell behind the tab comes to the front as the focus
  // moves — the same as a click.
  // Where focus should land after the next state change: on the selected
  // tab, when a tab was closed from the keyboard (the button it was on is
  // gone) — never after a mouse close, which keeps the keyboard in the shell.
  const focusSelectedRef = useRef(false);
  const onTabKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Only from a tab itself: an arrow on a close button must not move the
    // selection under a focus that stays on the button.
    if ((e.target as HTMLElement).getAttribute("role") !== "tab") return;
    if (e.key === "F2") {
      e.preventDefault();
      setRenamingId(activeIdRef.current);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    setState((prev) => {
      const index = prev.tabs.findIndex((tab) => tab.id === prev.activeId);
      if (index < 0) return prev;
      const next = e.key === "Home" ? 0
        : e.key === "End" ? prev.tabs.length - 1
        : e.key === "ArrowRight" ? (index + 1) % prev.tabs.length
        : (index - 1 + prev.tabs.length) % prev.tabs.length;
      return next === index ? prev : selectTab(prev, prev.tabs[next].id);
    });
  }, []);

  // ── Overflow ──────────────────────────────────────────────────────────
  const measureOverflow = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  useLayoutEffect(() => {
    measureOverflow();
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => measureOverflow());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureOverflow, tabs.length]);
  // The tab in front is always in view, whichever way it came to the front.
  useEffect(() => {
    const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-testid="terminal-tab-${activeId}"]`);
    el?.parentElement?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    measureOverflow();
  }, [activeId, tabs.length, measureOverflow]);
  const scrollTabs = useCallback((direction: 1 | -1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy?.({ left: direction * Math.max(120, el.clientWidth * 0.6), behavior: "smooth" });
  }, []);
  // A mouse wheel has no sideways axis: its turn scrolls the strip sideways.
  const onStripWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollerRef.current;
    if (!el || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    el.scrollLeft += e.deltaY;
  }, []);

  // ── Tab menu ──────────────────────────────────────────────────────────
  const tabMenuRef = useRef<HTMLDivElement>(null);
  const closeTabMenu = useCallback(() => setTabMenu(null), []);
  useEffect(() => {
    if (!tabMenu) return;
    tabMenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not([disabled])')?.focus();
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") { closeTabMenu(); focusTerminal(); } };
    const onPointer = (ev: PointerEvent) => {
      if (!(ev.target as HTMLElement | null)?.closest("[data-terminal-tab-menu]")) closeTabMenu();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [tabMenu, closeTabMenu, focusTerminal]);
  const onTabMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Tab") { e.preventDefault(); closeTabMenu(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const items = Array.from(tabMenuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])') ?? []);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0
      : e.key === "End" ? items.length - 1
      : e.key === "ArrowDown" ? (current + 1) % items.length
      : (current - 1 + items.length) % items.length;
    items[next].focus();
  }, [closeTabMenu]);

  const commitRename = useCallback((id: number, value: string | null) => {
    if (value !== null) setState((prev) => renameTab(prev, id, value));
    setRenamingId(null);
    // Back to the shell, after the input that had the keyboard is gone.
    setTimeout(focusTerminal, 0);
  }, [focusTerminal]);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setTimeout(focusTerminal, 0);
  }, [focusTerminal]);

  const stripBackground = chrome && !chrome.active ? palette.titleBarInactive : palette.strip;
  const text = light ? "rgba(0, 0, 0," : "rgba(255, 255, 255,";
  const hoverFill = light ? "hover:bg-black/[0.05]" : "hover:bg-white/[0.05]";
  const buttonHover = light ? "hover:bg-black/[0.07] active:bg-black/[0.12]" : "hover:bg-white/10 active:bg-white/[0.16]";
  const glyph = light ? "text-black/55 hover:text-black/85" : "text-white/55 hover:text-white/90";
  const settingsLabel = tr("terminal.settings.title", "Terminal settings");
  const newTabTitle = `${t("terminal.newTab")} (${shortcutLabel("newTab", mac)})`;

  const gear = (
    <button
      type="button"
      data-testid="terminal-settings-button"
      aria-label={settingsLabel}
      aria-haspopup="dialog"
      aria-expanded={settingsOpen}
      title={settingsLabel}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setSettingsOpen((open) => !open)}
      className={`w-6 h-6 flex items-center justify-center rounded-full transition-colors cursor-pointer border-none bg-transparent ${chrome?.actions ? palette.controlHoverClass : buttonHover} ${settingsOpen ? (light ? "bg-black/[0.08]" : "bg-white/10") : ""}`}
    >
      <span className={`material-symbols-rounded ${chrome?.actions ? palette.controlClass : glyph}`} style={{ fontSize: 16 }} aria-hidden="true">settings</span>
    </button>
  );

  return (
    <div
      ref={rootRef}
      className="relative flex flex-col h-full"
      style={{ background: theme.colors.background }}
      data-testid="terminal-tabs"
      data-terminal-tone={theme.tone}
      onKeyDown={onRootKeyDown}
    >
      <div
        className="flex items-end shrink-0 h-[34px] pl-1.5 pr-1 gap-0.5 select-none"
        style={{ background: stripBackground, boxShadow: `inset 0 -1px 0 ${palette.hairline}` }}
        onWheel={onStripWheel}
        onDoubleClick={(e) => {
          // A double click on the empty strip opens a tab, as it does in a browser.
          if (e.target === e.currentTarget) onAdd();
        }}
      >
        {overflow.left && (
          <button
            type="button"
            aria-label={tr("terminal.scrollTabsLeft", "Scroll tabs left")}
            data-testid="terminal-tabs-scroll-left"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => scrollTabs(-1)}
            className={`mb-[3px] w-6 h-7 shrink-0 flex items-center justify-center rounded-md bg-transparent border-none cursor-pointer ${buttonHover} ${glyph}`}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">chevron_left</span>
          </button>
        )}
        <div
          ref={scrollerRef}
          role="tablist"
          // The strip's accessible name: every other string here is a
          // `terminal.*` key, and this one stayed English on a German desktop.
          aria-label={tr("terminal.tabsLabel", "Terminal tabs")}
          onKeyDown={onTabKeyDown}
          onScroll={measureOverflow}
          className="terminal-tabstrip flex items-end gap-0.5 min-w-0 overflow-x-auto overflow-y-hidden h-full"
          style={{
            flex: "0 1 auto",
            // The ends fade where more tabs are hidden.
            maskImage: overflow.left || overflow.right
              ? `linear-gradient(to right, ${overflow.left ? "transparent 0, #000 18px" : "#000 0"}, ${overflow.right ? "#000 calc(100% - 18px), transparent 100%" : "#000 100%"})`
              : undefined,
          }}
        >
          {tabs.map((tab) => {
            const selected = tab.id === activeId;
            const renaming = renamingId === tab.id;
            const title = terminalTabTitle(tab, t);
            return (
              // The tab and its close button are siblings: a control nested
              // inside a role="tab" is flattened away by assistive technology.
              <div
                key={tab.id}
                data-tab-shell={tab.id}
                className={`group relative flex items-center h-[30px] rounded-t-lg transition-colors ${selected ? "" : hoverFill}`}
                style={{
                  flex: "0 1 13rem",
                  // Narrow enough to squeeze, wide enough that "Terminal 12"
                  // still reads whole beside its icon and close button — at
                  // 7.5rem every tab of a full strip read "Termina…". The
                  // strip scrolls for the rest.
                  minWidth: "8.75rem",
                  background: selected ? theme.colors.background : undefined,
                  boxShadow: selected ? `inset 0 1px 0 ${palette.hairline}, inset 1px 0 0 ${palette.hairline}, inset -1px 0 0 ${palette.hairline}` : undefined,
                }}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(tab.id); } }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTabMenu({
                    id: tab.id,
                    x: Math.min(e.clientX, Math.max(0, window.innerWidth - TAB_MENU_W)),
                    y: Math.min(e.clientY, Math.max(0, window.innerHeight - shelfHeight() - TAB_MENU_H)),
                  });
                }}
              >
                {selected && (
                  // The coral line the desktop marks the thing in front with.
                  <span aria-hidden="true" className="absolute left-2 right-2 top-0 h-[2px] rounded-b-full" style={{ background: "var(--coral-bright)" }} />
                )}
                {renaming ? (
                  <RenameField
                    initial={tab.title ?? title}
                    label={tr("terminal.tabNameLabel", "Tab name")}
                    light={light}
                    onDone={(value) => commitRename(tab.id, value)}
                  />
                ) : (
                  <div
                    role="tab"
                    id={`terminal-tab-${tab.id}`}
                    aria-selected={selected}
                    aria-controls={`terminal-panel-${tab.id}`}
                    data-testid={`terminal-tab-${tab.id}`}
                    data-active={selected ? "true" : "false"}
                    tabIndex={selected ? 0 : -1}
                    title={title}
                    ref={(el) => {
                      if (!selected || !el) return;
                      if (focusSelectedRef.current || document.activeElement?.getAttribute("role") === "tab") {
                        focusSelectedRef.current = false;
                        el.focus();
                      }
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onSelect(tab.id)}
                    onDoubleClick={() => setRenamingId(tab.id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(tab.id); } }}
                    className="flex flex-1 items-center gap-1.5 h-full pl-3 pr-1 text-xs cursor-pointer min-w-0 rounded-t-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--coral-bright)]"
                    style={{ color: selected ? `${text} ${light ? 0.88 : 0.92})` : `${text} ${light ? 0.55 : 0.55})` }}
                  >
                    <span
                      className="material-symbols-rounded shrink-0"
                      style={{ fontSize: 15, color: selected || tab.bell ? "var(--coral-bright)" : `${text} 0.4)` }}
                      aria-hidden="true"
                    >
                      {tab.bell ? "notifications_active" : "terminal"}
                    </span>
                    <span className="truncate font-medium">{title}</span>
                    {tab.bell && <span className="sr-only">{tr("terminal.tabBell", "rang the bell")}</span>}
                  </div>
                )}
                {!renaming && (
                  <button
                    type="button"
                    aria-label={t("terminal.closeTab")}
                    title={`${t("terminal.closeTab")} (${shortcutLabel("closeTab", mac)})`}
                    data-testid={`terminal-tab-close-${tab.id}`}
                    onMouseDown={(e) => e.preventDefault()}
                    // `detail === 0`: a click the keyboard made (Enter, Space).
                    onClick={(e) => { if (e.detail === 0) focusSelectedRef.current = true; onClose(tab.id); }}
                    className={`terminal-tab-close mr-1.5 w-5 h-5 shrink-0 rounded-md flex items-center justify-center bg-transparent border-none cursor-pointer transition-opacity ${buttonHover} ${glyph} ${
                      selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    }`}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">close</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {overflow.right && (
          <button
            type="button"
            aria-label={tr("terminal.scrollTabsRight", "Scroll tabs right")}
            data-testid="terminal-tabs-scroll-right"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => scrollTabs(1)}
            className={`mb-[3px] w-6 h-7 shrink-0 flex items-center justify-center rounded-md bg-transparent border-none cursor-pointer ${buttonHover} ${glyph}`}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">chevron_right</span>
          </button>
        )}
        <button
          type="button"
          aria-label={t("terminal.newTab")}
          title={newTabTitle}
          data-testid="terminal-tab-new"
          disabled={tabs.length >= MAX_TERMINAL_TABS}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onAdd}
          className={`mb-[3px] ml-0.5 w-7 h-7 shrink-0 flex items-center justify-center rounded-md bg-transparent border-none cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent ${buttonHover} ${glyph}`}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">add</span>
        </button>
        <div className="flex-1 self-stretch" onDoubleClick={onAdd} />
        {!chrome?.actions && <div className="mb-[5px] shrink-0">{gear}</div>}
      </div>
      {chrome?.actions && createPortal(gear, chrome.actions)}

      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`terminal-panel-${tab.id}`}
          aria-labelledby={`terminal-tab-${tab.id}`}
          data-testid={`terminal-panel-${tab.id}`}
          hidden={tab.id !== activeId}
          className="flex-1 min-h-0"
        >
          <TerminalApp
            initialCommand={tab.command}
            active={tab.id === activeId}
            onTabAction={onTabAction}
            onOpenSettings={() => setSettingsOpen(true)}
            onBell={() => onBell(tab.id)}
          />
        </div>
      ))}

      {settingsOpen && <TerminalSettingsSheet onClose={closeSettings} />}

      {tabMenu && createPortal(
        <div
          ref={tabMenuRef}
          role="menu"
          data-terminal-tab-menu
          data-testid="terminal-tab-menu"
          className="fixed min-w-[200px] py-1.5 rounded-xl shadow-2xl border border-[var(--border-subtle)] text-sm text-[var(--text-primary)]"
          style={{ left: tabMenu.x, top: tabMenu.y, zIndex: DESKTOP_LAYERS.menu, background: "var(--bg-elevated)", backdropFilter: "blur(16px)" }}
          onKeyDown={onTabMenuKeyDown}
        >
          <button type="button" role="menuitem" data-testid="terminal-tab-menu-rename" className={TAB_MENU_ITEM} onClick={() => { const id = tabMenu.id; closeTabMenu(); setState((prev) => selectTab(prev, id)); setRenamingId(id); }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }} aria-hidden="true">edit</span>
            {tr("terminal.renameTab", "Rename tab")}
            <span className={TAB_MENU_KEYS}>F2</span>
          </button>
          <button type="button" role="menuitem" data-testid="terminal-tab-menu-new" className={TAB_MENU_ITEM} disabled={tabs.length >= MAX_TERMINAL_TABS} onClick={() => { closeTabMenu(); onAdd(); }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }} aria-hidden="true">add</span>
            {t("terminal.newTab")}
            <span className={TAB_MENU_KEYS}>{shortcutLabel("newTab", mac)}</span>
          </button>
          <div role="separator" className="my-1 border-t border-[var(--border-subtle)]" />
          <button type="button" role="menuitem" data-testid="terminal-tab-menu-close" className={TAB_MENU_ITEM} onClick={() => { const id = tabMenu.id; closeTabMenu(); onClose(id); setTimeout(focusTerminal, 0); }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }} aria-hidden="true">close</span>
            {t("terminal.closeTab")}
            <span className={TAB_MENU_KEYS}>{shortcutLabel("closeTab", mac)}</span>
          </button>
          <button type="button" role="menuitem" data-testid="terminal-tab-menu-close-others" className={TAB_MENU_ITEM} disabled={tabs.length < 2} onClick={() => { const id = tabMenu.id; closeTabMenu(); setState((prev) => closeOtherTabs(prev, id)); setTimeout(focusTerminal, 0); }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }} aria-hidden="true">tab_close</span>
            {tr("terminal.closeOtherTabs", "Close other tabs")}
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

const TAB_MENU_ITEM = "w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors cursor-pointer bg-transparent border-none text-inherit hover:bg-white/[0.06] focus-visible:bg-white/[0.08] focus-visible:outline-none disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-default";
const TAB_MENU_KEYS = "ml-auto pl-4 text-[11px] text-[var(--text-muted)] font-mono";

/** The name field a tab turns into while it is renamed: Enter or leaving it keeps the name, Escape drops it. */
function RenameField({ initial, label, light, onDone }: { initial: string; label: string; light: boolean; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const doneRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // The field replaces the tab and takes the keyboard at once, name selected.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const finish = (next: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(next);
  };
  return (
    <input
      ref={inputRef}
      data-testid="terminal-tab-rename"
      aria-label={label}
      value={value}
      maxLength={MAX_TAB_TITLE}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); finish(value); }
        else if (e.key === "Escape") { e.preventDefault(); finish(null); }
      }}
      onBlur={() => finish(value)}
      className={`mx-1.5 my-1 h-[22px] min-w-0 flex-1 rounded-md px-1.5 text-xs font-medium outline-none border ${
        light ? "bg-white text-black/85 border-orange-500/60" : "bg-black/30 text-white/90 border-orange-500/60"
      }`}
    />
  );
}
