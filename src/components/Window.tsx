"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import type { WindowState } from "@/hooks/useWindows";
import SetupWizard from "./SetupWizard";

interface WindowProps {
  window: WindowState;
  onClose: (id: string) => void;
  onMinimize: (id: string) => void;
  onMaximize: (id: string) => void;
  onFocus: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  onResize: (id: string, width: number, height: number, x?: number, y?: number) => void;
  onFinishClosing: (id: string) => void;
  onFinishOpening: (id: string) => void;
  content: "settings" | "openclaw" | "placeholder";
}

type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | null;

export default function Window({
  window: win,
  onClose,
  onMinimize,
  onMaximize,
  onFocus,
  onMove,
  onResize,
  onFinishClosing,
  onFinishOpening,
  content,
}: WindowProps) {
  const windowRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeDirection, setResizeDirection] = useState<ResizeDirection>(null);
  const dragStart = useRef({ x: 0, y: 0, winX: 0, winY: 0 });
  const resizeStart = useRef({ x: 0, y: 0, width: 0, height: 0, winX: 0, winY: 0 });

  // Handle open/close animation completion
  useEffect(() => {
    if (win.isOpening) {
      const timer = setTimeout(() => onFinishOpening(win.id), 200);
      return () => clearTimeout(timer);
    }
  }, [win.isOpening, win.id, onFinishOpening]);

  useEffect(() => {
    if (win.isClosing) {
      const timer = setTimeout(() => onFinishClosing(win.id), 150);
      return () => clearTimeout(timer);
    }
  }, [win.isClosing, win.id, onFinishClosing]);

  // Drag handlers
  const handleTitleBarMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (win.isMaximized) return;
      e.preventDefault();
      setIsDragging(true);
      onFocus(win.id);
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        winX: win.x,
        winY: win.y,
      };
    },
    [win.isMaximized, win.id, win.x, win.y, onFocus]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - dragStart.current.x;
      const deltaY = e.clientY - dragStart.current.y;
      const newX = Math.max(0, dragStart.current.winX + deltaX);
      const newY = Math.max(0, dragStart.current.winY + deltaY);
      onMove(win.id, newX, newY);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, win.id, onMove]);

  // Resize handlers
  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent, direction: ResizeDirection) => {
      if (win.isMaximized) return;
      e.preventDefault();
      e.stopPropagation();
      setIsResizing(true);
      setResizeDirection(direction);
      onFocus(win.id);
      resizeStart.current = {
        x: e.clientX,
        y: e.clientY,
        width: win.width,
        height: win.height,
        winX: win.x,
        winY: win.y,
      };
    },
    [win.isMaximized, win.id, win.width, win.height, win.x, win.y, onFocus]
  );

  useEffect(() => {
    if (!isResizing || !resizeDirection) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - resizeStart.current.x;
      const deltaY = e.clientY - resizeStart.current.y;

      let newWidth = resizeStart.current.width;
      let newHeight = resizeStart.current.height;
      let newX: number | undefined;
      let newY: number | undefined;

      if (resizeDirection.includes("e")) {
        newWidth = resizeStart.current.width + deltaX;
      }
      if (resizeDirection.includes("w")) {
        newWidth = resizeStart.current.width - deltaX;
        newX = resizeStart.current.winX + deltaX;
        if (newWidth < win.minWidth) {
          newX = resizeStart.current.winX + (resizeStart.current.width - win.minWidth);
        }
      }
      if (resizeDirection.includes("s")) {
        newHeight = resizeStart.current.height + deltaY;
      }
      if (resizeDirection.includes("n")) {
        newHeight = resizeStart.current.height - deltaY;
        newY = resizeStart.current.winY + deltaY;
        if (newHeight < win.minHeight) {
          newY = resizeStart.current.winY + (resizeStart.current.height - win.minHeight);
        }
      }

      onResize(win.id, newWidth, newHeight, newX, newY);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      setResizeDirection(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, resizeDirection, win.id, win.minWidth, win.minHeight, onResize]);

  // Double-click to maximize
  const handleTitleBarDoubleClick = useCallback(() => {
    onMaximize(win.id);
  }, [win.id, onMaximize]);

  // Render content based on type
  const renderContent = () => {
    switch (content) {
      case "settings":
        return (
          <div className="w-full h-full overflow-auto bg-[var(--bg-deep)]">
            <SetupWizard />
          </div>
        );
      case "openclaw":
        return (
          <iframe
            src="/"
            className="w-full h-full border-0"
            title="OpenClaw Control"
          />
        );
      case "placeholder":
      default:
        return (
          <div className="w-full h-full flex items-center justify-center bg-[var(--bg-deep)]">
            <div className="text-center">
              <div className="text-4xl mb-4 opacity-50">🚧</div>
              <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-2">
                Coming Soon
              </h2>
              <p className="text-sm text-[var(--text-muted)]">
                This feature is under development
              </p>
            </div>
          </div>
        );
    }
  };

  // Calculate styles
  const windowStyle: React.CSSProperties = win.isMaximized
    ? {
        position: "fixed",
        top: 60,
        left: 0,
        width: "100%",
        height: "calc(100% - 120px)",
        zIndex: win.zIndex,
        transition: "all 0.2s ease-out",
      }
    : {
        position: "absolute",
        top: win.y,
        left: win.x,
        width: win.width,
        height: win.height,
        zIndex: win.zIndex,
        transition: isDragging || isResizing ? "none" : undefined,
      };

  // Animation classes
  let animationClass = "";
  if (win.isOpening) {
    animationClass = "window-opening";
  } else if (win.isClosing) {
    animationClass = "window-closing";
  } else if (win.isMinimized) {
    animationClass = "window-minimizing";
  }

  if (win.isMinimized && !win.isClosing) {
    return null; // Hidden when minimized
  }

  return (
    <div
      ref={windowRef}
      className={`flex flex-col rounded-xl overflow-hidden shadow-2xl border border-[var(--border-subtle)] ${animationClass}`}
      style={windowStyle}
      onMouseDown={() => onFocus(win.id)}
    >
      {/* Title Bar */}
      <div
        className="flex items-center justify-between h-10 px-3 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] select-none shrink-0"
        onMouseDown={handleTitleBarMouseDown}
        onDoubleClick={handleTitleBarDoubleClick}
        style={{ cursor: win.isMaximized ? "default" : "move" }}
      >
        {/* Left: Traffic lights (macOS style) */}
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose(win.id);
            }}
            className="w-3 h-3 rounded-full bg-[#ff5f57] hover:brightness-90 transition-all flex items-center justify-center group"
            title="Close"
          >
            <svg
              width="6"
              height="6"
              viewBox="0 0 6 6"
              className="opacity-0 group-hover:opacity-100 transition-opacity"
              stroke="#4a0002"
              strokeWidth="1.5"
            >
              <line x1="1" y1="1" x2="5" y2="5" />
              <line x1="5" y1="1" x2="1" y2="5" />
            </svg>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMinimize(win.id);
            }}
            className="w-3 h-3 rounded-full bg-[#febc2e] hover:brightness-90 transition-all flex items-center justify-center group"
            title="Minimize"
          >
            <svg
              width="6"
              height="2"
              viewBox="0 0 6 2"
              className="opacity-0 group-hover:opacity-100 transition-opacity"
              stroke="#985700"
              strokeWidth="1.5"
            >
              <line x1="0" y1="1" x2="6" y2="1" />
            </svg>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMaximize(win.id);
            }}
            className="w-3 h-3 rounded-full bg-[#28c840] hover:brightness-90 transition-all flex items-center justify-center group"
            title={win.isMaximized ? "Restore" : "Maximize"}
          >
            <svg
              width="6"
              height="6"
              viewBox="0 0 6 6"
              className="opacity-0 group-hover:opacity-100 transition-opacity"
              fill="#006500"
            >
              {win.isMaximized ? (
                // Restore icon (two overlapping squares)
                <>
                  <rect x="0" y="2" width="4" height="4" fill="none" stroke="#006500" strokeWidth="0.8" />
                  <rect x="2" y="0" width="4" height="4" fill="none" stroke="#006500" strokeWidth="0.8" />
                </>
              ) : (
                // Maximize icon (diagonal arrows)
                <>
                  <path d="M0 6 L6 0" stroke="#006500" strokeWidth="1" />
                  <path d="M4 0 L6 0 L6 2" fill="none" stroke="#006500" strokeWidth="1" />
                  <path d="M0 4 L0 6 L2 6" fill="none" stroke="#006500" strokeWidth="1" />
                </>
              )}
            </svg>
          </button>
        </div>

        {/* Center: Title with icon */}
        <div className="flex items-center gap-2 absolute left-1/2 transform -translate-x-1/2">
          <span className="w-4 h-4 flex items-center justify-center">{win.icon}</span>
          <span className="text-sm text-[var(--text-secondary)] font-medium truncate max-w-48">
            {win.title}
          </span>
        </div>

        {/* Right: Spacer for symmetry */}
        <div className="w-16" />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden bg-[var(--bg-deep)]">
        {renderContent()}
      </div>

      {/* Resize handles (only when not maximized) */}
      {!win.isMaximized && (
        <>
          {/* Edges */}
          <div
            className="absolute top-0 left-2 right-2 h-1 cursor-n-resize"
            onMouseDown={(e) => handleResizeMouseDown(e, "n")}
          />
          <div
            className="absolute bottom-0 left-2 right-2 h-1 cursor-s-resize"
            onMouseDown={(e) => handleResizeMouseDown(e, "s")}
          />
          <div
            className="absolute left-0 top-2 bottom-2 w-1 cursor-w-resize"
            onMouseDown={(e) => handleResizeMouseDown(e, "w")}
          />
          <div
            className="absolute right-0 top-2 bottom-2 w-1 cursor-e-resize"
            onMouseDown={(e) => handleResizeMouseDown(e, "e")}
          />

          {/* Corners */}
          <div
            className="absolute top-0 left-0 w-3 h-3 cursor-nw-resize"
            onMouseDown={(e) => handleResizeMouseDown(e, "nw")}
          />
          <div
            className="absolute top-0 right-0 w-3 h-3 cursor-ne-resize"
            onMouseDown={(e) => handleResizeMouseDown(e, "ne")}
          />
          <div
            className="absolute bottom-0 left-0 w-3 h-3 cursor-sw-resize"
            onMouseDown={(e) => handleResizeMouseDown(e, "sw")}
          />
          <div
            className="absolute bottom-0 right-0 w-3 h-3 cursor-se-resize"
            onMouseDown={(e) => handleResizeMouseDown(e, "se")}
          />
        </>
      )}
    </div>
  );
}
