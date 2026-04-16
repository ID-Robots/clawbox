"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Image from "next/image";
import { useT } from "@/lib/i18n";

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
  const { t } = useT();
  const [closing, setClosing] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"shutdown" | "restart" | null>(null);
  const [internet, setInternet] = useState<{ online: boolean; latencyMs: number | null } | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/setup-api/network/internet", { signal: AbortSignal.timeout(4000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (alive) setInternet({ online: !!d.online, latencyMs: d.latencyMs ?? null });
      } catch { if (alive) setInternet({ online: false, latencyMs: null }); }
    };
    void tick();
    const id = setInterval(tick, 15_000);
    return () => { alive = false; clearInterval(id); };
  }, [isOpen]);
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
    if (rebootState) return;
    setClosing(true);
    setTimeout(() => {
      onClose();
      setClosing(false);
    }, 150);
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
      <div className="fixed inset-0 z-[999999] flex items-center justify-center" style={{ background: rebootState.phase === "shutdown" ? "rgba(0, 0, 0, 0.99)" : "rgba(13, 17, 23, 1)" }}>
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
            <div className="relative w-32 h-32 flex items-center justify-center">
              <div className="absolute inset-0 rounded-full border-[3px] border-white/10 animate-spin" style={{ borderTopColor: BRAND_ORANGE }} />
              <Image src="/clawbox-crab.png" alt="ClawBox" width={96} height={96} className="w-24 h-24 object-contain animate-welcome-powerup" priority />
            </div>
          )}

          {/* Status message */}
          {rebootState.phase === "waiting" && (
            <>
              <h2 className="text-xl font-semibold text-white">
                {rebootState.action === "shutdown" ? t("tray.shuttingDown") : t("tray.restarting")}{dots}
              </h2>
              <p className="text-sm text-white/50">
                {rebootState.action === "shutdown"
                  ? t("tray.shutdownMessage")
                  : t("tray.restartMessage")}
              </p>
            </>
          )}

          {rebootState.phase === "shutdown" && (
            <>
              <h2 className="text-xl font-semibold text-white">
                {t("tray.shutdownComplete")}
              </h2>
              <p className="text-sm text-white/50">
                {t("tray.devicePoweredOff")}
              </p>
              <div className="mt-2 px-4 py-3 rounded-lg bg-white/5 border border-white/10">
                <p className="text-sm text-white/70">
                  {t("tray.restartInstructions")}
                </p>
              </div>
            </>
          )}

          {rebootState.phase === "reconnecting" && (
            <>
              <h2 className="text-xl font-semibold text-white">
                {t("tray.reconnecting")}
              </h2>
              <p className="text-sm text-white/50">
                {t("tray.waitingOnline")}
              </p>
            </>
          )}

          {rebootState.phase === "restoring" && (
            <>
              <h2 className="text-xl font-semibold text-white">
                {t("tray.backOnline")}
              </h2>
              <p className="text-sm text-white/50">
                {t("tray.restoringSession")}
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
        className={`fixed inset-0 z-[10020] transition-opacity duration-150 ${
          closing ? "opacity-0" : "opacity-100"
        }`}
        style={{ background: "rgba(0, 0, 0, 0.2)" }}
        onClick={handleClose}
      />

      {/* Power menu panel — anchored above the power button (bottom-right) */}
      <div
        className={`fixed bottom-16 right-2 w-72 z-[10020] transition-all duration-150 ${
          closing
            ? "opacity-0 translate-y-2 scale-95"
            : "opacity-100 translate-y-0 scale-100"
        }`}
        data-testid="system-tray"
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

          {/* Internet status */}
          {internet && (
            <div className="px-4 py-2.5 border-b border-white/10 flex items-center gap-2">
              <span aria-hidden="true" className={`w-2 h-2 rounded-full ${internet.online ? "bg-green-400" : "bg-red-400"}`} />
              <span className="text-xs text-white/70">
                {internet.online ? `Internet · ${internet.latencyMs ?? "?"} ms` : "No internet"}
              </span>
            </div>
          )}

          {/* Bottom actions */}
          <div className="p-4 flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => handlePower("restart")}
                className={`flex items-center justify-center gap-2 h-10 rounded-lg transition-colors cursor-pointer ${
                  confirmAction === "restart" ? "bg-yellow-500/30 hover:bg-yellow-500/40" : "bg-white/10 hover:bg-white/15"
                }`}
              >
                <span className="material-symbols-rounded text-white/70 shrink-0" style={{ fontSize: 16 }}>restart_alt</span>
                <span className="text-sm text-white/80 whitespace-nowrap">{confirmAction === "restart" ? t("tray.confirm") : t("tray.restart")}</span>
              </button>
              <button
                onClick={() => handlePower("shutdown")}
                className={`flex items-center justify-center gap-2 h-10 rounded-lg transition-colors cursor-pointer ${
                  confirmAction === "shutdown" ? "bg-red-500/30 hover:bg-red-500/40" : "bg-white/10 hover:bg-white/15"
                }`}
              >
                <span className="material-symbols-rounded text-white/70 shrink-0" style={{ fontSize: 16 }}>power_settings_new</span>
                <span className="text-sm text-white/80 whitespace-nowrap">{confirmAction === "shutdown" ? t("tray.confirm") : t("tray.shutDown")}</span>
              </button>
            </div>
            <button
              onClick={async () => {
                await fetch("/login-api/logout", { method: "POST" }).catch(() => {});
                window.location.href = "/login";
              }}
              className="flex items-center justify-center gap-2 h-10 rounded-lg transition-colors cursor-pointer bg-white/10 hover:bg-white/15 w-full"
            >
              <span className="material-symbols-rounded text-white/70 shrink-0" style={{ fontSize: 16 }}>lock</span>
              <span className="text-sm text-white/80">{t("tray.lock")}</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
