"use client";

/**
 * TerminalApp — xterm.js terminal emulator connected to a WebSocket PTY backend.
 * Auto-started via instrumentation.ts (no manual server needed).
 *
 * `initialCommand` types one line into the shell as soon as it is alive, which
 * is how the Coding app opens straight into `claude-ds` instead of asking the
 * owner to remember a command. It is TYPED, not injected: the shell echoes it,
 * so what ran is on screen and the window is still an ordinary terminal
 * afterwards.
 *
 * How it looks and behaves comes from the owner's Terminal settings
 * (src/lib/terminal-settings.ts): theme, face, size, line height, cursor,
 * scrollback, copy-on-select, bell, and the shell and folder a new tab starts
 * in. A change applies to every open terminal at once.
 *
 * Rendering: WebGL where the device has it — crisp at any devicePixelRatio,
 * box drawing and block elements drawn cell-exact by the renderer rather than
 * by the font, emoji and Nerd Font icons scaled back into their cells — and
 * xterm's DOM renderer where it does not or the context is lost. Only the tab
 * on screen holds a WebGL context; a browser allows a page about sixteen.
 * Character widths follow Unicode 11, so an emoji takes the two cells the
 * shell counted for it.
 */

import React, {
  useEffect,
  useRef,
  useCallback,
  useState,
} from "react";
import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { useTr } from "@/lib/i18n-floor";
import { DESKTOP_LAYERS, shelfHeight } from "@/lib/window-snap";
import { WINDOW_CHROME } from "@/lib/window-chrome";
import {
  TERMINAL_FONTS,
  TERMINAL_THEMES,
  getTerminalSettings,
  loadTerminalSettings,
  terminalFontFor,
  terminalThemeFor,
  useTerminalSettings,
  type TerminalColors,
  type TerminalFontDef,
  type TerminalSettings,
} from "@/lib/terminal-settings";
import { canReadClipboard as clipboardReadable, copyToClipboard, readClipboard } from "@/lib/terminal-clipboard";
import { isMacPlatform, shortcutLabel, terminalShortcut } from "@/lib/terminal-keys";
import "@xterm/xterm/css/xterm.css";

type XTerm = import("@xterm/xterm").Terminal;
type XFitAddon = import("@xterm/addon-fit").FitAddon;
type XWebglAddon = import("@xterm/addon-webgl").WebglAddon;

/** What a keyboard shortcut in the terminal asks the tab strip around it to do. */
export type TerminalTabAction = "newTab" | "closeTab" | "nextTab" | "prevTab";

export interface TerminalAppProps {
  /** Command typed into the shell once, per connection, after it first speaks. */
  initialCommand?: string;
  /**
   * Whether this terminal is the one on screen. A tab strip keeps every
   * terminal mounted so its shell survives a switch; the one that just became
   * visible takes the keyboard. Absent means "always".
   */
  active?: boolean;
  /**
   * Tab shortcuts — Ctrl+Shift+T/W, Ctrl+Tab/Ctrl+Shift+Tab and their Alt+Shift
   * twins (src/lib/terminal-keys.ts) — handed to whoever owns the tabs.
   * Without a handler the keys reach the shell as they always did.
   */
  onTabAction?: (action: TerminalTabAction) => void;
  /** Opens the Terminal's settings; the right-click menu offers it when given. */
  onOpenSettings?: () => void;
  /** The shell rang the bell (with the visual bell on) — the strip marks a tab behind the front one. */
  onBell?: () => void;
}

/** The default face's stack, as the rest of the desktop has always read it. */
export const TERMINAL_FONT_FAMILY = TERMINAL_FONTS["jetbrains-mono"].family;

/** How long the first cell waits for the settings and the web font before it is drawn with what is there. */
const FONT_WAIT_MS = 1500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
  ]).finally(() => { if (timer !== null) clearTimeout(timer); });
}

/**
 * A shipped face, loaded before the grid is measured — bounded, so a slow disk
 * never holds the shell. Answers whether the wait ran out and the load itself,
 * so a terminal drawn on the fallback face can be refitted the moment the real
 * one lands. The device's own monospace needs no wait.
 */
async function loadTerminalFont(font: TerminalFontDef, size: number): Promise<{ late: boolean; loading: Promise<boolean> | null }> {
  if (!font.face || typeof document === "undefined" || !("fonts" in document)) return { late: false, loading: null };
  let loading: Promise<boolean>;
  try {
    loading = document.fonts.load(`${size}px "${font.face}"`).then((faces) => faces.length > 0, () => false);
  } catch {
    return { late: false, loading: null };
  }
  const late = await withTimeout(loading.then(() => false), FONT_WAIT_MS);
  return { late: late === undefined, loading };
}

/**
 * Re-measure the grid on the face that has just arrived: xterm measures on a
 * font CHANGE, so the family is set away and back.
 */
const FALLBACK_FONT_FAMILY = '"DejaVu Sans Mono", "Liberation Mono", monospace';
function refitForFont(term: XTerm, fitAddon: XFitAddon, family: string): void {
  term.options.fontFamily = FALLBACK_FONT_FAMILY;
  term.options.fontFamily = family;
  fitAddon.fit();
}

/** The ClawBox palette on a given ground — kept for callers that draw a terminal on a ground of their own. */
export function terminalTheme(ground: string): TerminalColors {
  const { colors } = TERMINAL_THEMES["clawbox-dark"];
  return { ...colors, background: ground, cursorAccent: ground };
}

/** The xterm options a settings value decides — every one of them can change on a live terminal. */
function liveOptions(settings: TerminalSettings) {
  const theme = terminalThemeFor(settings.theme);
  return {
    theme: theme.colors,
    fontFamily: terminalFontFor(settings.font).family,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
    // A light ground needs the colours an app chose for a dark one nudged
    // until they read; on a dark ground every colour is drawn exactly as sent,
    // truecolor included.
    minimumContrastRatio: theme.tone === "light" ? 3 : 1,
  };
}

/**
 * The buffer's whole text — scrollback and screen — with every wrapped row
 * joined back onto the line it continues, so "Copy all" pastes the lines the
 * program printed rather than the width the window happened to be.
 */
export function terminalBufferText(term: Pick<XTerm, "buffer">): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    // A row that continues on the next keeps its trailing spaces: they are
    // text the program wrote, not the padding after it.
    const continues = buffer.getLine(y + 1)?.isWrapped === true;
    const text = line.translateToString(!continues);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

// ── Touch selection ───────────────────────────────────────────────────
//
// xterm selects with a mouse and has nothing for a finger. A long press
// selects the word under it (a path, a URL — what a phone copies), dragging
// then moves the selection's end, and letting go opens the same menu a right
// click does. A swipe that starts before the press is recognised stays xterm's
// scroll.

const LONG_PRESS_MS = 450;
const TOUCH_SLOP_PX = 10;

function cellAt(term: XTerm, clientX: number, clientY: number): { col: number; row: number } | null {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || !term.cols || !term.rows) return null;
  const rect = screen.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const col = Math.floor(((clientX - rect.left) / rect.width) * term.cols);
  const row = Math.floor(((clientY - rect.top) / rect.height) * term.rows);
  return {
    col: Math.min(term.cols - 1, Math.max(0, col)),
    row: term.buffer.active.viewportY + Math.min(term.rows - 1, Math.max(0, row)),
  };
}

/** The run of non-blank cells around `col` — the second half of a wide glyph belongs to its word. */
function wordAt(term: XTerm, col: number, row: number): { start: number; end: number } {
  const line = term.buffer.active.getLine(row);
  if (!line) return { start: col, end: col };
  const blank = (x: number) => {
    const cell = line.getCell(x);
    if (!cell) return true;
    if (cell.getWidth() === 0) return false;
    const chars = cell.getChars();
    return chars === "" || /\s/.test(chars);
  };
  if (blank(col)) return { start: col, end: col };
  let start = col;
  while (start > 0 && !blank(start - 1)) start--;
  let end = col;
  while (end < term.cols - 1 && !blank(end + 1)) end++;
  return { start, end };
}

function installTouchSelection(el: HTMLElement, term: XTerm, onSelected: (x: number, y: number) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: { x: number; y: number } | null = null;
  // The long-pressed word, as linear cell positions (row * cols + col).
  let anchor: { start: number; end: number } | null = null;
  const cancelTimer = () => { if (timer) clearTimeout(timer); timer = null; };

  const onStart = (ev: TouchEvent) => {
    cancelTimer();
    anchor = null;
    if (ev.touches.length !== 1) { origin = null; return; }
    origin = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
    timer = setTimeout(() => {
      timer = null;
      if (!origin) return;
      const cell = cellAt(term, origin.x, origin.y);
      if (!cell) return;
      const word = wordAt(term, cell.col, cell.row);
      anchor = { start: cell.row * term.cols + word.start, end: cell.row * term.cols + word.end };
      term.select(word.start, cell.row, word.end - word.start + 1);
      try { navigator.vibrate?.(10); } catch { /* no haptics here */ }
    }, LONG_PRESS_MS);
  };
  const onMove = (ev: TouchEvent) => {
    const touch = ev.touches[0];
    if (!touch) return;
    if (!anchor) {
      if (origin && Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > TOUCH_SLOP_PX) {
        cancelTimer();
        origin = null;
      }
      return;
    }
    // Selecting: the finger drags the selection's end, not the scrollback.
    ev.preventDefault();
    ev.stopPropagation();
    const cell = cellAt(term, touch.clientX, touch.clientY);
    if (!cell) return;
    const cols = term.cols;
    const at = cell.row * cols + cell.col;
    const start = Math.min(anchor.start, at);
    const end = Math.max(anchor.end, at);
    term.select(start % cols, Math.floor(start / cols), end - start + 1);
  };
  const onEnd = (ev: TouchEvent) => {
    cancelTimer();
    if (anchor) {
      // No synthetic mousedown after it: xterm would take that for a click
      // and clear the selection the finger just made.
      if (ev.cancelable) ev.preventDefault();
      anchor = null;
      const touch = ev.changedTouches[0];
      if (term.hasSelection()) onSelected(touch?.clientX ?? origin?.x ?? 0, touch?.clientY ?? origin?.y ?? 0);
    }
    origin = null;
  };
  const onCancel = () => { cancelTimer(); anchor = null; origin = null; };

  el.addEventListener("touchstart", onStart, { passive: true });
  el.addEventListener("touchmove", onMove, { passive: false, capture: true });
  el.addEventListener("touchend", onEnd, { passive: false });
  el.addEventListener("touchcancel", onCancel);
  return () => {
    cancelTimer();
    el.removeEventListener("touchstart", onStart);
    el.removeEventListener("touchmove", onMove, { capture: true });
    el.removeEventListener("touchend", onEnd);
    el.removeEventListener("touchcancel", onCancel);
  };
}

interface ContextMenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

/** The menu's width and height, for keeping it inside the viewport. */
const MENU_W = 240;
const MENU_H = 270;

const IS_MAC = isMacPlatform();

function TerminalInner({ initialCommand, active = true, onTabAction, onOpenSettings, onBell }: TerminalAppProps) {
  const tr = useTr();
  // Read through a ref for the same reason `initialCommand` is: `connect` must
  // not change identity — and with it the live socket's handlers — because the
  // translation catalogue finished loading.
  const trRef = useRef(tr);
  useEffect(() => { trRef.current = tr; }, [tr]);
  const { settings } = useTerminalSettings();
  const settingsRef = useRef(settings);
  // What the xterm instance was last given, so a render that changed nothing
  // re-applies nothing.
  const appliedSettingsRef = useRef<TerminalSettings | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // The right-click menu: where it is and whether Copy has anything to copy.
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  // Whether the clipboard can be READ from script — a secure origin only.
  // Paste is offered when it can, and named as a key combination when not.
  const [canReadClipboard] = useState(() => clipboardReadable());
  const onTabActionRef = useRef(onTabAction);
  useEffect(() => { onTabActionRef.current = onTabAction; }, [onTabAction]);
  const onBellRef = useRef(onBell);
  useEffect(() => { onBellRef.current = onBell; }, [onBell]);
  const activeRef = useRef(active);
  // Read by the key handler xterm calls before it forwards a key to the
  // shell, so an Escape meant for the menu never reaches the PTY.
  const menuOpenRef = useRef(false);
  useEffect(() => { menuOpenRef.current = menu !== null; }, [menu]);
  // A short line over the terminal — "Copied to clipboard" — and the visual bell.
  const [notice, setNotice] = useState<{ text: string; error: boolean; id: number } | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [bellFlash, setBellFlash] = useState(0);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<XFitAddon | null>(null);
  const webglRef = useRef<XWebglAddon | null>(null);
  const webglLoadingRef = useRef(false);
  const fitFrameRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // `exited`: the SHELL ended — `exit`, Ctrl+D — as opposed to the connection
  // to it going away. The first is the owner's doing and gets no retry; the
  // second is a dropped socket and gets one (sweep FT-4).
  type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error" | "exited";
  const statusRef = useRef<ConnectionStatus>("connecting");
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  // The Reconnect button's action, read by the key handler installed once at
  // terminal creation so Enter after an ended shell starts a new one.
  const reconnectRef = useRef<() => void>(() => {});
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const inputDisposableRef = useRef<{ dispose: () => void } | null>(null);
  // What lives as long as the xterm instance: its event subscriptions, the
  // resize observer, the touch handlers.
  const terminalCleanupRef = useRef<Array<() => void>>([]);
  const connectLockRef = useRef(false);
  // Held from connect until the shell's FIRST byte of output. Sending on
  // `onopen` instead would type into a PTY whose shell has not been exec'd
  // yet on a loaded Orin; waiting for output means the shell demonstrably
  // exists. Re-armed on every connection so a reconnect after a crash
  // restarts the app rather than dropping the owner at a bare prompt.
  const pendingCommandRef = useRef<string | null>(null);
  // Read through a ref so a changed prop cannot invalidate `connect` and tear
  // down a live socket.
  const initialCommandRef = useRef(initialCommand);
  useEffect(() => {
    initialCommandRef.current = initialCommand;
  }, [initialCommand]);

  // Connect to the terminal WebSocket through the same origin that served
  // the page — the production server proxies `/terminal-ws` upgrades to
  // 127.0.0.1:3006. Using the same origin means it works on the LAN, through
  // the Cloudflare tunnel, and under HTTPS (mixed-content-safe).
  const wsUrl = typeof window !== "undefined"
    ? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/terminal-ws`
    : "ws://localhost/terminal-ws";

  const updateStatus = useCallback((s: typeof status) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const showNotice = useCallback((text: string, error = false) => {
    if (!mountedRef.current) return;
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setNotice((prev) => ({ text, error, id: (prev?.id ?? 0) + 1 }));
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      if (mountedRef.current) setNotice(null);
    }, error ? 3200 : 1600);
  }, []);

  /** Copy text; say so unless `quiet` (copy-on-select), and always say when it failed. */
  const copyAndTell = useCallback((text: string, quiet = false) => {
    if (!text) return;
    void copyToClipboard(text).then((ok) => {
      if (ok && quiet) return;
      showNotice(
        ok ? trRef.current("terminal.copied", "Copied to clipboard")
          : trRef.current("terminal.copyFailed", "The browser refused the clipboard — select the text and press {keys}", { keys: shortcutLabel("copy", IS_MAC) }),
        !ok,
      );
    });
  }, [showNotice]);

  // One fit per frame, however many things asked for it. A panel that is not
  // on screen has no size to fit to and is fitted when it comes back.
  const scheduleFit = useCallback(() => {
    if (fitFrameRef.current !== null || typeof requestAnimationFrame !== "function") return;
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null;
      const el = containerRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      try { fitAddonRef.current?.fit(); } catch { /* not open yet */ }
    });
  }, []);

  // ── Renderer ──────────────────────────────────────────────────────────
  const releaseWebgl = useCallback(() => {
    const addon = webglRef.current;
    webglRef.current = null;
    if (!addon) return;
    try { addon.dispose(); } catch { /* already gone with its context */ }
    scheduleFit();
  }, [scheduleFit]);

  const ensureWebgl = useCallback(async () => {
    const term = termRef.current;
    if (!term || !activeRef.current || webglRef.current || webglLoadingRef.current) return;
    if (typeof window === "undefined" || typeof window.WebGL2RenderingContext === "undefined") return;
    webglLoadingRef.current = true;
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      if (termRef.current !== term || !activeRef.current || !mountedRef.current) return;
      const addon = new WebglAddon();
      // A lost context (the GPU reset, too many contexts on the page) hands
      // the terminal back to the DOM renderer; the next time this tab comes
      // to the front it asks for WebGL again.
      addon.onContextLoss(() => {
        if (webglRef.current === addon) webglRef.current = null;
        try { addon.dispose(); } catch { /* already gone */ }
      });
      term.loadAddon(addon);
      webglRef.current = addon;
      scheduleFit();
    } catch {
      // No WebGL2 here, or the addon would not start: the DOM renderer stays.
      webglRef.current = null;
    } finally {
      webglLoadingRef.current = false;
    }
  }, [scheduleFit]);

  // `connect()` raises the lock on entry and only `onopen`/`onclose` lower it
  // again, so ANY throw before the socket handlers are installed strands it:
  // a ChunkLoadError from the three dynamic imports below when an in-app update
  // replaced the build under an already-open tab, an xterm constructor that
  // fails, the WebSocket constructor itself. With the lock raised every later
  // attempt — the 3 s reconnect and the Reconnect button alike — returns at the
  // guard, silently, as an unhandled rejection, and the window sits on
  // "Connecting to terminal server…" until it is closed and reopened.
  const releaseAfterFailedConnect = useCallback((err: unknown) => {
    connectLockRef.current = false;
    if (!mountedRef.current) return;
    updateStatus("error");
    const reason = err instanceof Error ? err.message : String(err);
    termRef.current?.writeln(`\r\n\x1b[31mError: could not start the terminal — ${reason}\x1b[0m`);
  }, [updateStatus]);

  /** Everything that lives as long as the xterm instance, wired once after it opens. */
  const wireTerminal = useCallback((term: XTerm, el: HTMLElement) => {
    const cleanup = terminalCleanupRef.current;
    // xterm's own resize (a fit that changed the grid) is what the PTY hears.
    const resizeSub = term.onResize?.(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    if (resizeSub) cleanup.push(() => resizeSub.dispose());
    const bellSub = term.onBell?.(() => {
      if (settingsRef.current.bell !== "visual") return;
      setBellFlash((n) => n + 1);
      onBellRef.current?.();
    });
    if (bellSub) cleanup.push(() => bellSub.dispose());
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(() => scheduleFit());
      ro.observe(el);
      cleanup.push(() => ro.disconnect());
    }
    // A move to a screen with another pixel ratio (or a browser zoom) changes
    // the cell's size in CSS pixels without changing the element's.
    if (typeof window.matchMedia === "function") {
      let query: MediaQueryList | null = null;
      const onRatio = () => { scheduleFit(); listen(); };
      const listen = () => {
        query?.removeEventListener?.("change", onRatio);
        query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
        query?.addEventListener?.("change", onRatio);
      };
      listen();
      cleanup.push(() => query?.removeEventListener?.("change", onRatio));
    }
    if (typeof term.hasSelection === "function") {
      cleanup.push(installTouchSelection(el, term, (x, y) => {
        if (settingsRef.current.copyOnSelect) copyAndTell(term.getSelection(), true);
        setMenu({ x: clampMenuX(x), y: clampMenuY(y), hasSelection: true });
      }));
    }
  }, [scheduleFit, copyAndTell]);

  const connect = useCallback(async () => {
    if (!mountedRef.current || !containerRef.current) return;
    if (connectLockRef.current) return;
    connectLockRef.current = true;

    const { Terminal } = await import("@xterm/xterm");
    const { FitAddon } = await import("@xterm/addon-fit");
    const { WebLinksAddon } = await import("@xterm/addon-web-links");
    // Unmounted while the modules loaded: nothing to draw into, and the
    // lock goes back so a remount can connect.
    if (!mountedRef.current || !containerRef.current) { connectLockRef.current = false; return; }

    // Create terminal instance once
    if (!termRef.current) {
      // The owner's settings, then their face — each waited for, boundedly,
      // before the first cell is drawn, or xterm would size its grid on the
      // fallback face and every glyph would land off its cell once the real
      // one arrived.
      await withTimeout(loadTerminalSettings(), FONT_WAIT_MS);
      const initial = getTerminalSettings();
      const face = terminalFontFor(initial.font);
      const fontLate = await loadTerminalFont(face, initial.fontSize);
      if (!mountedRef.current || !containerRef.current) { connectLockRef.current = false; return; }
      const term = new Terminal({
        ...liveOptions(initial),
        letterSpacing: 0,
        cursorInactiveStyle: "outline",
        // The background is opaque, so transparency bought nothing and cost the
        // renderer its fast path — on a redraw-heavy TUI that showed as tearing.
        allowTransparency: false,
        // Claude Code marks emphasis with bold. Remapping bold onto the BRIGHT
        // palette (xterm's default) recoloured its text instead of weighting it.
        drawBoldTextInBrightColors: false,
        fontWeight: "normal",
        fontWeightBold: "bold",
        macOptionIsMeta: true,
        // A right click on a word selects it, so "right click, Copy" works
        // on a word without dragging first.
        rightClickSelectsWord: true,
        // Unicode 11 widths are "proposed" API in xterm 6.
        allowProposedApi: true,
        // WebGL draws box drawing and block elements itself, so `╭─╮ │ ╰─╯`
        // joins at every line height, and scales a glyph that would spill
        // into the next cell (an emoji, a Nerd Font icon) back into its own.
        customGlyphs: true,
        rescaleOverlappingGlyphs: true,
      });
      appliedSettingsRef.current = initial;

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      // Widths are decided as text is written, so before anything is.
      try {
        const { Unicode11Addon } = await import("@xterm/addon-unicode11");
        term.loadAddon(new Unicode11Addon());
        term.unicode.activeVersion = "11";
      } catch {
        // xterm's own Unicode 6 tables: emoji may count as one cell.
      }
      if (!mountedRef.current || !containerRef.current) { term.dispose(); connectLockRef.current = false; return; }

      // The keys the terminal answers itself (src/lib/terminal-keys.ts); every
      // other key is the shell's.
      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        // An Escape while the right-click menu is open is for the menu. xterm
        // sees the key before the document does, so without this the menu
        // closed AND the shell got \x1b — which aborts a running claude-ds
        // turn, or leaves insert mode in vim.
        if (menuOpenRef.current && ev.key === "Escape") {
          if (ev.type === "keydown") setMenu(null);
          return false;
        }
        // The shell is gone and the socket with it: Enter is the offer the
        // status bar makes, and there is nothing else for the key to reach.
        if (statusRef.current === "exited" && ev.key === "Enter") {
          if (ev.type === "keydown") reconnectRef.current();
          return false;
        }
        const action = terminalShortcut(ev, IS_MAC);
        if (!action) return true;
        // Paste is the browser's own: its paste event on xterm's hidden input
        // is the one clipboard read plain HTTP allows, and xterm turns it
        // into a bracketed paste. So the key is only kept from the shell.
        if (action === "paste") return false;
        if (action === "copy") {
          if (ev.type === "keydown") {
            ev.preventDefault();
            const sel = term.getSelection();
            if (sel) copyAndTell(sel);
          }
          return false;
        }
        const tabs = onTabActionRef.current;
        if (!tabs) return true;
        if (ev.type === "keydown") {
          ev.preventDefault();
          tabs(action);
        }
        return false;
      });

      termRef.current = term;
      fitAddonRef.current = fitAddon;
      // The wait ran out before the face was in: the grid was measured on
      // the fallback, so it is measured again when the real one lands —
      // for this terminal only, and only while it is still on screen.
      if (fontLate.late && fontLate.loading) {
        void fontLate.loading.then((loaded) => {
          if (loaded && mountedRef.current && termRef.current === term) refitForFont(term, fitAddon, face.family);
        });
      }

      term.open(containerRef.current!);
      wireTerminal(term, containerRef.current!);
      fitAddon.fit();
      void ensureWebgl();
    }

    const term = termRef.current!;

    term.writeln(`\x1b[2m\x1b[36m${trRef.current("terminal.connectingToServer", "Connecting to terminal server…")}\x1b[0m`);

    // Clean up previous connection
    inputDisposableRef.current?.dispose();
    inputDisposableRef.current = null;
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.close(1000);
      wsRef.current = null;
    }

    // The shell and folder a new shell starts in, when the owner chose them.
    // The server checks both (/etc/shells, an existing directory) and says
    // what it started instead of a refused one.
    const { shell, cwd } = settingsRef.current;
    const query = new URLSearchParams();
    if (shell) query.set("shell", shell);
    if (cwd) query.set("cwd", cwd);
    const queryString = query.toString();
    const connectUrl = queryString ? `${wsUrl}?${queryString}` : wsUrl;

    let ws: WebSocket;
    try {
      ws = new WebSocket(connectUrl);
    } catch (err) {
      // The lock is released by `onopen` and `onclose`, and a constructor that
      // throws reaches neither. Left raised it made the Reconnect button a
      // no-op (the 3 s auto-reconnect is scheduled inside `onclose`, which this
      // path never reaches, so the button is the whole of the recovery) and the
      // window could not be revived without being closed and reopened —
      // TASK-712's sibling call site.
      //
      // The reason, not a guess: what throws here is the BROWSER refusing the
      // url — mixed content, or a CSP `connect-src` block — and the old text
      // sent the owner after a PTY server that is running fine.
      connectLockRef.current = false;
      if (!mountedRef.current) return;
      updateStatus("error");
      const reason = err instanceof Error ? err.message : String(err);
      term.writeln(`\r\n\x1b[31mError: the browser refused ${wsUrl} — ${reason}\x1b[0m`);
      return;
    }
    wsRef.current = ws;
    pendingCommandRef.current = initialCommandRef.current?.trim() || null;
    updateStatus("connecting");

    ws.onopen = () => {
      connectLockRef.current = false;
      if (!mountedRef.current) { ws.close(); return; }
      updateStatus("connected");
      term.clear();
      if (activeRef.current) term.focus();

      // Send initial size; later changes go out from xterm's onResize.
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));

      // Forward terminal input → server
      inputDisposableRef.current = term.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "output" && typeof msg.data === "string") {
          term.write(msg.data);
          const pending = pendingCommandRef.current;
          if (pending && ws.readyState === WebSocket.OPEN) {
            pendingCommandRef.current = null;
            ws.send(JSON.stringify({ type: "input", data: `${pending}\r` }));
          }
        } else if (msg.type === "started") {
          // The server could not honour a chosen shell or folder and started
          // the box's default instead: said once, dimmed, above the prompt.
          if (typeof msg.shellRefused === "string" && typeof msg.shell === "string") {
            term.writeln(`\x1b[2m${trRef.current("terminal.shellFallback", "{shell} is not a shell on this box — started {fallback} instead", { shell: msg.shellRefused, fallback: msg.shell })}\x1b[0m`);
          }
          if (typeof msg.cwdRefused === "string" && typeof msg.cwd === "string") {
            term.writeln(`\x1b[2m${trRef.current("terminal.cwdFallback", "{cwd} is not a folder on this box — started in {fallback}", { cwd: msg.cwdRefused, fallback: msg.cwd })}\x1b[0m`);
          }
        } else if (msg.type === "exit") {
          term.writeln(`\r\n\x1b[33m[Process exited with code ${msg.code}]\x1b[0m`);
          term.writeln(`\x1b[2m${trRef.current("terminal.shellEnded", "The shell ended — press Enter or Reconnect to start a new one")}\x1b[0m`);
          updateStatus("exited");
        }
      } catch {}
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      updateStatus("error");
      term.writeln(`\r\n\x1b[31mError: Cannot connect to ${wsUrl}\x1b[0m`);
      term.writeln("\x1b[2mTerminal server may not be running.\x1b[0m");
    };

    ws.onclose = (ev) => {
      connectLockRef.current = false;
      inputDisposableRef.current?.dispose();
      inputDisposableRef.current = null;

      if (!mountedRef.current) return;
      // The server closes the socket right after `exit`: that close is the
      // end of a shell the owner finished, not a disconnect — it used to be
      // reported as one and respawned a shell three seconds later, with the
      // window's own URL in the bar (sweep FT-4). A new shell is one Enter or
      // Reconnect away instead.
      if (statusRef.current === "exited") return;
      if (statusRef.current !== "error") {
        updateStatus("disconnected");
        if (ev.code !== 1000) {
          term.writeln(`\r\n\x1b[33m[${trRef.current("terminal.retrying", "Disconnected — will retry in 3s…")}]\x1b[0m`);
          reconnectTimerRef.current = setTimeout(() => {
            if (mountedRef.current) connect().catch(releaseAfterFailedConnect);
          }, 3000);
        }
      }
    };
  }, [wsUrl, updateStatus, releaseAfterFailedConnect, wireTerminal, ensureWebgl, copyAndTell]);

  useEffect(() => {
    mountedRef.current = true;
    connect().catch(releaseAfterFailedConnect);

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      if (fitFrameRef.current !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(fitFrameRef.current);
      inputDisposableRef.current?.dispose();
      for (const undo of terminalCleanupRef.current.splice(0)) {
        try { undo(); } catch { /* best effort */ }
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close(1000, "component unmounted");
      }
      webglRef.current = null;
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Settings, live ────────────────────────────────────────────────────
  useEffect(() => {
    settingsRef.current = settings;
    const term = termRef.current;
    const previous = appliedSettingsRef.current;
    if (!term || !previous || previous === settings) return;
    appliedSettingsRef.current = settings;
    const next = liveOptions(settings);
    try {
      term.options.theme = next.theme;
      term.options.fontSize = next.fontSize;
      term.options.lineHeight = next.lineHeight;
      term.options.cursorStyle = next.cursorStyle;
      term.options.cursorBlink = next.cursorBlink;
      term.options.scrollback = next.scrollback;
      term.options.minimumContrastRatio = next.minimumContrastRatio;
    } catch {
      return;
    }
    scheduleFit();
    if (previous.font !== settings.font || previous.fontSize !== settings.fontSize) {
      // A shipped face is fetched before it is measured, like the first one was.
      const face = terminalFontFor(settings.font);
      const apply = () => {
        if (termRef.current !== term || !mountedRef.current) return;
        term.options.fontFamily = face.family;
        scheduleFit();
      };
      if (face.face && typeof document !== "undefined" && "fonts" in document) {
        document.fonts.load(`${settings.fontSize}px "${face.face}"`).then(apply, apply);
      } else {
        apply();
      }
    }
  }, [settings, scheduleFit]);

  // Focus terminal on any interaction with the container
  const handleContainerClick = useCallback(() => {
    termRef.current?.focus();
  }, []);

  // The tab that just came on screen takes the keyboard and the GPU; the one
  // that went behind gives its WebGL context back. Its container was
  // display:none a moment ago, so the fit is redone too — a focus into a
  // stale-sized terminal would put the cursor in the wrong place for a frame.
  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      releaseWebgl();
      return;
    }
    try { fitAddonRef.current?.fit(); } catch {}
    termRef.current?.focus();
    void ensureWebgl();
  }, [active, ensureWebgl, releaseWebgl]);

  // Re-focus terminal when the window becomes visible/active
  useEffect(() => {
    const refocus = () => {
      if (!active) return;
      if (termRef.current && statusRef.current === "connected") {
        termRef.current.focus();
      }
    };
    // Focus when tab becomes visible
    document.addEventListener("visibilitychange", refocus);
    // Focus when window receives focus
    window.addEventListener("focus", refocus);
    return () => {
      document.removeEventListener("visibilitychange", refocus);
      window.removeEventListener("focus", refocus);
    };
  }, [active]);

  // Copy on select, for a mouse: the selection is final when the button comes up.
  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 || !settingsRef.current.copyOnSelect) return;
    const term = termRef.current;
    // xterm settles a double- or triple-click selection on this same event.
    setTimeout(() => {
      const sel = term?.getSelection();
      if (sel) copyAndTell(sel, true);
    }, 0);
  }, [copyAndTell]);

  // ── Right-click menu ──────────────────────────────────────────────────
  //
  // The browser's own menu has nothing useful for a terminal — no Copy over
  // plain HTTP, no Paste that reaches the shell — so it is replaced with the
  // things a terminal is actually asked for.
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const term = termRef.current;
    setMenu({ x: clampMenuX(e.clientX), y: clampMenuY(e.clientY), hasSelection: Boolean(term?.getSelection()) });
  }, []);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => {
    setMenu(null);
    termRef.current?.focus();
  }, []);
  // A role="menu" must be enterable: the first item that can be used takes
  // focus when the menu opens (Shift+F10 and the Menu key open it too).
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not([disabled])')?.focus();
  }, [menu]);
  const onMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Tab") { e.preventDefault(); closeMenu(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])') ?? []);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0
      : e.key === "End" ? items.length - 1
      : e.key === "ArrowDown" ? (current + 1) % items.length
      : (current - 1 + items.length) % items.length;
    items[next].focus();
  }, [closeMenu]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") closeMenu(); };
    const onPointer = (ev: PointerEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target?.closest("[data-terminal-menu]")) closeMenu();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [menu, closeMenu]);
  const menuCopy = useCallback(() => {
    const sel = termRef.current?.getSelection();
    if (sel) copyAndTell(sel);
    closeMenu();
  }, [closeMenu, copyAndTell]);
  const menuCopyAll = useCallback(() => {
    const term = termRef.current;
    let text = "";
    try { text = term ? terminalBufferText(term) : ""; } catch { text = ""; }
    if (text) copyAndTell(text);
    closeMenu();
  }, [closeMenu, copyAndTell]);
  const menuPaste = useCallback(() => {
    closeMenu();
    const term = termRef.current;
    if (!term) return;
    void readClipboard().then((text) => {
      // Through xterm's own paste so bracketed-paste mode is honoured: a
      // multi-line paste into a shell that asked for it arrives as one
      // paste, not as lines run one by one.
      if (text) term.paste(text);
      term.focus();
    });
  }, [closeMenu]);
  const menuSelectAll = useCallback(() => {
    termRef.current?.selectAll();
    closeMenu();
  }, [closeMenu]);
  const menuClear = useCallback(() => {
    termRef.current?.clear();
    closeMenu();
  }, [closeMenu]);
  const menuSettings = useCallback(() => {
    setMenu(null);
    onOpenSettings?.();
  }, [onOpenSettings]);

  // Fallback keyboard handler — copy/paste is handled at the xterm level
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // The right-click menu is a child of this div in React's tree (a portal in
    // the DOM — see the note where it is rendered), and React bubbles a
    // synthetic event through a portal, so every key pressed in the menu
    // arrives here — and the test below ("the textarea is not focused") is
    // true precisely because focus is on a menu item. The menu was therefore
    // losing the keyboard to xterm on its first
    // keystroke and the key's bytes went to the shell: Escape as \x1b (which
    // aborts a running claude-ds turn — the very thing the xterm-level guard
    // above exists to prevent), ArrowDown as \x1b[B (a stray `[B` on the
    // prompt), Tab as a literal tab. While the menu is open the keyboard is
    // the menu's.
    if (menuOpenRef.current) return;
    // If xterm's textarea doesn't have focus, forward key to PTY directly
    const xtermTextarea = containerRef.current?.querySelector("textarea.xterm-helper-textarea");
    if (xtermTextarea && document.activeElement !== xtermTextarea) {
      // Try to focus xterm first
      termRef.current?.focus();
      if (statusRef.current === "exited") {
        if (e.key === "Enter") { e.preventDefault(); reconnectRef.current(); }
        return;
      }
      // A terminal shortcut is never the shell's, focused or not.
      if (terminalShortcut(e, IS_MAC)) return;
      // Map key to terminal data and send directly
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      let data = "";
      if (e.key === "Enter") data = "\r";
      else if (e.key === "Backspace") data = "\x7f";
      else if (e.key === "Tab") data = "\t";
      else if (e.key === "Escape") data = "\x1b";
      else if (e.key === "ArrowUp") data = "\x1b[A";
      else if (e.key === "ArrowDown") data = "\x1b[B";
      else if (e.key === "ArrowRight") data = "\x1b[C";
      else if (e.key === "ArrowLeft") data = "\x1b[D";
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) data = e.key;
      else if (e.ctrlKey && e.key.length === 1) data = String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64);
      if (data) {
        e.preventDefault();
        ws.send(JSON.stringify({ type: "input", data }));
      }
    }
  }, []);

  const theme = terminalThemeFor(settings.theme);
  const colors = theme.colors;
  const chrome = WINDOW_CHROME[theme.tone];
  const light = theme.tone === "light";

  const statusDot = {
    connecting: "bg-yellow-400 motion-safe:animate-pulse",
    connected: "bg-green-400",
    disconnected: "bg-gray-500",
    error: "bg-red-400",
    exited: "bg-gray-500",
  }[status];

  const statusLabel = {
    connecting: tr("terminal.connecting", "Connecting…"),
    connected: tr("terminal.connected", "Connected"),
    disconnected: tr("terminal.disconnected", "Disconnected"),
    error: tr("terminal.error", "Error"),
    // A state word, like the other four: the instruction is printed in the
    // scrollback where Enter is the next keystroke, and the button it names
    // is the next thing in this row.
    exited: tr("terminal.exited", "Shell ended"),
  }[status];

  const handleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close(1000);
    }
    connect().catch(releaseAfterFailedConnect);
  }, [connect, releaseAfterFailedConnect]);
  useEffect(() => { reconnectRef.current = handleReconnect; }, [handleReconnect]);

  const pasteKeys = shortcutLabel("paste", IS_MAC);

  return (
    <div
      className="flex flex-col h-full"
      style={{ background: colors.background, color: colors.foreground }}
      data-terminal-theme={theme.id}
      onKeyDown={handleKeyDown}
    >
      {/* Status bar — only shown when disconnected/error */}
      {status !== "connected" && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 border-b shrink-0"
          style={{
            background: light ? "rgba(0,0,0,0.035)" : "rgba(255,255,255,0.035)",
            borderColor: chrome.hairline,
          }}
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot}`} />
          <span className="shrink-0 text-xs font-mono" style={{ opacity: 0.72 }}>
            {statusLabel}
          </span>
          {/* The socket's address is a diagnostic for a connection that
              failed; a shell the owner ended has nothing to diagnose. */}
          {status !== "exited" && (
            <span className="text-xs font-mono ml-1 min-w-0 truncate" style={{ opacity: 0.45 }}>
              — {wsUrl}
            </span>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleReconnect}
            className="shrink-0 whitespace-nowrap text-xs px-2.5 py-0.5 rounded-md transition-colors font-medium cursor-pointer bg-[rgba(249,115,22,0.14)] hover:bg-[rgba(249,115,22,0.24)] border border-[rgba(249,115,22,0.35)]"
            style={{ color: light ? "#c2410c" : "var(--coral-bright)" }}
          >
            {tr("terminal.reconnect", "Reconnect")}
          </button>
        </div>
      )}

      {/* The terminal. The padding is on this frame, not on the element
          xterm measures: FitAddon reads its parent's border-box height, so
          padding there made the grid one row taller than the space it had
          and the bottom row was cut through. */}
      <div
        className="relative flex-1 min-h-0"
        style={{ padding: "6px 2px 4px 8px", background: colors.background }}
        onContextMenu={handleContextMenu}
        onMouseUp={handleMouseUp}
      >
        <div
          ref={containerRef}
          tabIndex={0}
          data-testid="terminal-surface"
          className="h-full w-full overflow-hidden outline-none"
          onClick={handleContainerClick}
          onFocus={handleContainerClick}
        />
        {bellFlash > 0 && (
          <div
            key={bellFlash}
            aria-hidden="true"
            data-testid="terminal-bell-flash"
            className="terminal-bell-flash pointer-events-none absolute inset-0"
            style={{ background: colors.foreground }}
          />
        )}
        <div aria-live="polite" className="pointer-events-none absolute right-3 bottom-3 flex justify-end">
          {notice && (
            <span
              key={notice.id}
              data-testid="terminal-notice"
              className="terminal-notice rounded-lg px-2.5 py-1 text-xs font-medium shadow-lg border"
              style={{
                background: "var(--bg-elevated)",
                borderColor: "var(--border-subtle)",
                color: notice.error ? "#fca5a5" : "var(--text-primary)",
              }}
            >
              {notice.text}
            </span>
          )}
        </div>
      </div>

      {/* On the body, not in the window: a window is its own stacking
          context, so no z-index INSIDE it can reach above the shelf or the
          docked chat — the menu's 99999 was measured against the window's
          siblings and painted under the shelf's 10000 (sweep FT-2). Keys
          still bubble here through React's tree, so the guards above hold.
          Drawn as the desktop's other context menus are (Files, the desktop
          icons): the elevated surface, the subtle border, a blur. */}
      {menu && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={tr("terminal.menuLabel", "Terminal")}
          data-terminal-menu
          data-testid="terminal-context-menu"
          className="fixed min-w-[220px] py-1.5 rounded-xl shadow-2xl border border-[var(--border-subtle)] text-sm text-[var(--text-primary)]"
          style={{ left: menu.x, top: menu.y, zIndex: DESKTOP_LAYERS.menu, background: "var(--bg-elevated)", backdropFilter: "blur(16px)" }}
          onKeyDown={onMenuKeyDown}
        >
          <button type="button" role="menuitem" data-testid="terminal-menu-copy" disabled={!menu.hasSelection} onClick={menuCopy} className={MENU_ITEM}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }} aria-hidden="true">content_copy</span>
            {tr("terminal.copy", "Copy")}
            <span className={MENU_KEYS}>{shortcutLabel("copy", IS_MAC)}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="terminal-menu-paste"
            disabled={!canReadClipboard}
            onClick={menuPaste}
            className={MENU_ITEM}
            title={canReadClipboard ? undefined : tr("terminal.pasteWith", "Paste with {keys}", { keys: pasteKeys })}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 17 }} aria-hidden="true">content_paste</span>
            {tr("terminal.paste", "Paste")}
            <span className={MENU_KEYS}>{pasteKeys}</span>
          </button>
          <button type="button" role="menuitem" data-testid="terminal-menu-copy-all" onClick={menuCopyAll} className={MENU_ITEM}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }} aria-hidden="true">file_copy</span>
            {tr("terminal.copyAll", "Copy all")}
          </button>
          <button type="button" role="menuitem" data-testid="terminal-menu-select-all" onClick={menuSelectAll} className={MENU_ITEM}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }} aria-hidden="true">select_all</span>
            {tr("terminal.selectAll", "Select all")}
          </button>
          <div role="separator" className="my-1 border-t border-[var(--border-subtle)]" />
          <button type="button" role="menuitem" data-testid="terminal-menu-clear" onClick={menuClear} className={MENU_ITEM}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }} aria-hidden="true">cleaning_services</span>
            {tr("terminal.clear", "Clear")}
          </button>
          {onOpenSettings && (
            <>
              <div role="separator" className="my-1 border-t border-[var(--border-subtle)]" />
              <button type="button" role="menuitem" data-testid="terminal-menu-settings" onClick={menuSettings} className={MENU_ITEM}>
                <span className="material-symbols-rounded" style={{ fontSize: 17 }} aria-hidden="true">settings</span>
                {tr("terminal.settingsMenu", "Terminal settings…")}
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Keep the menu inside the viewport — and above the shelf, not merely inside the screen. */
function clampMenuX(x: number): number {
  return Math.min(x, Math.max(0, window.innerWidth - MENU_W));
}
function clampMenuY(y: number): number {
  // A menu opened in the lower rows of a window that reaches the shelf put
  // Clear behind it, and the shelf took the click (sweep FT-2).
  return Math.min(y, Math.max(0, window.innerHeight - shelfHeight() - MENU_H));
}

const MENU_ITEM = "w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors cursor-pointer bg-transparent border-none text-inherit hover:bg-white/[0.06] focus-visible:bg-white/[0.08] focus-visible:outline-none disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-default";
const MENU_KEYS = "ml-auto pl-4 text-[11px] text-[var(--text-muted)] font-mono";

/** next/dynamic renders this inside the page's provider, so it can be translated. */
function TerminalLoading() {
  const tr = useTr();
  const colors = terminalThemeFor(getTerminalSettings().theme).colors;
  return (
    <div
      className="h-full flex flex-col items-center justify-center gap-3"
      style={{ background: colors.background }}
    >
      <div
        className="w-8 h-8 rounded-full border-2 border-t-transparent motion-safe:animate-spin"
        style={{ borderColor: "var(--coral-bright)", borderTopColor: "transparent" }}
      />
      <span className="text-sm font-mono" style={{ color: colors.foreground, opacity: 0.5 }}>
        {tr("terminal.loading", "Loading terminal…")}
      </span>
    </div>
  );
}

const TerminalApp = dynamic(
  () => Promise.resolve(TerminalInner),
  {
    ssr: false,
    loading: TerminalLoading,
  }
);

export default TerminalApp;
