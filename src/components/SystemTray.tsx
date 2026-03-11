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
                  <svg
                    className="w-5 h-5 text-white"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                    <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                    <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                    <circle cx="12" cy="20" r="1" fill="currentColor" />
                  </svg>
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
                <svg
                  className="w-5 h-5 text-white/70"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
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
                <svg
                  className="w-5 h-5 text-white/70"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
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
              <svg
                className="w-4 h-4 text-white/70"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span className="text-sm text-white/80">Settings</span>
            </button>
            <button className="flex-1 flex items-center justify-center gap-2 h-10 rounded-lg bg-white/10 hover:bg-white/15 transition-colors cursor-pointer">
              <svg
                className="w-4 h-4 text-white/70"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                <line x1="12" y1="2" x2="12" y2="12" />
              </svg>
              <span className="text-sm text-white/80">Power</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
