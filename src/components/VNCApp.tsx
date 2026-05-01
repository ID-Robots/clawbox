"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useT } from "@/lib/i18n";
import { getTrackedVncKey, type TrackedKey } from "@/lib/vnc-keys";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

const REMOTE_MODIFIER_RELEASES: TrackedKey[] = [
  { code: "ControlLeft", keysym: 0xffe3 },
  { code: "ControlRight", keysym: 0xffe4 },
  { code: "AltLeft", keysym: 0xffe9 },
  { code: "AltRight", keysym: 0xffea },
  { code: "MetaLeft", keysym: 0xffe7 },
  { code: "MetaRight", keysym: 0xffe8 },
  { code: "ShiftLeft", keysym: 0xffe1 },
  { code: "ShiftRight", keysym: 0xffe2 },
];
const REMOTE_MODIFIER_CODES = new Set(REMOTE_MODIFIER_RELEASES.map((key) => key.code));

function isEditableTarget(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
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
  // Install/repair flow: when the VNC API is unreachable or reports VNC as
  // missing, the user can trigger `install.sh --step vnc_install` through
  // /setup-api/vnc/repair. On success we reboot to make sure the freshly
  // installed clawbox-vnc / websockify services come up cleanly.
  const [repairState, setRepairState] = useState<"idle" | "repairing" | "rebooting" | "failed">("idle");
  const [repairError, setRepairError] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const pasteTextareaRef = useRef<HTMLTextAreaElement>(null);
  // Mirrors pasteOpen so the focus/keyboard handlers (which live in effect
  // closures and can't see React state updates directly) can short-circuit
  // when the paste modal is open.
  const pasteOpenRef = useRef(false);

  const checkVnc = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/vnc");
      const data = await res.json();
      if (data.available) {
        // Keep host/wsPort in the state shape for backwards compatibility but
        // the WebSocket URL is actually built below against same-origin.
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

  const releaseRemoteModifiers = useCallback(() => {
    for (const key of REMOTE_MODIFIER_RELEASES) {
      rfbRef.current?.sendKey(key.keysym, key.code, false);
    }
  }, []);

  const activateVncInput = useCallback(() => {
    if (!vncFocusedRef.current) {
      releaseRemoteModifiers();
    }
    vncFocusedRef.current = true;
    focusVncSurface();
  }, [focusVncSurface, releaseRemoteModifiers]);

  const deactivateVncInput = useCallback(() => {
    if (!vncFocusedRef.current) return;
    vncFocusedRef.current = false;
    releaseTrackedKeys();
    releaseRemoteModifiers();
    rfbRef.current?.blur();
  }, [releaseRemoteModifiers, releaseTrackedKeys]);

  useEffect(() => {
    if (!vncInfo || !canvasContainerRef.current) return;

    let rfb: InstanceType<typeof import("@novnc/novnc/lib/rfb").default> | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let handleContextMenu: ((event: Event) => void) | null = null;

    const connect = async () => {
      try {
        const { default: RFB } = await import("@novnc/novnc/lib/rfb");
        // Same-origin WebSocket path: the production server proxies
        // /novnc-ws upgrades to 127.0.0.1:${vncInfo.wsPort} (websockify).
        // This keeps the flow working on the LAN, under HTTPS (no mixed
        // content), and through the Cloudflare tunnel (only port 80/443
        // exposed there).
        const wsProto = window.location.protocol === "https:" ? "wss" : "ws";
        const wsUrl = `${wsProto}://${window.location.host}/novnc-ws`;
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

        // Remote → local: when the guest copies, push the text into the
        // host browser's clipboard so the user can paste it elsewhere.
        rfb.addEventListener("clipboard", (e: CustomEvent) => {
          const text = e.detail?.text;
          if (typeof text !== "string" || !text) return;
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).catch(() => {
              // Host browser blocked the write (permissions / focus). Non-fatal.
            });
          }
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
      if (pasteOpenRef.current) return;
      activateVncInput();
    };

    const onWheelCapture = (event: WheelEvent) => {
      if (pasteOpenRef.current) return;
      const target = event.target as Node | null;
      if (!target || !container.contains(target)) return;
      activateVncInput();
      event.preventDefault();
    };

    const onFocusOut = (e: PointerEvent | MouseEvent) => {
      if (pasteOpenRef.current) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (chromeWindow?.contains(target)) return;
      if (container.contains(target)) return;
      deactivateVncInput();
    };

    // Local → remote: the `paste` event only fires on editable elements,
    // and the VNC canvas is not editable — so we listen for Ctrl/Cmd+V
    // directly. On each shortcut we read the host clipboard via the async
    // Clipboard API and push it into the guest's X CLIPBOARD selection via
    // RFB (x11vnc turns that message into an X selection). noVNC continues
    // to forward the V keystroke itself, so Chromium / terminals on the
    // guest see "Ctrl+V pressed" and paste from the freshly-updated CLIPBOARD.
    //
    // navigator.clipboard.readText() requires a secure context (HTTPS or
    // localhost). On LAN-served HTTP (http://clawbox.local, http://192.168.x.x)
    // the browser rejects the read and we silently no-op — the user can still
    // paste manually via the guest's context menu.
    const onKeyDown = (event: KeyboardEvent) => {
      if (pasteOpenRef.current) return;
      if (!vncFocusedRef.current) return;
      const isPasteShortcut =
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "v";
      if (!isPasteShortcut) return;
      if (!navigator.clipboard?.readText) return;
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) rfbRef.current?.clipboardPasteFrom(text);
        })
        .catch(() => {
          // Non-secure origin or clipboard permission denied — silently skip.
        });
    };

    container.addEventListener("mousedown", onFocusIn, true);
    container.addEventListener("pointerdown", onFocusIn, true);
    container.addEventListener("mouseenter", onFocusIn);
    container.addEventListener("focusin", onFocusIn);
    container.addEventListener("wheel", onWheelCapture, { capture: true, passive: false });
    container.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onFocusOut, true);
    document.addEventListener("pointerdown", onFocusOut, true);
    window.addEventListener("blur", deactivateVncInput);

    // ChromeWindow disables pointer events on its content host during drag/resize.
    // Re-focus the VNC canvas as soon as the content host becomes interactive again.
    const observer = interactionHost ? new MutationObserver(() => {
      if (pasteOpenRef.current) return;
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
      container.removeEventListener("wheel", onWheelCapture, true);
      container.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onFocusOut, true);
      document.removeEventListener("pointerdown", onFocusOut, true);
      window.removeEventListener("blur", deactivateVncInput);
      observer?.disconnect();
      deactivateVncInput();
    };
  }, [activateVncInput, deactivateVncInput, focusVncSurface, status]);

  // Let noVNC handle keys directly on its canvas. If a keydown bubbles out to
  // the document anyway, focus has drifted or the browser never handed it to
  // noVNC, so we manually forward it. Printable and navigation keys are sent
  // as a full press+release on keydown so missing keyup events can't wedge the
  // remote keyboard state; only true modifiers stay held until keyup/blur.
  useEffect(() => {
    if (status !== "connected") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!vncFocusedRef.current || !rfbRef.current) return;
      if (isEditableTarget(e.target)) return;

      if (!getInputCanvas()) return;
      if (e.defaultPrevented) return;

      const trackedKey = getTrackedVncKey(e);
      if (!trackedKey) return;

      const keyId = trackedKey.code || e.key;
      e.preventDefault();
      e.stopPropagation();

      if (trackedKey.code && REMOTE_MODIFIER_CODES.has(trackedKey.code)) {
        if (!e.repeat) pressedKeysRef.current.set(keyId, trackedKey);
        rfbRef.current.sendKey(trackedKey.keysym, trackedKey.code, true);
        return;
      }

      rfbRef.current.sendKey(trackedKey.keysym, trackedKey.code);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!vncFocusedRef.current || !rfbRef.current) return;
      if (isEditableTarget(e.target)) return;

      const trackedKey = getTrackedVncKey(e);
      if (!trackedKey) return;

      const keyId = trackedKey.code || e.key;
      if (!pressedKeysRef.current.has(keyId)) return;

      pressedKeysRef.current.delete(keyId);
      rfbRef.current.sendKey(trackedKey.keysym, trackedKey.code, false);
      return;
    };

    const handleCanvasKeyUp = (e: KeyboardEvent) => {
      if (!vncFocusedRef.current || !rfbRef.current) return;
      if (isEditableTarget(e.target)) return;

      const inputCanvas = getInputCanvas();
      if (!inputCanvas || e.target !== inputCanvas) return;

      const trackedKey = getTrackedVncKey(e);
      if (!trackedKey) return;
      if (trackedKey.code && REMOTE_MODIFIER_CODES.has(trackedKey.code)) return;

      // Some browsers let noVNC consume keydown on the canvas but lose the
      // matching keyup as focus shifts around the surrounding window chrome.
      // A redundant non-modifier release is harmless and prevents sticky keys.
      rfbRef.current.sendKey(trackedKey.keysym, trackedKey.code, false);
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp, true);
    document.addEventListener("keyup", handleCanvasKeyUp, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp, true);
      document.removeEventListener("keyup", handleCanvasKeyUp, true);
    };
  }, [getInputCanvas, status]);

  const handleReconnect = useCallback(() => {
    setStatus("connecting");
    setError(null);
    setVncInfo(null);
    checkVnc();
  }, [checkVnc]);

  const handleRepairAndReboot = useCallback(async () => {
    setRepairError(null);
    setRepairState("repairing");
    try {
      const res = await fetch("/setup-api/install/run-step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "vnc_install" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setRepairError(data?.error || `vnc_install failed (HTTP ${res.status})`);
        setRepairState("failed");
        return;
      }
      // Repair succeeded — reboot so the freshly-installed services start
      // cleanly. /setup-api/system/power triggers `systemctl reboot` after
      // a 1.5s delay so the response reaches us first. Only flip into the
      // "rebooting" state once the request is accepted; a 4xx/5xx here
      // would otherwise leave the UI stuck on the rebooting spinner.
      try {
        const rebootRes = await fetch("/setup-api/system/power", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "restart" }),
        });
        if (!rebootRes.ok) {
          const body = await rebootRes.json().catch(() => ({}));
          setRepairError(body?.error || `Reboot request failed (HTTP ${rebootRes.status})`);
          setRepairState("failed");
          return;
        }
        setRepairState("rebooting");
      } catch {
        // The reboot itself severs the connection — treat transport errors
        // as a successful reboot trigger and let the user wait it out.
        setRepairState("rebooting");
      }
    } catch (err) {
      setRepairError(err instanceof Error ? err.message : "Repair request failed");
      setRepairState("failed");
    }
  }, []);

  const openPasteModal = useCallback(() => {
    setPasteText("");
    pasteOpenRef.current = true;
    setPasteOpen(true);
    // Stop the VNC-input handlers from grabbing focus back onto the canvas
    // while the textarea needs it for the user's Ctrl+V.
    deactivateVncInput();
    // Defer focus until the textarea mounts.
    requestAnimationFrame(() => pasteTextareaRef.current?.focus());
  }, [deactivateVncInput]);

  const closePasteModal = useCallback(() => {
    pasteOpenRef.current = false;
    setPasteOpen(false);
    setPasteText("");
    focusVncSurface();
  }, [focusVncSurface]);

  const sendPaste = useCallback(() => {
    const text = pasteText;
    if (text.length > 0) {
      rfbRef.current?.clipboardPasteFrom(text);
    }
    pasteOpenRef.current = false;
    setPasteOpen(false);
    setPasteText("");
    focusVncSurface();
  }, [focusVncSurface, pasteText]);

  if (status === "error" && !vncInfo) {
    const repairing = repairState === "repairing";
    const rebooting = repairState === "rebooting";
    const busy = repairing || rebooting;
    return (
      <div className="flex flex-col items-center justify-center h-full bg-black text-white/70 gap-4 p-8">
        <span className="material-symbols-rounded text-red-400" style={{ fontSize: 48 }}>error</span>
        <p className="text-sm text-center max-w-md">{error}</p>
        {repairError && (
          <p
            role="alert"
            aria-atomic="true"
            className="text-xs text-red-400/80 text-center max-w-md whitespace-pre-wrap"
          >
            {repairError}
          </p>
        )}
        {rebooting ? (
          <div className="flex flex-col items-center gap-2 mt-2">
            <span className="material-symbols-rounded animate-spin text-orange-400" style={{ fontSize: 28 }}>progress_activity</span>
            <p className="text-sm text-white/80">Rebooting device — Remote Desktop will be ready in ~30s.</p>
          </div>
        ) : repairing ? (
          <div className="flex flex-col items-center gap-2 mt-2">
            <span className="material-symbols-rounded animate-spin text-orange-400" style={{ fontSize: 28 }}>progress_activity</span>
            <p className="text-sm text-white/80">Installing / repairing Remote Desktop… this may take a few minutes.</p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-center gap-2 mt-2">
            <button
              onClick={handleReconnect}
              disabled={busy}
              className="px-4 py-2 rounded-lg text-sm text-white/90 bg-white/10 hover:bg-white/15 disabled:opacity-50 cursor-pointer"
            >
              {t("vnc.retryConnection")}
            </button>
            <button
              onClick={handleRepairAndReboot}
              disabled={busy}
              className="px-4 py-2 btn-gradient rounded-lg text-sm text-white transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-2"
              title="Runs install.sh --step vnc_install, then reboots"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>build</span>
              Install / Repair &amp; Reboot
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={canvasContainerRef}
      tabIndex={0}
      className="h-full overflow-hidden bg-black relative"
    >
      {status === "connected" && (
        <button
          type="button"
          onClick={openPasteModal}
          title={t("vnc.pasteToRemote")}
          className="absolute top-3 right-3 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white/90 bg-black/60 hover:bg-black/80 backdrop-blur-sm border border-white/10 transition-colors cursor-pointer"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>content_paste</span>
          {t("vnc.pasteToRemote")}
        </button>
      )}
      {pasteOpen && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={closePasteModal}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="vnc-paste-dialog-title"
            aria-describedby="vnc-paste-dialog-desc"
            className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0f1219] p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="vnc-paste-dialog-title" className="text-sm font-semibold text-white mb-1">{t("vnc.pasteToRemote")}</h3>
            <p id="vnc-paste-dialog-desc" className="text-xs text-white/50 mb-3">{t("vnc.pasteHelp")}</p>
            <textarea
              ref={pasteTextareaRef}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  sendPaste();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closePasteModal();
                }
              }}
              rows={5}
              placeholder={t("vnc.pastePlaceholder")}
              aria-labelledby="vnc-paste-dialog-title"
              aria-describedby="vnc-paste-dialog-desc"
              className="w-full px-3 py-2 bg-white/[0.04] border border-white/10 rounded-lg text-sm text-white outline-none focus:border-orange-400/60 focus:bg-white/[0.06] placeholder-white/25 resize-y"
            />
            <div className="flex items-center justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={closePasteModal}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-white/70 bg-white/5 hover:bg-white/10 border border-white/10 cursor-pointer"
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={sendPaste}
                disabled={pasteText.length === 0}
                className="px-4 py-1.5 rounded-lg text-xs font-medium text-white bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 cursor-pointer"
              >
                {t("vnc.sendPaste")}
              </button>
            </div>
          </div>
        </div>
      )}
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
