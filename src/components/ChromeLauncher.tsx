"use client";

import { useState, useEffect, useRef, ReactNode, useCallback, useMemo } from "react";

interface LauncherApp {
  id: string;
  name: string;
  color: string;
  icon: ReactNode;
  isPinned?: boolean;
}

interface ChromeLauncherProps {
  apps: LauncherApp[];
  isOpen: boolean;
  onClose: () => void;
  onAppClick: (id: string) => void;
  onPinApp?: (id: string) => void;
  onUnpinApp?: (id: string) => void;
  onAddToDesktop?: (id: string) => void;
}

// Responsive grid: more cols/rows on bigger screens
function useLauncherGrid() {
  const [grid, setGrid] = useState({ cols: 5, rows: 2 });
  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const cols = w >= 1600 ? 8 : w >= 1200 ? 7 : w >= 900 ? 6 : 5;
      const rows = h >= 900 ? 4 : h >= 700 ? 3 : 2;
      setGrid({ cols, rows });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return grid;
}

export default function ChromeLauncher({
  apps,
  isOpen,
  onClose,
  onAppClick,
  onAddToDesktop,
  onPinApp,
  onUnpinApp,
}: ChromeLauncherProps) {
  const { cols: gridCols, rows: gridRows } = useLauncherGrid();
  const APPS_PER_PAGE = gridCols * gridRows;
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(0);
  const [animationState, setAnimationState] = useState<"closed" | "opening" | "open" | "closing">("closed");
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; app: LauncherApp } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const prevOpenRef = useRef(isOpen);
  const ctxOpenedAt = useRef(0);
  // Swipe tracking
  const swipeStartX = useRef(0);
  const swipeStartY = useRef(0);
  const swiping = useRef(false);

  const filteredApps = apps.filter((app) =>
    app.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const totalPages = Math.max(1, Math.ceil(filteredApps.length / APPS_PER_PAGE));
  const pageApps = useMemo(() => {
    const start = currentPage * APPS_PER_PAGE;
    return filteredApps.slice(start, start + APPS_PER_PAGE);
  }, [filteredApps, currentPage]);

  // Reset page when search changes or launcher opens
  useEffect(() => {
    setCurrentPage(0);
  }, [searchQuery]);

  // Handle open/close state transitions
  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      setSearchQuery("");
      setCtxMenu(null);
      setCurrentPage(0);
      setAnimationState("opening");
      const timer = setTimeout(() => {
        setAnimationState("open");
        searchRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    } else if (!isOpen && prevOpenRef.current) {
      setAnimationState("closed");
      setCtxMenu(null);
    }
    prevOpenRef.current = isOpen;
  }, [isOpen]);

  // Close context menu on click/right-click elsewhere
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => {
      setCtxMenu(null);
    };
    const closeCtx = (e: Event) => {
      if (Date.now() - ctxOpenedAt.current < 100) return;
      e.preventDefault();
      setCtxMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", closeCtx);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", closeCtx);
    };
  }, [ctxMenu]);

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
    } else if (e.key === "ArrowLeft") {
      setCurrentPage(p => Math.max(0, p - 1));
    } else if (e.key === "ArrowRight") {
      setCurrentPage(p => Math.min(totalPages - 1, p + 1));
    }
  }, [handleClose, totalPages]);

  // Swipe handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    swipeStartX.current = e.touches[0].clientX;
    swipeStartY.current = e.touches[0].clientY;
    swiping.current = true;
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!swiping.current) return;
    swiping.current = false;
    const dx = e.changedTouches[0].clientX - swipeStartX.current;
    const dy = e.changedTouches[0].clientY - swipeStartY.current;
    // Only horizontal swipe (more X than Y movement, min 50px)
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) {
        setCurrentPage(p => Math.min(totalPages - 1, p + 1));
      } else {
        setCurrentPage(p => Math.max(0, p - 1));
      }
    }
  }, [totalPages]);

  // Mouse wheel to change pages
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (totalPages <= 1) return;
    if (e.deltaY > 0) {
      setCurrentPage(p => Math.min(totalPages - 1, p + 1));
    } else if (e.deltaY < 0) {
      setCurrentPage(p => Math.max(0, p - 1));
    }
  }, [totalPages]);

  // Don't render if closed
  if (animationState === "closed" && !isOpen) return null;

  const isClosing = animationState === "closing";

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-[9998] transition-opacity duration-200 ${
          isClosing ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
        style={{ background: "rgba(0, 0, 0, 0.3)" }}
        onClick={handleClose}
        onContextMenu={(e) => {
          e.preventDefault();
          handleClose();
        }}
      />

      {/* Launcher panel */}
      <div
        style={{ maxWidth: gridCols * 110 + 32 }}
        className={`fixed bottom-14 left-1/2 -translate-x-1/2 w-full z-[9999] transition-all duration-200 ${
          isClosing ? "translate-y-full opacity-0 pointer-events-none" : "translate-y-0 opacity-100"
        }`}
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
              <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-white/40" style={{ fontSize: 20 }}>search</span>
              <input
                ref={searchRef}
                type="text"
                placeholder="Search apps or store..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && searchQuery.trim()) {
                    window.open(`https://openclawhardware.dev/store?q=${encodeURIComponent(searchQuery.trim())}`, "_blank", "noopener,noreferrer");
                  }
                }}
                className="w-full h-11 pl-10 pr-4 bg-white/5 border border-white/10 rounded-full text-white placeholder-white/40 text-sm focus:outline-none focus:border-white/20 focus:bg-white/10 transition-colors"
              />
            </div>
          </div>

          {/* App grid — paginated */}
          <div
            className="px-4 pb-2"
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onWheel={handleWheel}
          >
            <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`, minHeight: gridRows * 100 }}>
              {pageApps.map((app) => (
                <button
                  key={app.id}
                  onClick={() => handleAppClick(app.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    ctxOpenedAt.current = Date.now();
                    setCtxMenu({ x: e.clientX, y: e.clientY, app });
                  }}
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

          {/* Page dots */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-1.5 pb-4 pt-1">
              {Array.from({ length: totalPages }, (_, i) => (
                <button
                  key={i}
                  onClick={() => setCurrentPage(i)}
                  className={`rounded-full transition-all duration-200 ${
                    i === currentPage
                      ? "w-5 h-2 bg-white/70"
                      : "w-2 h-2 bg-white/25 hover:bg-white/40"
                  }`}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Launcher context menu */}
      {ctxMenu && (
        <div
          className="fixed z-[99999] min-w-[180px] py-1 bg-[#2d2d2d] rounded-lg shadow-2xl border border-white/10 backdrop-blur-xl text-sm text-white/90"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 200),
            top: Math.min(ctxMenu.y, window.innerHeight - 150),
          }}
          onClick={() => setCtxMenu(null)}
        >
          <div className="px-4 py-1.5 text-xs text-white/40 font-medium truncate">
            {ctxMenu.app.name}
          </div>
          <div className="border-t border-white/10 my-0.5" />

          <button
            onClick={() => handleAppClick(ctxMenu.app.id)}
            className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3"
          >
            <span className="text-base">▶️</span> Open
          </button>

          {ctxMenu.app.isPinned ? (
            <button
              onClick={() => { if (onUnpinApp) onUnpinApp(ctxMenu.app.id); }}
              className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3"
            >
              <span className="text-base">📌</span> Unpin from shelf
            </button>
          ) : (
            <button
              onClick={() => { if (onPinApp) onPinApp(ctxMenu.app.id); }}
              className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3"
            >
              <span className="text-base">📌</span> Pin to shelf
            </button>
          )}

          {onAddToDesktop && (
            <button
              onClick={() => { onAddToDesktop(ctxMenu.app.id); }}
              className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3"
            >
              <span className="text-base">🖥️</span> Add to desktop
            </button>
          )}
        </div>
      )}
    </>
  );
}
