"use client";

import { useEffect, useState, useCallback } from "react";
import { AndroidStatusBar } from "./AndroidStatusBar";
import { AndroidNavBar } from "./AndroidNavBar";

interface FullScreenAppProps {
  title: string;
  children?: React.ReactNode;
  onClose: () => void;
}

export function FullScreenApp({ title, children, onClose }: FullScreenAppProps) {
  const [isClosing, setIsClosing] = useState(false);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
    }, 250);
  }, [onClose]);

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleClose]);

  // Prevent body scroll when app is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  return (
    <div
      className={`fixed inset-0 z-[90] bg-[#0a0a0f] ${
        isClosing ? "animate-slide-down" : "animate-slide-up"
      }`}
    >
      {/* Status bar */}
      <AndroidStatusBar />

      {/* App header bar with back arrow */}
      <div
        className="absolute left-0 right-0 h-14 px-4 flex items-center gap-3 bg-black/20 border-b border-white/5"
        style={{ top: "28px" }}
      >
        <button
          onClick={handleClose}
          className="p-2 -ml-2 rounded-full hover:bg-white/10 active:bg-white/20 transition-colors cursor-pointer"
          aria-label="Back"
        >
          <span className="material-symbols-rounded text-white/80" style={{ fontSize: 24 }}>arrow_back</span>
        </button>
        <h1 className="text-lg font-medium text-white/90">{title}</h1>
      </div>

      {/* Content area */}
      <div
        className="absolute left-0 right-0 overflow-hidden bg-[#0a0a0f]"
        style={{
          top: "84px", // 28px status bar + 56px header
          bottom: "32px", // Above nav bar
        }}
      >
        {children}
      </div>

      {/* Navigation bar */}
      <AndroidNavBar onHome={handleClose} />
    </div>
  );
}
