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
        <span className="material-symbols-rounded text-white/90" style={{ fontSize: 16 }}>wifi</span>

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
            <span className="material-symbols-rounded text-white/90" style={{ fontSize: 10 }}>bolt</span>
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
