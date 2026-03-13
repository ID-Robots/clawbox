"use client";

import { useState, useEffect } from "react";

interface SystemTrayProps {
  isOpen: boolean;
  onClose: () => void;
  date: string;
  time: string;
}

export default function SystemTray({
  isOpen,
  onClose,
  date,
  time,
}: SystemTrayProps) {
  const [closing, setClosing] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"shutdown" | "restart" | null>(null);

  useEffect(() => {
    if (isOpen) {
      setClosing(false);
      setConfirmAction(null);
    }
  }, [isOpen]);

  const handleClose = () => {
    setClosing(true);
    setTimeout(onClose, 150);
  };

  const handlePower = async (action: "shutdown" | "restart") => {
    if (confirmAction !== action) {
      setConfirmAction(action);
      return;
    }
    try {
      await fetch("/setup-api/system/power", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
    } catch {}
    handleClose();
  };

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
