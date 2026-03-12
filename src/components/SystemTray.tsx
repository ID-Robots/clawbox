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
  const [wifiEnabled, setWifiEnabled] = useState(true);
  const [brightness, setBrightness] = useState(80);
  const [volume, setVolume] = useState(50);

  useEffect(() => {
    if (isOpen) {
      setClosing(false);
    }
  }, [isOpen]);

  const handleClose = () => {
    setClosing(true);
    setTimeout(onClose, 150);
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

          {/* Quick settings */}
          <div className="p-4 space-y-4">
            {/* WiFi toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
                    wifiEnabled ? "bg-blue-500" : "bg-white/10"
                  }`}
                >
                  <span className="material-symbols-rounded text-white" style={{ fontSize: 20 }}>wifi</span>
                </div>
                <div>
                  <div className="text-sm font-medium text-white">WiFi</div>
                  <div className="text-xs text-white/50">
                    {wifiEnabled ? "Connected" : "Off"}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setWifiEnabled(!wifiEnabled)}
                className={`w-11 h-6 rounded-full transition-colors cursor-pointer ${
                  wifiEnabled ? "bg-blue-500" : "bg-white/20"
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${
                    wifiEnabled ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>

            {/* Brightness slider */}
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span className="material-symbols-rounded text-white/70" style={{ fontSize: 20 }}>light_mode</span>
                <span className="text-sm text-white/70">Brightness</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={brightness}
                onChange={(e) => setBrightness(Number(e.target.value))}
                className="w-full h-1.5 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow"
              />
            </div>

            {/* Volume slider */}
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span className="material-symbols-rounded text-white/70" style={{ fontSize: 20 }}>volume_up</span>
                <span className="text-sm text-white/70">Volume</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                className="w-full h-1.5 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow"
              />
            </div>
          </div>

          {/* Bottom actions */}
          <div className="p-4 pt-0 flex items-center gap-2">
            <button className="flex-1 flex items-center justify-center gap-2 h-10 rounded-lg bg-white/10 hover:bg-white/15 transition-colors cursor-pointer">
              <span className="material-symbols-rounded text-white/70" style={{ fontSize: 16 }}>settings</span>
              <span className="text-sm text-white/80">Settings</span>
            </button>
            <button className="flex-1 flex items-center justify-center gap-2 h-10 rounded-lg bg-white/10 hover:bg-white/15 transition-colors cursor-pointer">
              <span className="material-symbols-rounded text-white/70" style={{ fontSize: 16 }}>power_settings_new</span>
              <span className="text-sm text-white/80">Power</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
