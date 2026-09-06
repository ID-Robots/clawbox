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
 */

import React, {
  useEffect,
  useRef,
  useCallback,
  useState,
} from "react";
import dynamic from "next/dynamic";
import { useT } from "@/lib/i18n";
import { useTr } from "@/lib/i18n-floor";
import "@xterm/xterm/css/xterm.css";

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
   * Tab shortcuts — Alt+Shift+T, Alt+Shift+W, Alt+Shift+PageDown/PageUp —
   * handed to whoever owns the tabs. Without a handler the keys reach the
   * shell as they always did.
   */
  onTabAction?: (action: TerminalTabAction) => void;
}

/**
 * Copy to the clipboard, over plain HTTP too: `navigator.clipboard` exists
 * only on a secure origin, and every LAN ClawBox is http://, so the
 * `execCommand` fallback is the path most boxes take.
 */
/**
 * The terminal's face. JetBrains Mono (shipped, public/fonts) for the text;
 * the Nerd Fonts symbols set (shipped) for the glyphs a TUI draws with —
 * powerline, devicons, the private-use icons; the platform's own colour
 * font for emoji, which no monospace face carries; then the faces the box
 * image has (DejaVu, Liberation) so a phone and the box's own Chromium fall
 * through the same way. Box drawing comes from JetBrains Mono itself — the
 * whole of Claude Code's UI is `╭─╮ │ ╰─╯`.
 */
export const TERMINAL_FONT_FAMILY = '"JetBrains Mono", "Symbols Nerd Font Mono", "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", "DejaVu Sans Mono", "Liberation Mono", "Ubuntu Mono", Menlo, Consolas, monospace';

/** How long the first cell waits for the web font before it is drawn with the fallback face. */
const FONT_WAIT_MS = 1500;

/**
 * The web font, loaded before the grid is measured — bounded, so a slow disk
 * never holds the shell. Answers whether the wait ran out and the load
 * itself, so a terminal drawn on the fallback face can be refitted the
 * moment the real one lands.
 */
async function loadTerminalFont(): Promise<{ late: boolean; loading: Promise<boolean> | null }> {
  if (typeof document === "undefined" || !("fonts" in document)) return { late: false, loading: null };
  let loading: Promise<boolean>;
  try {
    loading = document.fonts.load('13px "JetBrains Mono"').then((faces) => faces.length > 0, () => false);
  } catch {
    return { late: false, loading: null };
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = await Promise.race([
    loading.then(() => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), FONT_WAIT_MS); }),
  ]);
  if (timer !== null) clearTimeout(timer);
  return { late, loading };
}

/** Re-measure the grid on the face that has just arrived: xterm measures on a font CHANGE, so the family is set away and back. */
const FALLBACK_FONT_FAMILY = '"DejaVu Sans Mono", "Liberation Mono", monospace';
function refitForFont(term: import("@xterm/xterm").Terminal, fitAddon: import("@xterm/addon-fit").FitAddon): void {
  term.options.fontFamily = FALLBACK_FONT_FAMILY;
  term.options.fontFamily = TERMINAL_FONT_FAMILY;
  fitAddon.fit();
}

/** The Coding Agent's ground (`--win-ground`), as the terminal's canvas needs it: a literal. */
const TERMINAL_GROUND_FALLBACK = "#0d1117";
function terminalGround(): string {
  if (typeof window === "undefined") return TERMINAL_GROUND_FALLBACK;
  const v = getComputedStyle(document.documentElement).getPropertyValue("--win-ground").trim();
  return v || TERMINAL_GROUND_FALLBACK;
}

/**
 * The palette: GitHub's dark scheme, the same one the code editor colours
 * with (`.tok-*` in globals.css), on the Coding Agent's ground — so a run's
 * transcript in a Terminal window reads like the run's own page.
 */
export function terminalTheme(ground: string) {
  return {
    background: ground,
    foreground: "#e6edf3",
    cursor: "#f97316",
    cursorAccent: ground,
    selectionBackground: "rgba(255, 255, 255, 0.18)",
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#f0f6fc",
  };
}

function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text: string) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
}

interface ContextMenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

/** The menu's width and height, for keeping it inside the viewport. */
const MENU_W = 200;
const MENU_H = 160;

function TerminalInner({ initialCommand, active = true, onTabAction }: TerminalAppProps) {
  const { t } = useT();
  const tr = useTr();
  // Read through a ref for the same reason `initialCommand` is: `connect` must
  // not change identity — and with it the live socket's handlers — because the
  // translation catalogue finished loading.
  const trRef = useRef(tr);
  useEffect(() => { trRef.current = tr; }, [tr]);
  const containerRef = useRef<HTMLDivElement>(null);
  // The right-click menu: where it is and whether Copy has anything to copy.
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  // Whether the clipboard can be READ from script — a secure origin only.
  // Paste is offered when it can, and named as a key combination when not.
  const [canReadClipboard] = useState(() => typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function");
  const onTabActionRef = useRef(onTabAction);
  useEffect(() => { onTabActionRef.current = onTabAction; }, [onTabAction]);
  // Read by the key handler xterm calls before it forwards a key to the
  // shell, so an Escape meant for the menu never reaches the PTY.
  const menuOpenRef = useRef(false);
  useEffect(() => { menuOpenRef.current = menu !== null; }, [menu]);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const statusRef = useRef<"connecting" | "connected" | "disconnected" | "error">("connecting");
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "error">("connecting");
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const inputDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
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
    let fontLate: { late: boolean; loading: Promise<boolean> | null } | null = null;
    if (!termRef.current) {
      // The face is a web font: waited for before the first cell is drawn,
      // or xterm would size its grid on the fallback and every glyph would
      // land off its cell once the real one arrived.
      fontLate = await loadTerminalFont();
      if (!mountedRef.current || !containerRef.current) { connectLockRef.current = false; return; }
      const term = new Terminal({
        theme: terminalTheme(terminalGround()),
        // Box-drawing first. Claude Code's whole UI is drawn with `╭─╮ │ ╰─╯`,
        // and NONE of the four fonts the old stack named (Cascadia, JetBrains
        // Mono, Fira Code, Consolas — nor its Courier New fallback) exists on
        // this image: `fc-list` has none of them, so every session fell through
        // to the generic `monospace` alias and the glyphs were whatever the
        // viewing device's fontconfig happened to resolve. DejaVu and Liberation
        // DO ship here, so naming them makes the result the same on the box's
        // own Chromium and on a phone that has neither.
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: 13,
        // 1.0, not 1.4. Line height is leading BETWEEN rows, and a full-screen
        // TUI draws its vertical borders as one glyph per row — at 1.4 every
        // `│` was separated from the one below it by 40% of a line, so every box
        // in Claude Code rendered as a dotted column. Prose scrollback can
        // afford leading; a TUI cannot.
        lineHeight: 1.0,
        cursorBlink: true,
        cursorStyle: "block",
        scrollback: 5000,
        // The background is opaque, so transparency bought nothing and cost the
        // renderer its fast path — on a redraw-heavy TUI that showed as tearing.
        allowTransparency: false,
        // Claude Code marks emphasis with bold. Remapping bold onto the BRIGHT
        // palette (xterm's default) recoloured its text instead of weighting it.
        drawBoldTextInBrightColors: false,
        macOptionIsMeta: true,
        // A right click on a word selects it, so "right click, Copy" works
        // on a word without dragging first.
        rightClickSelectsWord: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());

      // Clipboard key handler at xterm level.
      // - Ctrl+Shift+C: copy selection
      // - Ctrl+Shift+V and Ctrl+V: let the event pass through to the browser
      //   so it fires a native "paste" event on xterm's hidden textarea (the
      //   only way to read the clipboard over plain HTTP).
      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        // An Escape while the right-click menu is open is for the menu. xterm
        // sees the key before the document does, so without this the menu
        // closed AND the shell got \x1b — which aborts a running claude-ds
        // turn, or leaves insert mode in vim.
        if (menuOpenRef.current && ev.key === "Escape") {
          if (ev.type === "keydown") setMenu(null);
          return false;
        }
        if (ev.ctrlKey && ev.shiftKey && ev.key === "C" && ev.type === "keydown") {
          const sel = term.getSelection();
          if (sel) copyText(sel);
          return false;
        }
        // Tab shortcuts, only when somebody owns the tabs. Alt+Shift, not
        // Ctrl+Shift: Ctrl+Shift+T/W and Ctrl+PageUp/PageDown are the
        // browser's own accelerators (reopen tab, CLOSE THE WINDOW, switch
        // tab), handled before the page ever sees the key — preventDefault
        // cannot claim them. Alt+Shift+letter is bound by no browser.
        const tabs = onTabActionRef.current;
        if (tabs && ev.type === "keydown" && ev.altKey && ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
          let action: TerminalTabAction | null = null;
          if (ev.key === "T" || ev.key === "t") action = "newTab";
          else if (ev.key === "W" || ev.key === "w") action = "closeTab";
          else if (ev.key === "PageDown") action = "nextTab";
          else if (ev.key === "PageUp") action = "prevTab";
          if (action) {
            ev.preventDefault();
            tabs(action);
            return false;
          }
        }
        // Let Ctrl+Shift+V AND Ctrl+V bubble to the browser natively
        if (ev.ctrlKey && (ev.key === "v" || ev.key === "V") && ev.type === "keydown") {
          return false;
        }
        return true;
      });

      termRef.current = term;
      fitAddonRef.current = fitAddon;
      // The wait ran out before the face was in: the grid was measured on
      // the fallback, so it is measured again when the real one lands —
      // for this terminal only, and only while it is still on screen.
      if (fontLate?.late && fontLate.loading) {
        void fontLate.loading.then((loaded) => {
          if (loaded && mountedRef.current && termRef.current === term) refitForFont(term, fitAddon);
        });
      }

      term.open(containerRef.current!);
      fitAddon.fit();
    }

    const term = termRef.current!;
    const fitAddon = fitAddonRef.current!;

    term.writeln(`\x1b[2m\x1b[36m${trRef.current("terminal.connectingToServer", "Connecting to terminal server…")}\x1b[0m`);

    // Clean up previous connection
    inputDisposableRef.current?.dispose();
    inputDisposableRef.current = null;
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.close(1000);
      wsRef.current = null;
    }

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    pendingCommandRef.current = initialCommandRef.current?.trim() || null;
    updateStatus("connecting");

    ws.onopen = () => {
      connectLockRef.current = false;
      if (!mountedRef.current) { ws.close(); return; }
      updateStatus("connected");
      term.clear();
      term.focus();

      // Send initial size
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));

      // Forward terminal input → server
      inputDisposableRef.current = term.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      // Handle resize
      const ro = new ResizeObserver(() => {
        try {
          fitAddon.fit();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          }
        } catch {}
      });
      if (containerRef.current) ro.observe(containerRef.current);
      resizeObserverRef.current = ro;
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
        } else if (msg.type === "exit") {
          term.writeln(`\r\n\x1b[33m[Process exited with code ${msg.code}]\x1b[0m`);
          updateStatus("disconnected");
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
      // Clean up input/resize handlers
      inputDisposableRef.current?.dispose();
      inputDisposableRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;

      if (!mountedRef.current) return;
      if (statusRef.current !== "error") {
        updateStatus("disconnected");
        if (ev.code !== 1000) {
          term.writeln(`\r\n\x1b[33m[${trRef.current("terminal.retrying", "Disconnected — will retry in 3s…")}]\x1b[0m`);
          reconnectTimerRef.current = setTimeout(() => {
            if (mountedRef.current) connect();
          }, 3000);
        }
      }
    };
  }, [wsUrl, updateStatus]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      inputDisposableRef.current?.dispose();
      resizeObserverRef.current?.disconnect();
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close(1000, "component unmounted");
      }
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus terminal on any interaction with the container
  const handleContainerClick = useCallback(() => {
    termRef.current?.focus();
  }, []);

  // The tab that just came on screen takes the keyboard. Its container was
  // display:none a moment ago, so the fit is redone too — the ResizeObserver
  // sees the size change as well, but a focus into a stale-sized terminal
  // would put the cursor in the wrong place for a frame.
  useEffect(() => {
    if (!active) return;
    try { fitAddonRef.current?.fit(); } catch {}
    termRef.current?.focus();
  }, [active]);

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

  // ── Right-click menu ──────────────────────────────────────────────────
  //
  // The browser's own menu has nothing useful for a terminal — no Copy over
  // plain HTTP, no Paste that reaches the shell — so it is replaced with the
  // four things a terminal is actually asked for.
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const term = termRef.current;
    const x = Math.min(e.clientX, Math.max(0, window.innerWidth - MENU_W));
    const y = Math.min(e.clientY, Math.max(0, window.innerHeight - MENU_H));
    setMenu({ x, y, hasSelection: Boolean(term?.getSelection()) });
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
    if (sel) copyText(sel);
    closeMenu();
    termRef.current?.focus();
  }, [closeMenu]);
  const menuPaste = useCallback(() => {
    closeMenu();
    const term = termRef.current;
    if (!term || !navigator.clipboard?.readText) return;
    navigator.clipboard.readText().then((text) => {
      // Through xterm's own paste so bracketed-paste mode is honoured: a
      // multi-line paste into a shell that asked for it arrives as one
      // paste, not as lines run one by one.
      if (text) term.paste(text);
      term.focus();
    }).catch(() => { term.focus(); });
  }, [closeMenu]);
  const menuSelectAll = useCallback(() => {
    termRef.current?.selectAll();
    closeMenu();
  }, [closeMenu]);
  const menuClear = useCallback(() => {
    termRef.current?.clear();
    closeMenu();
    termRef.current?.focus();
  }, [closeMenu]);

  // Fallback keyboard handler — copy/paste is handled at the xterm level
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // The right-click menu is rendered INSIDE the div this handler sits on, so
    // every key pressed in the menu bubbles here — and the test below ("the
    // textarea is not focused") is true precisely because focus is on a menu
    // item. The menu was therefore losing the keyboard to xterm on its first
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

  const statusDot = {
    connecting: "bg-yellow-400 animate-pulse",
    connected: "bg-green-400",
    disconnected: "bg-gray-500",
    error: "bg-red-400",
  }[status];

  const statusLabel = {
    connecting: tr("terminal.connecting", "Connecting…"),
    connected: tr("terminal.connected", "Connected"),
    disconnected: tr("terminal.disconnected", "Disconnected"),
    error: tr("terminal.error", "Error"),
  }[status];

  const handleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close(1000);
    }
    connect();
  }, [connect]);

  return (
    <div
      className="flex flex-col h-full"
      style={{ background: "var(--win-ground)" }}
      onKeyDown={handleKeyDown}
    >
      {/* Status bar — only shown when disconnected/error */}
      {status !== "connected" && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 border-b shrink-0"
          style={{
            background: "rgba(255,255,255,0.04)",
            borderColor: "rgba(255,255,255,0.06)",
          }}
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot}`} />
          <span className="text-xs font-mono" style={{ color: "#9ca3af" }}>
            {statusLabel}
          </span>
          <span className="text-xs font-mono ml-1" style={{ color: "#6b7280" }}>
            — {wsUrl}
          </span>
          <div className="flex-1" />
          <button
            onClick={handleReconnect}
            className="text-xs px-2 py-0.5 rounded transition-colors font-mono"
            style={{
              background: "rgba(34,197,94,0.15)",
              color: "var(--coral-bright)",
              border: "1px solid rgba(34,197,94,0.3)",
            }}
          >
            {tr("terminal.reconnect", "Reconnect")}
          </button>
        </div>
      )}

      {/* Terminal container */}
      <div
        ref={containerRef}
        tabIndex={0}
        className="flex-1 overflow-hidden outline-none"
        style={{
          padding: "6px 4px",
          background: "var(--win-ground)",
        }}
        onClick={handleContainerClick}
        onFocus={handleContainerClick}
        onContextMenu={handleContextMenu}
      />

      {menu && (
        <div
          ref={menuRef}
          role="menu"
          data-terminal-menu
          data-testid="terminal-context-menu"
          className="fixed z-[99999] min-w-[200px] py-1 bg-[#1c1c30] rounded-lg shadow-2xl border border-white/10 text-sm text-white/90"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={onMenuKeyDown}
        >
          <button type="button" role="menuitem" data-testid="terminal-menu-copy" disabled={!menu.hasSelection} onClick={menuCopy} className={MENU_ITEM}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">content_copy</span>
            {t("terminal.copy")}
            <span className="ml-auto text-[11px] text-white/40 font-mono">Ctrl+Shift+C</span>
          </button>
          <button type="button" role="menuitem" data-testid="terminal-menu-paste" disabled={!canReadClipboard} onClick={menuPaste} className={MENU_ITEM} title={canReadClipboard ? undefined : t("terminal.pasteHint")}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">content_paste</span>
            {t("terminal.paste")}
            <span className="ml-auto text-[11px] text-white/40 font-mono">Ctrl+Shift+V</span>
          </button>
          <div role="separator" className="my-1 border-t border-white/10" />
          <button type="button" role="menuitem" data-testid="terminal-menu-select-all" onClick={menuSelectAll} className={MENU_ITEM}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">select_all</span>
            {t("terminal.selectAll")}
          </button>
          <button type="button" role="menuitem" data-testid="terminal-menu-clear" onClick={menuClear} className={MENU_ITEM}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">cleaning_services</span>
            {t("terminal.clear")}
          </button>
        </div>
      )}
    </div>
  );
}

const MENU_ITEM = "w-full px-3 py-1.5 text-left hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent flex items-center gap-2 bg-transparent border-none cursor-pointer disabled:cursor-default text-inherit";

/** next/dynamic renders this inside the page's provider, so it can be translated. */
function TerminalLoading() {
  const tr = useTr();
  return (
    <div
      className="h-full flex flex-col items-center justify-center gap-3"
      style={{ background: "var(--win-ground)" }}
    >
      <div
        className="w-8 h-8 rounded-full border-2 border-t-transparent motion-safe:animate-spin"
        style={{ borderColor: "var(--coral-bright)", borderTopColor: "transparent" }}
      />
      <span className="text-sm font-mono" style={{ color: "#4b5563" }}>
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
