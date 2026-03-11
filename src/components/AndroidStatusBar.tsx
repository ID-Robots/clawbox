"use client";

import { useState, useEffect } from "react";

export function AndroidStatusBar() {
  const [time, setTime] = useState("");
  const [batteryLevel, setBatteryLevel] = useState(100);
  const [isCharging, setIsCharging] = useState(false);

  useEffect(() => {
    // Update time
    const updateTime = () => {
      const now = new Date();
      setTime(
        now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);

    // Get battery status if available
    if ("getBattery" in navigator) {
      (navigator as Navigator & { getBattery: () => Promise<BatteryManager> })
        .getBattery()
        .then((battery: BatteryManager) => {
          setBatteryLevel(Math.round(battery.level * 100));
          setIsCharging(battery.charging);

          battery.addEventListener("levelchange", () => {
            setBatteryLevel(Math.round(battery.level * 100));
          });
          battery.addEventListener("chargingchange", () => {
            setIsCharging(battery.charging);
          });
        })
        .catch(() => {
          // Battery API not available, use default
        });
    }

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="android-status-bar fixed top-0 left-0 right-0 z-50 h-7 px-4 flex items-center justify-between bg-black/40 backdrop-blur-md">
      {/* Left side - ClawBox branding */}
      <div className="flex items-center gap-2">
        <span className="text-white/90 text-xs font-medium tracking-wide">
          ClawBox
        </span>
      </div>

      {/* Right side - Status icons and time */}
      <div className="flex items-center gap-3">
        {/* WiFi icon */}
        <svg
          className="w-4 h-4 text-white/90"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M12 18c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zm-4.9-2.3l1.4 1.4c1.9-1.9 5.1-1.9 7 0l1.4-1.4c-2.7-2.7-7.1-2.7-9.8 0zm-2.8-2.8l1.4 1.4c3.6-3.6 9.4-3.6 13 0l1.4-1.4c-4.4-4.4-11.4-4.4-15.8 0zm-2.8-2.8l1.4 1.4c5.5-5.5 14.3-5.5 19.8 0l1.4-1.4c-6.2-6.3-16.4-6.3-22.6 0z" />
        </svg>

        {/* Battery icon */}
        <div className="flex items-center gap-1">
          <div className="relative w-6 h-3 border border-white/70 rounded-sm">
            <div
              className="absolute left-0.5 top-0.5 bottom-0.5 rounded-sm transition-all duration-300"
              style={{
                width: `${Math.max(0, batteryLevel - 10)}%`,
                backgroundColor:
                  batteryLevel > 20
                    ? "rgba(255,255,255,0.9)"
                    : "rgba(239,68,68,0.9)",
              }}
            />
            <div className="absolute -right-1 top-1/2 -translate-y-1/2 w-0.5 h-1.5 bg-white/70 rounded-r-sm" />
          </div>
          {isCharging && (
            <svg
              className="w-2.5 h-2.5 text-white/90"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M11 21h-1l1-7H7.5c-.88 0-.33-.75-.31-.78C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-6 10.49z" />
            </svg>
          )}
        </div>

        {/* Time */}
        <span className="text-white/90 text-xs font-medium tabular-nums">
          {time}
        </span>
      </div>
    </div>
  );
}

interface BatteryManager extends EventTarget {
  charging: boolean;
  level: number;
}
