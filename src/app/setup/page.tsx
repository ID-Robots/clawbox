"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import ChromeShelf from "@/components/ChromeShelf";
import ChromeLauncher from "@/components/ChromeLauncher";
import ChromeWindow from "@/components/ChromeWindow";
import SystemTray from "@/components/SystemTray";
import SetupWizard from "@/components/SetupWizard";
import AppStore, { storeApps } from "@/components/AppStore";
import type { StoreApp } from "@/components/AppStore";

const Mascot = dynamic(() => import("@/components/Mascot"), { ssr: false });

// localStorage key for installed apps
const INSTALLED_APPS_KEY = "clawbox-installed-apps";

// App definitions
interface AppDef {
  id: string;
  name: string;
  color: string;
  type: "settings" | "openclaw" | "placeholder" | "external" | "store" | "installed";
  url?: string;
  pinned: boolean;
  defaultWidth?: number;
  defaultHeight?: number;
  storeApp?: StoreApp;
}

const apps: AppDef[] = [
  { id: "settings", name: "Settings", color: "#6b7280", type: "settings", pinned: true, defaultWidth: 800, defaultHeight: 600 },
  { id: "openclaw", name: "OpenClaw", color: "#06b6d4", type: "openclaw", pinned: true, defaultWidth: 900, defaultHeight: 700 },
  { id: "terminal", name: "Terminal", color: "#22c55e", type: "placeholder", pinned: true },
  { id: "files", name: "Files", color: "#f97316", type: "placeholder", pinned: true },
  { id: "store", name: "Store", color: "#22c55e", type: "store", pinned: true, defaultWidth: 900, defaultHeight: 600 },
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
    case "store":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
          <line x1="3" y1="6" x2="21" y2="6" />
          <path d="M16 10a4 4 0 0 1-8 0" />
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

// Icon component for installed store apps
function InstalledAppIcon({ iconType, size = "w-6 h-6" }: { iconType: StoreApp["iconType"]; size?: string }) {
  const iconClass = `${size} text-white`;

  switch (iconType) {
    case "home":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      );
    case "chart":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="20" x2="12" y2="10" />
          <line x1="18" y1="20" x2="18" y2="4" />
          <line x1="6" y1="20" x2="6" y2="16" />
          <polyline points="3 10 8 5 13 10 21 2" />
        </svg>
      );
    case "cloud":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
        </svg>
      );
    case "code":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      );
    case "shield":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
    default:
      return null;
  }
}

// Toast notification component
function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[10010] animate-toast-in">
      <div className="flex items-center gap-3 px-4 py-3 bg-[#1e2939]/95 backdrop-blur-xl rounded-xl border border-white/10 shadow-lg">
        <div className="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center">
          <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <span className="text-sm text-white font-medium">{message}</span>
      </div>
    </div>
  );
}

export default function ChromeDesktop() {
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [openWindows, setOpenWindows] = useState<OpenWindow[]>([]);
  const [nextZIndex, setNextZIndex] = useState(100);
  const [time, setTime] = useState("");
  const [date, setDate] = useState("");
  const [installedApps, setInstalledApps] = useState<string[]>(() => {
    // Lazy initializer - only runs once on mount
    if (typeof window === "undefined") return [];
    try {
      const stored = localStorage.getItem(INSTALLED_APPS_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [toast, setToast] = useState<string | null>(null);
  const [recentlyInstalled, setRecentlyInstalled] = useState<string | null>(null);

  // ─── Desktop icon grid positions ───
  const GRID_COLS = 8;
  const GRID_ROWS = 5;
  const ICON_GRID_KEY = "clawbox-icon-grid";
  const [iconPositions, setIconPositions] = useState<Record<string, { row: number; col: number }>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const saved = localStorage.getItem(ICON_GRID_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });
  const [draggingIcon, setDraggingIcon] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dragGhost, setDragGhost] = useState<{ row: number; col: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Save icon positions
  useEffect(() => {
    try { localStorage.setItem(ICON_GRID_KEY, JSON.stringify(iconPositions)); } catch {}
  }, [iconPositions]);

  // Assign default positions to new icons
  const getIconPosition = useCallback((appId: string, index: number) => {
    if (iconPositions[appId]) return iconPositions[appId];
    // Auto-assign: fill columns top to bottom, left to right
    const col = Math.floor(index / GRID_ROWS) % GRID_COLS;
    const row = index % GRID_ROWS;
    return { row, col };
  }, [iconPositions]);

  const isGridCellOccupied = useCallback((row: number, col: number, excludeId?: string) => {
    return Object.entries(iconPositions).some(
      ([id, pos]) => id !== excludeId && pos.row === row && pos.col === col
    );
  }, [iconPositions]);

  const snapToGrid = useCallback((clientX: number, clientY: number): { row: number; col: number } | null => {
    if (!gridRef.current) return null;
    const rect = gridRef.current.getBoundingClientRect();
    const cellW = rect.width / GRID_COLS;
    const cellH = rect.height / GRID_ROWS;
    const col = Math.floor((clientX - rect.left) / cellW);
    const row = Math.floor((clientY - rect.top) / cellH);
    if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) return null;
    return { row, col };
  }, []);

  const handleIconDragStart = useCallback((appId: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingIcon(appId);
    setDragPos({ x: e.clientX, y: e.clientY });
    const snap = snapToGrid(e.clientX, e.clientY);
    if (snap) setDragGhost(snap);

    const onMove = (ev: PointerEvent) => {
      setDragPos({ x: ev.clientX, y: ev.clientY });
      const s = snapToGrid(ev.clientX, ev.clientY);
      if (s) setDragGhost(s);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const target = snapToGrid(ev.clientX, ev.clientY);
      if (target && !isGridCellOccupied(target.row, target.col, appId)) {
        setIconPositions(prev => ({ ...prev, [appId]: target }));
      }
      setDraggingIcon(null);
      setDragPos(null);
      setDragGhost(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [snapToGrid, isGridCellOccupied]);

  // Save installed apps to localStorage when they change
  useEffect(() => {
    try {
      localStorage.setItem(INSTALLED_APPS_KEY, JSON.stringify(installedApps));
    } catch (e) {
      console.error("Failed to save installed apps:", e);
    }
  }, [installedApps]);

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

  // Install app handler
  const handleInstallApp = useCallback((appId: string) => {
    setInstalledApps((prev) => [...prev, appId]);
    setRecentlyInstalled(appId);
    setToast("App installed!");
    // Clear recently installed animation after delay
    setTimeout(() => setRecentlyInstalled(null), 1000);
  }, []);

  // Uninstall app handler
  const handleUninstallApp = useCallback((appId: string) => {
    setInstalledApps((prev) => prev.filter((id) => id !== appId));
    // Close any windows of this app
    setOpenWindows((prev) => prev.filter((w) => w.appId !== `installed-${appId}`));
    setToast("App uninstalled");
  }, []);

  // Get all apps including installed ones
  const getAllApps = useCallback((): AppDef[] => {
    const installedAppDefs: AppDef[] = [];
    for (const appId of installedApps) {
      const storeApp = storeApps.find((a) => a.id === appId);
      if (storeApp) {
        installedAppDefs.push({
          id: `installed-${appId}`,
          name: storeApp.name,
          color: storeApp.color,
          type: "installed",
          pinned: false,
          defaultWidth: 600,
          defaultHeight: 400,
          storeApp,
        });
      }
    }
    return [...apps, ...installedAppDefs];
  }, [installedApps]);

  const getActiveWindowId = useCallback(() => {
    const visibleWindows = openWindows.filter((w) => !w.minimized);
    if (visibleWindows.length === 0) return null;
    return visibleWindows.reduce((a, b) => (a.zIndex > b.zIndex ? a : b)).id;
  }, [openWindows]);

  const openApp = useCallback((appId: string) => {
    const allApps = getAllApps();
    const app = allApps.find((a) => a.id === appId);
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
  }, [openWindows, nextZIndex, getAllApps]);

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
    const allApps = getAllApps();
    const app = allApps.find((a) => a.id === appId);
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
            src={`http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:${process.env.NEXT_PUBLIC_GATEWAY_PORT || '18789'}`}
            className="w-full h-full border-0"
            title="OpenClaw Control"
          />
        );
      case "store":
        return (
          <AppStore
            installedApps={installedApps}
            onInstall={handleInstallApp}
            onUninstall={handleUninstallApp}
          />
        );
      case "installed":
        return (
          <div className="h-full flex flex-col items-center justify-center gap-6 text-white/60 p-8">
            <div
              className="w-24 h-24 rounded-2xl flex items-center justify-center shadow-lg"
              style={{ backgroundColor: app.color }}
            >
              {app.storeApp && <InstalledAppIcon iconType={app.storeApp.iconType} size="w-12 h-12" />}
            </div>
            <div className="text-center max-w-md">
              <h2 className="text-2xl font-semibold text-white mb-2">
                {app.name}
              </h2>
              <div className="flex items-center justify-center gap-2 mb-4">
                <span className="px-2 py-0.5 bg-green-500/20 text-green-400 text-xs font-medium rounded-full">
                  Installed
                </span>
                {app.storeApp && (
                  <span className="flex items-center gap-1 text-xs text-white/50">
                    <svg className="w-3 h-3 text-yellow-400 fill-current" viewBox="0 0 24 24">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                    {app.storeApp.rating.toFixed(1)}
                  </span>
                )}
              </div>
              <p className="text-sm text-white/50 mb-6">
                {app.storeApp?.description}
              </p>
              <a
                href="https://openclawhardware.dev/store"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/15 border border-white/10 rounded-lg text-sm text-white/70 hover:text-white transition-colors"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                Configure in Store
              </a>
            </div>
          </div>
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

  // Get installed apps for desktop display
  const installedAppDefs = installedApps
    .map((appId) => storeApps.find((a) => a.id === appId))
    .filter((a): a is StoreApp => a !== null);

  // Get all apps for launcher (including installed)
  const allAppsForLauncher = getAllApps();

  return (
    <div className="min-h-screen relative overflow-hidden select-none">
      {/* Desktop wallpaper background */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a0f1a] via-[#111827] to-[#1a1f2e] z-0" />
      <div className="absolute inset-0 bg-stars z-0" />
      <div className="absolute inset-0 bg-nebula z-0" />

      {/* Desktop icon grid — draggable */}
      <div ref={gridRef} className="absolute inset-0 z-[1] pointer-events-none" style={{ paddingBottom: 56 }}>
        {installedAppDefs.map((app, i) => {
          const pos = getIconPosition(app.id, i);
          const isBeingDragged = draggingIcon === app.id;
          const isRecent = recentlyInstalled === app.id;
          const cellW = 100 / GRID_COLS;
          const cellH = 100 / GRID_ROWS;

          return (
            <div
              key={app.id}
              data-crab-platform="true"
              style={isBeingDragged && dragPos ? {
                position: "fixed",
                left: dragPos.x - 40,
                top: dragPos.y - 40,
                zIndex: 9999,
                opacity: 0.85,
                pointerEvents: "none",
                transition: "none",
              } : {
                position: "absolute",
                left: `${pos.col * cellW}%`,
                top: `${pos.row * cellH}%`,
                width: `${cellW}%`,
                height: `${cellH}%`,
                transition: "left 0.2s, top 0.2s",
              }}
              className="flex items-center justify-center pointer-events-auto"
            >
              <button
                onPointerDown={(e) => handleIconDragStart(app.id, e)}
                onClick={() => { if (!draggingIcon) openApp(`installed-${app.id}`); }}
                className={`group flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-white/10 active:bg-white/15 transition-all duration-200 select-none touch-none ${
                  isRecent ? "animate-install-bounce" : ""
                }`}
              >
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-transform duration-200 group-hover:scale-105 group-active:scale-95"
                  style={{ backgroundColor: app.color }}
                >
                  <InstalledAppIcon iconType={app.iconType} size="w-7 h-7" />
                </div>
                <span className="text-xs text-white/80 font-medium text-center line-clamp-1 max-w-[80px]">
                  {app.name}
                </span>
              </button>
            </div>
          );
        })}

        {/* Ghost indicator for drop target */}
        {draggingIcon && dragGhost && (
          <div
            style={{
              position: "absolute",
              left: `${dragGhost.col * (100 / GRID_COLS)}%`,
              top: `${dragGhost.row * (100 / GRID_ROWS)}%`,
              width: `${100 / GRID_COLS}%`,
              height: `${100 / GRID_ROWS}%`,
            }}
            className="flex items-center justify-center pointer-events-none"
          >
            <div className="w-16 h-16 rounded-2xl border-2 border-dashed border-white/30 bg-white/5" />
          </div>
        )}
      </div>

      {/* Mascot - only show when no windows are maximized */}
      <Mascot />

      {/* Windows */}
      {openWindows.map((window) => {
        const allApps = getAllApps();
        const app = allApps.find((a) => a.id === window.appId);
        if (!app) return null;

        // Render icon based on app type
        const renderWindowIcon = () => {
          if (app.type === "installed" && app.storeApp) {
            return (
              <div
                className="w-5 h-5 rounded flex items-center justify-center"
                style={{ backgroundColor: app.color }}
              >
                <InstalledAppIcon iconType={app.storeApp.iconType} size="w-3 h-3" />
              </div>
            );
          }
          return (
            <div
              className="w-5 h-5 rounded flex items-center justify-center"
              style={{ backgroundColor: app.color }}
            >
              <AppIcon id={app.id} size="w-3 h-3" />
            </div>
          );
        };

        return (
          <ChromeWindow
            key={window.id}
            title={app.name}
            icon={renderWindowIcon()}
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
        apps={allAppsForLauncher.map((app) => {
          if (app.type === "installed" && app.storeApp) {
            return {
              id: app.id,
              name: app.name,
              color: app.color,
              icon: <InstalledAppIcon iconType={app.storeApp.iconType} />,
            };
          }
          return {
            id: app.id,
            name: app.name,
            color: app.color,
            icon: <AppIcon id={app.id} />,
          };
        })}
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

      {/* Toast notification */}
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
