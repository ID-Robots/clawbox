"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import ChromeShelf from "@/components/ChromeShelf";
import ChromeLauncher from "@/components/ChromeLauncher";
import ChromeWindow from "@/components/ChromeWindow";
import SystemTray from "@/components/SystemTray";
import SettingsApp from "@/components/SettingsApp";
import type { UISettings } from "@/components/SettingsApp";
import AppStore from "@/components/AppStore";
import FilesApp from "@/components/FilesApp";
import type { StoreApp } from "@/components/AppStore";
import TerminalApp from "@/components/TerminalApp";
import InstalledAppSettings from "@/components/InstalledAppSettings";
import BrowserApp from "@/components/BrowserApp";
import VNCApp from "@/components/VNCApp";
import VSCodeApp from "@/components/VSCodeApp";
import OpenClawApp from "@/components/OpenClawApp";

const Mascot = dynamic(() => import("@/components/Mascot"), { ssr: false });

// Preference keys (stored in SQLite via /setup-api/preferences)
const INSTALLED_APPS_KEY = "installed_apps";

// App definitions
interface AppDef {
  id: string;
  name: string;
  color: string;
  type: "settings" | "openclaw" | "placeholder" | "external" | "store" | "installed" | "terminal" | "files" | "browser" | "vnc" | "vscode";
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
  { id: "browser", name: "Browser", color: "#4285f4", type: "browser", pinned: true, defaultWidth: 1000, defaultHeight: 700 },
  { id: "vnc", name: "Remote Desktop", color: "#7c3aed", type: "vnc", pinned: true, defaultWidth: 1000, defaultHeight: 700 },
  { id: "vscode", name: "VS Code", color: "#007acc", type: "vscode", pinned: true, defaultWidth: 1100, defaultHeight: 750 },
  { id: "help", name: "Help", color: "#ec4899", type: "external", url: "https://openclawhardware.dev/docs", pinned: false },
];

// Inline SVG icons for each app
function MIcon({ name, className = "", size = 24 }: { name: string; className?: string; size?: number }) {
  return <span className={`material-symbols-rounded ${className}`} style={{ fontSize: size }}>{name}</span>;
}

function AppIcon({ id, size = "w-6 h-6" }: { id: string; size?: string }) {
  const px = size.includes("w-6") ? 24 : size.includes("w-5") ? 20 : size.includes("w-4") ? 16 : 24;

  if (id === "vscode") {
    return (
      <svg className={`${size}`} viewBox="0 0 100 100" fill="none">
        <path d="M74.5 3.5L37.8 35.2 18.3 20.5c-1.8-1.3-4.3-1.1-5.9.4l-5 5c-1.8 1.8-1.8 4.7 0 6.5L21.5 50 7.4 67.6c-1.8 1.8-1.8 4.7 0 6.5l5 5c1.6 1.5 4.1 1.7 5.9.4l19.5-14.7L74.5 96.5c1.7 1.7 4.1 2.5 6.5 2.1l.8-.2c2-.4 3.6-1.7 4.4-3.5L97 50V7.2l-12-4.3c-2.7-1-5.5-.5-7.6 1.6L74.5 3.5zM79 73L53 50l26-23v46z" fill="white"/>
      </svg>
    );
  }

  if (id === "browser") {
    return (
      <svg className={`${size}`} viewBox="0 0 135.47 135.47">
        <path d="m67.733 67.733 29.33 16.933-29.33 50.8c37.408 0 67.733-30.325 67.733-67.733 0-12.341-3.3168-23.901-9.0837-33.867h-58.65z" fill="#afccf9"/>
        <path d="m67.733-1e-6c-25.07 0-46.942 13.63-58.654 33.875l29.324 50.792 29.33-16.933v-33.867h58.65c-11.714-20.24-33.583-33.867-58.65-33.867z" fill="#1767d1"/>
        <path d="m0 67.733c0 37.408 30.324 67.733 67.733 67.733l29.33-50.8-29.33-16.933-29.33 16.933-29.324-50.792c-5.7637 9.9632-9.0794 21.519-9.0794 33.858" fill="#679ef5"/>
        <path d="m101.6 67.733c0 18.704-15.163 33.867-33.867 33.867-18.704 0-33.867-15.163-33.867-33.867s15.163-33.867 33.867-33.867c18.704 0 33.867 15.163 33.867 33.867" fill="#fff"/>
        <path d="m95.25 67.733c0 15.197-12.32 27.517-27.517 27.517-15.197 0-27.517-12.32-27.517-27.517 0-15.197 12.32-27.517 27.517-27.517 15.197 0 27.517 12.32 27.517 27.517" fill="#1a74e7"/>
      </svg>
    );
  }

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
    files: "folder",
    help: "help",
    vnc: "desktop_windows",
    camera: "photo_camera",
    store: "storefront",
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
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

// Icon component for installed store apps — tries local cached icon first, then store URL
function InstalledAppIcon({ iconUrl, appId, name, size = "w-6 h-6" }: { iconUrl?: string; appId?: string; name?: string; size?: string }) {
  const px = size.includes("w-12") ? 48 : size.includes("w-7") ? 28 : size.includes("w-6") ? 24 : size.includes("w-3") ? 12 : 24;
  const localSrc = appId ? `/setup-api/apps/icon/${appId}` : undefined;
  const sources = [localSrc, iconUrl].filter(Boolean) as string[];
  const [srcIdx, setSrcIdx] = useState(0);
  const [failed, setFailed] = useState(false);

  const src = sources[srcIdx];
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={name || ""}
        className="w-full h-full object-cover rounded-[inherit]"
        onError={() => {
          if (srcIdx + 1 < sources.length) {
            setSrcIdx(srcIdx + 1);
          } else {
            setFailed(true);
          }
        }}
      />
    );
  }
  return <span className="material-symbols-rounded text-white" style={{ fontSize: px }}>extension</span>;
}


export default function ChromeDesktop() {
  const [setupChecked, setSetupChecked] = useState(false);

  // Check if setup is complete — redirect to /setup if not
  useEffect(() => {
    fetch("/setup-api/setup/status")
      .then(r => r.json())
      .then(data => {
        if (!data.setup_complete) {
          window.location.href = "/setup";
        } else {
          setSetupChecked(true);
        }
      })
      .catch(() => setSetupChecked(true)); // If API fails, show desktop anyway
  }, []);

  const [launcherOpen, setLauncherOpen] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [openWindows, setOpenWindows] = useState<OpenWindow[]>([]);
  const [nextZIndex, setNextZIndex] = useState(100);
  const [time, setTime] = useState("");
  const [date, setDate] = useState("");
  const [installedApps, setInstalledApps] = useState<string[]>([]);
  const [recentlyInstalled, setRecentlyInstalled] = useState<string | null>(null);
  const INSTALLED_META_KEY = "installed_meta";
  const [installedMeta, setInstalledMeta] = useState<Record<string, { name: string; color: string; iconUrl: string }>>({});

  // ─── Desktop shortcuts for built-in apps ───
  const DESKTOP_APPS_KEY = "desktop_apps";
  const [desktopApps, setDesktopApps] = useState<string[]>([]);
  const HIDDEN_INSTALLED_KEY = "hidden_installed";
  const [hiddenInstalledApps, setHiddenInstalledApps] = useState<string[]>([]);
  const handleAddToDesktop = useCallback((appId: string) => {
    // Also unhide installed apps when adding to desktop
    setHiddenInstalledApps(prev => prev.filter(id => id !== appId && id !== `installed-${appId}`));
    setDesktopApps(prev => prev.includes(appId) ? prev : [...prev, appId]);

  }, []);

  // ─── Dynamic pin state ───
  const PINNED_KEY = "pinned_apps";
  const [pinnedOverrides, setPinnedOverrides] = useState<Record<string, boolean>>({});
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
  const [wallpaperId, setWallpaperId] = useState("clawbox");
  const currentWallpaper = wallpapers.find(w => w.id === wallpaperId) || wallpapers[0];
  const WP_FIT_KEY = "clawbox-wallpaper-fit";
  type WpFit = "fill" | "fit" | "center";
  const [wpFit, setWpFit] = useState<WpFit>("fill");
  const WP_BG_COLOR_KEY = "clawbox-wallpaper-bg-color";
  const [wpBgColor, setWpBgColor] = useState("#000000");
  const WP_OPACITY_KEY = "clawbox-wallpaper-opacity";
  const [wpOpacity, setWpOpacity] = useState(50);
  // ─── Unified SQLite load on mount ───
  const prefsLoaded = useRef(false);
  useEffect(() => {
    fetch("/setup-api/preferences?all=1")
      .then(r => r.json())
      .then((data: Record<string, unknown>) => {
        prefsLoaded.current = true;
        // Wallpaper
        if (data.wp_id) setWallpaperId(String(data.wp_id));
        if (data.wp_fit) setWpFit(data.wp_fit as WpFit);
        if (data.wp_bg_color) setWpBgColor(String(data.wp_bg_color));
        if (data.wp_opacity !== undefined && data.wp_opacity !== null) setWpOpacity(parseInt(String(data.wp_opacity), 10));
        // Installed apps
        if (Array.isArray(data.installed_apps)) setInstalledApps(data.installed_apps as string[]);
        if (data.installed_meta && typeof data.installed_meta === "object") setInstalledMeta(data.installed_meta as Record<string, { name: string; color: string; iconUrl: string }>);
        // Desktop
        if (Array.isArray(data.desktop_apps)) setDesktopApps(data.desktop_apps as string[]);
        if (Array.isArray(data.hidden_installed)) setHiddenInstalledApps(data.hidden_installed as string[]);
        if (data.pinned_apps && typeof data.pinned_apps === "object") setPinnedOverrides(data.pinned_apps as Record<string, boolean>);
        if (data.icon_grid && typeof data.icon_grid === "object") setIconPositions(data.icon_grid as Record<string, { row: number; col: number }>);
        // Open windows
        if (Array.isArray(data.desktop_open_windows)) {
          const restored = (data.desktop_open_windows as Array<{ appId: string; minimized: boolean; x?: number; y?: number; width?: number; height?: number }>)
            .map((w, i) => ({ id: `${w.appId}-${Date.now()}-${i}`, appId: w.appId, zIndex: 100 + i, minimized: w.minimized, x: w.x, y: w.y, width: w.width, height: w.height }));
          if (restored.length > 0) {
            setOpenWindows(restored);
            setNextZIndex(100 + restored.length);
          }
        }
        // Mascot
        if (data.ui_mascot_hidden) setMascotHidden(true);
      })
      .catch(() => { prefsLoaded.current = true; });
  }, []);

  const wpFitStyle: React.CSSProperties = wpFit === "fill"
    ? { backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" }
    : wpFit === "fit"
    ? { backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat" }
    : { backgroundSize: "auto", backgroundPosition: "center", backgroundRepeat: "no-repeat" };
  const CUSTOM_WPS_KEY = "clawbox-custom-wallpapers";
  const [customWallpapers, setCustomWallpapers] = useState<string[]>([]);
  // Custom wallpapers are large base64 — keep in localStorage only
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CUSTOM_WPS_KEY);
      if (saved) { setCustomWallpapers(JSON.parse(saved)); return; }
      const old = localStorage.getItem("clawbox-custom-wallpaper");
      if (old) { const arr = [old]; localStorage.setItem(CUSTOM_WPS_KEY, JSON.stringify(arr)); localStorage.removeItem("clawbox-custom-wallpaper"); setCustomWallpapers(arr); }
    } catch {}
  }, []);
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
        setWpOpacity(100);
        return next;
      });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }, []);

  // ─── Mascot visibility ───
  const [mascotHidden, setMascotHidden] = useState(false);
  useEffect(() => {
    const onShow = () => setMascotHidden(false);
    const onStorage = (e: StorageEvent) => { if (e.key === "clawbox-mascot-hidden") setMascotHidden(e.newValue === "1"); };
    window.addEventListener("clawbox-show-mascot", onShow);
    window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener("clawbox-show-mascot", onShow); window.removeEventListener("storage", onStorage); };
  }, []);

  // ─── Desktop icon grid positions ───
  const GRID_COLS = 10;
  const GRID_ROWS = 6;
  const CELL_W = 100; // px
  const CELL_H = 110; // px
  const ICON_GRID_KEY = "icon_grid";
  const [iconPositions, setIconPositions] = useState<Record<string, { row: number; col: number }>>({});
  const [draggingIcon, setDraggingIcon] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dragGhost, setDragGhost] = useState<{ row: number; col: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // ─── Unified SQLite save (debounced, after all state is declared) ───
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!prefsLoaded.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch("/setup-api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wp_id: wallpaperId,
          wp_fit: wpFit,
          wp_bg_color: wpBgColor,
          wp_opacity: wpOpacity,
          installed_apps: installedApps,
          installed_meta: installedMeta,
          desktop_apps: desktopApps,
          hidden_installed: hiddenInstalledApps,
          pinned_apps: pinnedOverrides,
          icon_grid: iconPositions,
          desktop_open_windows: openWindows.map(w => ({ appId: w.appId, minimized: w.minimized, x: w.x, y: w.y, width: w.width, height: w.height })),
          ui_mascot_hidden: mascotHidden ? 1 : 0,
        }),
      }).catch(() => {});
    }, 500);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [wallpaperId, wpFit, wpBgColor, wpOpacity, installedApps, installedMeta, desktopApps, hiddenInstalledApps, pinnedOverrides, iconPositions, openWindows, mascotHidden]);

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
      const col = index % GRID_COLS;
      const row = Math.floor(index / GRID_COLS) % GRID_ROWS;
      return { row, col };
    })();
    return {
      left: rect.left + pos.col * CELL_W,
      top: rect.top + pos.row * CELL_H,
      right: rect.left + pos.col * CELL_W + CELL_W,
      bottom: rect.top + pos.row * CELL_H + CELL_H,
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



  // Arrange all desktop icons into a centered grid, preserving current visual order
  const arrangeIcons = useCallback(() => {
    const visibleInstalled = installedApps.filter((id) => !hiddenInstalledApps.includes(id));
    const builtinIds = desktopApps.map((id) => `desktop-${id}`);
    const allIconIds = [...visibleInstalled, ...builtinIds];
    if (allIconIds.length === 0) return;
    // Sort by current position to preserve visual order
    allIconIds.sort((a, b) => {
      const pa = iconPositions[a] || { row: 999, col: 999 };
      const pb = iconPositions[b] || { row: 999, col: 999 };
      return pa.row !== pb.row ? pa.row - pb.row : pa.col - pb.col;
    });
    // Compute centered grid
    const areaW = GRID_COLS * CELL_W;
    const rect = gridRef.current?.getBoundingClientRect();
    const areaH = rect ? rect.height : (typeof window !== "undefined" ? window.innerHeight - 80 : GRID_ROWS * CELL_H);
    const cols = Math.min(allIconIds.length, GRID_COLS);
    const rows = Math.ceil(allIconIds.length / cols);
    const gridW = cols * CELL_W;
    const gridH = rows * CELL_H;
    const offsetCol = Math.floor((areaW - gridW) / 2 / CELL_W);
    const offsetRow = Math.max(0, Math.floor((areaH - gridH) / 2 / CELL_H));
    const positions: Record<string, { row: number; col: number }> = {};
    allIconIds.forEach((id, i) => {
      positions[id] = { row: Math.floor(i / cols) + offsetRow, col: (i % cols) + offsetCol };
    });
    setIconPositions(positions);
  }, [installedApps, hiddenInstalledApps, desktopApps, iconPositions]);

  // Auto-arrange when icons are added or removed
  useEffect(() => {
    const visibleInstalled = installedApps.filter((id) => !hiddenInstalledApps.includes(id));
    const builtinIds = desktopApps.map((id) => `desktop-${id}`);
    const allIconIds = [...visibleInstalled, ...builtinIds];
    const missing = allIconIds.filter((id) => !iconPositions[id]);
    if (missing.length === 0) return;
    arrangeIcons();
  }, [installedApps, hiddenInstalledApps, desktopApps]); // eslint-disable-line react-hooks/exhaustive-deps

  // Get icon position (should always be in iconPositions after effect runs)
  const getIconPosition = useCallback((appId: string, _index: number) => {
    return iconPositions[appId] || { row: 0, col: 0 };
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
          } else {
            // Single icon drop: insert at target and shift others right if occupied
            setIconPositions(prev => {
              const next = { ...prev };
              // If target cell is empty, just move there
              const occupantId = Object.entries(next).find(
                ([id, pos]) => id !== appId && pos.row === target.row && pos.col === target.col
              )?.[0];
              if (!occupantId) {
                return { ...next, [appId]: target };
              }
              // Sort all icons by position (row-major) to get current linear order
              const allIds = Object.keys(next).filter(id => id !== appId);
              allIds.sort((a, b) => {
                const pa = next[a], pb = next[b];
                return pa.row !== pb.row ? pa.row - pb.row : pa.col - pb.col;
              });
              // Find where to insert based on target position
              const targetLinear = target.row * GRID_COLS + target.col;
              let insertIdx = allIds.findIndex(id => {
                const p = next[id];
                return p.row * GRID_COLS + p.col >= targetLinear;
              });
              if (insertIdx === -1) insertIdx = allIds.length;
              // Insert the dragged icon into the sequence
              allIds.splice(insertIdx, 0, appId);
              // Find the grid bounds from current layout (use the centering offsets)
              const minRow = Math.min(...Object.values(next).map(p => p.row));
              const minCol = Math.min(...Object.values(next).map(p => p.col));
              // Determine cols used in current layout
              const maxCol = Math.max(...Object.values(next).map(p => p.col));
              const layoutCols = maxCol - minCol + 1;
              // Re-assign positions sequentially from the same starting offset
              const positions: Record<string, { row: number; col: number }> = {};
              allIds.forEach((id, i) => {
                const col = i % layoutCols;
                const row = Math.floor(i / layoutCols);
                positions[id] = { row: row + minRow, col: col + minCol };
              });
              return positions;
            });
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

  // Install app handler — called after AppStore's server-side install completes
  const handleInstallApp = useCallback((app: StoreApp) => {
    setInstalledApps((prev) => prev.includes(app.id) ? prev : [...prev, app.id]);
    setInstalledMeta((prev) => ({ ...prev, [app.id]: { name: app.name, color: app.color, iconUrl: app.iconUrl } }));
    setHiddenInstalledApps((prev) => prev.filter((id) => id !== app.id));
    setRecentlyInstalled(app.id);
    setTimeout(() => setRecentlyInstalled(null), 1000);
  }, []);

  // Uninstall confirmation
  const [uninstallConfirm, setUninstallConfirm] = useState<string | null>(null);

  const requestUninstallApp = useCallback((appId: string) => {
    setUninstallConfirm(appId);
  }, []);

  const confirmUninstallApp = useCallback(() => {
    if (!uninstallConfirm) return;
    const appId = uninstallConfirm;
    setInstalledApps((prev) => prev.filter((id) => id !== appId));
    setOpenWindows((prev) => prev.filter((w) => w.appId !== `installed-${appId}`));
    setIconPositions((prev) => {
      const next = { ...prev };
      delete next[appId];
      return next;
    });
    setUninstallConfirm(null);
  }, [uninstallConfirm]);

  // Get all apps including installed ones
  const getAllApps = useCallback((): AppDef[] => {
    const installedAppDefs: AppDef[] = [];
    for (const appId of installedApps) {
      const meta = installedMeta[appId];
      if (meta) {
        const storeApp: StoreApp = { id: appId, name: meta.name, description: "", rating: 0, color: meta.color, category: "", iconUrl: meta.iconUrl };
        installedAppDefs.push({
          id: `installed-${appId}`,
          name: meta.name,
          color: meta.color,
          type: "installed",
          pinned: false,
          defaultWidth: 600,
          defaultHeight: 400,
          storeApp,
        });
      }
    }
    return [...apps, ...installedAppDefs];
  }, [installedApps, installedMeta]);

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

  const updateWindowGeometry = useCallback((windowId: string, geo: { x: number; y: number; width: number; height: number }) => {
    setOpenWindows((prev) =>
      prev.map((w) => w.id === windowId ? { ...w, x: geo.x, y: geo.y, width: geo.width, height: geo.height } : w)
    );
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

  const pinnedApps = getAllApps().filter((a) => isAppPinned(a.id));

  const renderWindowContent = (appId: string) => {
    const allApps = getAllApps();
    const app = allApps.find((a) => a.id === appId);
    if (!app) return null;

    switch (app.type) {
      case "settings":
        return (
          <div className="h-full overflow-y-auto">
            <SettingsApp ui={{
              wallpaperId,
              wpFit,
              wpBgColor,
              wpOpacity,
              mascotHidden,
              wallpapers: wallpapers.map(w => ({ id: w.id, name: w.name, image: w.image || undefined })),
              customWallpapers,
              onWallpaperChange: setWallpaperId,
              onWpFitChange: setWpFit,
              onWpBgColorChange: setWpBgColor,
              onWpOpacityChange: setWpOpacity,
              onMascotToggle: setMascotHidden,
              onWallpaperUpload: () => wallpaperInputRef.current?.click(),
              onCustomWallpaperDelete: (idx: number) => {
                setCustomWallpapers(prev => {
                  const next = prev.filter((_, i) => i !== idx);
                  try { localStorage.setItem("clawbox-custom-wallpapers", JSON.stringify(next)); } catch {}
                  if (wallpaperId === `custom-${idx}`) setWallpaperId("clawbox");
                  return next;
                });
              },
            }} />
          </div>
        );
      case "openclaw":
        return (
          <iframe
            src="/setup-api/gateway"
            className="w-full h-full border-0"
            title="OpenClaw Control"
          />
        );
      case "terminal":
        return <TerminalApp />;
      case "store":
        return (
          <AppStore
            installedAppIds={installedApps}
            onInstall={(app: StoreApp) => handleInstallApp(app)}
            onUninstall={requestUninstallApp}
          />
        );
      case "installed":
        return app.storeApp ? (
          <InstalledAppSettings
            appId={app.storeApp.id}
            storeApp={app.storeApp}
            icon={<InstalledAppIcon appId={app.storeApp.id} iconUrl={app.storeApp.iconUrl} name={app.storeApp.name} size="w-12 h-12" />}
          />
        ) : null;
      case "files":
        return <FilesApp />;
      case "browser":
        return <BrowserApp />;
      case "vnc":
        return <VNCApp />;
      case "vscode":
        return <VSCodeApp />;
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

  // Get installed store apps for desktop display (exclude hidden ones)
  const installedAppDefs = installedApps
    .filter((appId) => !hiddenInstalledApps.includes(appId))
    .map((appId) => {
      const meta = installedMeta[appId];
      if (!meta) return null;
      return { id: appId, name: meta.name, description: "", rating: 0, color: meta.color, category: "", iconUrl: meta.iconUrl } as StoreApp;
    })
    .filter((a): a is StoreApp => a !== null);

  // Built-in apps with desktop shortcuts
  const desktopBuiltinApps = desktopApps
    .map((appId) => apps.find((a) => a.id === appId))
    .filter((a): a is AppDef => a !== null);

  // Get all apps for launcher (including installed)
  const allAppsForLauncher = getAllApps();

  if (!setupChecked) {
    return <div className="min-h-screen bg-[#0a0f1a]" />;
  }

  return (
    <div className="min-h-screen relative overflow-hidden select-none">
      {/* Desktop wallpaper background */}
      {(() => {
        const customIdx = wallpaperId.startsWith("custom-") ? parseInt(wallpaperId.split("-")[1]) : -1;
        const customWp = customIdx >= 0 ? customWallpapers[customIdx] : undefined;
        return customWp ? (
          <>
            <div className="absolute inset-0 z-0 pointer-events-none" style={{ backgroundColor: wpBgColor }} />
            <div className="absolute inset-0 z-0 pointer-events-none" style={{ backgroundImage: `url(${customWp})`, ...wpFitStyle, opacity: wpOpacity / 100 }} />
          </>
      ) : currentWallpaper.image ? (
        <>
          <div className="absolute inset-0 z-0 pointer-events-none" style={{ backgroundColor: wpBgColor }} />
          <div className="absolute inset-0 z-0 pointer-events-none" style={{ backgroundImage: `url(${currentWallpaper.image})`, ...wpFitStyle, opacity: wpOpacity / 100 }} />
        </>
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
      <div className="absolute inset-0 z-[1] flex justify-center" style={{ paddingBottom: 56, paddingTop: 24 }} onContextMenu={handleDesktopContextMenu} onPointerDown={handleGridPointerDown}>
      <div ref={gridRef} className="relative" style={{ width: GRID_COLS * CELL_W, maxWidth: "100%" }}>
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
                className={`group flex flex-col items-center justify-start gap-2 p-3 rounded-xl hover:bg-white/10 active:bg-white/15 transition-all duration-200 select-none touch-none ${
                  isRecent ? "animate-install-bounce" : ""
                } ${isSelected ? "bg-white/15 ring-2 ring-blue-400/60 rounded-xl" : ""}`}
              >
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg ring-1 ring-black/20 transition-transform duration-200 group-hover:scale-105 group-active:scale-95"
                  style={{ backgroundColor: app.color }}
                >
                  <InstalledAppIcon appId={app.id} iconUrl={app.iconUrl} name={app.name} size="w-7 h-7" />
                </div>
                <span className="text-[13px] leading-tight text-white font-semibold text-center line-clamp-2 max-w-[80px] min-h-[calc(2*13px*1.25)]" style={{ textShadow: "0 1px 4px rgba(0,0,0,1), 0 0 10px rgba(0,0,0,0.8), 0 0 20px rgba(0,0,0,0.4)" }}>
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
                className={`group flex flex-col items-center justify-start gap-2 p-3 rounded-xl hover:bg-white/10 active:bg-white/15 transition-all duration-200 select-none touch-none ${isSelected ? "bg-white/15 ring-2 ring-blue-400/60 rounded-xl" : ""}`}
              >
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg ring-1 ring-black/20 transition-transform duration-200 group-hover:scale-105 group-active:scale-95"
                  style={{ backgroundColor: app.color }}
                >
                  <AppIcon id={app.id} size="w-7 h-7" />
                </div>
                <span className="text-[13px] leading-tight text-white font-semibold text-center line-clamp-2 max-w-[80px] min-h-[calc(2*13px*1.25)]" style={{ textShadow: "0 1px 4px rgba(0,0,0,1), 0 0 10px rgba(0,0,0,0.8), 0 0 20px rgba(0,0,0,0.4)" }}>
                  {app.name}
                </span>
              </button>
            </div>
          );
        })}

        {/* Ghost indicator for drop target */}
        {draggingIcon && dragGhost && (() => {
          const isOccupied = Object.entries(iconPositions).some(
            ([id, pos]) => id !== draggingIcon && pos.row === dragGhost.row && pos.col === dragGhost.col
          );
          if (isOccupied) {
            // Show insertion line on the left edge of the occupied cell
            return (
              <div
                style={{
                  position: "absolute",
                  left: dragGhost.col * CELL_W - 2,
                  top: dragGhost.row * CELL_H + 8,
                  width: 4,
                  height: CELL_H - 16,
                }}
                className="rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.6)] pointer-events-none"
              />
            );
          }
          return (
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
          );
        })()}

        </div>{/* end centering wrapper */}

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
                <InstalledAppIcon appId={app.storeApp.id} iconUrl={app.storeApp.iconUrl} name={app.storeApp.name} size="w-3 h-3" />
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
            initialPosition={window.x !== undefined && window.y !== undefined ? { x: window.x, y: window.y } : undefined}
            initialSize={window.width !== undefined && window.height !== undefined ? { width: window.width, height: window.height } : undefined}
            isActive={window.id === activeWindowId}
            zIndex={window.zIndex}
            onClose={() => closeWindow(window.id)}
            onFocus={() => focusWindow(window.id)}
            onMinimize={() => minimizeWindow(window.id)}
            onGeometryChange={(geo) => updateWindowGeometry(window.id, geo)}
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
              icon: <InstalledAppIcon appId={app.storeApp.id} iconUrl={app.storeApp.iconUrl} name={app.storeApp.name} />,
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
                    <InstalledAppIcon appId={app.storeApp.id} iconUrl={app.storeApp.iconUrl} name={app.storeApp.name} />
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
          className="fixed z-[99999] min-w-[200px] py-1 bg-[#2d2d2d] rounded-lg shadow-2xl border border-white/10 backdrop-blur-xl text-sm text-white/90 overflow-y-auto"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 220),
            top: Math.min(ctxMenu.y, window.innerHeight - 400),
            maxHeight: "calc(100vh - 80px)",
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
                    setHiddenInstalledApps(prev => prev.includes(id) ? prev : [...prev, id]);
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
              {isAppPinned(resolvedAppId) ? (
                <button onClick={() => handleUnpinApp(resolvedAppId)} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>keep_off</span> Unpin from shelf
                </button>
              ) : (
                <button onClick={() => handlePinApp(resolvedAppId)} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>keep</span> Pin to shelf
                </button>
              )}
              <div className="border-t border-white/10 my-1" />
              <button onClick={() => {
                if (ctxMenu.appId) requestUninstallApp(ctxMenu.appId);
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
                  // Hide installed app from desktop (not uninstall)
                  setHiddenInstalledApps(prev => prev.includes(id) ? prev : [...prev, id]);
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
              <button onClick={() => arrangeIcons()} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>grid_view</span> Arrange icons
              </button>
              <div className="border-t border-white/10 my-1" />
              <button onClick={() => openApp("settings")} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>settings</span> Settings
              </button>
            </>
          )}
        </div>
      )}

      {/* Uninstall confirmation modal */}
      {uninstallConfirm && (() => {
        const meta = installedMeta[uninstallConfirm];
        const appName = meta?.name || uninstallConfirm;
        return (
          <div className="fixed inset-0 z-[999999] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setUninstallConfirm(null)}>
            <div className="bg-[#1e2030] border border-white/10 rounded-2xl shadow-2xl p-6 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
              <div className="flex flex-col items-center text-center">
                <div className="w-14 h-14 rounded-xl flex items-center justify-center mb-4" style={{ backgroundColor: meta?.color || "#6b7280" }}>
                  <InstalledAppIcon appId={uninstallConfirm} iconUrl={meta?.iconUrl} name={appName} size="w-7 h-7" />
                </div>
                <h3 className="text-lg font-semibold text-white mb-1">Uninstall {appName}?</h3>
                <p className="text-sm text-white/50 mb-6">This will remove the app from your desktop and launcher. You can reinstall it from the App Store.</p>
                <div className="flex gap-3 w-full">
                  <button
                    onClick={() => setUninstallConfirm(null)}
                    className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-white/10 hover:bg-white/15 text-white transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmUninstallApp}
                    className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors cursor-pointer"
                  >
                    Uninstall
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
