"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import * as kv from "@/lib/client-kv";
import ChromeShelf from "@/components/ChromeShelf";
import ChromeLauncher from "@/components/ChromeLauncher";
import ChromeWindow from "@/components/ChromeWindow";
import SystemTray from "@/components/SystemTray";
import SettingsApp from "@/components/SettingsApp";
import AppStore from "@/components/AppStore";
import FilesApp from "@/components/FilesApp";
import type { StoreApp } from "@/components/AppStore";
import TerminalApp from "@/components/TerminalApp";
import InstalledAppSettings from "@/components/InstalledAppSettings";
import BrowserApp from "@/components/BrowserApp";
import VNCApp from "@/components/VNCApp";
import ChatPopup from "@/components/ChatPopup";
import SetupWizard from "@/components/SetupWizard";
import { I18nProvider, useT } from "@/lib/i18n";
import { cleanVersion } from "@/lib/version-utils";


const Mascot = dynamic(() => import("@/components/Mascot"), { ssr: false });

// App definitions
interface AppDef {
  id: string;
  name: string;
  color: string;
  type: "settings" | "placeholder" | "external" | "store" | "installed" | "terminal" | "files" | "browser" | "vnc" | "webapp" | "setup";
  url?: string;
  pinned: boolean;
  defaultWidth?: number;
  defaultHeight?: number;
  storeApp?: StoreApp;
}

const apps: AppDef[] = [
  { id: "settings", name: "app.settings", color: "#6b7280", type: "settings", pinned: true, defaultWidth: 800, defaultHeight: 600 },
  { id: "openclaw", name: "app.openclaw", color: "#0a0f1a", type: "external", url: "http://clawbox.local/chat", pinned: true },
  { id: "terminal", name: "app.terminal", color: "#1a1a2e", type: "terminal" as const, pinned: false, defaultWidth: 900, defaultHeight: 600 },
  { id: "files", name: "app.files", color: "#f97316", type: "files", pinned: true },
  { id: "store", name: "app.store", color: "#22c55e", type: "store", pinned: true, defaultWidth: 900, defaultHeight: 600 },
  { id: "browser", name: "app.browser", color: "#4285f4", type: "browser", pinned: false, defaultWidth: 1000, defaultHeight: 700 },
  { id: "vnc", name: "app.remoteDesktop", color: "#7c3aed", type: "vnc", pinned: false, defaultWidth: 1000, defaultHeight: 700 },
];
const DEFAULT_DESKTOP_APPS = apps.map(a => a.id);

// Inline SVG icons for each app
function MIcon({ name, className = "", size = 24 }: { name: string; className?: string; size?: number }) {
  return <span className={`material-symbols-rounded ${className}`} style={{ fontSize: size }}>{name}</span>;
}

function AppIcon({ id, size = "w-6 h-6" }: { id: string; size?: string }) {
  const px = size.includes("w-6") ? 24 : size.includes("w-5") ? 20 : size.includes("w-4") ? 16 : 24;

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
    setup: "construction",
    terminal: "terminal",
    files: "folder",
    vnc: "desktop_windows",
    camera: "photo_camera",
    store: "storefront",
    chat: "chat_bubble",
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
  meta?: Record<string, string>;
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


function ChromeDesktopInner() {
  const { t } = useT();
  const resolveAppName = (app: AppDef) => t(app.name) || app.name;
  const [setupChecked, setSetupChecked] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);

  // Check if setup is complete. The desktop boots either way; incomplete
  // setups get the wizard opened as a window after the UI loads.
  useEffect(() => {
    Promise.all([
      fetch("/setup-api/setup/status").then(r => r.json()),
      kv.init(),
    ])
      .then(([data]) => {
        setSetupRequired(!data.setup_complete);
        setSetupChecked(true);
      })
      .catch(() => setSetupChecked(true)); // If API fails, show desktop anyway
  }, []);

  // ─── Haptic feedback helper ───
  const vibrate = useCallback((ms: number = 10) => {
    try { navigator.vibrate?.(ms); } catch {}
  }, []);

  const [launcherOpen, setLauncherOpen] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [openWindows, setOpenWindows] = useState<OpenWindow[]>([]);
  const [nextZIndex, setNextZIndex] = useState(100);
  const nextZIndexRef = useRef(100);
  const [time, setTime] = useState("");
  const [date, setDate] = useState("");
  const [installedApps, setInstalledApps] = useState<string[]>([]);
  const [recentlyInstalled, setRecentlyInstalled] = useState<string | null>(null);
  const [installedMeta, setInstalledMeta] = useState<Record<string, { name: string; color: string; iconUrl: string }>>({});

  // ─── Desktop shortcuts for built-in apps ───
  const [desktopApps, setDesktopApps] = useState<string[]>(DEFAULT_DESKTOP_APPS);
  const [hiddenInstalledApps, setHiddenInstalledApps] = useState<string[]>([]);
  const handleAddToDesktop = useCallback((appId: string) => {
    // Also unhide installed apps when adding to desktop
    setHiddenInstalledApps(prev => prev.filter(id => id !== appId && id !== `installed-${appId}`));
    setDesktopApps(prev => prev.includes(appId) ? prev : [...prev, appId]);

  }, []);

  // ─── Dynamic pin state ───
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
  const wallpapers = [
    { id: "clawbox", name: "ClawBox", gradient: "", stars: false, nebula: false, image: "/clawbox-wallpaper.jpeg" },
    { id: "deep-space", name: "Deep Space", gradient: "bg-gradient-to-br from-[#0a0f1a] via-[#111827] to-[#1a1f2e]", stars: true, nebula: false, image: "" },
  ] as const;
  const [wallpaperId, setWallpaperId] = useState("clawbox");
  const currentWallpaper = wallpapers.find(w => w.id === wallpaperId) || wallpapers[0];
  type WpFit = "fill" | "fit" | "center";
  const [wpFit, setWpFit] = useState<WpFit>("fill");
  const [wpBgColor, setWpBgColor] = useState("#000000");
  const [wpOpacity, setWpOpacity] = useState(50);
  // ─── Unified SQLite load on mount ───
  const prefsLoaded = useRef(false);
  useEffect(() => {
    nextZIndexRef.current = nextZIndex;
  }, [nextZIndex]);

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
            .filter((w) => w.appId !== "setup")
            .map((w, i) => ({ id: `${w.appId}-${Date.now()}-${i}`, appId: w.appId, zIndex: 100 + i, minimized: w.minimized, x: w.x, y: w.y, width: w.width, height: w.height }));
          if (restored.length > 0) {
            setOpenWindows(restored);
            setNextZIndex(100 + restored.length);
          }
        }
        // Mascot
        if (data.ui_mascot_hidden) setMascotHidden(true);
        // Chat panel dock state
        if (data.ui_chat_panel_width && Number(data.ui_chat_panel_width) > 0) {
          setChatPanelWidth(Number(data.ui_chat_panel_width));
          setChatOpen(true);
        } else if (data.ui_chat_open) {
          setChatOpen(true);
        }
        // Auto-open chat once after fresh install (no saved preferences yet)
        if (!data.desktop_apps && !data.wp_id && !kv.get('clawbox-chat-greeted')) {
          kv.set('clawbox-chat-greeted', '1');
          setChatOpen(true);
        }
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
  // Wallpapers are large base64 blobs — keep in localStorage to avoid
  // bloating the KV JSON file that gets read/written on every state save.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CUSTOM_WPS_KEY);
      if (saved) setCustomWallpapers(JSON.parse(saved));
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

  // ─── Chat (mascot click toggles chat popup) ───
  const [chatOpen, setChatOpen] = useState(false);
  const [chatPanelWidth, setChatPanelWidth] = useState(0);
  const [mascotX, setMascotX] = useState(85);
  const handleChatPanelModeChange = useCallback((panelWidth: number) => setChatPanelWidth(panelWidth), []);

  // Open chat when a skill is installed/uninstalled/toggled
  useEffect(() => {
    const handler = () => setChatOpen(true);
    window.addEventListener('clawbox-skill-installed', handler);
    return () => window.removeEventListener('clawbox-skill-installed', handler);
  }, []);

  // ─── Mascot visibility ───
  const [mascotHidden, setMascotHidden] = useState(false);
  useEffect(() => {
    const onShow = () => setMascotHidden(false);
    const onHide = () => setMascotHidden(true);
    window.addEventListener("clawbox-show-mascot", onShow);
    window.addEventListener("clawbox-hide-mascot", onHide);
    return () => { window.removeEventListener("clawbox-show-mascot", onShow); window.removeEventListener("clawbox-hide-mascot", onHide); };
  }, []);

  // ─── Desktop icon grid + mobile detection (single resize listener) ───
  const [gridDims, setGridDims] = useState({ cols: 10, cellW: 100, mobile: false });
  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      const cellW = w < 500 ? 85 : 100;
      const cols = Math.max(3, Math.floor(w / cellW));
      setGridDims({ cols, cellW, mobile: w < 768 });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const GRID_COLS = gridDims.cols;
  const isMobile = gridDims.mobile;
  const GRID_ROWS = 6;
  const CELL_W = gridDims.cellW;
  const CELL_H = 110; // px
  const [iconPositions, setIconPositions] = useState<Record<string, { row: number; col: number }>>({});
  const [draggingIcon, setDraggingIcon] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dragGhost, setDragGhost] = useState<{ row: number; col: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // ─── Unified SQLite save (debounced, after all state is declared) ───
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
          desktop_open_windows: openWindows
            .filter((w) => w.appId !== "setup")
            .map(w => ({ appId: w.appId, minimized: w.minimized, x: w.x, y: w.y, width: w.width, height: w.height })),
          ui_mascot_hidden: mascotHidden ? 1 : 0,
          ui_chat_panel_width: chatPanelWidth || 0,
          ui_chat_open: chatOpen ? 1 : 0,
        }),
      }).catch(() => {});
    }, 500);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [wallpaperId, wpFit, wpBgColor, wpOpacity, installedApps, installedMeta, desktopApps, hiddenInstalledApps, pinnedOverrides, iconPositions, openWindows, mascotHidden, chatPanelWidth, chatOpen]);

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
    // Long-press on touch → open desktop context menu
    if (isTouchDevice) {
      longPressFired.current = false;
      const x = e.clientX, y = e.clientY;
      longPressTimer.current = setTimeout(() => {
        longPressFired.current = true;
        ctxMenuOpenedAt.current = Date.now();
        setCtxMenu({ x, y });
      }, 500);
    }
    marqueeRef.current = { active: true, startX: e.clientX, startY: e.clientY };
    setMarquee(null);

    const onMove = (ev: PointerEvent) => {
      if (!marqueeRef.current.active) return;
      const dx = ev.clientX - marqueeRef.current.startX;
      const dy = ev.clientY - marqueeRef.current.startY;
      // Cancel long-press on movement
      if (Math.abs(dx) + Math.abs(dy) >= 5 && longPressTimer.current) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = undefined;
      }
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
      if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = undefined; }
      marqueeRef.current.active = false;
      setMarquee(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  // ─── Context menu ───
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; appId?: string; isGroup?: boolean } | null>(null);

  const ctxMenuOpenedAt = useRef(0);
  const longPressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const longPressFired = useRef(false);
  const isTouchDevice = typeof window !== "undefined" && "ontouchstart" in window;



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



  // Arrange all desktop icons — desktop: single column top-left, mobile: centered grid
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
    const positions: Record<string, { row: number; col: number }> = {};
    const mobile = typeof window !== "undefined" && window.innerWidth < 768;
    if (mobile) {
      // Mobile: top-aligned grid, filling columns left to right
      const cols = Math.min(allIconIds.length, GRID_COLS);
      allIconIds.forEach((id, i) => {
        positions[id] = { row: Math.floor(i / cols), col: i % cols };
      });
    } else {
      // Desktop: single column, top-left aligned
      allIconIds.forEach((id, i) => {
        positions[id] = { row: i, col: 0 };
      });
    }
    setIconPositions(positions);
  }, [installedApps, hiddenInstalledApps, desktopApps, iconPositions]);

  // Auto-arrange when icons are added/removed or grid dimensions change
  useEffect(() => {
    const visibleInstalled = installedApps.filter((id) => !hiddenInstalledApps.includes(id));
    const builtinIds = desktopApps.map((id) => `desktop-${id}`);
    const allIconIds = [...visibleInstalled, ...builtinIds];
    const missing = allIconIds.filter((id) => !iconPositions[id]);
    const overflow = allIconIds.some((id) => iconPositions[id] && iconPositions[id].col >= GRID_COLS);
    if (missing.length === 0 && !overflow) return;
    arrangeIcons();
  }, [installedApps, hiddenInstalledApps, desktopApps, GRID_COLS]); // eslint-disable-line react-hooks/exhaustive-deps

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

    // Long-press on touch → open icon context menu
    longPressFired.current = false;
    if (isTouchDevice) {
      longPressTimer.current = setTimeout(() => {
        longPressFired.current = true;
        ctxMenuOpenedAt.current = Date.now();
        if (selectedIcons.size > 1 && selectedIcons.has(appId)) {
          setCtxMenu({ x: startX, y: startY, appId, isGroup: true });
        } else {
          setCtxMenu({ x: startX, y: startY, appId });
        }
        // Clean up listeners since we're opening menu, not dragging
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      }, 500);
    }

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!isDragging && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      if (!isDragging) {
        isDragging = true;
        if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = undefined; }
        setDraggingIcon(appId);
      }
      setDragPos({ x: ev.clientX, y: ev.clientY });
      const s = snapToGrid(ev.clientX, ev.clientY);
      if (s) setDragGhost(s);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = undefined; }
      if (!isDragging) {
        // It was a tap/click — open the app via the onClick handler (unless long-press fired)
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

  const confirmUninstallApp = useCallback(async () => {
    if (!uninstallConfirm) return;
    const appId = uninstallConfirm;
    // Remove skill files and reload gateway
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      await fetch("/setup-api/apps/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId }),
        signal: controller.signal,
      });
      clearTimeout(timer);
    } catch (err) {
      console.warn("[uninstall] Failed to uninstall skill:", err);
    }
    setInstalledApps((prev) => prev.filter((id) => id !== appId));
    setOpenWindows((prev) => prev.filter((w) => w.appId !== `installed-${appId}`));
    setIconPositions((prev) => {
      const next = { ...prev };
      delete next[appId];
      return next;
    });
    setUninstallConfirm(null);
    // Refresh agent session with updated skills
    window.dispatchEvent(new CustomEvent('clawbox-skill-installed', { detail: { action: 'uninstall', id: appId } }));
  }, [uninstallConfirm]);

  // Get all apps including installed ones
  const getAllApps = useCallback((): AppDef[] => {
    const installedAppDefs: AppDef[] = [];
    for (const appId of installedApps) {
      const meta = installedMeta[appId] as Record<string, string> | undefined;
      if (meta) {
        const isWebapp = !!meta.webappUrl;
        const storeApp: StoreApp = { id: appId, name: meta.name, description: "", rating: 0, color: meta.color, category: "", iconUrl: meta.iconUrl };
        installedAppDefs.push({
          id: `installed-${appId}`,
          name: meta.name,
          color: meta.color,
          type: isWebapp ? "webapp" : "installed",
          url: isWebapp ? meta.webappUrl : undefined,
          pinned: false,
          defaultWidth: isWebapp ? 800 : 600,
          defaultHeight: isWebapp ? 600 : 400,
          storeApp,
        });
      }
    }
    return [
      ...apps,
      ...installedAppDefs,
      {
        id: "setup",
        name: "Setup",
        color: "#f97316",
        type: "setup",
        pinned: false,
        defaultWidth: 980,
        defaultHeight: 760,
      },
    ];
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

  useEffect(() => {
    if (!setupChecked || !setupRequired) return;
    setOpenWindows((prev) => {
      if (prev.some((w) => w.appId === "setup")) return prev;
      const z = nextZIndexRef.current;
      return [...prev, { id: `setup-${Date.now()}`, appId: "setup", zIndex: z, minimized: false }];
    });
    setNextZIndex((z) => z + 1);
  }, [setupChecked, setupRequired]);

  const handleSetupComplete = useCallback(() => {
    setSetupRequired(false);
    setOpenWindows((prev) => prev.filter((w) => w.appId !== "setup"));
  }, []);

  // ─── Android back button / browser back handling ───
  useEffect(() => {
    // Push a dummy history state so back button triggers popstate instead of leaving
    const pushState = () => {
      if (window.history.state !== "clawbox") {
        window.history.pushState("clawbox", "");
      }
    };
    pushState();

    const handleBack = (e: PopStateEvent) => {
      // Re-push state to stay on the page
      pushState();

      // Close things in priority order
      if (launcherOpen) { setLauncherOpen(false); return; }
      if (trayOpen) { setTrayOpen(false); return; }

      // Close topmost non-minimized window
      const visible = openWindows.filter(w => !w.minimized);
      if (visible.length > 0) {
        const top = visible.reduce((a, b) => a.zIndex > b.zIndex ? a : b);
        closeWindow(top.id);
        return;
      }
    };

    window.addEventListener("popstate", handleBack);
    return () => window.removeEventListener("popstate", handleBack);
  }, [launcherOpen, trayOpen, openWindows, closeWindow]);

  // ─── Poll for MCP-triggered UI actions (open app, notify, etc.) ───
  const openAppRef = useRef(openApp);
  openAppRef.current = openApp;

  useEffect(() => {
    let active = true;
    let lastProcessedTs = 0;
    let polling = false;
    const poll = async () => {
      if (!active || polling) return;
      polling = true;
      try {
        const res = await fetch("/setup-api/kv?key=ui:pending-action");
        if (res.ok) {
          const data = await res.json();
          if (data.value) {
            const action = typeof data.value === "string" ? JSON.parse(data.value) : data.value;
            const ts = action.ts ?? 0;
            // Skip if already processed
            if (ts > 0 && ts <= lastProcessedTs) { polling = false; return; }
            lastProcessedTs = ts;
            // Delete before processing to prevent re-reads
            await fetch("/setup-api/kv", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ key: "ui:pending-action", delete: true }),
            }).catch(() => {});
            if (action.type === "open_app" && action.appId) {
              openAppRef.current(action.appId);
            } else if (action.type === "register_webapp" && action.appId && action.name && action.url) {
              setInstalledApps(prev => prev.includes(action.appId) ? prev : [...prev, action.appId]);
              setInstalledMeta(prev => ({
                ...prev,
                [action.appId]: {
                  name: action.name,
                  color: action.color || "#f97316",
                  iconUrl: action.iconUrl || "",
                  webappUrl: action.url,
                },
              }));
              setHiddenInstalledApps(prev => prev.includes(action.appId) ? prev.filter(id => id !== action.appId) : prev);
            } else if (action.type === "notify" && action.message) {
              window.dispatchEvent(new CustomEvent("clawbox:toast", { detail: { message: action.message } }));
            }
          }
        }
      } catch {}
      polling = false;
    };
    const id = setInterval(poll, 2000);
    return () => { active = false; clearInterval(id); };
  }, []);

  // Surfaces a corner card when ClawBox or OpenClaw has a newer release.
  // Dismissals persist per exact target-version pair via SQLite so the user
  // isn't pestered across browsers or after a cache wipe.
  const [updateAvailable, setUpdateAvailable] = useState<{
    clawbox: { current: string | null; target: string | null };
    openclaw: { current: string | null; target: string | null };
  } | null>(null);
  const lastVersionFingerprintRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const checkVersions = async () => {
      try {
        const versionsRes = await fetch("/setup-api/update/versions");
        if (!active || !versionsRes.ok) return;
        const data = await versionsRes.json();
        const clawboxNeedsUpdate = !!data.clawbox?.target && data.clawbox.target !== data.clawbox.current;
        const openclawNeedsUpdate = !!data.openclaw?.target && data.openclaw.target !== data.openclaw.current;
        // Fingerprint covers both targets *and* currents — bumping the device
        // version after an update should retire a stale "available" card even
        // if the next-target hasn't shifted yet.
        const fingerprint = `${data.clawbox?.current ?? ""}|${data.clawbox?.target ?? ""}|${data.openclaw?.current ?? ""}|${data.openclaw?.target ?? ""}`;
        if (fingerprint === lastVersionFingerprintRef.current) return;
        lastVersionFingerprintRef.current = fingerprint;

        if (!clawboxNeedsUpdate && !openclawNeedsUpdate) {
          setUpdateAvailable(null);
          return;
        }
        // Only hit the dismissal store when we actually have something to suppress.
        const dismissalRes = await fetch("/setup-api/update/dismissal");
        let dismissed: string | null = null;
        if (dismissalRes.ok) {
          try { dismissed = (await dismissalRes.json()).fingerprint ?? null; } catch {}
        }
        const dismissalFingerprint = `${data.clawbox?.target ?? ""}|${data.openclaw?.target ?? ""}`;
        setUpdateAvailable(dismissed === dismissalFingerprint ? null : data);
      } catch { /* network blip — try again next interval */ }
    };
    checkVersions();
    const id = setInterval(checkVersions, 30 * 60 * 1000);
    return () => { active = false; clearInterval(id); };
  }, []);

  const dismissUpdateNotification = useCallback(() => {
    setUpdateAvailable((current) => {
      if (current) {
        const fingerprint = `${current.clawbox?.target ?? ""}|${current.openclaw?.target ?? ""}`;
        fetch("/setup-api/update/dismissal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fingerprint }),
        }).catch(() => { /* will retry next dismiss */ });
      }
      return null;
    });
  }, []);

  const openUpdateSettings = useCallback(() => {
    // Stash the section before opening so SettingsApp drains it on mount,
    // and also dispatch the event for already-mounted instances.
    (window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection = "about";
    window.dispatchEvent(new CustomEvent("clawbox:open-settings-section", { detail: { section: "about" } }));
    openAppRef.current("settings");
    dismissUpdateNotification();
  }, [dismissUpdateNotification]);

  const openSettingsSection = useCallback((section: "ai" | "localAi") => {
    (window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection = section;
    window.dispatchEvent(new CustomEvent("clawbox:open-settings-section", { detail: { section } }));
    openApp("settings");
  }, [openApp]);

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
    vibrate(10);
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

  const renderWindowContent = (appId: string, _meta?: Record<string, string>) => {
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
            onUninstall={requestUninstallApp}
          />
        ) : null;
      case "files":
        return <FilesApp />;
      case "browser":
        return <BrowserApp onOpenApp={openApp} />;
      case "vnc":
        return <VNCApp />;
      case "webapp": {
        let webappSrc = "about:blank";
        try { const u = new URL(app.url || "", window.location.origin); if (["http:", "https:"].includes(u.protocol)) webappSrc = u.href; } catch {}
        return (
          <iframe
            src={webappSrc}
            style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
            title={resolveAppName(app)}
          />
        );
      }
      case "setup":
        return (
          <div className="h-full overflow-y-auto bg-[var(--bg-deep)]">
            <SetupWizard onComplete={handleSetupComplete} />
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
                {resolveAppName(app)}
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
    .filter((a): a is AppDef => !!a);

  // Get all apps for launcher (including installed)
  const allApps = getAllApps();
  const allAppsForLauncher = allApps.filter((app) => app.id !== "setup");

  // ─── Mobile fullscreen splash (every load) ───
  const [showSplash, setShowSplash] = useState(() => {
    if (typeof window === "undefined") return false;
    const isMobileUA = /Android|iPhone|iPad/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
    // Show on mobile browsers, not standalone PWA, not already fullscreen
    return isMobileUA && !isStandalone && !document.fullscreenElement;
  });

  const handleSplashTap = useCallback(() => {
    document.documentElement.requestFullscreen().catch(() => {});
    setShowSplash(false);
  }, []);

  const dismissSplash = useCallback(() => {
    setShowSplash(false);
  }, []);

  // ─── Global drag-and-drop file upload ───
  const [desktopDragOver, setDesktopDragOver] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const dragCountRef = useRef(0);

  const handleDesktopDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) {
      dragCountRef.current++;
      setDesktopDragOver(true);
    }
  }, []);
  const handleDesktopDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); }, []);
  const handleDesktopDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) { dragCountRef.current = 0; setDesktopDragOver(false); }
  }, []);
  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  const uploadFileWithProgress = useCallback((file: File, dir: string, onProgress: (pct: number) => void): Promise<{ ok: boolean; error?: string }> => {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/setup-api/files?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({ ok: true });
        } else {
          try {
            const data = JSON.parse(xhr.responseText);
            resolve({ ok: false, error: data.error });
          } catch {
            resolve({ ok: false, error: `Upload failed (${xhr.status})` });
          }
        }
      };
      xhr.onerror = () => resolve({ ok: false, error: "Network error" });
      xhr.send(file);
    });
  }, []);

  const handleDesktopDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current = 0;
    setDesktopDragOver(false);
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    const dir = "/home/clawbox/Downloads";
    const total = files.length;
    const totalSize = Array.from(files).reduce((sum, f) => sum + f.size, 0);

    // Check available disk space before uploading
    try {
      const res = await fetch(`/setup-api/files?dir=${encodeURIComponent(dir)}`);
      if (res.ok) {
        const data = await res.json();
        if (typeof data.availableSpace === 'number' && totalSize > data.availableSpace) {
          setUploadStatus(`Not enough disk space. Need ${formatBytes(totalSize)}, only ${formatBytes(data.availableSpace)} available.`);
          setTimeout(() => setUploadStatus(null), 5000);
          return;
        }
      }
    } catch { /* proceed anyway */ }

    let ok = 0;
    setUploadProgress(0);
    for (let i = 0; i < total; i++) {
      const file = files[i];
      setUploadStatus(`Uploading ${file.name} (${i + 1}/${total})...`);
      const result = await uploadFileWithProgress(file, dir, (pct) => {
        const overallPct = Math.round(((i + pct / 100) / total) * 100);
        setUploadProgress(overallPct);
      });
      if (result.ok) {
        ok++;
      } else if (result.error) {
        setUploadStatus(result.error);
        setUploadProgress(0);
        setTimeout(() => { setUploadStatus(null); }, 5000);
        return;
      }
    }
    setUploadStatus(`Uploaded ${ok}/${total} file(s)`);
    setUploadProgress(100);
    setTimeout(() => { setUploadStatus(null); setUploadProgress(0); }, 3000);
  }, [uploadFileWithProgress]);

  if (!setupChecked) {
    return <div className="bg-[#0a0f1a]" style={{ height: '100dvh' }} />;
  }

  return (
    <div
      data-testid="desktop-root"
      className="relative overflow-hidden select-none"
      style={{ height: '100dvh' }}
      onContextMenu={(e) => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return;
        e.preventDefault();
      }}
      onDragEnter={handleDesktopDragEnter}
      onDragOver={handleDesktopDragOver}
      onDragLeave={handleDesktopDragLeave}
      onDrop={handleDesktopDrop}
    >
      {/* Drop overlay */}
      {desktopDragOver && (
        <div className="fixed inset-0 z-[99998] flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-none">
          <div className="flex flex-col items-center gap-3 p-8 rounded-2xl border-2 border-dashed border-orange-500/60 bg-[#0d1117]/90">
            <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 48 }}>upload_file</span>
            <span className="text-lg font-semibold text-white">Drop files to upload</span>
            <span className="text-sm text-white/50">Files will be saved to Downloads</span>
          </div>
        </div>
      )}
      {/* Upload status toast */}
      {uploadStatus && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[99998] min-w-[220px] rounded-lg bg-[#1e2030] border border-white/10 text-sm text-white shadow-lg overflow-hidden">
          <div className="px-4 py-2">{uploadStatus}</div>
          {uploadProgress < 100 && (
            <div className="h-1 bg-white/5">
              <div className="h-full bg-[var(--coral-bright)] transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
            </div>
          )}
        </div>
      )}
      {/* New version available notification */}
      {updateAvailable && (() => {
        const cb = updateAvailable.clawbox;
        const oc = updateAvailable.openclaw;
        const cbNeeds = !!cb?.target && cb.target !== cb.current;
        const ocNeeds = !!oc?.target && oc.target !== oc.current;
        return (
          <div
            className="fixed top-4 right-4 z-[99998] w-[320px] rounded-xl bg-[#1e2030] border border-white/10 shadow-2xl overflow-hidden animate-in slide-in-from-top-2 fade-in duration-300"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-start gap-3 px-4 py-3">
              <div className="w-9 h-9 rounded-full bg-orange-500/15 border border-orange-500/30 flex items-center justify-center shrink-0">
                <span className="material-symbols-rounded text-orange-400" style={{ fontSize: 20 }}>system_update</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-white">{t("updateNotification.title")}</div>
                <div className="text-xs text-white/60 mt-0.5">{t("updateNotification.description")}</div>
                <div className="mt-2 space-y-0.5">
                  {cbNeeds && (
                    <div className="text-[11px] text-white/70 font-mono truncate">
                      ClawBox {cleanVersion(cb.current) ?? "?"} → <span className="text-orange-300">{cleanVersion(cb.target) ?? "?"}</span>
                    </div>
                  )}
                  {ocNeeds && (
                    <div className="text-[11px] text-white/70 font-mono truncate">
                      OpenClaw {cleanVersion(oc.current) ?? "?"} → <span className="text-orange-300">{cleanVersion(oc.target) ?? "?"}</span>
                    </div>
                  )}
                </div>
              </div>
              <button
                onClick={dismissUpdateNotification}
                className="w-7 h-7 flex items-center justify-center rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors shrink-0 bg-transparent border-none cursor-pointer"
                aria-label={t("updateNotification.dismiss")}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
              </button>
            </div>
            <div className="flex items-center gap-2 px-4 pb-3">
              <button
                onClick={openUpdateSettings}
                className="flex-1 px-3 py-1.5 rounded-md bg-orange-500 hover:bg-orange-600 text-white text-xs font-semibold transition-colors cursor-pointer border-none"
              >
                {t("updateNotification.viewUpdate")}
              </button>
              <button
                onClick={dismissUpdateNotification}
                className="px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/70 text-xs font-medium transition-colors cursor-pointer border-none"
              >
                {t("updateNotification.later")}
              </button>
            </div>
          </div>
        );
      })()}
      {/* Mobile fullscreen splash */}
      {showSplash && (
        <div
          className="fixed inset-0 z-[99999] flex flex-col items-center justify-center bg-[#0a0f1a] cursor-pointer"
          onClick={handleSplashTap}
        >
          <img src="/icon-512.png" alt="ClawBox" className="w-24 h-24 rounded-3xl mb-6 shadow-2xl" />
          <h1 className="text-2xl font-bold text-white mb-2">ClawBox</h1>
          <p className="text-white/50 text-sm mb-8">Personal AI Assistant</p>
          <div className="flex flex-col items-center gap-3">
            <div className="px-8 py-3 rounded-xl bg-orange-500 text-white font-semibold text-base shadow-lg">
              Tap to Enter Fullscreen
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); dismissSplash(); }}
              className="text-white/30 text-xs hover:text-white/50 bg-transparent border-none cursor-pointer mt-2"
            >
              Skip
            </button>
          </div>
        </div>
      )}

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
                onClick={() => { if (!draggingIcon && !longPressFired.current) openApp(`installed-${app.id}`); }}
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
                onClick={() => { if (!draggingIcon && !longPressFired.current) openApp(app.id); }}
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
                  {resolveAppName(app)}
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

      {/* Mascot - tapping toggles chat popup, hidden when chat is docked as panel */}
      {chatPanelWidth === 0 && (
        <Mascot frozen={chatOpen} onTap={(x?: number) => { if (x !== undefined) setMascotX(x); setChatOpen(prev => !prev); }} onPositionChange={chatOpen ? setMascotX : undefined} />
      )}
      <ChatPopup isOpen={chatOpen} onClose={() => setChatOpen(false)} onOpenSettingsSection={openSettingsSection} onPanelModeChange={handleChatPanelModeChange} initialPanelWidth={chatPanelWidth} mascotX={mascotHidden ? 85 : mascotX} trayMode={mascotHidden} />

      {/* Windows — mobile: fullscreen, desktop: ChromeWindow */}
      {isMobile ? (
        // Mobile: render only the topmost non-minimized window as fullscreen
        (() => {
          const visible = openWindows.filter(w => !w.minimized);
          if (visible.length === 0) return null;
          const top = visible.reduce((a, b) => a.zIndex > b.zIndex ? a : b);
          const allApps = getAllApps();
          const app = allApps.find(a => a.id === top.appId);
          if (!app) return null;
          return (
            <div
              key={top.id}
              className="fixed inset-0 z-[200] flex flex-col bg-[#0d1117] animate-slide-up"
              style={{ paddingBottom: 'calc(56px + env(safe-area-inset-bottom))', paddingTop: 'env(safe-area-inset-top)' }}
            >
              {/* Mobile window header */}
              <div className="flex items-center gap-3 px-3 py-2 bg-[#161b22] border-b border-white/[0.06] shrink-0">
                <button
                  onClick={() => { vibrate(10); closeWindow(top.id); }}
                  className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 text-white/60 cursor-pointer"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
                <div className="w-6 h-6 rounded flex items-center justify-center shrink-0" style={{ backgroundColor: app.color }}>
                  {app.type === "installed" && app.storeApp
                    ? <InstalledAppIcon appId={app.storeApp.id} iconUrl={app.storeApp.iconUrl} name={app.storeApp.name} size="w-3 h-3" />
                    : <AppIcon id={app.id} size="w-3 h-3" />}
                </div>
                <span className="text-sm font-medium text-white/80 truncate flex-1">{resolveAppName(app)}</span>
                {visible.length > 1 && (
                  <button
                    onClick={() => minimizeWindow(top.id)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 text-white/60 cursor-pointer"
                    title="Switch app"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" /></svg>
                  </button>
                )}
              </div>
              {/* Mobile window content */}
              <div className="flex-1 overflow-hidden">
                {renderWindowContent(top.appId, top.meta)}
              </div>
            </div>
          );
        })()
      ) : (
        // Desktop: normal ChromeWindow rendering
        openWindows.map((window) => {
          const app = allApps.find((a) => a.id === window.appId);
          if (!app) return null;

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
              title={resolveAppName(app)}
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
              rightInset={chatPanelWidth}
            >
              {renderWindowContent(window.appId, window.meta)}
            </ChromeWindow>
          );
        })
      )}

      {/* App Launcher */}
      <ChromeLauncher
        apps={allAppsForLauncher.map((app) => {
          if (app.type === "installed" && app.storeApp) {
            return {
              id: app.id,
              name: resolveAppName(app),
              color: app.color,
              icon: <InstalledAppIcon appId={app.storeApp.id} iconUrl={app.storeApp.iconUrl} name={app.storeApp.name} />,
              isPinned: isAppPinned(app.id),
            };
          }
          return {
            id: app.id,
            name: resolveAppName(app),
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
            .filter((a): a is AppDef => !!a)
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
              name: resolveAppName(app),
              icon: renderIcon(),
              isOpen: appWindows.length > 0,
              isActive: topWin?.id === activeWindowId && !topWin?.minimized,
              isPinned: pinnedIds.has(app.id),
              windowCount: appWindows.length,
              url: app.url,
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
          // Clock click — no-op for now (could open a calendar/notifications panel)
        }}
        onPowerClick={() => {
          setLauncherOpen(false);
          setTrayOpen((prev) => !prev);
        }}
        onPinApp={handlePinApp}
        onUnpinApp={handleUnpinApp}
        onCloseApp={(appId) => {
          setOpenWindows(prev => prev.filter(w => w.appId !== appId));
        }}
        onShelfSettings={() => openApp("settings")}
        onChatClick={() => setChatOpen(prev => !prev)}
        showChatButton={mascotHidden}
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
              <button onClick={() => {
                window.open(`/app/${encodeURIComponent(resolvedAppId)}`, "_blank");
              }} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_new</span> Open in new tab
              </button>
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
              <div className="border-t border-white/10 my-1" />
              <button onClick={() => window.location.reload()} className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>refresh</span> Refresh
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

export default function ChromeDesktop() {
  return (
    <I18nProvider>
      <ChromeDesktopInner />
    </I18nProvider>
  );
}
