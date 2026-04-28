"use client";

import { ReactNode, useState, useEffect, useRef, useCallback } from "react";
import { useT } from "@/lib/i18n";

interface ShelfApp {
  id: string;
  name: string;
  icon: ReactNode;
  isOpen: boolean;
  isActive: boolean;
  isPinned?: boolean;
  windowCount?: number;
  url?: string;
}

interface ChromeShelfProps {
  apps: ShelfApp[];
  onAppClick: (id: string) => void;
  onNewWindow?: (id: string) => void;
  onLauncherClick: () => void;
  onTrayClick: () => void;
  onClawKeepShieldClick?: () => void;
  clawkeepStale?: boolean;
  onPinApp?: (id: string) => void;
  onUnpinApp?: (id: string) => void;
  onCloseApp?: (id: string) => void;
  onShelfSettings?: () => void;
  onPowerClick?: () => void;
  onChatClick?: () => void;
  showChatButton?: boolean;
  time: string;
  clawAiAuthenticated?: boolean;
}

export default function ChromeShelf({
  apps,
  onAppClick,
  onNewWindow,
  onLauncherClick,
  onTrayClick,
  onClawKeepShieldClick,
  clawkeepStale = false,
  onPinApp,
  onUnpinApp,
  onCloseApp,
  onShelfSettings,
  onPowerClick,
  onChatClick,
  showChatButton,
  time,
  clawAiAuthenticated = false,
}: ChromeShelfProps) {
  const { t } = useT();
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; app: ShelfApp } | null>(null);
  const [shelfMenu, setShelfMenu] = useState<{ x: number; y: number } | null>(null);
  const openedAt = useRef(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => {
      window.removeEventListener("resize", checkMobile);
      document.removeEventListener("fullscreenchange", onFsChange);
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!ctxMenu && !shelfMenu) return;
    const close = (e: Event) => {
      if (Date.now() - openedAt.current < 100) return;
      e.preventDefault();
      setCtxMenu(null);
      setShelfMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [ctxMenu, shelfMenu]);

  // Pinned apps already live on the mobile home grid; the bottom bar would
  // overflow past the visible area on narrow phones if we duplicated them
  // here. On mobile keep only Settings pinned (frequent system access),
  // show full set on desktop.
  const pinnedApps = isMobile
    ? apps.filter(a => a.id === "settings" && a.isPinned !== false)
    : apps.filter(a => a.isPinned !== false);
  const unpinnedApps = isMobile
    ? apps.filter(a => a.isOpen && a.id !== "settings")
    : apps.filter(a => a.isPinned === false);
  const shieldTitle = clawAiAuthenticated
    ? t("shelf.openClawKeep")
    : t("shelf.connectClawBoxAI");
  // Two reasons to flag the shield red: AI not connected (needs setup) or
  // ClawKeep is paired/configured but hasn't run a backup in >24 h. The
  // first is the original behaviour; the second is the new stale-backup
  // signal so a user notices their off-device backups stopped before they
  // need to restore.
  const shieldClasses = clawAiAuthenticated && !clawkeepStale
    ? "text-emerald-300"
    : "text-red-700";
  const shieldInteractive = typeof onClawKeepShieldClick === "function";
  const renderShieldButton = () => {
    if (!shieldInteractive) return null;
    return (
      <button
        onClick={onClawKeepShieldClick}
        className="flex items-center justify-center w-10 h-10 rounded-full transition-colors hover:bg-white/10 active:bg-white/15 cursor-pointer"
        title={shieldTitle}
        aria-label={shieldTitle}
        data-testid="shelf-clawkeep-shield-button"
      >
        <span className={`material-symbols-rounded ${shieldClasses}`} style={{ fontSize: 18 }}>shield</span>
      </button>
    );
  };

  const renderApp = (app: ShelfApp) => (
    <button
      key={app.id}
      data-crab-platform="true"
      data-testid={`shelf-app-${app.id}`}
      onClick={() => onAppClick(app.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openedAt.current = Date.now();
        setCtxMenu({ x: e.clientX, y: e.clientY, app });
      }}
      className="relative w-11 h-11 flex items-center justify-center rounded-lg hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer group"
      title={app.name}
      aria-label={app.name}
    >
      <div className="w-10 h-10 flex items-center justify-center">{app.icon}</div>

      {/* Active indicator dot(s) */}
      {app.isOpen && (
        <div className="absolute bottom-0.5 left-1/2 -translate-x-1/2 flex items-center gap-0.5">
          {(app.windowCount ?? 1) > 1 ? (
            Array.from({ length: Math.min(app.windowCount ?? 1, 4) }).map((_, i) => (
              <div
                key={i}
                className={`h-1 w-1.5 rounded-full transition-all ${
                  app.isActive ? "bg-white" : "bg-white/60"
                }`}
              />
            ))
          ) : (
            <div
              className={`h-1 rounded-full transition-all ${
                app.isActive ? "w-4 bg-white" : "w-1.5 bg-white/60"
              }`}
            />
          )}
        </div>
      )}

      {/* Tooltip — hide when context menu is open */}
      {!ctxMenu && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-[#1e2939] text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap border border-white/10">
          {app.name}
        </div>
      )}
    </button>
  );

  return (
    <>
      <div
        className="fixed bottom-0 left-0 right-0 flex items-center justify-center px-2 z-[10000]"
        style={{
          height: "calc(56px + env(safe-area-inset-bottom))",
          paddingBottom: "env(safe-area-inset-bottom)",
          background: "rgba(17, 24, 39, 0.55)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderTop: "1px solid rgba(255, 255, 255, 0.1)",
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openedAt.current = Date.now();
          setShelfMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {isMobile ? (
          <>
            {/* Mobile: launcher (left), chat (center), clock + fullscreen + power (right) */}
            <div className="absolute left-2 flex items-center">
              <button
                onClick={onLauncherClick}
                className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
                title={t("shelf.appLauncher")}
                aria-label={t("shelf.appLauncher")}
                data-testid="shelf-launcher-button"
              >
                <div className="w-10 h-10 rounded-full flex items-center justify-center bg-gradient-to-br from-white/20 to-white/5 border border-white/10">
                  <span className="material-symbols-rounded text-white/80" style={{ fontSize: 22 }}>apps</span>
                </div>
              </button>
            </div>
            {showChatButton && (
              <button
                onClick={onChatClick}
                className="flex items-center justify-center w-12 h-12 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
                title={t("shelf.chat")}
                aria-label={t("shelf.chat")}
              >
                <img src="/clawbox-crab.png" alt="Chat" className="w-12 h-12 object-contain" />
              </button>
            )}
            <div className="absolute right-2 flex items-center gap-1">
              {renderShieldButton()}
              <button
                onClick={onTrayClick}
                className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
                title={t("shelf.systemSettings")}
                aria-label={t("shelf.systemSettings")}
                data-testid="shelf-tray-button"
              >
                <span className="text-xs text-white/80 font-medium tabular-nums">{time}</span>
              </button>
              <button
                onClick={toggleFullscreen}
                className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
                title={isFullscreen ? t("shelf.exitFullscreen") : t("shelf.fullscreen")}
              >
                <span className="material-symbols-rounded text-white/60" style={{ fontSize: 18 }}>
                  {isFullscreen ? "fullscreen_exit" : "fullscreen"}
                </span>
              </button>
              <button
                onClick={onPowerClick}
                className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
                title={t("shelf.power")}
                aria-label={t("shelf.power")}
                data-testid="shelf-power-button"
              >
                <span className="material-symbols-rounded text-white/60" style={{ fontSize: 18 }}>power_settings_new</span>
              </button>
            </div>
          </>
        ) : <>
        {/* Launcher button — left, mobile only (desktop renders it inline) */}
        <div className="absolute left-2 flex items-center sm:hidden">
          <button
            onClick={onLauncherClick}
            className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
            title={t("shelf.appLauncher")}
            aria-label={t("shelf.appLauncher")}
            data-testid="shelf-launcher-button"
          >
            <div className="w-10 h-10 rounded-full flex items-center justify-center bg-gradient-to-br from-white/20 to-white/5 border border-white/10">
              <span className="material-symbols-rounded text-white/80" style={{ fontSize: 22 }}>apps</span>
            </div>
          </button>
        </div>

        {/* Centered: pinned + open apps */}
        <div className="flex items-center gap-1">
          {/* Launcher button — desktop only (inline) */}
          <button
            onClick={onLauncherClick}
            className="w-11 h-11 hidden sm:flex items-center justify-center rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
            title={t("shelf.appLauncher")}
            aria-label={t("shelf.appLauncher")}
            data-testid="shelf-launcher-button"
          >
            <div className="w-10 h-10 rounded-full flex items-center justify-center bg-gradient-to-br from-white/20 to-white/5 border border-white/10">
              <span className="material-symbols-rounded text-white/80" style={{ fontSize: 22 }}>apps</span>
            </div>
          </button>

          {/* Separator (desktop only) */}
          <div className="w-px h-8 bg-white/10 mx-1 hidden sm:block" />

          {/* Pinned apps */}
          {pinnedApps.map(renderApp)}

          {/* Separator between pinned and unpinned open apps */}
          {unpinnedApps.length > 0 && (
            <div className="w-px h-8 bg-white/10 mx-1" />
          )}

          {/* Unpinned open apps */}
          {unpinnedApps.map(renderApp)}
        </div>

        {/* Right side: system tray */}
        <div className="absolute right-2 flex items-center gap-1">
          {showChatButton && (
            <button
              onClick={onChatClick}
              className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
              title={t("shelf.chat")}
              aria-label={t("shelf.chat")}
            >
              <img src="/clawbox-crab.png" alt="Chat" className="w-10 h-10 object-contain" />
            </button>
          )}
          {renderShieldButton()}
          <button
            onClick={onTrayClick}
            className="hidden sm:flex items-center h-10 px-3 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
            title={t("shelf.systemSettings")}
            aria-label={t("shelf.systemSettings")}
            data-testid="shelf-tray-button"
          >
            <span className="text-sm text-white/80 font-medium">{time}</span>
          </button>
          <button
            onClick={toggleFullscreen}
            className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
            title={isFullscreen ? t("shelf.exitFullscreen") : t("shelf.fullscreen")}
          >
            <span className="material-symbols-rounded text-white/60" style={{ fontSize: 18 }}>
              {isFullscreen ? "fullscreen_exit" : "fullscreen"}
            </span>
          </button>
          <button
            onClick={onPowerClick}
            className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
            title={t("shelf.power")}
            aria-label={t("shelf.power")}
            data-testid="shelf-power-button"
          >
            <span className="material-symbols-rounded text-white/60" style={{ fontSize: 18 }}>power_settings_new</span>
          </button>
        </div>
        </>}
      </div>

      {/* Shelf context menu */}
      {ctxMenu && (
        <div
          className="fixed z-[99999] min-w-[180px] py-1 bg-[#2d2d2d] rounded-lg shadow-2xl border border-white/10 backdrop-blur-xl text-sm text-white/90"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 200),
            top: ctxMenu.y - 8,
            transform: "translateY(-100%)",
          }}
          onClick={() => setCtxMenu(null)}
        >
          {/* App name header */}
          <div className="px-4 py-1.5 text-xs text-white/40 font-medium truncate">
            {ctxMenu.app.name}
          </div>
          <div className="border-t border-white/10 my-0.5" />

          {/* Open / Focus */}
          <button
            onClick={() => { onAppClick(ctxMenu.app.id); setCtxMenu(null); }}
            className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3"
          >
            <span className="text-base">▶️</span> {ctxMenu.app.isOpen ? t("shelf.focus") : t("shelf.open")}
          </button>

          {/* New Window — only if app is already open */}
          {ctxMenu.app.isOpen && onNewWindow && (
            <button
              onClick={() => { onNewWindow(ctxMenu.app.id); setCtxMenu(null); }}
              className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3"
            >
              <span className="text-base">🪟</span> {t("shelf.newWindow")}
            </button>
          )}

          {/* Open in new tab */}
          <button
            onClick={() => { window.open(`/app/${encodeURIComponent(ctxMenu.app.id)}`, "_blank"); setCtxMenu(null); }}
            className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_new</span> {t("shelf.openNewTab")}
          </button>

          {/* Pin / Unpin */}
          {ctxMenu.app.isPinned ? (
            <button
              onClick={() => { if (onUnpinApp) onUnpinApp(ctxMenu.app.id); setCtxMenu(null); }}
              className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3"
            >
              <span className="text-base">📌</span> {t("shelf.unpinFromShelf")}
            </button>
          ) : (
            <button
              onClick={() => { if (onPinApp) onPinApp(ctxMenu.app.id); setCtxMenu(null); }}
              className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3"
            >
              <span className="text-base">📌</span> {t("shelf.pinToShelf")}
            </button>
          )}

          {/* Close — only if app is open */}
          {ctxMenu.app.isOpen && onCloseApp && (
            <>
              <div className="border-t border-white/10 my-0.5" />
              <button
                onClick={() => { onCloseApp(ctxMenu.app.id); setCtxMenu(null); }}
                className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3 text-red-400"
              >
                <span className="text-base">✕</span> {t("shelf.close")}
              </button>
            </>
          )}
        </div>
      )}

      {/* Shelf context menu (right-click on empty shelf area) */}
      {shelfMenu && (
        <div
          className="fixed z-[99999] min-w-[180px] py-1 bg-[#2d2d2d] rounded-lg shadow-2xl border border-white/10 backdrop-blur-xl text-sm text-white/90"
          style={{
            left: Math.min(shelfMenu.x, window.innerWidth - 200),
            top: shelfMenu.y - 8,
            transform: "translateY(-100%)",
          }}
          onClick={() => setShelfMenu(null)}
        >
          <button
            onClick={() => { if (onShelfSettings) onShelfSettings(); }}
            className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3"
          >
            <span className="material-symbols-rounded text-white/60" style={{ fontSize: 18 }}>settings</span>
            {t("shelf.shelfSettings")}
          </button>
        </div>
      )}
    </>
  );
}
