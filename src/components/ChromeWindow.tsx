"use client";

import { useState, useRef, useCallback, useEffect, useLayoutEffect, ReactNode } from "react";

interface ChromeWindowProps {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  defaultWidth?: number;
  defaultHeight?: number;
  isActive: boolean;
  zIndex: number;
  onClose: () => void;
  onFocus: () => void;
  onMinimize: () => void;
  minimized?: boolean;
}

// Calculate initial centered position
function getInitialPosition(width: number, height: number) {
  if (typeof window === "undefined") return { x: 100, y: 50 };
  const shelfHeight = 56;
  const maxWidth = window.innerWidth;
  const maxHeight = window.innerHeight - shelfHeight;
  return {
    x: Math.max(20, (maxWidth - width) / 2),
    y: Math.max(20, (maxHeight - height) / 2),
  };
}

export default function ChromeWindow({
  title,
  icon,
  children,
  defaultWidth = 800,
  defaultHeight = 600,
  isActive,
  zIndex,
  onClose,
  onFocus,
  onMinimize,
  minimized = false,
}: ChromeWindowProps) {
  const [position, setPosition] = useState(() => getInitialPosition(defaultWidth, defaultHeight));
  const [size, setSize] = useState({ width: defaultWidth, height: defaultHeight });
  const [maximized, setMaximized] = useState(false);
  const [closing, setClosing] = useState(false);
  const [opening, setOpening] = useState(true);
  const [minimizing, setMinimizing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ isDragging: false, startX: 0, startY: 0, startPosX: 0, startPosY: 0 });
  const prevSizeRef = useRef({ width: defaultWidth, height: defaultHeight, x: 0, y: 0 });
  const prevMinimizedRef = useRef(minimized);

  // Opening animation - runs once on mount
  useEffect(() => {
    const timer = setTimeout(() => setOpening(false), 200);
    return () => clearTimeout(timer);
  }, []);

  // Handle minimize state changes - synchronize animation state with minimized prop
  useLayoutEffect(() => {
    const wasMinimized = prevMinimizedRef.current;
    prevMinimizedRef.current = minimized;

    if (minimized && !wasMinimized) {
      // Starting minimize animation
      setMinimizing(true);
    } else if (!minimized && wasMinimized) {
      // Starting restore animation
      setRestoring(true);
      const timer = setTimeout(() => setRestoring(false), 250);
      return () => clearTimeout(timer);
    }
  }, [minimized]);

  const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (maximized) return;
    e.preventDefault();
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
    dragRef.current = {
      isDragging: true,
      startX: clientX,
      startY: clientY,
      startPosX: position.x,
      startPosY: position.y,
    };
    onFocus();
  }, [maximized, position.x, position.y, onFocus]);

  useEffect(() => {
    const handleMove = (e: MouseEvent | TouchEvent) => {
      if (!dragRef.current.isDragging) return;
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
      const dx = clientX - dragRef.current.startX;
      const dy = clientY - dragRef.current.startY;
      setPosition({
        x: dragRef.current.startPosX + dx,
        y: Math.max(0, dragRef.current.startPosY + dy),
      });
    };

    const handleEnd = () => {
      dragRef.current.isDragging = false;
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleEnd);
    window.addEventListener("touchmove", handleMove);
    window.addEventListener("touchend", handleEnd);

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleEnd);
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleEnd);
    };
  }, []);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => onClose(), 150);
  }, [onClose]);

  const handleMaximize = useCallback(() => {
    if (maximized) {
      setSize({ width: prevSizeRef.current.width, height: prevSizeRef.current.height });
      setPosition({ x: prevSizeRef.current.x, y: prevSizeRef.current.y });
      setMaximized(false);
    } else {
      prevSizeRef.current = { width: size.width, height: size.height, x: position.x, y: position.y };
      setMaximized(true);
    }
  }, [maximized, size.width, size.height, position.x, position.y]);

  const handleMinimize = useCallback(() => {
    setMinimizing(true);
    setTimeout(() => {
      setMinimizing(false);
      onMinimize();
    }, 250);
  }, [onMinimize]);

  if (minimized && !restoring) return null;

  const shelfHeight = 56;
  const windowStyle = maximized
    ? { left: 0, top: 0, width: "100%", height: `calc(100vh - ${shelfHeight}px)` }
    : { left: position.x, top: position.y, width: size.width, height: size.height };

  return (
    <div
      ref={windowRef}
      className={`fixed flex flex-col overflow-hidden ${
        opening ? "chrome-window-opening" : ""
      } ${closing ? "chrome-window-closing" : ""} ${
        minimizing ? "chrome-window-minimizing" : ""
      } ${restoring ? "chrome-window-restoring" : ""}`}
      style={{
        ...windowStyle,
        zIndex,
        borderRadius: maximized ? 0 : 12,
        boxShadow: isActive
          ? "0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.1)"
          : "0 4px 16px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.05)",
        backgroundColor: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
      }}
      onMouseDown={onFocus}
    >
      {/* Title bar */}
      <div
        className="flex items-center justify-between h-10 px-3 cursor-default select-none shrink-0"
        style={{
          background: isActive
            ? "linear-gradient(180deg, rgba(30, 41, 57, 0.95) 0%, rgba(23, 32, 48, 0.95) 100%)"
            : "rgba(23, 32, 48, 0.9)",
          borderBottom: "1px solid var(--border-subtle)",
          borderRadius: maximized ? 0 : "12px 12px 0 0",
        }}
        onMouseDown={handleDragStart}
        onTouchStart={handleDragStart}
        onDoubleClick={handleMaximize}
      >
        {/* Left: icon + title */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-5 h-5 flex items-center justify-center shrink-0">{icon}</div>
          <span className="text-sm font-medium text-white/90 truncate">{title}</span>
        </div>

        {/* Right: window controls */}
        <div className="flex items-center gap-1 ml-2">
          {/* Minimize */}
          <button
            onClick={handleMinimize}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/10 transition-colors cursor-pointer"
            title="Minimize"
          >
            <svg className="w-4 h-4 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>

          {/* Maximize */}
          <button
            onClick={handleMaximize}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/10 transition-colors cursor-pointer"
            title={maximized ? "Restore" : "Maximize"}
          >
            {maximized ? (
              <svg className="w-3.5 h-3.5 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="5" y="9" width="10" height="10" rx="1" />
                <path d="M9 9V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-4" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="4" y="4" width="16" height="16" rx="1" />
              </svg>
            )}
          </button>

          {/* Close */}
          <button
            onClick={handleClose}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-red-500/80 transition-colors cursor-pointer"
            title="Close"
          >
            <svg className="w-4 h-4 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden bg-[var(--bg-deep)]">{children}</div>
    </div>
  );
}
