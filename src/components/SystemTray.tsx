"use client";

import { useState, useEffect, useCallback, useRef } from "react";

const BRAND_ORANGE = "#fe6e00";

interface SystemTrayProps {
  isOpen: boolean;
  onClose: () => void;
  date: string;
  time: string;
}

type RebootState =
  | null
  | { phase: "waiting"; action: "restart" | "shutdown"; dots: number }
  | { phase: "reconnecting"; attempt: number; dots: number }
  | { phase: "restoring" }
  | { phase: "shutdown" };

export default function SystemTray({
  isOpen,
  onClose,
  date,
  time,
}: SystemTrayProps) {
  const [closing, setClosing] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"shutdown" | "restart" | null>(null);
  const [rebootState, setRebootState] = useState<RebootState>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dotsRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isOpen) {
      setClosing(false);
      setConfirmAction(null);
    }
  }, [isOpen]);

  // Animate dots
  useEffect(() => {
    if (rebootState && rebootState.phase !== "restoring") {
      dotsRef.current = setInterval(() => {
        setRebootState(prev => {
          if (!prev || prev.phase === "restoring" || prev.phase === "shutdown") return prev;
          return { ...prev, dots: (prev.dots + 1) % 4 };
        });
      }, 500);
      return () => { if (dotsRef.current) clearInterval(dotsRef.current); };
    }
  }, [rebootState?.phase]);

  const startReconnecting = useCallback(() => {
    setRebootState({ phase: "reconnecting", attempt: 0, dots: 0 });

    let attempt = 0;
    pollRef.current = setInterval(async () => {
      attempt++;
      setRebootState(prev => {
        if (!prev || prev.phase !== "reconnecting") return prev;
        return { ...prev, attempt };
      });

      try {
        const res = await fetch("/setup-api/setup/status", { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          // Device is back online
          if (pollRef.current) clearInterval(pollRef.current);
          setRebootState({ phase: "restoring" });
          setTimeout(() => {
            setRebootState(null);
            window.location.reload();
          }, 1500);
        }
      } catch {
        // Still offline, keep polling
      }
    }, 3000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (dotsRef.current) clearInterval(dotsRef.current);
    };
  }, []);

  const handleClose = () => {
    if (rebootState) return; // Don't close during reboot
    setClosing(true);
    setTimeout(onClose, 150);
  };

  const handlePower = async (action: "shutdown" | "restart") => {
    if (confirmAction !== action) {
      setConfirmAction(action);
      return;
    }

    // Show the waiting overlay
    setRebootState({ phase: "waiting", action, dots: 0 });

    try {
      await fetch("/setup-api/system/power", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
    } catch {}

    if (action === "restart") {
      // Wait for the device to go down, then start reconnecting
      setTimeout(() => startReconnecting(), 5000);
    } else {
      // Shutdown: show spinner briefly, then show powered-off screen
      setTimeout(() => setRebootState({ phase: "shutdown" }), 4000);
    }
  };

  // Full-screen reboot overlay
  if (rebootState) {
    const dots = (rebootState.phase === "waiting" || rebootState.phase === "reconnecting")
      ? ".".repeat(rebootState.dots)
      : "";

    return (
      <div className="fixed inset-0 z-[99999] flex items-center justify-center" style={{ background: rebootState.phase === "shutdown" ? "rgba(0, 0, 0, 0.97)" : "rgba(0, 0, 0, 0.92)" }}>
        <div className="flex flex-col items-center gap-6 max-w-md text-center px-6">
          {/* Icon */}
          {rebootState.phase === "restoring" ? (
            <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ backgroundColor: BRAND_ORANGE }}>
              <span className="material-symbols-rounded text-white" style={{ fontSize: 32 }}>check</span>
            </div>
          ) : rebootState.phase === "shutdown" ? (
            <div className="w-16 h-16 rounded-full flex items-center justify-center bg-white/10">
              <span className="material-symbols-rounded text-white/60" style={{ fontSize: 32 }}>power_settings_new</span>
            </div>
          ) : (
            <div className="w-16 h-16 rounded-full border-[3px] border-white/10 animate-spin" style={{ borderTopColor: BRAND_ORANGE }} />
          )}

          {/* Status message */}
          {rebootState.phase === "waiting" && (
            <>
              <h2 className="text-xl font-semibold text-white">
                {rebootState.action === "shutdown" ? "Shutting down" : "Restarting"}{dots}
              </h2>
              <p className="text-sm text-white/50">
                {rebootState.action === "shutdown"
                  ? "Your device is shutting down. Please wait."
                  : "Please wait while your device restarts. This may take a minute."}
              </p>
            </>
          )}

          {rebootState.phase === "shutdown" && (
            <>
              <h2 className="text-xl font-semibold text-white">
                ClawBox has been shut down
              </h2>
              <p className="text-sm text-white/50">
                Your device has been powered off.
              </p>
              <div className="mt-2 px-4 py-3 rounded-lg bg-white/5 border border-white/10">
                <p className="text-sm text-white/70">
                  To start your ClawBox again, unplug the power cable and plug it back in.
                </p>
              </div>
            </>
          )}

          {rebootState.phase === "reconnecting" && (
            <>
              <h2 className="text-xl font-semibold text-white">
                Reconnecting
              </h2>
              <p className="text-sm text-white/50">
                Waiting for device to come back online
              </p>
            </>
          )}

          {rebootState.phase === "restoring" && (
            <>
              <h2 className="text-xl font-semibold text-white">
                Device is back online
              </h2>
              <p className="text-sm text-white/50">
                Restoring your session...
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  if (!isOpen && !closing) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-[9998] transition-opacity duration-150 ${
          closing ? "opacity-0" : "opacity-100"
        }`}
        style={{ background: "rgba(0, 0, 0, 0.2)" }}
        onClick={handleClose}
      />

      {/* Tray panel */}
      <div
        className={`fixed bottom-16 right-2 w-80 z-[9999] transition-all duration-150 ${
          closing
            ? "opacity-0 translate-y-2 scale-95"
            : "opacity-100 translate-y-0 scale-100"
        }`}
        style={{ transformOrigin: "bottom right" }}
      >
        <div
          className="rounded-xl overflow-hidden"
          style={{
            background: "rgba(17, 24, 39, 0.95)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
          }}
        >
          {/* Date and time */}
          <div className="p-4 border-b border-white/10">
            <div className="text-2xl font-medium text-white">{time}</div>
            <div className="text-sm text-white/60">{date}</div>
          </div>

          {/* Bottom actions */}
          <div className="p-4 grid grid-cols-2 gap-2">
            <button
              onClick={() => handlePower("restart")}
              className={`flex items-center justify-center gap-2 h-10 rounded-lg transition-colors cursor-pointer ${
                confirmAction === "restart" ? "bg-yellow-500/30 hover:bg-yellow-500/40" : "bg-white/10 hover:bg-white/15"
              }`}
            >
              <span className="material-symbols-rounded text-white/70 shrink-0" style={{ fontSize: 16 }}>restart_alt</span>
              <span className="text-sm text-white/80 whitespace-nowrap">{confirmAction === "restart" ? "Confirm?" : "Restart"}</span>
            </button>
            <button
              onClick={() => handlePower("shutdown")}
              className={`flex items-center justify-center gap-2 h-10 rounded-lg transition-colors cursor-pointer ${
                confirmAction === "shutdown" ? "bg-red-500/30 hover:bg-red-500/40" : "bg-white/10 hover:bg-white/15"
              }`}
            >
              <span className="material-symbols-rounded text-white/70 shrink-0" style={{ fontSize: 16 }}>power_settings_new</span>
              <span className="text-sm text-white/80 whitespace-nowrap">{confirmAction === "shutdown" ? "Confirm?" : "Shut Down"}</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
