"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useT } from "@/lib/i18n";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
type TrackedKey = {
  code: string | null;
  keysym: number;
};

const SPECIAL_KEYSYMS: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Insert: 0xff63,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
  ShiftLeft: 0xffe1,
  ShiftRight: 0xffe2,
  ControlLeft: 0xffe3,
  ControlRight: 0xffe4,
  AltLeft: 0xffe9,
  AltRight: 0xffea,
  MetaLeft: 0xffe7,
  MetaRight: 0xffe8,
  CapsLock: 0xffe5,
  NumLock: 0xff7f,
  ScrollLock: 0xff14,
  " ": 0x0020,
};

const MODIFIER_KEYSYMS: Record<string, number> = {
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffe7,
};

function isEditableTarget(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function getTrackedKey(event: KeyboardEvent): TrackedKey | null {
  const code = event.code || null;
  let keysym: number | null = null;

  if (code && code in SPECIAL_KEYSYMS) {
    keysym = SPECIAL_KEYSYMS[code];
  } else if (event.key in MODIFIER_KEYSYMS) {
    keysym = MODIFIER_KEYSYMS[event.key];
  } else if (event.key in SPECIAL_KEYSYMS) {
    keysym = SPECIAL_KEYSYMS[event.key];
  } else if (event.key.length === 1) {
    keysym = event.key.charCodeAt(0);
  }

  if (keysym === null) return null;
  return { code, keysym };
}

export default function VNCApp() {
  const { t } = useT();
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<InstanceType<typeof import("@novnc/novnc/lib/rfb").default> | null>(null);
  const vncFocusedRef = useRef(false);
  const pressedKeysRef = useRef<Map<string, TrackedKey>>(new Map());
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

  useEffect(() => {
    checkVnc();
  }, [checkVnc]);

  const getInputCanvas = useCallback(() => (
    canvasContainerRef.current?.querySelector("canvas") ?? null
  ), []);

  const focusVncSurface = useCallback(() => {
    const canvas = getInputCanvas();
    if (!canvas) return;

    canvas.tabIndex = 0;
    rfbRef.current?.focus();
    canvas.focus({ preventScroll: true });
  }, [getInputCanvas]);

  const releaseTrackedKeys = useCallback(() => {
    const pressedKeys = [...pressedKeysRef.current.values()];
    pressedKeysRef.current.clear();
    for (const key of pressedKeys) {
      rfbRef.current?.sendKey(key.keysym, key.code, false);
    }
  }, []);

  const activateVncInput = useCallback(() => {
    vncFocusedRef.current = true;
    focusVncSurface();
  }, [focusVncSurface]);

  const deactivateVncInput = useCallback(() => {
    if (!vncFocusedRef.current) return;
    vncFocusedRef.current = false;
    releaseTrackedKeys();
    rfbRef.current?.blur();
  }, [releaseTrackedKeys]);

  useEffect(() => {
    if (!vncInfo || !canvasContainerRef.current) return;

    let rfb: InstanceType<typeof import("@novnc/novnc/lib/rfb").default> | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let handleContextMenu: ((event: Event) => void) | null = null;

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
          focusVncSurface();

          canvas = getInputCanvas();
          handleContextMenu = (event: Event) => event.preventDefault();
          canvas?.addEventListener("contextmenu", handleContextMenu);
        });

        rfb.addEventListener("disconnect", (e: CustomEvent) => {
          setStatus("disconnected");
          deactivateVncInput();
          if (e.detail?.clean === false) setError("Connection lost unexpectedly");
        });

        rfbRef.current = rfb;
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to load noVNC");
      }
    };

    connect();

    return () => {
      if (canvas && handleContextMenu) {
        canvas.removeEventListener("contextmenu", handleContextMenu);
      }
      deactivateVncInput();
      if (rfb) {
        rfb.disconnect();
        rfbRef.current = null;
      }
    };
  }, [deactivateVncInput, focusVncSurface, getInputCanvas, vncInfo]);

  useEffect(() => {
    if (status !== "connected") return;
    const container = canvasContainerRef.current;
    if (!container) return;

    const chromeWindow = container.closest('[class*="chrome-window"]') || container.parentElement?.parentElement;
    const interactionHost = container.closest("[data-chrome-window-content]") ?? container.parentElement;

    const onFocusIn = () => {
      activateVncInput();
    };

    const onFocusOut = (e: PointerEvent | MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (chromeWindow?.contains(target)) return;
      if (container.contains(target)) return;
      deactivateVncInput();
    };

    container.addEventListener("mousedown", onFocusIn, true);
    container.addEventListener("pointerdown", onFocusIn, true);
    container.addEventListener("mouseenter", onFocusIn);
    container.addEventListener("focusin", onFocusIn);
    document.addEventListener("mousedown", onFocusOut, true);
    document.addEventListener("pointerdown", onFocusOut, true);
    window.addEventListener("blur", deactivateVncInput);

    // ChromeWindow disables pointer events on its content host during drag/resize.
    // Re-focus the VNC canvas as soon as the content host becomes interactive again.
    const observer = interactionHost ? new MutationObserver(() => {
      if (interactionHost instanceof HTMLElement && interactionHost.style.pointerEvents !== "none" && vncFocusedRef.current) {
        focusVncSurface();
      }
    }) : null;
    if (observer && interactionHost) {
      observer.observe(interactionHost, { attributes: true, attributeFilter: ["style"] });
    }

    activateVncInput();

    return () => {
      container.removeEventListener("mousedown", onFocusIn, true);
      container.removeEventListener("pointerdown", onFocusIn, true);
      container.removeEventListener("mouseenter", onFocusIn);
      container.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("mousedown", onFocusOut, true);
      document.removeEventListener("pointerdown", onFocusOut, true);
      window.removeEventListener("blur", deactivateVncInput);
      observer?.disconnect();
      deactivateVncInput();
    };
  }, [activateVncInput, deactivateVncInput, focusVncSurface, status]);

  // Keep noVNC's own keyboard handler as the single source of truth by routing
  // active desktop keystrokes straight to the RFB connection when focus drifts
  // outside the noVNC canvas.
  useEffect(() => {
    if (status !== "connected") return;

    const handler = (e: KeyboardEvent) => {
      if (!vncFocusedRef.current || !rfbRef.current) return;
      if (isEditableTarget(e.target)) return;

      const inputCanvas = getInputCanvas();
      if (!inputCanvas) return;
      if (e.target === inputCanvas) return;

      const trackedKey = getTrackedKey(e);
      if (!trackedKey) return;

      const keyId = e.code || e.key;
      if (e.type === "keydown") {
        if (!e.repeat) pressedKeysRef.current.set(keyId, trackedKey);
      } else {
        pressedKeysRef.current.delete(keyId);
      }

      e.preventDefault();
      e.stopPropagation();
      rfbRef.current.sendKey(trackedKey.keysym, trackedKey.code, e.type === "keydown");
    };

    window.addEventListener("keydown", handler, true);
    window.addEventListener("keyup", handler, true);
    return () => {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("keyup", handler, true);
    };
  }, [getInputCanvas, status]);

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
      tabIndex={0}
      className="h-full overflow-hidden bg-black relative"
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
