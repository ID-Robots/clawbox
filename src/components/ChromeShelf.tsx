"use client";

import { ReactNode, useState, useEffect, useRef, useCallback } from "react";
import { useT } from "@/lib/i18n";
import { DESKTOP_LAYERS } from "@/lib/window-snap";
import type { Protection, ProtectionReason } from "@/lib/clawkeep-protection";

/** The reasons that put a shield in an at-risk state. `ok` is not among them. */
type AtRiskReason = Exclude<ProtectionReason, "ok">;

/**
 * What the shield says out loud for each way a box can be unprotected. The
 * amber "has drifted" shield and the red "never protected" one used to share
 * one sentence — "ClawKeep backup overdue" — so the distinction between them
 * reached only people who can see the difference between amber and red
 * (WCAG 2.2 SC 1.4.1). "Overdue" was also wrong for a run that ran and failed,
 * for one refusing to start, and for a backup that was never scheduled.
 *
 * Keyed on the at-risk reasons alone: an unprotected shield must never be able
 * to fall back to a reassuring "Open ClawKeep", so the type refuses the entry
 * rather than the code having to remember not to use it.
 */
const AT_RISK_TITLE_KEY: Record<AtRiskReason, string> = {
  stale: "shelf.clawkeepStale",
  error: "shelf.clawkeepFailed",
  blocked: "shelf.clawkeepBlocked",
  never: "shelf.clawkeepNeverBackedUp",
};

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
  clawkeepStatus?: {
    /** The shared protection verdict (see `deriveProtection`), whole or not at
     *  all — null while it is not yet known: on a box that is not paired, or
     *  before the first status arrives. State and reason travel together so a
     *  shield can never be at risk without a sentence to say why. */
    protection?: Protection | null;
    unconfigured?: boolean;
    busy: boolean;
    restoring: boolean;
  };
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
  clawkeepStatus = { protection: null, unconfigured: false, busy: false, restoring: false },
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
  // Phone portrait: hide chat crab + ClawKeep shield to fit launcher / clock /
  // fullscreen / power. Tablet portrait and phone landscape keep the full bar.
  const [isPortraitPhone, setIsPortraitPhone] = useState(false);

  useEffect(() => {
    const checkLayout = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setIsMobile(w < 768);
      setIsPortraitPhone(w < 500 && h > w);
    };
    checkLayout();
    window.addEventListener("resize", checkLayout);
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => {
      window.removeEventListener("resize", checkLayout);
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
    // Escape dismisses a menu, like it does everywhere else on the desktop.
    // Neither of these menus takes focus, so there was no key handler anywhere
    // to hear it and a click outside was the only way out.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setCtxMenu(null);
      setShelfMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKey);
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
  // Priority: restoring (orange) > backup running (green) > lapsed (amber)
  // > never-protected (red) > ok.
  // Restore is the rarer, longer, more user-blocking operation, so it wins
  // even if a backup heartbeat happens to be in flight at the same time.
  const protection = clawkeepStatus.protection;
  const atRisk = clawAiAuthenticated
    && !!protection && protection.state !== "protected" && protection.reason !== "ok";
  // Never-paired is not "overdue": nothing is late on a box that has never
  // been set up. It gets its own invitation and a calm colour instead of the
  // red alert a genuinely missed backup earns.
  const needsSetup = clawAiAuthenticated && !atRisk && !!clawkeepStatus.unconfigured;
  const baseTitle = !clawAiAuthenticated
    ? t("shelf.connectClawBoxAI")
    : atRisk
    ? t(AT_RISK_TITLE_KEY[protection!.reason as AtRiskReason])
    : needsSetup
    ? t("shelf.clawkeepNotSetUp")
    : t("shelf.openClawKeep");
  // A box that WAS protected and has drifted is not the same as one that
  // never was — the card says so in amber, and the shelf has to agree or the
  // distinction only exists on the screen the owner has not opened.
  const lapsed = atRisk && protection!.state === "lapsed";
  const mode: "restoring" | "busy" | "lapsed" | "alert" | "setup" | "ok" =
    clawkeepStatus.restoring ? "restoring"
    : clawkeepStatus.busy ? "busy"
    : !clawAiAuthenticated ? "alert"
    : lapsed ? "lapsed"
    : atRisk ? "alert"
    : needsSetup ? "setup"
    : "ok";
  // Tailwind JIT can only see *literal* class strings, so each variant
  // ships its full pulse/icon class names rather than composing them.
  const SHIELD_STYLE = {
    restoring: {
      icon: "text-amber-300 clawkeep-shelf-glow-orange",
      pulse: "bg-amber-400/25",
      pulseDelayed: "bg-amber-400/20",
      tooltip: t("shelf.clawkeepRestoring"),
    },
    busy: {
      icon: "text-emerald-300 clawkeep-shelf-glow",
      pulse: "bg-emerald-400/20",
      pulseDelayed: "bg-emerald-400/15",
      tooltip: t("shelf.clawkeepBusy"),
    },
    // Was protected, has drifted. The colour is the only thing this entry
    // changes: `baseTitle` already names the cause, so a screen reader is told
    // amber from red rather than being left to see it.
    lapsed: {
      icon: "text-amber-400 clawkeep-shelf-glow-orange",
      pulse: "bg-amber-400/25",
      pulseDelayed: "bg-amber-400/20",
      tooltip: baseTitle,
    },
    alert: {
      icon: "text-red-500 clawkeep-shelf-glow-red",
      pulse: "bg-red-500/25",
      pulseDelayed: "bg-red-500/20",
      tooltip: baseTitle,
    },
    // Never paired. It blinks so the invitation is noticed on a shelf the owner
    // is not looking at — but ORANGE, not the red a genuinely missed backup
    // earns: nothing is wrong yet, there is just something to set up.
    setup: {
      icon: "text-orange-300 clawkeep-shelf-glow-orange",
      pulse: "bg-orange-400/25",
      pulseDelayed: "bg-orange-400/20",
      tooltip: baseTitle,
    },
    ok: {
      icon: "text-emerald-300",
      pulse: "",
      pulseDelayed: "",
      tooltip: baseTitle,
    },
  } as const;
  const style = SHIELD_STYLE[mode];
  const shieldInteractive = typeof onClawKeepShieldClick === "function";
  const renderShieldButton = () => {
    if (!shieldInteractive) return null;
    const iconSize = isMobile ? 22 : 18;
    return (
      <button
        onClick={onClawKeepShieldClick}
        className="relative flex items-center justify-center w-10 h-10 rounded-full transition-colors hover:bg-white/10 active:bg-white/15 cursor-pointer"
        title={style.tooltip}
        aria-label={style.tooltip}
        data-testid="shelf-clawkeep-shield-button"
      >
        {style.pulse && (
          <>
            <span className={`absolute inset-1 rounded-full ${style.pulse} clawkeep-shelf-pulse pointer-events-none`} aria-hidden="true" />
            <span className={`absolute inset-1 rounded-full ${style.pulseDelayed} clawkeep-shelf-pulse-delayed pointer-events-none`} aria-hidden="true" />
          </>
        )}
        <span
          className={`material-symbols-rounded relative ${style.icon}`}
          style={{ fontSize: iconSize }}
        >
          shield
        </span>
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
      {/* `data-mascot-ground` marks the surface a Hermes pet walks on. The
          mascot measures THIS element — its top edge is the pet's ground line
          and its width is how far the pet may roam — so the pet keeps standing
          on the shelf as the safe-area inset or the viewport changes. Nothing
          reads it on OpenClaw: the crab keeps the desktop floor. */}
      <div
        data-mascot-ground
        className="fixed bottom-0 left-0 right-0 flex items-center justify-center px-2"
        style={{
          zIndex: DESKTOP_LAYERS.shelf,
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
            {/* Every mobile bar button shares a 40×40 container for a single baseline. */}
            <div className="absolute left-2 flex items-center">
              <button
                onClick={onLauncherClick}
                className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
                title={t("shelf.appLauncher")}
                aria-label={t("shelf.appLauncher")}
                data-testid="shelf-launcher-button"
              >
                <div className="w-9 h-9 rounded-full flex items-center justify-center bg-gradient-to-br from-white/20 to-white/5 border border-white/10">
                  <span className="material-symbols-rounded text-white/80" style={{ fontSize: 20 }}>apps</span>
                </div>
              </button>
            </div>
            {showChatButton && !isPortraitPhone && (
              <button
                onClick={onChatClick}
                data-testid="shelf-chat-button"
                className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
                title={t("shelf.chat")}
                aria-label={t("shelf.chat")}
              >
                <img src="/clawbox-crab.png" alt="Chat" className="w-[21px] h-[21px] object-contain" />
              </button>
            )}
            <div className="absolute right-2 flex items-center gap-1">
              {!isPortraitPhone && renderShieldButton()}
              {!isPortraitPhone && (
                <button
                  onClick={onTrayClick}
                  className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
                  title={t("shelf.systemSettings")}
                  aria-label={t("shelf.systemSettings")}
                  data-testid="shelf-tray-button"
                >
                  <span className="text-xs text-white/80 font-medium tabular-nums">{time}</span>
                </button>
              )}
              <button
                onClick={toggleFullscreen}
                className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
                title={isFullscreen ? t("shelf.exitFullscreen") : t("shelf.fullscreen")}
              >
                <span className="material-symbols-rounded text-white/60" style={{ fontSize: 20 }}>
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
                <span className="material-symbols-rounded text-white/60" style={{ fontSize: 20 }}>power_settings_new</span>
              </button>
            </div>
          </>
        ) : <>
        {/* One launcher button per shelf. A second, `sm:hidden` copy used to sit
            at the left of this branch — dead weight, since anything narrower
            than 768px renders the mobile bar above instead, but always in the
            DOM: two elements answered `shelf-launcher-button`, which is a
            strict-locator failure for a test and a duplicated "App Launcher"
            control for assistive tech. */}

        {/* Centered: pinned + open apps */}
        <div className="flex items-center gap-1">
          {/* Launcher button — desktop only (inline) */}
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
              data-testid="shelf-chat-button"
              className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
              title={t("shelf.chat")}
              aria-label={t("shelf.chat")}
            >
              <img src="/clawbox-crab.png" alt="Chat" className="w-[21px] h-[21px] object-contain" />
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
          className="fixed min-w-[180px] py-1 bg-[#2d2d2d] rounded-lg shadow-2xl border border-white/10 backdrop-blur-xl text-sm text-white/90"
          style={{
            zIndex: DESKTOP_LAYERS.menu,
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
          className="fixed min-w-[180px] py-1 bg-[#2d2d2d] rounded-lg shadow-2xl border border-white/10 backdrop-blur-xl text-sm text-white/90"
          style={{
            zIndex: DESKTOP_LAYERS.menu,
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
