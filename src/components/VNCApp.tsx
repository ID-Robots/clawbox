"use client";

/**
 * VNCApp — Remote desktop viewer using noVNC.
 * Connects to a VNC server via a WebSocket proxy running on port 6080.
 * If no VNC server is detected, shows setup instructions.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export default function VNCApp() {
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<InstanceType<typeof import("@novnc/novnc/lib/rfb").default> | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [vncInfo, setVncInfo] = useState<{ host: string; wsPort: number; vncPort: number } | null>(null);
  const [clipboardText, setClipboardText] = useState("");
  const [showClipboard, setShowClipboard] = useState(false);
  const [scale, setScale] = useState(true);

  const checkVnc = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/vnc");
      const data = await res.json();
      if (data.available) {
        setVncInfo({
          host: window.location.hostname,
          wsPort: data.wsPort || 6080,
          vncPort: data.vncPort || 5900,
        });
      } else {
        setStatus("error");
        setError(data.error || "No VNC server detected");
      }
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "VNC check failed");
    }
  }, []);

  // Check VNC availability on mount
  useEffect(() => {
    checkVnc();
  }, [checkVnc]);

  // Connect to VNC when info available
  useEffect(() => {
    if (!vncInfo || !canvasContainerRef.current) return;

    let rfb: InstanceType<typeof import("@novnc/novnc/lib/rfb").default> | null = null;

    const connect = async () => {
      try {
        const { default: RFB } = await import("@novnc/novnc/lib/rfb");

        const wsUrl = `ws://${vncInfo.host}:${vncInfo.wsPort}`;

        rfb = new RFB(canvasContainerRef.current!, wsUrl, {
          credentials: { password: "" },
        });

        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.clipViewport = false;
        rfb.showDotCursor = true;
        rfb.focusOnClick = true;

        rfb.addEventListener("connect", () => {
          setStatus("connected");
          setError(null);
          // Focus the VNC canvas so keyboard events pass through
          rfb.focus();
          // Ensure the internal canvas element is focusable
          const canvas = canvasContainerRef.current?.querySelector("canvas");
          if (canvas) {
            canvas.tabIndex = 0;
            canvas.focus();
          }
        });

        rfb.addEventListener("disconnect", (e: CustomEvent) => {
          setStatus("disconnected");
          if (e.detail?.clean === false) {
            setError("Connection lost unexpectedly");
          }
        });

        rfb.addEventListener("clipboard", (e: CustomEvent) => {
          if (e.detail?.text) setClipboardText(e.detail.text);
        });

        rfbRef.current = rfb;
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to load noVNC");
      }
    };

    connect();

    return () => {
      if (rfb) {
        rfb.disconnect();
        rfbRef.current = null;
      }
    };
  }, [vncInfo]);

  // Update scale without reconnecting
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.scaleViewport = scale;
  }, [scale]);

  // Track whether the VNC window is the "active" window so we know when to
  // forward keyboard events. We set this on mousedown inside the VNC container.
  const vncActiveRef = useRef(false);

  useEffect(() => {
    if (status !== "connected") return;
    const container = canvasContainerRef.current;
    if (!container) return;

    // Mark VNC as active when clicking inside the container
    const activate = () => { vncActiveRef.current = true; };
    // Deactivate when clicking outside
    const deactivate = (e: MouseEvent) => {
      if (!container.contains(e.target as Node)) {
        vncActiveRef.current = false;
      }
    };

    container.addEventListener("mousedown", activate, true);
    document.addEventListener("mousedown", deactivate);

    // Initially active since we just connected
    vncActiveRef.current = true;

    return () => {
      container.removeEventListener("mousedown", activate, true);
      document.removeEventListener("mousedown", deactivate);
    };
  }, [status]);

  // Intercept keyboard events at the document level and send them to the VNC
  // server using RFB.sendKey(). This bypasses all focus issues — we simply
  // translate browser key events to X11 keysyms and send them directly.
  useEffect(() => {
    if (status !== "connected") return;

    // Map browser event.key → X11 keysym
    // Printable characters use their Unicode codepoint directly.
    // Special keys are mapped explicitly.
    const specialKeys: Record<string, number> = {
      Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b,
      Delete: 0xffff, Home: 0xff50, End: 0xff57,
      PageUp: 0xff55, PageDown: 0xff56,
      ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
      Insert: 0xff63, F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1,
      F5: 0xffc2, F6: 0xffc3, F7: 0xffc4, F8: 0xffc5,
      F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
      Shift: 0xffe1, Control: 0xffe3, Alt: 0xffe9, Meta: 0xffe7,
      CapsLock: 0xffe5, NumLock: 0xff7f, ScrollLock: 0xff14,
      " ": 0x0020,
    };

    const toKeysym = (e: KeyboardEvent): number | null => {
      if (e.key in specialKeys) return specialKeys[e.key];
      // Single printable character → Unicode codepoint
      if (e.key.length === 1) return e.key.charCodeAt(0);
      return null;
    };

    const handler = (e: KeyboardEvent) => {
      if (!vncActiveRef.current || !rfbRef.current) return;
      // Don't steal from real HTML input fields
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const keysym = toKeysym(e);
      if (keysym === null) return;

      rfbRef.current.sendKey(keysym, e.code, e.type === "keydown");
      e.preventDefault();
      e.stopPropagation();
    };

    document.addEventListener("keydown", handler, true);
    document.addEventListener("keyup", handler, true);
    return () => {
      document.removeEventListener("keydown", handler, true);
      document.removeEventListener("keyup", handler, true);
    };
  }, [status]);

  const handleReconnect = useCallback(() => {
    setStatus("connecting");
    setError(null);
    setVncInfo(null);
    checkVnc();
  }, [checkVnc]);

  const sendClipboard = useCallback(() => {
    if (rfbRef.current && clipboardText) {
      rfbRef.current.clipboardPasteFrom(clipboardText);
    }
  }, [clipboardText]);

  const sendCtrlAltDel = useCallback(() => {
    rfbRef.current?.sendCtrlAltDel();
  }, []);

  if (status === "error" && !vncInfo) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#1a1a2e] text-white/70 gap-4 p-8">
        <span className="material-symbols-rounded text-amber-400" style={{ fontSize: 48 }}>desktop_windows</span>
        <p className="text-sm text-center max-w-md">{error}</p>
        <div className="bg-white/5 rounded-lg p-4 text-xs text-white/50 max-w-lg w-full space-y-2">
          <p className="text-white/70 font-medium">To enable Remote Desktop:</p>
          <p>1. Install a VNC server:</p>
          <code className="block bg-black/30 px-2 py-1 rounded">sudo apt install tigervnc-standalone-server</code>
          <p>2. Start a VNC session:</p>
          <code className="block bg-black/30 px-2 py-1 rounded">vncserver :0 -localhost no -geometry 1280x720</code>
          <p>3. Install websockify (VNC → WebSocket proxy):</p>
          <code className="block bg-black/30 px-2 py-1 rounded">sudo apt install websockify</code>
          <p>4. Start the WebSocket proxy:</p>
          <code className="block bg-black/30 px-2 py-1 rounded">websockify 6080 localhost:5900</code>
        </div>
        <button
          onClick={handleReconnect}
          className="mt-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm text-white transition-colors"
        >
          Retry Connection
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#1a1a2e]">
      {/* Toolbar — onMouseDown preventDefault keeps focus on VNC canvas */}
      <div className="flex items-center gap-2 px-2 py-1.5 bg-[#252547] border-b border-white/10" onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault(); }}>
        {/* Status indicator */}
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${
            status === "connected" ? "bg-green-400" :
            status === "connecting" ? "bg-yellow-400 animate-pulse" :
            "bg-red-400"
          }`} />
          <span className="text-xs text-white/60 capitalize">{status}</span>
        </div>

        <div className="w-px h-4 bg-white/10" />

        {/* Scale toggle */}
        <button
          onClick={() => setScale(!scale)}
          className={`p-1 rounded text-xs ${scale ? "bg-white/10 text-white/80" : "text-white/40 hover:text-white/60"}`}
          title={scale ? "Fit to window" : "Native resolution"}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>
            {scale ? "fit_screen" : "fullscreen"}
          </span>
        </button>

        {/* Clipboard */}
        <button
          onClick={() => setShowClipboard(!showClipboard)}
          className="p-1 rounded hover:bg-white/10 text-white/50"
          title="Clipboard"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>content_paste</span>
        </button>

        {/* Ctrl+Alt+Del */}
        <button
          onClick={sendCtrlAltDel}
          className="p-1 rounded hover:bg-white/10 text-white/50 text-xs"
          title="Send Ctrl+Alt+Del"
        >
          Ctrl+Alt+Del
        </button>

        <div className="flex-1" />

        {/* Reconnect */}
        {status !== "connected" && (
          <button
            onClick={handleReconnect}
            className="px-2 py-0.5 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white"
          >
            Reconnect
          </button>
        )}
      </div>

      {/* Clipboard panel */}
      {showClipboard && (
        <div className="flex items-center gap-2 px-2 py-1.5 bg-[#1e1e3a] border-b border-white/10">
          <input
            type="text"
            value={clipboardText}
            onChange={(e) => setClipboardText(e.target.value)}
            placeholder="Paste text to send to remote..."
            className="flex-1 px-2 py-1 text-sm bg-black/30 text-white/80 rounded border border-white/10 focus:border-blue-500 focus:outline-none"
          />
          <button
            onClick={sendClipboard}
            className="px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white"
          >
            Send
          </button>
        </div>
      )}

      {/* VNC canvas */}
      <div
        ref={canvasContainerRef}
        className="flex-1 overflow-hidden bg-black"
        style={{ position: "relative" }}
        tabIndex={0}
        onMouseDown={(e) => {
          // Prevent the Window wrapper from stealing focus away from the canvas
          e.stopPropagation();
          // Let noVNC's own focusOnClick handle focusing the canvas
          // If that doesn't work, force it after a microtask
          requestAnimationFrame(() => {
            rfbRef.current?.focus();
          });
        }}
      >
        {status === "connecting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white/50 gap-3">
            <span className="material-symbols-rounded animate-spin" style={{ fontSize: 48 }}>progress_activity</span>
            <p className="text-sm">Connecting to remote desktop...</p>
          </div>
        )}
      </div>
    </div>
  );
}
