"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import ChromeShelf from "@/components/ChromeShelf";
import ChromeLauncher from "@/components/ChromeLauncher";
import ChromeWindow from "@/components/ChromeWindow";
import SystemTray from "@/components/SystemTray";
import SetupWizard from "@/components/SetupWizard";

const Mascot = dynamic(() => import("@/components/Mascot"), { ssr: false });

// App definitions
interface AppDef {
  id: string;
  name: string;
  color: string;
  type: "settings" | "openclaw" | "placeholder" | "external";
  url?: string;
  pinned: boolean;
  defaultWidth?: number;
  defaultHeight?: number;
}

const apps: AppDef[] = [
  { id: "settings", name: "Settings", color: "#6b7280", type: "settings", pinned: true, defaultWidth: 800, defaultHeight: 600 },
  { id: "openclaw", name: "OpenClaw", color: "#06b6d4", type: "openclaw", pinned: true, defaultWidth: 900, defaultHeight: 700 },
  { id: "terminal", name: "Terminal", color: "#22c55e", type: "placeholder", pinned: true },
  { id: "files", name: "Files", color: "#f97316", type: "placeholder", pinned: true },
  { id: "system", name: "System Monitor", color: "#3b82f6", type: "placeholder", pinned: false },
  { id: "ollama", name: "Ollama", color: "#a855f7", type: "placeholder", pinned: false },
  { id: "network", name: "Network", color: "#14b8a6", type: "placeholder", pinned: false },
  { id: "help", name: "Help", color: "#ec4899", type: "external", url: "https://docs.openclaw.ai", pinned: false },
  { id: "browser", name: "Browser", color: "#ef4444", type: "placeholder", pinned: false },
  { id: "camera", name: "Camera", color: "#eab308", type: "placeholder", pinned: false },
];

// Inline SVG icons for each app
function AppIcon({ id, size = "w-6 h-6" }: { id: string; size?: string }) {
  const iconClass = `${size} text-white`;

  switch (id) {
    case "settings":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case "openclaw":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
          <circle cx="12" cy="12" r="2" fill="currentColor" />
        </svg>
      );
    case "terminal":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      );
    case "system":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
          <polyline points="6 10 10 8 14 12 18 7" />
        </svg>
      );
    case "ollama":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2a4 4 0 0 0-4 4v2a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4z" />
          <path d="M6 10a6 6 0 0 0 12 0" />
          <path d="M12 16v6" />
          <path d="M8 22h8" />
          <circle cx="10" cy="6" r="1" fill="currentColor" />
          <circle cx="14" cy="6" r="1" fill="currentColor" />
        </svg>
      );
    case "files":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "network":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.55a11 11 0 0 1 14.08 0" />
          <path d="M1.42 9a16 16 0 0 1 21.16 0" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <circle cx="12" cy="20" r="1" fill="currentColor" />
        </svg>
      );
    case "help":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
    case "browser":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      );
    case "camera":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      );
    default:
      return null;
  }
}

interface OpenWindow {
  id: string;
  appId: string;
  zIndex: number;
  minimized: boolean;
}

export default function ChromeDesktop() {
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [openWindows, setOpenWindows] = useState<OpenWindow[]>([]);
  const [nextZIndex, setNextZIndex] = useState(100);
  const [time, setTime] = useState("");
  const [date, setDate] = useState("");

  // Update clock
  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      setTime(now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      setDate(now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }));
    };
    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => clearInterval(interval);
  }, []);

  const getActiveWindowId = useCallback(() => {
    const visibleWindows = openWindows.filter((w) => !w.minimized);
    if (visibleWindows.length === 0) return null;
    return visibleWindows.reduce((a, b) => (a.zIndex > b.zIndex ? a : b)).id;
  }, [openWindows]);

  const openApp = useCallback((appId: string) => {
    const app = apps.find((a) => a.id === appId);
    if (!app) return;

    if (app.type === "external" && app.url) {
      window.open(app.url, "_blank", "noopener,noreferrer");
      return;
    }

    // Check if app is already open
    const existingWindow = openWindows.find((w) => w.appId === appId);
    if (existingWindow) {
      // If minimized, restore it; otherwise bring to front
      if (existingWindow.minimized) {
        setOpenWindows((prev) =>
          prev.map((w) =>
            w.id === existingWindow.id
              ? { ...w, minimized: false, zIndex: nextZIndex }
              : w
          )
        );
        setNextZIndex((z) => z + 1);
      } else {
        // Bring to front
        setOpenWindows((prev) =>
          prev.map((w) =>
            w.id === existingWindow.id ? { ...w, zIndex: nextZIndex } : w
          )
        );
        setNextZIndex((z) => z + 1);
      }
      return;
    }

    // Open new window
    const windowId = `${appId}-${Date.now()}`;
    setOpenWindows((prev) => [
      ...prev,
      { id: windowId, appId, zIndex: nextZIndex, minimized: false },
    ]);
    setNextZIndex((z) => z + 1);
  }, [openWindows, nextZIndex]);

  const closeWindow = useCallback((windowId: string) => {
    setOpenWindows((prev) => prev.filter((w) => w.id !== windowId));
  }, []);

  const focusWindow = useCallback((windowId: string) => {
    setOpenWindows((prev) =>
      prev.map((w) => (w.id === windowId ? { ...w, zIndex: nextZIndex } : w))
    );
    setNextZIndex((z) => z + 1);
  }, [nextZIndex]);

  const minimizeWindow = useCallback((windowId: string) => {
    setOpenWindows((prev) =>
      prev.map((w) => (w.id === windowId ? { ...w, minimized: true } : w))
    );
  }, []);

  const handleShelfAppClick = useCallback((appId: string) => {
    const window = openWindows.find((w) => w.appId === appId);
    if (window) {
      if (window.minimized) {
        // Restore
        setOpenWindows((prev) =>
          prev.map((w) =>
            w.id === window.id
              ? { ...w, minimized: false, zIndex: nextZIndex }
              : w
          )
        );
        setNextZIndex((z) => z + 1);
      } else if (getActiveWindowId() === window.id) {
        // Minimize if already focused
        minimizeWindow(window.id);
      } else {
        // Bring to front
        focusWindow(window.id);
      }
    } else {
      openApp(appId);
    }
  }, [openWindows, openApp, minimizeWindow, focusWindow, getActiveWindowId, nextZIndex]);

  const pinnedApps = apps.filter((a) => a.pinned);

  const renderWindowContent = (appId: string) => {
    const app = apps.find((a) => a.id === appId);
    if (!app) return null;

    switch (app.type) {
      case "settings":
        return (
          <div className="h-full overflow-y-auto">
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
        return (
          <div className="h-full flex flex-col items-center justify-center gap-4 text-white/60">
            <div
              className="w-20 h-20 rounded-full flex items-center justify-center"
              style={{ backgroundColor: app.color }}
            >
              <AppIcon id={app.id} size="w-10 h-10" />
            </div>
            <div className="text-center">
              <h2 className="text-xl font-medium text-white/80 mb-1">
                {app.name}
              </h2>
              <p className="text-sm">Coming Soon</p>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  const activeWindowId = getActiveWindowId();

  return (
    <div className="min-h-screen relative overflow-hidden select-none">
      {/* Desktop wallpaper background */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a0f1a] via-[#111827] to-[#1a1f2e] z-0" />
      <div className="absolute inset-0 bg-stars z-0" />
      <div className="absolute inset-0 bg-nebula z-0" />

      {/* Mascot - only show when no windows are maximized */}
      <Mascot />

      {/* Windows */}
      {openWindows.map((window) => {
        const app = apps.find((a) => a.id === window.appId);
        if (!app) return null;

        return (
          <ChromeWindow
            key={window.id}
            title={app.name}
            icon={
              <div
                className="w-5 h-5 rounded flex items-center justify-center"
                style={{ backgroundColor: app.color }}
              >
                <AppIcon id={app.id} size="w-3 h-3" />
              </div>
            }
            defaultWidth={app.defaultWidth}
            defaultHeight={app.defaultHeight}
            isActive={window.id === activeWindowId}
            zIndex={window.zIndex}
            onClose={() => closeWindow(window.id)}
            onFocus={() => focusWindow(window.id)}
            onMinimize={() => minimizeWindow(window.id)}
            minimized={window.minimized}
          >
            {renderWindowContent(window.appId)}
          </ChromeWindow>
        );
      })}

      {/* App Launcher */}
      <ChromeLauncher
        apps={apps.map((app) => ({
          id: app.id,
          name: app.name,
          color: app.color,
          icon: <AppIcon id={app.id} />,
        }))}
        isOpen={launcherOpen}
        onClose={() => setLauncherOpen(false)}
        onAppClick={openApp}
      />

      {/* System Tray */}
      <SystemTray
        isOpen={trayOpen}
        onClose={() => setTrayOpen(false)}
        date={date}
        time={time}
      />

      {/* Shelf (taskbar) */}
      <ChromeShelf
        apps={pinnedApps.map((app) => {
          const window = openWindows.find((w) => w.appId === app.id);
          return {
            id: app.id,
            name: app.name,
            icon: (
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center"
                style={{ backgroundColor: app.color }}
              >
                <AppIcon id={app.id} />
              </div>
            ),
            isOpen: !!window,
            isActive: window?.id === activeWindowId && !window?.minimized,
          };
        })}
        onAppClick={handleShelfAppClick}
        onLauncherClick={() => {
          setTrayOpen(false);
          setLauncherOpen((prev) => !prev);
        }}
        onTrayClick={() => {
          setLauncherOpen(false);
          setTrayOpen((prev) => !prev);
        }}
        time={time}
      />
    </div>
  );
}
