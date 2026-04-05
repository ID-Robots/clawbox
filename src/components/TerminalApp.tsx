"use client";

/**
 * TerminalApp — xterm.js terminal emulator connected to a WebSocket PTY backend.
 * Auto-started via instrumentation.ts (no manual server needed).
 */

import React, {
  useEffect,
  useRef,
  useCallback,
  useState,
} from "react";
import dynamic from "next/dynamic";
import "@xterm/xterm/css/xterm.css";

function TerminalInner() {
  const containerRef = useRef<HTMLDivElement>(null);
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

  const wsPort = typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_TERMINAL_WS_PORT || "3006")
    : "3006";

  const wsUrl = `ws://${typeof window !== "undefined" ? window.location.hostname : "localhost"}:${wsPort}`;

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

    // Create terminal instance once
    if (!termRef.current) {
      const term = new Terminal({
        theme: {
          background: "#0d0d1a",
          foreground: "#e0e0e0",
          cursor: "#22c55e",
          cursorAccent: "#0d0d1a",
          selectionBackground: "rgba(34, 197, 94, 0.3)",
          black: "#1a1a2e",
          red: "#f87171",
          green: "#4ade80",
          yellow: "#fbbf24",
          blue: "#60a5fa",
          magenta: "#c084fc",
          cyan: "#22d3ee",
          white: "#e0e0e0",
          brightBlack: "#374151",
          brightRed: "#ff6b6b",
          brightGreen: "#22c55e",
          brightYellow: "#fcd34d",
          brightBlue: "#93c5fd",
          brightMagenta: "#d8b4fe",
          brightCyan: "#67e8f9",
          brightWhite: "#f9fafb",
        },
        fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", "Consolas", "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.4,
        cursorBlink: true,
        cursorStyle: "block",
        scrollback: 5000,
        allowTransparency: true,
        macOptionIsMeta: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());

      // Clipboard helper: works over plain HTTP (navigator.clipboard needs HTTPS)
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

      // Clipboard key handler at xterm level.
      // - Ctrl+Shift+C: copy selection
      // - Ctrl+Shift+V and Ctrl+V: let the event pass through to the browser
      //   so it fires a native "paste" event on xterm's hidden textarea (the
      //   only way to read the clipboard over plain HTTP).
      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        if (ev.ctrlKey && ev.shiftKey && ev.key === "C" && ev.type === "keydown") {
          const sel = term.getSelection();
          if (sel) copyText(sel);
          return false;
        }
        // Let Ctrl+Shift+V AND Ctrl+V bubble to the browser natively
        if (ev.ctrlKey && (ev.key === "v" || ev.key === "V") && ev.type === "keydown") {
          return false;
        }
        return true;
      });

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      term.open(containerRef.current!);
      fitAddon.fit();
    }

    const term = termRef.current!;
    const fitAddon = fitAddonRef.current!;

    term.writeln("\x1b[2m\x1b[36mConnecting to terminal server…\x1b[0m");

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
          term.writeln(`\r\n\x1b[33m[Disconnected — will retry in 3s…]\x1b[0m`);
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

  // Re-focus terminal when the window becomes visible/active
  useEffect(() => {
    const refocus = () => {
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
  }, []);

  // Fallback keyboard handler — copy/paste is handled at the xterm level
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
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
    connecting: "Connecting…",
    connected: "Connected",
    disconnected: "Disconnected",
    error: "Error",
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
      style={{ background: "#0d0d1a" }}
      onKeyDown={handleKeyDown}
    >
      {/* Status bar — only shown when disconnected/error */}
      {status !== "connected" && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 border-b shrink-0"
          style={{
            background: "#12122a",
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
              color: "#22c55e",
              border: "1px solid rgba(34,197,94,0.3)",
            }}
          >
            Reconnect
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
          background: "#0d0d1a",
        }}
        onClick={handleContainerClick}
        onFocus={handleContainerClick}
      />
    </div>
  );
}

const TerminalApp = dynamic(
  () => Promise.resolve(TerminalInner),
  {
    ssr: false,
    loading: () => (
      <div
        className="h-full flex flex-col items-center justify-center gap-3"
        style={{ background: "#0d0d1a" }}
      >
        <div
          className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin"
          style={{ borderColor: "#22c55e", borderTopColor: "transparent" }}
        />
        <span className="text-sm font-mono" style={{ color: "#4b5563" }}>
          Loading terminal…
        </span>
      </div>
    ),
  }
);

export default TerminalApp;
