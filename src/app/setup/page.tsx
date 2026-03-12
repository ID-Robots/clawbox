"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import ChromeShelf from "@/components/ChromeShelf";
import ChromeLauncher from "@/components/ChromeLauncher";
import ChromeWindow from "@/components/ChromeWindow";
import SystemTray from "@/components/SystemTray";
import SetupWizard from "@/components/SetupWizard";
import AppStore, { storeApps } from "@/components/AppStore";
import FilesApp from "@/components/FilesApp";
import SystemApp from "@/components/SystemApp";
import type { StoreApp } from "@/components/AppStore";
import TerminalApp from "@/components/TerminalApp";

const Mascot = dynamic(() => import("@/components/Mascot"), { ssr: false });

// localStorage key for installed apps
const INSTALLED_APPS_KEY = "clawbox-installed-apps";

// App definitions
interface AppDef {
  id: string;
  name: string;
  color: string;
  type: "settings" | "openclaw" | "placeholder" | "external" | "store" | "installed" | "terminal" | "system" | "files" | "iframe";
  url?: string;
  pinned: boolean;
  defaultWidth?: number;
  defaultHeight?: number;
  storeApp?: StoreApp;
}

const apps: AppDef[] = [
  { id: "settings", name: "Settings", color: "#6b7280", type: "settings", pinned: true, defaultWidth: 800, defaultHeight: 600 },
  { id: "openclaw", name: "OpenClaw", color: "#0a0f1a", type: "openclaw", pinned: true, defaultWidth: 900, defaultHeight: 700 },
  { id: "terminal", name: "Terminal", color: "#1a1a2e", type: "terminal" as const, pinned: true, defaultWidth: 900, defaultHeight: 600 },
  { id: "files", name: "Files", color: "#f97316", type: "files", pinned: true },
  { id: "store", name: "Store", color: "#22c55e", type: "store", pinned: true, defaultWidth: 900, defaultHeight: 600 },
  { id: "telegram", name: "Telegram", color: "#2AABEE", type: "external", url: "https://web.telegram.org/", pinned: true },
  { id: "system", name: "System Monitor", color: "#3b82f6", type: "system", pinned: false },
  { id: "help", name: "Help", color: "#ec4899", type: "external", url: "https://openclawhardware.dev/docs", pinned: false },
];

// Inline SVG icons for each app
function MIcon({ name, className = "", size = 24 }: { name: string; className?: string; size?: number }) {
  return <span className={`material-symbols-rounded ${className}`} style={{ fontSize: size }}>{name}</span>;
}

function AppIcon({ id, size = "w-6 h-6" }: { id: string; size?: string }) {
  const px = size.includes("w-6") ? 24 : size.includes("w-5") ? 20 : size.includes("w-4") ? 16 : 24;

  if (id === "openclaw") {
    return (
      <svg className={`${size} text-white`} viewBox="0 0 120 120" fill="none">
        <defs>
          <linearGradient id="oc-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ff4d4d"/>
            <stop offset="100%" stopColor="#991b1b"/>
          </linearGradient>
        </defs>
        <path d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z" fill="url(#oc-grad)"/>
        <path d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z" fill="url(#oc-grad)"/>
        <path d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z" fill="url(#oc-grad)"/>
        <path d="M45 15Q35 5 30 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round"/>
        <path d="M75 15Q85 5 90 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round"/>
        <circle cx="45" cy="35" r="6" fill="#050810"/>
        <circle cx="75" cy="35" r="6" fill="#050810"/>
        <circle cx="46" cy="34" r="2.5" fill="#00e5cc"/>
        <circle cx="76" cy="34" r="2.5" fill="#00e5cc"/>
      </svg>
    );
  }

  const iconMap: Record<string, string> = {
    settings: "settings",
    terminal: "terminal",
    system: "monitor_heart",
    files: "folder",
    help: "help",
    browser: "language",
    camera: "photo_camera",
    store: "storefront",
    telegram: "send",
  };

  const iconName = iconMap[id];
  if (!iconName) return null;
  return <MIcon name={iconName} className="text-white" size={px} />;
}

interface OpenWindow {
  id: string;
  appId: string;
  zIndex: number;
  minimized: boolean;
}

// Icon component for installed store apps
function InstalledAppIcon({ iconType, size = "w-6 h-6" }: { iconType: StoreApp["iconType"]; size?: string }) {
  const px = size.includes("w-12") ? 48 : size.includes("w-6") ? 24 : 24;

  const iconMap: Record<string, string> = {
    home: "home",
    chart: "trending_up",
    cloud: "cloud",
    code: "code",
    shield: "verified_user",
  };

  const iconName = iconMap[iconType];
  if (!iconName) return null;
  return <span className="material-symbols-rounded text-white" style={{ fontSize: px }}>{iconName}</span>;
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
  const [recentlyInstalled, setRecentlyInstalled] = useState<string | null>(null);

  // ─── Desktop shortcuts for built-in apps ───
  const DESKTOP_APPS_KEY = "clawbox-desktop-apps";
  const [desktopApps, setDesktopApps] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = localStorage.getItem(DESKTOP_APPS_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem(DESKTOP_APPS_KEY, JSON.stringify(desktopApps)); } catch {}
  }, [desktopApps]);
  const handleAddToDesktop = useCallback((appId: string) => {
    setDesktopApps(prev => prev.includes(appId) ? prev : [...prev, appId]);

  }, []);

  // ─── Dynamic pin state ───
  const PINNED_KEY = "clawbox-pinned-apps";
  const [pinnedOverrides, setPinnedOverrides] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const saved = localStorage.getItem(PINNED_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(PINNED_KEY, JSON.stringify(pinnedOverrides)); } catch {}
  }, [pinnedOverrides]);
  const isAppPinned = useCallback((appId: string) => {
    if (appId in pinnedOverrides) return pinnedOverrides[appId];
    const app = apps.find(a => a.id === appId);
    return app?.pinned ?? false;
  }, [pinnedOverrides]);
  const handlePinApp = useCallback((appId: string) => {
    setPinnedOverrides(prev => ({ ...prev, [appId]: true }));

  }, []);
  const handleUnpinApp = useCallback((appId: string) => {
    setPinnedOverrides(prev => ({ ...prev, [appId]: false }));

  }, []);

  // ─── Wallpapers ───
  const WALLPAPER_KEY = "clawbox-wallpaper";
  const wallpapers = [
    { id: "clawbox", name: "ClawBox", gradient: "", stars: false, nebula: false, image: "/clawbox-wallpaper.jpeg" },
    { id: "deep-space", name: "Deep Space", gradient: "bg-gradient-to-br from-[#0a0f1a] via-[#111827] to-[#1a1f2e]", stars: true, nebula: false, image: "" },
  ] as const;
  const [wallpaperId, setWallpaperId] = useState<string>(() => {
    if (typeof window === "undefined") return "clawbox";
    try { return localStorage.getItem(WALLPAPER_KEY) || "clawbox"; } catch { return "clawbox"; }
  });
  const currentWallpaper = wallpapers.find(w => w.id === wallpaperId) || wallpapers[0];
  const WP_FIT_KEY = "clawbox-wallpaper-fit";
  type WpFit = "fill" | "fit" | "center";
  const [wpFit, setWpFit] = useState<WpFit>(() => {
    if (typeof window === "undefined") return "fill";
    try { return (localStorage.getItem(WP_FIT_KEY) as WpFit) || "fill"; } catch { return "fill"; }
  });
  useEffect(() => { try { localStorage.setItem(WP_FIT_KEY, wpFit); } catch {} }, [wpFit]);
  const wpFitStyle: React.CSSProperties = wpFit === "fill"
    ? { backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" }
    : wpFit === "fit"
    ? { backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat" }
    : { backgroundSize: "auto", backgroundPosition: "center", backgroundRepeat: "no-repeat" };
  const CUSTOM_WPS_KEY = "clawbox-custom-wallpapers";
  const [customWallpapers, setCustomWallpapers] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = localStorage.getItem(CUSTOM_WPS_KEY);
      if (saved) return JSON.parse(saved);
      // Migrate old single custom wallpaper
      const old = localStorage.getItem("clawbox-custom-wallpaper");
      if (old) { const arr = [old]; localStorage.setItem(CUSTOM_WPS_KEY, JSON.stringify(arr)); localStorage.removeItem("clawbox-custom-wallpaper"); return arr; }
    } catch {}
    return [];
  });
  const wallpaperInputRef = useRef<HTMLInputElement>(null);
  const handleWallpaperUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setCustomWallpapers(prev => {
        const next = [...prev, dataUrl];
        try { localStorage.setItem(CUSTOM_WPS_KEY, JSON.stringify(next)); } catch {}
        setWallpaperId(`custom-${next.length - 1}`);
        return next;
      });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }, []);
  useEffect(() => {
    try { localStorage.setItem(WALLPAPER_KEY, wallpaperId); } catch {}
  }, [wallpaperId]);

  // ─── Mascot visibility ───
  const [mascotHidden, setMascotHidden] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("clawbox-mascot-hidden") === "1"; } catch { return false; }
  });
  useEffect(() => {
    const onShow = () => setMascotHidden(false);
    const onStorage = (e: StorageEvent) => { if (e.key === "clawbox-mascot-hidden") setMascotHidden(e.newValue === "1"); };
    window.addEventListener("clawbox-show-mascot", onShow);
    window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener("clawbox-show-mascot", onShow); window.removeEventListener("storage", onStorage); };
  }, []);

  // ─── Desktop icon grid positions ───
  const GRID_COLS = 4;
  const GRID_ROWS = 8;
  const CELL_W = 90; // px
  const CELL_H = 110; // px
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

  // ─── Marquee selection ───
  const [selectedIcons, setSelectedIcons] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  const marqueeRef = useRef<{ active: boolean; startX: number; startY: number }>({ active: false, startX: 0, startY: 0 });

  const getMarqueeRect = useCallback((m: { startX: number; startY: number; endX: number; endY: number }) => ({
    left: Math.min(m.startX, m.endX),
    top: Math.min(m.startY, m.endY),
    right: Math.max(m.startX, m.endX),
    bottom: Math.max(m.startY, m.endY),
  }), []);

  const getIconRect = useCallback((iconId: string, index: number) => {
    if (!gridRef.current) return null;
    const rect = gridRef.current.getBoundingClientRect();
    const pos = iconPositions[iconId] || (() => {
      const col = Math.floor(index / GRID_ROWS) % GRID_COLS;
      const row = index % GRID_ROWS;
      return { row, col };
    })();
    const padding = { top: 24, left: 16 };
    return {
      left: rect.left + padding.left + pos.col * CELL_W,
      top: rect.top + padding.top + pos.row * CELL_H,
      right: rect.left + padding.left + pos.col * CELL_W + CELL_W,
      bottom: rect.top + padding.top + pos.row * CELL_H + CELL_H,
    };
  }, [iconPositions]);

  const handleGridPointerDown = useCallback((e: React.PointerEvent) => {
    // Only start marquee on left click directly on the grid (not on icons)
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    setSelectedIcons(new Set());
    marqueeRef.current = { active: true, startX: e.clientX, startY: e.clientY };
    setMarquee(null);

    const onMove = (ev: PointerEvent) => {
      if (!marqueeRef.current.active) return;
      const dx = ev.clientX - marqueeRef.current.startX;
      const dy = ev.clientY - marqueeRef.current.startY;
      // Only start drawing after small threshold
      if (Math.abs(dx) + Math.abs(dy) < 5) return;
      const m = {
        startX: marqueeRef.current.startX,
        startY: marqueeRef.current.startY,
        endX: ev.clientX,
        endY: ev.clientY,
      };
      setMarquee(m);
      // Real-time selection during drag
      const mRect = {
        left: Math.min(m.startX, m.endX),
        top: Math.min(m.startY, m.endY),
        right: Math.max(m.startX, m.endX),
        bottom: Math.max(m.startY, m.endY),
      };
      const selected = new Set<string>();
      document.querySelectorAll("[data-desktop-icon-id]").forEach((el) => {
        const iconId = el.getAttribute("data-desktop-icon-id");
        if (!iconId) return;
        const r = el.getBoundingClientRect();
        if (r.left < mRect.right && r.right > mRect.left && r.top < mRect.bottom && r.bottom > mRect.top) {
          selected.add(iconId);
        }
      });
      setSelectedIcons(selected);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      marqueeRef.current.active = false;
      setMarquee(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  // ─── Context menu ───
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; appId?: string; isGroup?: boolean } | null>(null);

  const ctxMenuOpenedAt = useRef(0);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: Event) => {
      // Ignore events that happen within 100ms of opening (same interaction)
      if (Date.now() - ctxMenuOpenedAt.current < 100) return;
      e.preventDefault();
      setCtxMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [ctxMenu]);

  const handleDesktopContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    ctxMenuOpenedAt.current = Date.now();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleIconContextMenu = useCallback((e: React.MouseEvent, appId: string) => {
    e.preventDefault();
    e.stopPropagation();
    ctxMenuOpenedAt.current = Date.now();
    // If right-clicking a selected icon in a multi-selection, show group menu
    if (selectedIcons.size > 1 && selectedIcons.has(appId)) {
      setCtxMenu({ x: e.clientX, y: e.clientY, appId, isGroup: true });
    } else {
      setSelectedIcons(new Set());
      setCtxMenu({ x: e.clientX, y: e.clientY, appId });
    }
  }, [selectedIcons]);

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
    const col = Math.floor((clientX - rect.left) / CELL_W);
    const row = Math.floor((clientY - rect.top) / CELL_H);
    const maxCols = Math.floor(rect.width / CELL_W);
    const maxRows = Math.floor(rect.height / CELL_H);
    if (row < 0 || row >= maxRows || col < 0 || col >= maxCols) return null;
    return { row, col };
  }, []);

  const handleIconDragStart = useCallback((appId: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    let isDragging = false;
    const DRAG_THRESHOLD = 8; // px before drag activates
    // Check if this icon is part of a multi-selection
    const isGroupDrag = selectedIcons.size > 1 && selectedIcons.has(appId);
    const groupIds = isGroupDrag ? Array.from(selectedIcons) : [appId];

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!isDragging && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      if (!isDragging) {
        isDragging = true;
        setDraggingIcon(appId);
      }
      setDragPos({ x: ev.clientX, y: ev.clientY });
      const s = snapToGrid(ev.clientX, ev.clientY);
      if (s) setDragGhost(s);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!isDragging) {
        // It was a tap/click — open the app via the onClick handler
        setDraggingIcon(null);
        return;
      } else {
        const target = snapToGrid(ev.clientX, ev.clientY);
        if (target) {
          if (isGroupDrag) {
            // Group drag: compute delta from the dragged icon's original position and apply to all
            setIconPositions(prev => {
              const next = { ...prev };
              const originPos = prev[appId] || { row: 0, col: 0 };
              const dRow = target.row - originPos.row;
              const dCol = target.col - originPos.col;
              // Calculate new positions for all group icons
              const newPositions: Record<string, { row: number; col: number }> = {};
              let valid = true;
              for (const id of groupIds) {
                const pos = prev[id] || { row: 0, col: 0 };
                const newPos = { row: pos.row + dRow, col: pos.col + dCol };
                // Bounds check
                if (newPos.row < 0 || newPos.col < 0) { valid = false; break; }
                // Check occupied by non-group icon
                const occupied = Object.entries(prev).some(
                  ([oid, opos]) => !groupIds.includes(oid) && opos.row === newPos.row && opos.col === newPos.col
                );
                if (occupied) { valid = false; break; }
                newPositions[id] = newPos;
              }
              if (valid) {
                return { ...next, ...newPositions };
              }
              return prev;
            });
          } else if (!isGridCellOccupied(target.row, target.col, appId)) {
            setIconPositions(prev => ({ ...prev, [appId]: target }));
          }
        }
      }
      setDraggingIcon(null);
      setDragPos(null);
      setDragGhost(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [snapToGrid, isGridCellOccupied, selectedIcons]);

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

    // Clear recently installed animation after delay
    setTimeout(() => setRecentlyInstalled(null), 1000);
  }, []);

  // Uninstall app handler
  const handleUninstallApp = useCallback((appId: string) => {
    setInstalledApps((prev) => prev.filter((id) => id !== appId));
    // Close any windows of this app
    setOpenWindows((prev) => prev.filter((w) => w.appId !== `installed-${appId}`));

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

  const openApp = useCallback((appId: string, forceNew = false) => {
    const allApps = getAllApps();
    const app = allApps.find((a) => a.id === appId);
    if (!app) return;

    if (app.type === "external" && app.url) {
      window.open(app.url, "_blank", "noopener,noreferrer");
      return;
    }

    if (!forceNew) {
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
    const appWindows = openWindows.filter((w) => w.appId === appId);
    if (appWindows.length === 0) {
      openApp(appId);
      return;
    }

    // Check if any are minimized — restore them all
    const anyMinimized = appWindows.some(w => w.minimized);
    if (anyMinimized) {
      setOpenWindows((prev) =>
        prev.map((w) =>
          w.appId === appId && w.minimized
            ? { ...w, minimized: false, zIndex: nextZIndex }
            : w
        )
      );
      setNextZIndex((z) => z + 1);
      return;
    }

    // If the top window of this app is active, minimize all
    const topWindow = appWindows.reduce((a, b) => (a.zIndex > b.zIndex ? a : b));
    if (getActiveWindowId() === topWindow.id) {
      appWindows.forEach(w => minimizeWindow(w.id));
    } else {
      // Bring all to front, top window on top
      let z = nextZIndex;
      setOpenWindows((prev) =>
        prev.map((w) => {
          if (w.appId !== appId) return w;
          return { ...w, zIndex: w.id === topWindow.id ? z + appWindows.length : z++ };
        })
      );
      setNextZIndex((z) => z + appWindows.length + 1);
    }
  }, [openWindows, openApp, minimizeWindow, getActiveWindowId, nextZIndex]);

  const pinnedApps = apps.filter((a) => isAppPinned(a.id));

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
      case "terminal":
        return <TerminalApp />;
      case "system":
        return <SystemApp />;
      case "store":
        return (
          <AppStore
            installedAppIds={installedApps}
            onInstall={(app: StoreApp) => handleInstallApp(app.id)}
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
                    <span className="material-symbols-rounded text-yellow-400" style={{ fontSize: 12 }}>star</span>
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
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_new</span>
                Configure in Store
              </a>
            </div>
          </div>
        );
      case "iframe":
        return app.url ? (
          <iframe
            src={app.url}
            className="w-full h-full border-0"
            title={app.name}
            allow="clipboard-read; clipboard-write"
          />
        ) : null;
      case "files":
        return <FilesApp />;
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

  // Get installed store apps for desktop display
  const installedAppDefs = installedApps
    .map((appId) => storeApps.find((a) => a.id === appId))
    .filter((a): a is StoreApp => a !== null);

  // Built-in apps with desktop shortcuts
  const desktopBuiltinApps = desktopApps
    .map((appId) => apps.find((a) => a.id === appId))
    .filter((a): a is AppDef => a !== null);

  // Get all apps for launcher (including installed)
  const allAppsForLauncher = getAllApps();

  return (
    <div className="min-h-screen relative overflow-hidden select-none">
      {/* Desktop wallpaper background */}
      {(() => {
        const customIdx = wallpaperId.startsWith("custom-") ? parseInt(wallpaperId.split("-")[1]) : -1;
        const customWp = customIdx >= 0 ? customWallpapers[customIdx] : undefined;
        return customWp ? (
          <div className="absolute inset-0 z-0 pointer-events-none bg-black" style={{ backgroundImage: `url(${customWp})`, ...wpFitStyle }} />
      ) : currentWallpaper.image ? (
        <div className="absolute inset-0 z-0 pointer-events-none bg-black" style={{ backgroundImage: `url(${currentWallpaper.image})`, ...wpFitStyle }} />
      ) : (
        <>
          <div className={`absolute inset-0 ${currentWallpaper.gradient} z-0 pointer-events-none`} />
          {currentWallpaper.stars && <div className="absolute inset-0 bg-stars z-0 pointer-events-none" />}
          {currentWallpaper.nebula && <div className="absolute inset-0 bg-nebula z-0 pointer-events-none" />}
        </>
      );
      })()}
      {/* Hidden file input for wallpaper upload */}
      <input ref={wallpaperInputRef} type="file" accept="image/*" className="hidden" onChange={handleWallpaperUpload} />
      {/* Desktop icon grid — draggable + right-click surface */}
      <div ref={gridRef} className="absolute inset-0 z-[1]" style={{ paddingBottom: 56, paddingTop: 24, paddingLeft: 16, paddingRight: 16 }} onContextMenu={handleDesktopContextMenu} onPointerDown={handleGridPointerDown}>
        {installedAppDefs.map((app, i) => {
          const pos = getIconPosition(app.id, i);
          const isBeingDragged = draggingIcon === app.id;
          const isGroupMemberDragged = draggingIcon !== null && draggingIcon !== app.id && selectedIcons.size > 1 && selectedIcons.has(app.id) && selectedIcons.has(draggingIcon);
          const isRecent = recentlyInstalled === app.id;
          const isSelected = selectedIcons.has(app.id);
          return (
            <div
              key={app.id}
              data-desktop-icon-id={app.id}

              style={isBeingDragged && dragPos ? {
                position: "fixed",
                left: dragPos.x - 40,
                top: dragPos.y - 40,
                zIndex: 9999,
                opacity: 0.85,
                pointerEvents: "none",
                transition: "none",
              } : isGroupMemberDragged ? {
                position: "absolute",
                left: pos.col * CELL_W,
                top: pos.row * CELL_H,
                width: CELL_W,
                height: CELL_H,
                opacity: 0.4,
                pointerEvents: "none",
                transition: "opacity 0.15s",
              } : {
                position: "absolute",
                left: pos.col * CELL_W,
                top: pos.row * CELL_H,
                width: CELL_W,
                height: CELL_H,
                transition: "left 0.2s, top 0.2s",
              }}
              className="flex items-center justify-center pointer-events-auto"
            >
              <button
                onPointerDown={(e) => handleIconDragStart(app.id, e)}
                onClick={() => { if (!draggingIcon) openApp(`installed-${app.id}`); }}
                onContextMenu={(e) => handleIconContextMenu(e, app.id)}
                className={`group flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-white/10 active:bg-white/15 transition-all duration-200 select-none touch-none ${
                  isRecent ? "animate-install-bounce" : ""
                } ${isSelected ? "bg-white/15 ring-2 ring-blue-400/60 rounded-xl" : ""}`}
              >
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg ring-1 ring-black/20 transition-transform duration-200 group-hover:scale-105 group-active:scale-95"
                  style={{ backgroundColor: app.color }}
                >
                  <InstalledAppIcon iconType={app.iconType} size="w-7 h-7" />
                </div>
                <span className="text-xs text-white font-medium text-center line-clamp-1 max-w-[80px]" style={{ textShadow: "0 1px 3px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.5)" }}>
                  {app.name}
                </span>
              </button>
            </div>
          );
        })}

        {/* Built-in app desktop shortcuts */}
        {desktopBuiltinApps.map((app, i) => {
          const iconId = `desktop-${app.id}`;
          const pos = getIconPosition(iconId, installedAppDefs.length + i);
          const isBeingDragged = draggingIcon === iconId;
          const isGroupMemberDragged = draggingIcon !== null && draggingIcon !== iconId && selectedIcons.size > 1 && selectedIcons.has(iconId) && selectedIcons.has(draggingIcon);
          const isSelected = selectedIcons.has(iconId);
          return (
            <div
              key={iconId}
              data-desktop-icon-id={iconId}
              style={isBeingDragged && dragPos ? {
                position: "fixed",
                left: dragPos.x - 40,
                top: dragPos.y - 40,
                zIndex: 9999,
                opacity: 0.85,
                pointerEvents: "none",
                transition: "none",
              } : isGroupMemberDragged ? {
                position: "absolute",
                left: pos.col * CELL_W,
                top: pos.row * CELL_H,
                width: CELL_W,
                height: CELL_H,
                opacity: 0.4,
                pointerEvents: "none",
                transition: "opacity 0.15s",
              } : {
                position: "absolute",
                left: pos.col * CELL_W,
                top: pos.row * CELL_H,
                width: CELL_W,
                height: CELL_H,
                transition: "left 0.2s, top 0.2s",
              }}
              className="flex items-center justify-center pointer-events-auto"
            >
              <button
                onPointerDown={(e) => handleIconDragStart(`desktop-${app.id}`, e)}
                onClick={() => { if (!draggingIcon) openApp(app.id); }}
                onContextMenu={(e) => handleIconContextMenu(e, `desktop-${app.id}`)}
                className={`group flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-white/10 active:bg-white/15 transition-all duration-200 select-none touch-none ${isSelected ? "bg-white/15 ring-2 ring-blue-400/60 rounded-xl" : ""}`}
              >
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg ring-1 ring-black/20 transition-transform duration-200 group-hover:scale-105 group-active:scale-95"
                  style={{ backgroundColor: app.color }}
                >
                  <AppIcon id={app.id} size="w-7 h-7" />
                </div>
                <span className="text-xs text-white font-medium text-center line-clamp-1 max-w-[80px]" style={{ textShadow: "0 1px 3px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.5)" }}>
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
              left: dragGhost.col * CELL_W,
              top: dragGhost.row * CELL_H,
              width: CELL_W,
              height: CELL_H,
            }}
            className="flex items-center justify-center pointer-events-none"
          >
            <div className="w-16 h-16 rounded-2xl border-2 border-dashed border-white/30 bg-white/5" />
          </div>
        )}

        {/* Marquee selection rectangle */}
        {marquee && (
          <div
            className="fixed pointer-events-none border border-blue-400/60 bg-blue-400/15 z-[2]"
            style={{
              left: Math.min(marquee.startX, marquee.endX),
              top: Math.min(marquee.startY, marquee.endY),
              width: Math.abs(marquee.endX - marquee.startX),
              height: Math.abs(marquee.endY - marquee.startY),
            }}
          />
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
            appId={window.appId}
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
              isPinned: isAppPinned(app.id),
            };
          }
          return {
            id: app.id,
            name: app.name,
            color: app.color,
            icon: <AppIcon id={app.id} />,
            isPinned: isAppPinned(app.id),
          };
        })}
        isOpen={launcherOpen}
        onClose={() => setLauncherOpen(false)}
        onAppClick={openApp}
        onPinApp={handlePinApp}
        onUnpinApp={handleUnpinApp}
        onAddToDesktop={handleAddToDesktop}
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
        apps={(() => {
          const allApps = getAllApps();
          const pinnedIds = new Set(pinnedApps.map(a => a.id));
          // Open apps that aren't pinned
          const unpinnedOpenApps = openWindows
            .filter(w => !pinnedIds.has(w.appId))
            .map(w => allApps.find(a => a.id === w.appId))
            .filter((a): a is AppDef => a !== null)
            // Deduplicate
            .filter((a, i, arr) => arr.findIndex(x => x.id === a.id) === i);

          const mapApp = (app: AppDef) => {
            const appWindows = openWindows.filter((w) => w.appId === app.id);
            const topWin = appWindows.length > 0
              ? appWindows.reduce((a, b) => (a.zIndex > b.zIndex ? a : b))
              : null;
            const renderIcon = () => {
              if (app.type === "installed" && app.storeApp) {
                return (
                  <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ backgroundColor: app.color }}>
                    <InstalledAppIcon iconType={app.storeApp.iconType} />
                  </div>
                );
              }
              return (
                <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ backgroundColor: app.color }}>
                  <AppIcon id={app.id} />
                </div>
              );
            };
            return {
              id: app.id,
              name: app.name,
              icon: renderIcon(),
              isOpen: appWindows.length > 0,
              isActive: topWin?.id === activeWindowId && !topWin?.minimized,
              isPinned: pinnedIds.has(app.id),
              windowCount: appWindows.length,
            };
          };

          return [
            ...pinnedApps.map(mapApp),
            ...unpinnedOpenApps.map(mapApp),
          ];
        })()}
        onAppClick={handleShelfAppClick}
        onNewWindow={(appId) => openApp(appId, true)}
        onLauncherClick={() => {
          setTrayOpen(false);
          setLauncherOpen((prev) => !prev);
        }}
        onTrayClick={() => {
          setLauncherOpen(false);
          setTrayOpen((prev) => !prev);
        }}
        onPinApp={handlePinApp}
        onUnpinApp={handleUnpinApp}
        onCloseApp={(appId) => {
          setOpenWindows(prev => prev.filter(w => w.appId !== appId));
        }}
        onShelfSettings={() => openApp("settings")}
        time={time}
      />


      {/* Context menu */}
      {ctxMenu && (
        <div
          className="fixed z-[99999] min-w-[200px] py-1 bg-[#2d2d2d] rounded-lg shadow-2xl border border-white/10 backdrop-blur-xl text-sm text-white/90"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 220),
            top: Math.min(ctxMenu.y, window.innerHeight - 300),
          }}
          onClick={() => setCtxMenu(null)}
        >
          {ctxMenu.isGroup && ctxMenu.appId ? (
            <>
              <div className="px-4 py-1.5 text-xs text-white/40 font-medium">
                {selectedIcons.size} items selected
              </div>
              <div className="border-t border-white/10 my-0.5" />
              <button onClick={() => {
                selectedIcons.forEach(id => {
                  if (id.startsWith("desktop-")) {
                    openApp(id.replace("desktop-", ""));
                  } else {
                    openApp(`installed-${id}`);
                  }
                });
                setSelectedIcons(new Set());
              }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_new</span> Open all
              </button>
              <div className="border-t border-white/10 my-1" />
              <button onClick={() => {
                setIconPositions(prev => {
                  const next = { ...prev };
                  selectedIcons.forEach(id => { delete next[id]; });
                  return next;
                });
                setSelectedIcons(new Set());
              }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>grid_view</span> Reset positions
              </button>
              <div className="border-t border-white/10 my-1" />
              <button onClick={() => {
                selectedIcons.forEach(id => {
                  if (id.startsWith("desktop-")) {
                    const appId = id.replace("desktop-", "");
                    setDesktopApps(prev => prev.filter(a => a !== appId));
                  } else {
                    handleUninstallApp(id);
                  }
                });
                setSelectedIcons(new Set());
              }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3 text-red-400">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>visibility_off</span> Remove all from desktop
              </button>
            </>
          ) : ctxMenu.appId ? (() => {
            // Resolve the actual appId for opening
            const resolvedAppId = ctxMenu.appId!.startsWith("desktop-")
              ? ctxMenu.appId!.replace("desktop-", "")
              : `installed-${ctxMenu.appId}`;
            return (
            <>
              <button onClick={() => openApp(resolvedAppId)} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_new</span> Open
              </button>
              {openWindows.some(w => w.appId === resolvedAppId) && (
                <button onClick={() => openApp(resolvedAppId, true)} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>tab</span> New Window
                </button>
              )}
              <div className="border-t border-white/10 my-1" />
              <button onClick={() => {
                if (ctxMenu.appId) handleUninstallApp(ctxMenu.appId);
              }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3 text-red-400">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>delete</span> Uninstall
              </button>
              <div className="border-t border-white/10 my-1" />
              <button onClick={() => {
                if (ctxMenu.appId) setIconPositions(prev => {
                  const next = { ...prev };
                  delete next[ctxMenu.appId!];
                  return next;
                });
              }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>grid_view</span> Reset Position
              </button>
              <div className="border-t border-white/10 my-1" />
              <button onClick={() => {
                if (!ctxMenu.appId) return;
                const id = ctxMenu.appId;
                if (id.startsWith("desktop-")) {
                  // Remove built-in app desktop shortcut
                  const appId = id.replace("desktop-", "");
                  setDesktopApps(prev => prev.filter(a => a !== appId));
                } else {
                  // Uninstall store app (removes from desktop)
                  handleUninstallApp(id);
                }
              }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3 text-red-400">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>visibility_off</span> Remove from desktop
              </button>
            </>
            ); })() : (
            <>
              <button onClick={() => openApp("store")} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>storefront</span> App Store
              </button>
              <button onClick={() => openApp("terminal")} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>terminal</span> Terminal
              </button>
              <div className="border-t border-white/10 my-1" />
              <button onClick={() => openApp("openclaw")} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="w-4 h-4 inline-block"><AppIcon id="openclaw" size="w-4 h-4" /></span> OpenClaw
              </button>
              <button onClick={() => {
                // Collect all desktop icon IDs
                const allIconIds = [
                  ...installedAppDefs.map(a => a.id),
                  ...desktopBuiltinApps.map(a => `desktop-${a.id}`),
                ];
                if (allIconIds.length === 0) return;
                // Calculate grid to center icons
                const rect = gridRef.current?.getBoundingClientRect();
                const areaW = rect ? rect.width : window.innerWidth;
                const areaH = rect ? rect.height - 56 : window.innerHeight - 56;
                const cols = Math.min(allIconIds.length, Math.max(1, Math.floor(areaW / CELL_W)));
                const rows = Math.ceil(allIconIds.length / cols);
                const gridW = cols * CELL_W;
                const gridH = rows * CELL_H;
                const offsetCol = Math.floor((areaW - gridW) / 2 / CELL_W);
                const offsetRow = Math.floor((areaH - gridH) / 2 / CELL_H);
                const positions: Record<string, { row: number; col: number }> = {};
                allIconIds.forEach((id, i) => {
                  const col = i % cols;
                  const row = Math.floor(i / cols);
                  positions[id] = { row: row + offsetRow, col: col + offsetCol };
                });
                setIconPositions(positions);
              }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>grid_view</span> Arrange icons
              </button>
              <div className="border-t border-white/10 my-1" />
              <div className="px-4 py-2">
                <div className="grid grid-cols-4 gap-1.5" onClick={(e) => e.stopPropagation()}>
                  {wallpapers.map((wp) => (
                    <button
                      key={wp.id}
                      onClick={() => { setWallpaperId(wp.id); setCtxMenu(null); }}
                      className={`h-8 rounded-md border-2 transition-all ${
                        wallpaperId === wp.id ? "border-orange-400 scale-105" : "border-transparent hover:border-white/30"
                      } ${wp.gradient}`}
                      style={wp.image ? { backgroundImage: `url(${wp.image})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}
                      title={wp.name}
                    />
                  ))}
                  {customWallpapers.map((wp, i) => (
                    <div key={`custom-${i}`} className="relative group">
                      <button
                        onClick={() => { setWallpaperId(`custom-${i}`); setCtxMenu(null); }}
                        className={`w-full h-8 rounded-md border-2 transition-all ${
                          wallpaperId === `custom-${i}` ? "border-orange-400 scale-105" : "border-transparent hover:border-white/30"
                        }`}
                        style={{ backgroundImage: `url(${wp})`, backgroundSize: "cover", backgroundPosition: "center" }}
                        title={`Custom ${i + 1}`}
                      />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setCustomWallpapers(prev => {
                            const next = prev.filter((_, j) => j !== i);
                            try { localStorage.setItem(CUSTOM_WPS_KEY, JSON.stringify(next)); } catch {}
                            return next;
                          });
                          if (wallpaperId === `custom-${i}`) setWallpaperId(wallpapers[0].id);
                        }}
                        className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500/90 hover:bg-red-400 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Remove wallpaper"
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 10 }}>close</span>
                      </button>
                    </div>
                  ))}
                  <label
                    className="h-8 rounded-md border-2 border-dashed border-white/20 hover:border-white/40 transition-all flex items-center justify-center text-white/40 hover:text-white/70 cursor-pointer"
                    title="Upload wallpaper"
                  >
                    <input type="file" accept="image/*" className="hidden" onChange={handleWallpaperUpload} />
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
                  </label>
                </div>
                <div className="flex gap-1 mt-2" onClick={(e) => e.stopPropagation()}>
                  {([["fill", "Fill"], ["fit", "Fit"], ["center", "Center"]] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      onClick={() => setWpFit(mode)}
                      className={`flex-1 text-[10px] py-1 rounded transition-all ${
                        wpFit === mode ? "bg-white/20 text-white" : "bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/60"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="border-t border-white/10 my-1" />
              {mascotHidden ? (
                <button onClick={() => { window.dispatchEvent(new Event('clawbox-show-mascot')); try { localStorage.removeItem('clawbox-mascot-hidden') } catch {}; setMascotHidden(false); setCtxMenu(null); }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                  <span className="text-base">🦀</span> Show Mascot
                </button>
              ) : (
                <button onClick={() => { try { localStorage.setItem('clawbox-mascot-hidden', '1') } catch {}; setMascotHidden(true); window.dispatchEvent(new Event('clawbox-hide-mascot')); setCtxMenu(null); }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                  <span className="text-base">🦀</span> Hide Mascot
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
