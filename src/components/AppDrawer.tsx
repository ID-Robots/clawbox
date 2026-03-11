"use client";

import { useState, useRef, useEffect } from "react";

export interface AppDefinition {
  id: string;
  name: string;
  icon: React.ReactNode;
  color: string;
  type: "settings" | "openclaw" | "placeholder" | "external";
  url?: string;
}

interface AppDrawerProps {
  apps: AppDefinition[];
  isOpen: boolean;
  onClose: () => void;
  onAppClick: (app: AppDefinition) => void;
}

export function AppDrawer({
  apps,
  isOpen,
  onClose,
  onAppClick,
}: AppDrawerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Reset search when drawer closes
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery("");
    }
  }, [isOpen]);

  // Handle swipe down to close
  const handleTouchStart = (e: React.TouchEvent) => {
    setTouchStart(e.touches[0].clientY);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStart === null) return;
    const diff = e.touches[0].clientY - touchStart;
    if (diff > 100) {
      onClose();
      setTouchStart(null);
    }
  };

  const handleTouchEnd = () => {
    setTouchStart(null);
  };

  // Filter apps by search
  const filteredApps = apps
    .filter((app) => app.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div
      className={`fixed inset-0 z-[100] transition-all duration-300 ease-out ${
        isOpen
          ? "opacity-100 pointer-events-auto"
          : "opacity-0 pointer-events-none"
      }`}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-md"
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        ref={drawerRef}
        className={`absolute inset-x-0 bottom-0 top-7 bg-black/80 backdrop-blur-xl rounded-t-3xl transition-transform duration-300 ease-out ${
          isOpen ? "translate-y-0" : "translate-y-full"
        }`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-10 h-1 bg-white/30 rounded-full" />
        </div>

        {/* Search bar */}
        <div className="px-4 pb-4">
          <div className="relative">
            <svg
              className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/50"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              placeholder="Search apps"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-12 pl-12 pr-4 bg-white/10 rounded-full text-white placeholder-white/50 text-base outline-none focus:bg-white/15 transition-colors"
            />
          </div>
        </div>

        {/* Apps grid */}
        <div className="px-4 pb-20 overflow-y-auto" style={{ maxHeight: "calc(100vh - 140px)" }}>
          <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-4">
            {filteredApps.map((app) => (
              <button
                key={app.id}
                className="flex flex-col items-center gap-2 p-2 rounded-2xl hover:bg-white/10 active:bg-white/20 transition-colors"
                onClick={() => {
                  onAppClick(app);
                  onClose();
                }}
              >
                <div
                  className="w-14 h-14 rounded-[16px] flex items-center justify-center shadow-lg"
                  style={{ backgroundColor: app.color }}
                >
                  {app.icon}
                </div>
                <span className="text-white/90 text-xs text-center line-clamp-1 w-full">
                  {app.name}
                </span>
              </button>
            ))}
          </div>

          {filteredApps.length === 0 && (
            <div className="text-center text-white/50 py-8">
              No apps found for &ldquo;{searchQuery}&rdquo;
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
