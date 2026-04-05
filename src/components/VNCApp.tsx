"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { useT } from "@/lib/i18n";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export default function VNCApp() {
  const { t } = useT();
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<InstanceType<typeof import("@novnc/novnc/lib/rfb").default> | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [vncInfo, setVncInfo] = useState<{ host: string; wsPort: number } | null>(null);

  const checkVnc = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/vnc");
      const data = await res.json();
      if (data.available) {
        setVncInfo({ host: window.location.hostname, wsPort: data.wsPort || 6080 });
      } else {
        setStatus("error");
        setError(data.error || "No VNC server detected");
      }
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "VNC check failed");
    }
  }, []);

  useEffect(() => { checkVnc(); }, [checkVnc]);

  useEffect(() => {
    if (!vncInfo || !canvasContainerRef.current) return;

    let rfb: InstanceType<typeof import("@novnc/novnc/lib/rfb").default> | null = null;

    const connect = async () => {
      try {
        const { default: RFB } = await import("@novnc/novnc/lib/rfb");
        rfb = new RFB(canvasContainerRef.current!, `ws://${vncInfo.host}:${vncInfo.wsPort}`, {
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
          rfb?.focus();
          const canvas = canvasContainerRef.current?.querySelector("canvas");
          if (canvas) { canvas.tabIndex = 0; canvas.focus(); }
          canvasContainerRef.current?.addEventListener("contextmenu", (e) => e.preventDefault());
        });

        rfb.addEventListener("disconnect", (e: CustomEvent) => {
          setStatus("disconnected");
          if (e.detail?.clean === false) setError("Connection lost unexpectedly");
        });

        rfbRef.current = rfb;
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to load noVNC");
      }
    };

    connect();
    return () => { if (rfb) { rfb.disconnect(); rfbRef.current = null; } };
  }, [vncInfo]);

  // Track VNC focus for keyboard forwarding
  const vncActiveRef = useRef(false);
  useEffect(() => {
    if (status !== "connected") return;
    const container = canvasContainerRef.current;
    if (!container) return;
    const activate = () => { vncActiveRef.current = true; };
    const deactivate = (e: MouseEvent) => {
      if (!container.contains(e.target as Node)) vncActiveRef.current = false;
    };
    container.addEventListener("mousedown", activate, true);
    document.addEventListener("mousedown", deactivate);
    vncActiveRef.current = true;
    return () => {
      container.removeEventListener("mousedown", activate, true);
      document.removeEventListener("mousedown", deactivate);
    };
  }, [status]);

  // Forward keyboard events to VNC via X11 keysyms
  useEffect(() => {
    if (status !== "connected") return;
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
      if (e.key.length === 1) return e.key.charCodeAt(0);
      return null;
    };
    const handler = (e: KeyboardEvent) => {
      if (!vncActiveRef.current || !rfbRef.current) return;
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

  if (status === "error" && !vncInfo) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-black text-white/70 gap-4 p-8">
        <span className="material-symbols-rounded text-red-400" style={{ fontSize: 48 }}>error</span>
        <p className="text-sm text-center max-w-md">{error}</p>
        <button
          onClick={handleReconnect}
          className="mt-2 px-4 py-2 btn-gradient rounded-lg text-sm text-white transition-colors cursor-pointer"
        >
          {t("vnc.retryConnection")}
        </button>
      </div>
    );
  }

  return (
    <div
      ref={canvasContainerRef}
      className="h-full overflow-hidden bg-black relative"
      tabIndex={0}
      onMouseDown={(e) => {
        e.stopPropagation();
        requestAnimationFrame(() => { rfbRef.current?.focus(); });
      }}
    >
      {(status === "connecting" || status === "disconnected") && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-white/50 gap-3 z-10">
          {status === "connecting" ? (
            <>
              <span className="material-symbols-rounded animate-spin" style={{ fontSize: 48 }}>progress_activity</span>
              <p className="text-sm">{t("vnc.connectingDesktop")}</p>
            </>
          ) : (
            <>
              <span className="material-symbols-rounded text-red-400" style={{ fontSize: 48 }}>link_off</span>
              <p className="text-sm">{error || t("vnc.disconnected")}</p>
              <button
                onClick={handleReconnect}
                className="mt-2 px-4 py-2 btn-gradient rounded-lg text-sm text-white cursor-pointer"
              >
                {t("vnc.reconnect")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
