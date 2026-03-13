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

  // Focus terminal on container click
  const handleContainerClick = useCallback(() => {
    termRef.current?.focus();
  }, []);

  // Keyboard shortcut: Ctrl+Shift+C to copy, Ctrl+Shift+V to paste
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === "C") {
      e.preventDefault();
      const sel = termRef.current?.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
    }
    if (e.ctrlKey && e.shiftKey && e.key === "V") {
      e.preventDefault();
      navigator.clipboard.readText().then((text) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "input", data: text }));
        }
      }).catch(() => {});
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
      {/* Status bar */}
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
        {status !== "connected" && (
          <span className="text-xs font-mono ml-1" style={{ color: "#6b7280" }}>
            — {wsUrl}
          </span>
        )}
        <div className="flex-1" />
        {(status === "disconnected" || status === "error") && (
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
        )}
        <span className="text-xs font-mono" style={{ color: "#4b5563" }}>
          Ctrl+Shift+C/V to copy/paste
        </span>
      </div>

      {/* Terminal container */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden"
        style={{
          padding: "6px 4px",
          background: "#0d0d1a",
        }}
        onClick={handleContainerClick}
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
