"use client";

import { useState, useEffect, useRef, ReactNode, useCallback } from "react";

interface LauncherApp {
  id: string;
  name: string;
  color: string;
  icon: ReactNode;
}

interface ChromeLauncherProps {
  apps: LauncherApp[];
  isOpen: boolean;
  onClose: () => void;
  onAppClick: (id: string) => void;
}

export default function ChromeLauncher({
  apps,
  isOpen,
  onClose,
  onAppClick,
}: ChromeLauncherProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [animationState, setAnimationState] = useState<"closed" | "opening" | "open" | "closing">("closed");
  const searchRef = useRef<HTMLInputElement>(null);
  const prevOpenRef = useRef(isOpen);

  const filteredApps = apps.filter((app) =>
    app.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Handle open/close state transitions - synchronizing internal animation state with isOpen prop
  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      // Opening - reset search and start animation
      setSearchQuery("");
      setAnimationState("opening");
      const timer = setTimeout(() => {
        setAnimationState("open");
        searchRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    } else if (!isOpen && prevOpenRef.current) {
      // Parent initiated close - already handled by handleClose animation
      setAnimationState("closed");
    }
    prevOpenRef.current = isOpen;
  }, [isOpen]);

  const handleClose = useCallback(() => {
    setAnimationState("closing");
    setTimeout(() => {
      onClose();
    }, 200);
  }, [onClose]);

  const handleAppClick = useCallback((id: string) => {
    handleClose();
    setTimeout(() => onAppClick(id), 200);
  }, [handleClose, onAppClick]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      handleClose();
    }
  }, [handleClose]);

  // Don't render if closed
  if (animationState === "closed" && !isOpen) return null;

  const isClosing = animationState === "closing";

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-[9998] transition-opacity duration-200 ${
          isClosing ? "opacity-0" : "opacity-100"
        }`}
        style={{ background: "rgba(0, 0, 0, 0.3)" }}
        onClick={handleClose}
      />

      {/* Launcher panel */}
      <div
        className={`fixed bottom-14 left-1/2 -translate-x-1/2 w-full max-w-xl z-[9999] transition-all duration-200 ${
          isClosing ? "translate-y-full opacity-0" : "translate-y-0 opacity-100"
        }`}
        style={{
          maxHeight: "calc(100vh - 80px)",
        }}
        onKeyDown={handleKeyDown}
      >
        <div
          className="rounded-t-2xl overflow-hidden"
          style={{
            background: "rgba(17, 24, 39, 0.95)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
            borderBottom: "none",
          }}
        >
          {/* Search bar */}
          <div className="p-4 pb-3">
            <div className="relative">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-white/40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                placeholder="Search apps..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-11 pl-10 pr-4 bg-white/5 border border-white/10 rounded-full text-white placeholder-white/40 text-sm focus:outline-none focus:border-white/20 focus:bg-white/10 transition-colors"
              />
            </div>
          </div>

          {/* App grid */}
          <div
            className="px-4 pb-6 overflow-y-auto"
            style={{ maxHeight: "calc(100vh - 200px)" }}
          >
            <div className="grid grid-cols-5 gap-4">
              {filteredApps.map((app) => (
                <button
                  key={app.id}
                  onClick={() => handleAppClick(app.id)}
                  className="flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer group"
                >
                  {/* App icon */}
                  <div
                    className="w-12 h-12 rounded-full flex items-center justify-center shadow-lg group-hover:scale-105 transition-transform"
                    style={{ backgroundColor: app.color }}
                  >
                    {app.icon}
                  </div>
                  {/* App name */}
                  <span className="text-xs text-white/80 text-center line-clamp-1 w-full">
                    {app.name}
                  </span>
                </button>
              ))}
            </div>

            {filteredApps.length === 0 && (
              <div className="text-center py-8 text-white/40 text-sm">
                No apps found
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
