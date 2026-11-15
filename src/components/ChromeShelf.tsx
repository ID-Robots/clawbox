"use client";

import { ReactNode, WheelEvent, useState, useEffect, useRef, useCallback, useSyncExternalStore } from "react";
import { useT } from "@/lib/i18n";
import { DESKTOP_LAYERS } from "@/lib/window-snap";
import { mainInsets } from "@/lib/desktop-screens";
import { useDeskScreens } from "@/lib/use-desk-screens";
import type { Protection, ProtectionReason } from "@/lib/clawkeep-protection";
import { formatBytesApart } from "@/lib/format-bytes";
import { openInKiosk } from "@/lib/kiosk-tabs-client";
import { useDesktopClock } from "@/lib/use-desktop-clock";
import { desktopOverlayMounted, quickCaptureRequest, requestCapture, subscribeOverlays } from "@/lib/screenshot/session";
import { captureShortcutKeys } from "@/lib/screenshot/shortcuts";
import { useCanRequestFullscreen, useIsFullscreen } from "@/lib/use-is-fullscreen";
import BatteryIndicator from "./BatteryIndicator";

/** The reasons that put a shield in an at-risk state. `ok` is not among them. */
type AtRiskReason = Exclude<ProtectionReason, "ok">;

/**
 * The shelf's fill: a flat tint, not frosted glass. Chromium cannot redraw
 * part of a backdrop blur: anything that changes over ANY pixel of the bar —
 * the mascot standing on it (its feet and glows reach a few pixels in), the
 * shield's pulse on every box not signed in to ClawBox AI, a pet, a window
 * beneath — re-blurred the WHOLE bar, at the rate the change ran: measured as
 * 1920x162 of damage per frame for a resting crab where 154x154 would do, and
 * 1920x56 at 60 Hz for the pulse. A plain fill is redrawn only where something
 * moved. 0.8 is the fill that reads closest to the glass over the built-in
 * wallpapers (compared pixel by pixel in Chromium): the bar's brightness moves
 * by under 3/255, and the wallpaper's own detail now shows through faintly,
 * where the blur used to smear it. kiosk/extension/bar.js wears the same fill
 * on the desktop (kiosk-extension.test.ts).
 */
const SHELF_FILL = "rgba(17, 24, 39, 0.8)";

/**
 * The phone bar's fill, more opaque than the shelf's. On a phone the icon grid
 * scrolls UNDER the bar (its scroll area is the whole screen, padded 56 px at
 * the bottom; in landscape a row can sit under it before any scrolling), and
 * at the shelf's 0.8 the tiles and their white labels showed through sharp:
 * faint but readable text, where the blur used to leave only a soft glow.
 * 0.93 is where a label's brightest step (17.9/255) meets the glass's own
 * strongest glow (17.8/255) — measured in Chromium over the four built-in
 * wallpapers, with the grid at every offset of a row, portrait and landscape.
 * There the tiles show through less than the glass's glows did, and the bar
 * is on average 4.5/255 darker than the glass (2.8 at 0.8). 0.9 still left
 * the labels 40% brighter than anything the glass let through; anything more
 * opaque only darkens the bar further from the glass's tone.
 */
const PHONE_BAR_FILL = "rgba(17, 24, 39, 0.93)";

/**
 * THE ROOM A BAR HAS, NOT THE DEVICE IT IS ON.
 *
 * The bar is a row of three: the launcher, the apps and the tray. The tray is
 * in the row — it takes the width its buttons need and the apps are what give
 * way: they shrink and scroll (`APP_ROW`) instead of sliding under it, however
 * many are pinned or open. Nothing here asks which phone, fold or window it is.
 *
 * A tray with everything in it is wider than a small bar can spare, though, so
 * the buttons the bar can do without leave it, lowest value first, as the
 * BAR's own width falls: a CSS container query on the row, not a media query on
 * the viewport, so zoom, a narrow window and a docked panel all count the same.
 * It never sheds the chat crab (a phone's way back to the assistant),
 * fullscreen, the signed-in user or power.
 *
 * Each width below is the room the bar needs to keep that button AND leave the
 * apps three icons, counting every button at its widest:
 *
 *   launcher + divider ........................ 57px   (44 + 13)
 *   three app icons, 4px apart, in their row .. 148px  (3 x 44 + 2 x 4 + 8)
 *   chat, fullscreen, user, power ............. 172px  (4 x 40 + 3 x 4)
 *   + shield .................................. 44px   -> needs 421px, 26.25rem
 *   + clock, "12:34 PM" ....................... 92px   -> needs 513px, 32rem
 *   + screenshot and battery, "100%" .......... 110px  -> needs 623px, 39rem
 *
 * Rounded to a tidy rem, within a pixel; a bar narrower than it gives that button up (a
 * Tailwind `@max-[X]` is a strict `width < X`). The count is the same for
 * both bars (the phone's launcher is the narrower, so it sheds a hair sooner
 * than it must), and it is by width alone — never by how many apps are open —
 * so opening an app never moves the tray.
 */
const SHED_FIRST = "@max-[39rem]:hidden"; // screenshot, battery: a bar under 624px
const SHED_CLOCK = "@max-[32rem]:hidden"; // the clock: under 512px
const SHED_LAST = "@max-[26.25rem]:hidden"; // the shield: under 420px

/**
 * The app row of either bar. `min-w-0` lets it shrink below its icons and
 * `overflow-x-auto` scrolls the rest (a wheel is turned sideways below), with
 * `justify-center-safe` so a row that fits sits in the middle and one that does
 * not starts at its first app instead of losing it off the left edge. The
 * scrollbar is hidden: it would take 15px of a 56px bar on a desktop browser.
 */
const APP_ROW =
  "min-w-0 flex items-center justify-center-safe gap-1 overflow-x-auto overflow-y-hidden px-1 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

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

/** A backup the daemon would not upload — see `useClawkeepShieldStatus`. */
interface ShieldRefusal {
  kind: "quota_full" | "usage_unverified";
  neededBytes: number;
  freeBytes: number;
}

/**
 * What the shield says for a backup that was REFUSED rather than one that
 * broke. "Last backup failed — open to see why" is true of it and useless: the
 * owner of a full account is told nothing they can act on until they open the
 * window. The sizes are the ones the ClawKeep card prints, in the same units.
 */
function refusalTitle(
  refusal: ShieldRefusal,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (refusal.kind === "usage_unverified") return t("shelf.clawkeepUsageUnverified");
  // Apart, as on the card: never "needs 1.2 GB but only 1.2 GB is free".
  const [needed, free] = formatBytesApart(refusal.neededBytes, refusal.freeBytes);
  return t("shelf.clawkeepNoRoom", { needed, free });
}

interface ShelfApp {
  id: string;
  name: string;
  icon: ReactNode;
  isOpen: boolean;
  isActive: boolean;
  isPinned?: boolean;
  windowCount?: number;
  url?: string;
  /**
   * The app is a web page opened in the browser rather than a window here —
   * on the laptop's kiosk, the Web app standing for every page the desktop
   * opened. Its menu offers a new tab in place of a new window, and not the
   * "open in new tab" that means this app's own /app/<id> page.
   */
  external?: boolean;
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
    /** Why the last backup was refused, when it was. Said only beside an
     *  `error` verdict — it is that verdict's reason, not one of its own. */
    refusal?: ShieldRefusal | null;
  };
  onPinApp?: (id: string) => void;
  onUnpinApp?: (id: string) => void;
  onCloseApp?: (id: string) => void;
  onShelfSettings?: () => void;
  onPowerClick?: () => void;
  onChatClick?: () => void;
  showChatButton?: boolean;
  clawAiAuthenticated?: boolean;
  /**
   * Who is signed in (TASK-1256). Drawn as an avatar beside the power button
   * only when given — page.tsx passes it on a box with more than one user, so
   * a single-user shelf is unchanged. Opens the tray, where "Switch user" is.
   */
  sessionUser?: { username: string; isOwner: boolean } | null;
}

/**
 * The shelf's clock. It reads the desktop clock itself (see
 * use-desktop-clock.ts) instead of being handed the time by the desktop, so a
 * new minute re-renders this label — not the desktop, every window on it and
 * the chat.
 */
function ShelfClock({ className }: { className: string }) {
  const { time } = useDesktopClock();
  return <span className={className}>{time}</span>;
}

/**
 * The Screenshot app's button in the tray (TASK-1491): one click starts a
 * region selection, as Shift+Print Screen does, through the request the app's
 * own capture buttons send — the window need not be open, it opens itself on
 * the result. Its name gives the region keys, the ones it stands for. Drawn
 * only while the desktop's capture overlay is mounted (the owner's desktop,
 * like the app), since nothing else would answer the click.
 */
function ShelfScreenshotButton({ iconSize, className = "" }: { iconSize: number; className?: string }) {
  const { t } = useT();
  const available = useSyncExternalStore(subscribeOverlays, desktopOverlayMounted, () => false);
  if (!available) return null;
  const [key, fallback] = captureShortcutKeys("region");
  const label = t("screenshot.trayTooltip", { key, fallback });
  return (
    <button
      type="button"
      onClick={() => requestCapture(quickCaptureRequest("region"))}
      className={`flex items-center justify-center w-10 h-10 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer ${className}`}
      title={label}
      aria-label={label}
      data-testid="shelf-screenshot-button"
    >
      <span className="material-symbols-rounded text-white/60" style={{ fontSize: iconSize }} aria-hidden="true">
        screenshot_monitor
      </span>
    </button>
  );
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
  clawAiAuthenticated = false,
  sessionUser = null,
}: ChromeShelfProps) {
  const { t } = useT();
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; app: ShelfApp } | null>(null);
  const [shelfMenu, setShelfMenu] = useState<{ x: number; y: number } | null>(null);
  const openedAt = useRef(0);
  const isFullscreen = useIsFullscreen();
  const canFullscreen = useCanRequestFullscreen();
  const [isMobile, setIsMobile] = useState(false);
  // The app whose name is showing, drawn below at the bar's level (see
  // `renderApp`): not inside the app row, which scrolls and so would clip it.
  const [appTip, setAppTip] = useState<{ id: string; name: string; x: number; y: number } | null>(null);
  const deskScreens = useDeskScreens();
  const mainIns = deskScreens ? mainInsets() : null;

  useEffect(() => {
    // Only the bar's FLAVOUR hangs on the width (the phone bar lists Settings
    // and the open apps; the desktop one every pinned app). What fits in it
    // never does: the row and the tray below are sized by the room the bar
    // has, whatever the device, orientation or zoom.
    const checkLayout = () => {
      setIsMobile(window.innerWidth < 768);
      // The icons move (or the other bar replaces them) under a resting
      // pointer, which fires no mouseleave: a name left showing would float
      // where its icon no longer is.
      setAppTip(null);
    };
    checkLayout();
    window.addEventListener("resize", checkLayout);
    return () => {
      window.removeEventListener("resize", checkLayout);
    };
  }, []);

  const enterFullscreen = useCallback(() => {
    // Optional all the way: the button is not drawn where the API is missing,
    // and a call that answers no promise must not throw either.
    document.documentElement.requestFullscreen?.()?.catch(() => {});
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
  // Every OPEN app on the phone, whether the desktop shelf pins it or not —
  // an unpinned Settings is still open, and an open app the bar does not draw
  // is one that vanishes the moment it is switched away from.
  const unpinnedApps = isMobile
    ? apps.filter(a => a.isOpen && !pinnedApps.some(p => p.id === a.id))
    : apps.filter(a => a.isPinned === false);
  // Offered only while there is a fullscreen to ENTER, in a browser that can
  // be asked for one (an iPhone's Safari cannot). Once the page fills the
  // screen — its own request, F11, or a kiosk's window — the button is gone
  // rather than turned into "Exit": leaving is the browser's own gesture (Esc
  // or F11 with a keyboard, the system's back or swipe on a touch screen).
  const renderFullscreenButton = (iconSize: number) => canFullscreen && !isFullscreen && (
    <button
      onClick={enterFullscreen}
      className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
      title={t("shelf.fullscreen")}
      aria-label={t("shelf.fullscreen")}
      data-testid="shelf-fullscreen-button"
    >
      <span className="material-symbols-rounded text-white/60" style={{ fontSize: iconSize }}>fullscreen</span>
    </button>
  );
  // Priority: restoring (orange) > backup running (green) > lapsed (amber)
  // > never-protected (red) > ok.
  // Restore is the rarer, longer, more user-blocking operation, so it wins
  // even if a backup heartbeat happens to be in flight at the same time.
  const renderUserBadge =(size: number) => sessionUser && (
    <button
      onClick={onPowerClick}
      className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
      title={t("tray.signedInAsName", { name: sessionUser.username })}
      aria-label={t("tray.signedInAsName", { name: sessionUser.username })}
      data-testid="shelf-user-badge"
    >
      <span
        aria-hidden="true"
        className="rounded-full flex items-center justify-center font-semibold text-white"
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size * 0.5),
          backgroundColor: sessionUser.isOwner ? "#fe6e00" : "#6366f1",
        }}
      >
        {sessionUser.username.charAt(0).toUpperCase()}
      </span>
    </button>
  );
  const protection = clawkeepStatus.protection;
  const atRisk = clawAiAuthenticated
    && !!protection && protection.state !== "protected" && protection.reason !== "ok";
  // Never-paired is not "overdue": nothing is late on a box that has never
  // been set up. It gets its own invitation and a calm colour instead of the
  // red alert a genuinely missed backup earns.
  const needsSetup = clawAiAuthenticated && !atRisk && !!clawkeepStatus.unconfigured;
  const refusal = atRisk && protection!.reason === "error" ? clawkeepStatus.refusal ?? null : null;
  const baseTitle = !clawAiAuthenticated
    ? t("shelf.connectClawBoxAI")
    : refusal
    ? refusalTitle(refusal, t)
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
  const renderShieldButton = (extraClass = "") => {
    if (!shieldInteractive) return null;
    const iconSize = isMobile ? 22 : 18;
    return (
      <button
        onClick={onClawKeepShieldClick}
        className={`relative flex items-center justify-center w-10 h-10 rounded-full transition-colors hover:bg-white/10 active:bg-white/15 cursor-pointer ${extraClass}`}
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
      onClick={() => {
        // A tap is a hover that never ends: the name goes with the click.
        setAppTip(null);
        onAppClick(app.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openedAt.current = Date.now();
        setAppTip(null);
        setCtxMenu({ x: e.clientX, y: e.clientY, app });
      }}
      // The name shows ABOVE the icon, so it cannot live inside the app row: a
      // row that scrolls clips whatever sticks out of it, and the name sits
      // wholly outside. It is one fixed element drawn once below the bar,
      // placed from the icon's own box.
      onMouseEnter={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        setAppTip({ id: app.id, name: app.name, x: box.left + box.width / 2, y: box.top });
      }}
      onMouseLeave={() => setAppTip(null)}
      className="relative shrink-0 w-11 h-11 flex items-center justify-center rounded-lg hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
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
    </button>
  );

  // A wheel has no sideways: turn it into the row's own scroll, so a mouse can
  // reach an app the row has scrolled away. A trackpad's sideways swipe (any
  // deltaX) already scrolls it and is left alone.
  const scrollRowWithWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (e.deltaX !== 0 || e.deltaY === 0) return;
    // `deltaMode`: Firefox reports a notch of a wheel as a few LINES, not
    // pixels; a page is the row's own width.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? e.currentTarget.clientWidth : 1;
    e.currentTarget.scrollLeft += e.deltaY * unit;
  };

  // The tray's buttons, for BOTH bars from one list so the two cannot drift:
  // only the glyph sizes differ. The ones the bar can do without carry the
  // `SHED_*` class that a narrow bar hides them by; each is a direct child of
  // the tray, so a button that draws nothing (no battery on this box, no
  // shield without a handler) leaves no empty cell behind to take a gap.
  const renderTray = (phone: boolean) => (
    <>
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
      {renderShieldButton(SHED_LAST)}
      <ShelfScreenshotButton iconSize={phone ? 22 : 18} className={SHED_FIRST} />
      {/* The laptop's battery, left of the clock; renders nothing on a box
          without one. */}
      <BatteryIndicator className={SHED_FIRST} />
      {/* As wide as the time it shows (`min-w-10`, not `w-10`): a 12-hour
          clock is wider than a 40px circle and spilled over its neighbours. */}
      <button
        onClick={onTrayClick}
        className={`flex items-center justify-center h-10 min-w-10 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer ${phone ? "px-1" : "px-3"} ${SHED_CLOCK}`}
        title={t("shelf.systemSettings")}
        aria-label={t("shelf.systemSettings")}
        data-testid="shelf-tray-button"
      >
        <ShelfClock className={phone ? "text-xs text-white/80 font-medium tabular-nums" : "text-sm text-white/80 font-medium"} />
      </button>
      {renderFullscreenButton(phone ? 20 : 18)}
      {renderUserBadge(22)}
      <button
        onClick={onPowerClick}
        className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
        title={t("shelf.power")}
        aria-label={t("shelf.power")}
        data-testid="shelf-power-button"
      >
        <span className="material-symbols-rounded text-white/60" style={{ fontSize: phone ? 20 : 18 }}>power_settings_new</span>
      </button>
    </>
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
          // On the main monitor when the desktop is spread over several.
          ...(mainIns ? { left: mainIns.left, right: mainIns.right, bottom: mainIns.bottom } : {}),
          zIndex: DESKTOP_LAYERS.shelf,
          height: "calc(56px + env(safe-area-inset-bottom))",
          paddingBottom: "env(safe-area-inset-bottom)",
          // A flat tint, not frosted glass (see SHELF_FILL), and a more opaque
          // one on a phone, where the icon grid scrolls under the bar.
          background: isMobile ? PHONE_BAR_FILL : SHELF_FILL,
          borderTop: "1px solid rgba(255, 255, 255, 0.1)",
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openedAt.current = Date.now();
          setShelfMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {/* The bar's one container. `@container` makes ITS width, not the
            viewport's, what the tray's `SHED_*` queries read — and it is a flex
            row of launcher, apps and tray, all in flow, so what the tray takes
            is what the apps do not get. */}
        <div className="@container flex w-full min-w-0 items-center">
        {isMobile ? (
          <>
            {/* Every mobile bar button shares a 40×40 container for a single
                baseline. Three in-flow flex items rather than two absolute
                clusters around a centred one: the app row in the middle has
                to be bounded by the launcher and the tray, or a fifth open app
                would sit under the power button. */}
            <div className="flex-none flex items-center">
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
            {/* Settings and the apps that are OPEN — the row `pinnedApps` and
                `unpinnedApps` are filtered for above and that this bar never
                drew: nothing said which apps were open, and an app minimized
                with "Switch app" vanished without a trace. It scrolls past
                what it cannot fit (`APP_ROW`). */}
            <div
              className={`flex-1 ${APP_ROW}`}
              data-testid="shelf-mobile-apps"
              onWheel={scrollRowWithWheel}
              onScroll={() => setAppTip(null)}
            >
              {pinnedApps.map(renderApp)}
              {unpinnedApps.map(renderApp)}
            </div>
            {/* The tray, in the desktop bar's order. The chat crab sits HERE,
                fixed, never in the row: with a handful of apps open the row
                overflows, and the one button that opens the assistant would
                scroll out of sight with them. */}
            <div className="flex-none flex items-center gap-1" data-testid="shelf-tray">
              {renderTray(true)}
            </div>
          </>
        ) : <>
        {/* One launcher button per shelf. A second, `sm:hidden` copy used to sit
            at the left of this branch — dead weight, since anything narrower
            than 768px renders the mobile bar above instead, but always in the
            DOM: two elements answered `shelf-launcher-button`, which is a
            strict-locator failure for a test and a duplicated "App Launcher"
            control for assistive tech. */}

        {/* Launcher, divider and apps sit in the MIDDLE of the bar when there is
            room: the two `flex-1` cells either side of them are equal, the
            tray's cell no narrower than the tray (`min-w-max`). With less room
            the left cell goes first and the group slides toward the tray, and
            with less still the apps shrink and scroll, the launcher and the tray
            staying whole. The tray used to be `absolute`: nothing reserved its
            width, so a centred row of several apps ran under it. */}
        <div className="flex-1 min-w-0" aria-hidden="true" />

        {/* Launcher button — desktop only (inline). It stays put: only the
            apps beside it scroll. */}
        <button
          onClick={onLauncherClick}
          className="flex-none w-11 h-11 flex items-center justify-center rounded-full hover:bg-white/10 active:bg-white/15 transition-colors cursor-pointer"
          title={t("shelf.appLauncher")}
          aria-label={t("shelf.appLauncher")}
          data-testid="shelf-launcher-button"
        >
          <div className="w-10 h-10 rounded-full flex items-center justify-center bg-gradient-to-br from-white/20 to-white/5 border border-white/10">
            <span className="material-symbols-rounded text-white/80" style={{ fontSize: 22 }}>apps</span>
          </div>
        </button>

        {/* Separator (desktop only) */}
        <div className="flex-none w-px h-8 bg-white/10 ml-2 mr-1" />

        {/* Centered: pinned + open apps. Wide as its icons while they fit
            (`flex-initial`), and no wider than the room beside the tray when
            they do not. */}
        <div
          className={`flex-initial ${APP_ROW}`}
          data-testid="shelf-desktop-apps"
          onWheel={scrollRowWithWheel}
          onScroll={() => setAppTip(null)}
        >
          {/* Pinned apps */}
          {pinnedApps.map(renderApp)}

          {/* Separator between pinned and unpinned open apps */}
          {unpinnedApps.length > 0 && (
            <div className="flex-none w-px h-8 bg-white/10 mx-1" />
          )}

          {/* Unpinned open apps */}
          {unpinnedApps.map(renderApp)}
        </div>

        {/* Right side: system tray, in the row. As wide as its buttons at the
            least (`min-w-max`), so the apps never get to draw under it, and its
            buttons sit at the bar's right edge. */}
        <div className="flex-1 min-w-max flex items-center justify-end gap-1" data-testid="shelf-tray">
          {renderTray(false)}
        </div>
        </>}
        </div>
      </div>

      {/* The hovered app's name. Fixed and drawn here, not inside the app row,
          which scrolls and would clip it; hidden while a menu is open and once
          the app it names has left the bar (no mouseleave fires for a button
          that unmounts under a resting pointer). `aria-hidden`: the button
          already carries the name, so a screen reader hears it once. */}
      {appTip && !ctxMenu && !shelfMenu && apps.some((a) => a.id === appTip.id) && (
        <div
          data-testid="shelf-tooltip"
          aria-hidden="true"
          className="fixed px-2 py-1 bg-[#1e2939] text-white text-xs rounded pointer-events-none whitespace-nowrap border border-white/10"
          style={{
            zIndex: DESKTOP_LAYERS.shelf,
            left: appTip.x,
            top: appTip.y - 8,
            transform: "translate(-50%, -100%)",
          }}
        >
          {appTip.name}
        </div>
      )}

      {/* Shelf context menu. No backdrop blur under its fill: #2d2d2d is
          opaque, so the blur could not be seen, and it was still a render pass
          re-run whenever anything beneath it moved — the crab, a pet. */}
      {ctxMenu && (
        <div
          className="fixed min-w-[180px] py-1 bg-[#2d2d2d] rounded-lg shadow-2xl border border-white/10 text-sm text-white/90"
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

          {/* New Window — only if app is already open, and never for a web
              page, whose "new window" is the new tab below. */}
          {!ctxMenu.app.external && ctxMenu.app.isOpen && onNewWindow && (
            <button
              onClick={() => { onNewWindow(ctxMenu.app.id); setCtxMenu(null); }}
              className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3"
            >
              <span className="text-base">🪟</span> {t("shelf.newWindow")}
            </button>
          )}

          {/* Open in new tab: this app's own /app/<id> page — or, for a web
              page, one more tab of it, open or not. */}
          {(!ctxMenu.app.external || onNewWindow) && (
            <button
              onClick={() => {
                if (ctxMenu.app.external) onNewWindow?.(ctxMenu.app.id);
                else openInKiosk(`/app/${encodeURIComponent(ctxMenu.app.id)}`, "");
                setCtxMenu(null);
              }}
              className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3"
              data-testid={ctxMenu.app.external ? "shelf-ctx-new-tab" : undefined}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_new</span> {t("shelf.openNewTab")}
            </button>
          )}

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

      {/* Shelf context menu (right-click on empty shelf area) — opaque, so no
          blur behind it either (see the menu above). */}
      {shelfMenu && (
        <div
          className="fixed min-w-[180px] py-1 bg-[#2d2d2d] rounded-lg shadow-2xl border border-white/10 text-sm text-white/90"
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
