"use client";

import { useState, useRef, useCallback, useEffect, useLayoutEffect, ReactNode } from "react";
import { createPortal } from "react-dom";

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

type SnapZone = "left" | "right" | "top" | "top-left" | "top-right" | "bottom-left" | "bottom-right" | null;

const SNAP_THRESHOLD = 12; // pixels from edge to trigger snap
const SHELF_HEIGHT = 56;

function getSnapZone(clientX: number, clientY: number): SnapZone {
  const w = window.innerWidth;
  const h = window.innerHeight - SHELF_HEIGHT;
  const nearLeft = clientX <= SNAP_THRESHOLD;
  const nearRight = clientX >= w - SNAP_THRESHOLD;
  const nearTop = clientY <= SNAP_THRESHOLD;
  const nearBottom = clientY >= h - SNAP_THRESHOLD;

  if (nearTop && nearLeft) return "top-left";
  if (nearTop && nearRight) return "top-right";
  if (nearBottom && nearLeft) return "bottom-left";
  if (nearBottom && nearRight) return "bottom-right";
  if (nearLeft) return "left";
  if (nearRight) return "right";
  if (nearTop) return "top";
  return null;
}

function getSnapRect(zone: SnapZone): { x: number; y: number; width: number; height: number } | null {
  if (!zone) return null;
  const w = window.innerWidth;
  const h = window.innerHeight - SHELF_HEIGHT;
  switch (zone) {
    case "left": return { x: 0, y: 0, width: w / 2, height: h };
    case "right": return { x: w / 2, y: 0, width: w / 2, height: h };
    case "top": return { x: 0, y: 0, width: w, height: h };
    case "top-left": return { x: 0, y: 0, width: w / 2, height: h / 2 };
    case "top-right": return { x: w / 2, y: 0, width: w / 2, height: h / 2 };
    case "bottom-left": return { x: 0, y: h / 2, width: w / 2, height: h / 2 };
    case "bottom-right": return { x: w / 2, y: h / 2, width: w / 2, height: h / 2 };
    default: return null;
  }
}

// Calculate initial centered position
function getInitialPosition(width: number, height: number) {
  if (typeof window === "undefined") return { x: 100, y: 50 };
  const maxWidth = window.innerWidth;
  const maxHeight = window.innerHeight - SHELF_HEIGHT;
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
  const [snapped, setSnapped] = useState<SnapZone>(null);
  const [snapPreview, setSnapPreview] = useState<SnapZone>(null);
  const [closing, setClosing] = useState(false);
  const [opening, setOpening] = useState(true);
  const [minimizing, setMinimizing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ isDragging: false, startX: 0, startY: 0, startPosX: 0, startPosY: 0 });
  const prevSizeRef = useRef({ width: defaultWidth, height: defaultHeight, x: 0, y: 0 });
  const currentSizeRef = useRef({ width: defaultWidth, height: defaultHeight });
  const currentPosRef = useRef(position);
  const prevMinimizedRef = useRef(minimized);

  currentSizeRef.current = size;
  currentPosRef.current = position;

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

    // If snapped, restore to pre-snap size and center on cursor
    if (snapped) {
      const restoreW = prevSizeRef.current.width;
      const restoreH = prevSizeRef.current.height;
      const newX = clientX - restoreW / 2;
      const newY = clientY - 18; // center on titlebar
      setSize({ width: restoreW, height: restoreH });
      setPosition({ x: newX, y: Math.max(0, newY) });
      setSnapped(null);
      dragRef.current = {
        isDragging: true,
        startX: clientX,
        startY: clientY,
        startPosX: newX,
        startPosY: Math.max(0, newY),
      };
    } else {
      dragRef.current = {
        isDragging: true,
        startX: clientX,
        startY: clientY,
        startPosX: position.x,
        startPosY: position.y,
      };
    }
    onFocus();
  }, [maximized, snapped, position.x, position.y, onFocus]);

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
      setSnapPreview(getSnapZone(clientX, clientY));
    };

    const handleEnd = (e: MouseEvent | TouchEvent) => {
      if (!dragRef.current.isDragging) return;
      dragRef.current.isDragging = false;

      const clientX = "changedTouches" in e ? e.changedTouches[0].clientX : (e as MouseEvent).clientX;
      const clientY = "changedTouches" in e ? e.changedTouches[0].clientY : (e as MouseEvent).clientY;
      const zone = getSnapZone(clientX, clientY);
      setSnapPreview(null);

      if (zone) {
        const rect = getSnapRect(zone)!;
        // Save pre-snap size for restore
        const cur = currentSizeRef.current;
        const pos = currentPosRef.current;
        prevSizeRef.current = { width: cur.width, height: cur.height, x: pos.x, y: pos.y };
        setPosition({ x: rect.x, y: rect.y });
        setSize({ width: rect.width, height: rect.height });
        setSnapped(zone);
      }
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
      // If snapped, save pre-snap size; otherwise save current
      if (!snapped) {
        prevSizeRef.current = { width: size.width, height: size.height, x: position.x, y: position.y };
      }
      setSnapped(null);
      setMaximized(true);
    }
  }, [maximized, snapped, size.width, size.height, position.x, position.y]);

  const handleMinimize = useCallback(() => {
    setMinimizing(true);
    setTimeout(() => {
      setMinimizing(false);
      onMinimize();
    }, 250);
  }, [onMinimize]);

  if (minimized && !restoring) return null;

  const windowStyle = maximized
    ? { left: 0, top: 0, width: "100%", height: `calc(100vh - ${SHELF_HEIGHT}px)` }
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
        borderRadius: maximized || snapped ? 0 : 8,
        boxShadow: isActive
          ? "0 12px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08)"
          : "0 4px 20px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.04)",
        opacity: 1,
        transition: snapped && !dragRef.current.isDragging
          ? "left 0.2s ease-out, top 0.2s ease-out, width 0.2s ease-out, height 0.2s ease-out, opacity 0.15s, box-shadow 0.15s"
          : "opacity 0.15s, box-shadow 0.15s",
      }}
      onMouseDown={onFocus}
    >
      {/* Title bar — ChromeOS style */}
      <div
        className="flex items-center h-9 px-2 cursor-default select-none shrink-0"
        style={{
          background: isActive
            ? "linear-gradient(180deg, #292d36 0%, #242830 100%)"
            : "#1f2228",
          borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
          borderRadius: maximized || snapped ? 0 : "8px 8px 0 0",
        }}
        onMouseDown={handleDragStart}
        onTouchStart={handleDragStart}
        onDoubleClick={handleMaximize}
      >
        {/* Left: icon + title */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="w-4 h-4 flex items-center justify-center shrink-0">{icon}</div>
          <span className={`text-xs font-medium truncate ${isActive ? "text-white/80" : "text-white/50"}`}>{title}</span>
        </div>

        {/* Right: window controls — ChromeOS circular buttons */}
        <div className="flex items-center gap-1.5 ml-2">
          {/* Minimize */}
          <button
            onClick={handleMinimize}
            className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-white/10 active:bg-white/20 transition-colors cursor-pointer"
            title="Minimize"
          >
            <svg className="w-3 h-3 text-white/60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="6" y1="12" x2="18" y2="12" />
            </svg>
          </button>

          {/* Maximize */}
          <button
            onClick={handleMaximize}
            className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-white/10 active:bg-white/20 transition-colors cursor-pointer"
            title={maximized ? "Restore" : "Maximize"}
          >
            {maximized ? (
              <svg className="w-3 h-3 text-white/60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="6" y="10" width="8" height="8" rx="1" />
                <path d="M10 10V7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-3" />
              </svg>
            ) : (
              <svg className="w-3 h-3 text-white/60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="5" y="5" width="14" height="14" rx="1" />
              </svg>
            )}
          </button>

          {/* Fullscreen */}
          <button
            onClick={() => {
              const el = document.documentElement;
              if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
              } else {
                el.requestFullscreen().catch(() => {});
              }
            }}
            className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-white/10 active:bg-white/20 transition-colors cursor-pointer"
            title="Fullscreen"
          >
            <svg className="w-3 h-3 text-white/60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
            </svg>
          </button>

          {/* Close */}
          <button
            onClick={handleClose}
            className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-red-500/80 active:bg-red-600 transition-colors cursor-pointer group"
            title="Close"
          >
            <svg className="w-3 h-3 text-white/60 group-hover:text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="7" y1="7" x2="17" y2="17" />
              <line x1="7" y1="17" x2="17" y2="7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden bg-[#181c22]">{children}</div>

      {/* Snap preview overlay */}
      {snapPreview && createPortal(
        <SnapPreviewOverlay zone={snapPreview} />,
        document.body
      )}
    </div>
  );
}

function SnapPreviewOverlay({ zone }: { zone: SnapZone }) {
  const rect = getSnapRect(zone);
  if (!rect) return null;
  return (
    <div
      style={{
        position: "fixed",
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        background: "rgba(59, 130, 246, 0.15)",
        border: "2px solid rgba(59, 130, 246, 0.5)",
        borderRadius: 8,
        zIndex: 99999,
        pointerEvents: "none",
        transition: "all 0.15s ease-out",
      }}
    />
  );
}
