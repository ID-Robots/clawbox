"use client";

import { ReactNode } from "react";

interface ShelfApp {
  id: string;
  name: string;
  icon: ReactNode;
  isOpen: boolean;
  isActive: boolean;
}

interface ChromeShelfProps {
  apps: ShelfApp[];
  onAppClick: (id: string) => void;
  onLauncherClick: () => void;
  onTrayClick: () => void;
  time: string;
}

export default function ChromeShelf({
  apps,
  onAppClick,
  onLauncherClick,
  onTrayClick,
  time,
}: ChromeShelfProps) {
  return (
    <div
      className="fixed bottom-0 left-0 right-0 h-14 flex items-center justify-center px-2 z-[10000]"
      style={{
        background: "rgba(17, 24, 39, 0.85)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderTop: "1px solid rgba(255, 255, 255, 0.1)",
      }}
    >
      {/* Centered: launcher + pinned apps */}
      <div className="flex items-center gap-1">
        {/* Launcher button (circle icon) */}
        <button
          onClick={onLauncherClick}
          className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
          title="App Launcher"
        >
          <div className="w-10 h-10 rounded-full flex items-center justify-center bg-gradient-to-br from-white/20 to-white/5 border border-white/10">
            <svg
              className="w-5 h-5 text-white/80"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="3" fill="currentColor" />
            </svg>
          </div>
        </button>

        {/* Separator */}
        <div className="w-px h-8 bg-white/10 mx-1" />

        {/* Pinned apps */}
        {apps.map((app) => (
          <button
            key={app.id}
            onClick={() => onAppClick(app.id)}
            className="relative w-11 h-11 flex items-center justify-center rounded-lg hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer group"
            title={app.name}
          >
            <div className="w-10 h-10 flex items-center justify-center">{app.icon}</div>

            {/* Active indicator dot */}
            {app.isOpen && (
              <div
                className={`absolute bottom-0.5 left-1/2 -translate-x-1/2 h-1 rounded-full transition-all ${
                  app.isActive ? "w-4 bg-white" : "w-1.5 bg-white/60"
                }`}
              />
            )}

            {/* Tooltip */}
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-[#1e2939] text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap border border-white/10">
              {app.name}
            </div>
          </button>
        ))}
      </div>

      {/* Right side: system tray (absolute to keep apps centered) */}
      <button
        onClick={onTrayClick}
        className="absolute right-2 flex items-center gap-3 h-10 px-3 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
        title="System Settings"
      >
        {/* Time */}
        <span className="text-sm text-white/80 font-medium">{time}</span>
      </button>
    </div>
  );
}
