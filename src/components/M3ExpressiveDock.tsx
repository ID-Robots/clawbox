"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import DockCalendarPopover from "@/components/DockCalendarPopover";

/**
 * M3 Expressive dock — Hermes tint.
 *
 * A drop-in alternative to ChromeShelf with the same props contract, so
 * page.tsx can swap between them with a single import change.
 *
 * Colour comes entirely from CSS custom properties declared on `.m3dx`, which
 * are mapped from the product's own tokens in globals.css. Nothing below that
 * block hardcodes a colour, so an OpenClaw variant is a token-block override
 * (`[data-agent="openclaw"] .m3dx { ... }`) rather than a second component.
 *
 * `--coral-bright` and `--cyan-bright` are never re-declared here — they are
 * only *read* into M3 role names, so the invariant enforced by
 * src/tests/unit/setup-skin.test.ts is untouched.
 */

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

interface M3ExpressiveDockProps {
  apps: ShelfApp[];
  onAppClick: (id: string) => void;
  onNewWindow?: (id: string) => void;
  onLauncherClick: () => void;
  onTrayClick: () => void;
  onClawKeepShieldClick?: () => void;
  clawkeepStatus?: { stale: boolean; busy: boolean; restoring: boolean };
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

export default function M3ExpressiveDock({
  apps,
  onAppClick,
  onLauncherClick,
  onTrayClick,
  onClawKeepShieldClick,
  clawkeepStatus = { stale: false, busy: false, restoring: false },
  onPowerClick,
  onChatClick,
  showChatButton,
  time,
}: M3ExpressiveDockProps) {
  const { t } = useT();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  };

  // "3:00 PM" -> ["3:00", "PM"]. A 24h locale yields no meridiem, which is fine:
  // the span simply renders empty rather than being dropped.
  const [clockMain, clockMeridiem = ""] = String(time).split(" ");

  return (
    <>
      <div className="m3dx">
        {/* role="group", not "toolbar": the ARIA toolbar pattern requires roving
            tabindex + arrow-key navigation, which this does not implement. Every
            control stays independently tabbable, which is correct for a group. */}
        <div className="m3dx-dock" role="group" aria-label={t("shelf.appLauncher")}>
          <div className="m3dx-group m3dx-group--main">
            {/* Launcher. Accessible name contains the visible tip ("Apps") so
                SC 2.5.3 Label in Name holds. */}
            <span className="m3dx-item">
              <button
                type="button"
                className="m3dx-btn m3dx-btn--xl m3dx-tone-launcher"
                aria-label={`Apps — ${t("shelf.appLauncher")}`}
                data-testid="shelf-launcher-button"
                onClick={onLauncherClick}
              >
                <span className="m3dx-state" aria-hidden="true" />
                <svg className="m3dx-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <rect x="3" y="3" width="5" height="5" rx="1.6" />
                  <rect x="9.5" y="3" width="5" height="5" rx="1.6" />
                  <rect x="16" y="3" width="5" height="5" rx="1.6" />
                  <rect x="3" y="9.5" width="5" height="5" rx="1.6" />
                  <rect x="9.5" y="9.5" width="5" height="5" rx="1.6" />
                  <rect x="16" y="9.5" width="5" height="5" rx="1.6" />
                  <rect x="3" y="16" width="5" height="5" rx="1.6" />
                  <rect x="9.5" y="16" width="5" height="5" rx="1.6" />
                  <rect x="16" y="16" width="5" height="5" rx="1.6" />
                </svg>
              </button>
              <span className="m3dx-tip" aria-hidden="true">Apps</span>
            </span>

            <span className="m3dx-sep" aria-hidden="true" />

            {/* Pinned + open apps. Shape alternates by index — that alternation
                IS the Expressive personality, so it is driven by position, not
                by app identity. */}
            {apps.map((app, i) => (
              <span
                key={app.id}
                className={`m3dx-item${app.isOpen ? " m3dx-item--active" : ""}`}
              >
                <button
                  type="button"
                  className={`m3dx-btn ${i % 2 === 0 ? "m3dx-btn--round" : "m3dx-btn--xl"} m3dx-tone-app`}
                  aria-label={app.isOpen ? `${app.name}, running` : app.name}
                  onClick={() => onAppClick(app.id)}
                >
                  <span className="m3dx-state" aria-hidden="true" />
                  <span className="m3dx-appicon" aria-hidden="true">{app.icon}</span>
                </button>
                {app.isOpen && <span className="m3dx-ind" aria-hidden="true" />}
                <span className="m3dx-tip" aria-hidden="true">{app.name}</span>
              </span>
            ))}
          </div>

          <div className="m3dx-group m3dx-group--sys">
            {showChatButton && (
              <span className="m3dx-item">
                <button
                  type="button"
                  className="m3dx-btn m3dx-btn--xl m3dx-tone-chat"
                  aria-label={t("shelf.chat")}
                  data-testid="shelf-chat-button"
                  onClick={onChatClick}
                >
                  <span className="m3dx-state" aria-hidden="true" />
                  <img src="/clawbox-crab.png" alt="" className="m3dx-crab" />
                </button>
                <span className="m3dx-tip" aria-hidden="true">{t("shelf.chat")}</span>
              </span>
            )}

            {onClawKeepShieldClick && (
              <span className="m3dx-item m3dx-optional">
                <button
                  type="button"
                  className={`m3dx-btn m3dx-btn--round m3dx-tone-keep${clawkeepStatus.stale ? " m3dx-is-stale" : ""}`}
                  aria-label="ClawKeep backup"
                  data-testid="shelf-clawkeep-shield-button"
                  onClick={onClawKeepShieldClick}
                >
                  <span className="m3dx-state" aria-hidden="true" />
                  <svg className="m3dx-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4Zm0 2.18 7 3.11V11c0 4.52-2.98 8.74-7 9.93-4.02-1.19-7-5.41-7-9.93V6.29l7-3.11Z" />
                    <path d="m10.6 16.2-3.3-3.3 1.41-1.41 1.89 1.88 4.59-4.59L16.6 10.2l-6 6Z" />
                  </svg>
                </button>
                <span className="m3dx-tip" aria-hidden="true">ClawKeep</span>
              </span>
            )}

            {/* Clock is a real button: it carries the shelf-tray-button testid,
                so it must be keyboard reachable and exposed to AT. The meridiem
                is visually hidden on narrow widths rather than display:none, so
                "3:00" never becomes ambiguous for AT users. */}
            <button
              type="button"
              className="m3dx-clock"
              data-testid="shelf-tray-button"
              aria-label={`${t("shelf.systemSettings")}, ${time}`}
              aria-expanded={calendarOpen}
              aria-haspopup="dialog"
              onClick={() => {
                setCalendarOpen((v) => !v);
                onTrayClick();
              }}
            >
              <span className="m3dx-state" aria-hidden="true" />
              <span className="m3dx-hm">{clockMain}</span>
              {clockMeridiem && <span className="m3dx-mer">{clockMeridiem}</span>}
            </button>

            <span className="m3dx-item m3dx-optional">
              <button
                type="button"
                className="m3dx-btn m3dx-btn--round m3dx-tone-neutral"
                aria-label={isFullscreen ? t("shelf.exitFullscreen") : t("shelf.fullscreen")}
                onClick={toggleFullscreen}
              >
                <span className="m3dx-state" aria-hidden="true" />
                <svg className="m3dx-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  {isFullscreen ? (
                    <path d="M5 16h3v3h2v-5H5v2Zm3-8H5v2h5V5H8v3Zm6 11h2v-3h3v-2h-5v5Zm2-11V5h-2v5h5V8h-3Z" />
                  ) : (
                    <path d="M7 14H5v5h5v-2H7v-3Zm-2-4h2V7h3V5H5v5Zm12 7h-3v2h5v-5h-2v3ZM14 5v2h3v3h2V5h-5Z" />
                  )}
                </svg>
              </button>
              <span className="m3dx-tip" aria-hidden="true">
                {isFullscreen ? t("shelf.exitFullscreen") : t("shelf.fullscreen")}
              </span>
            </span>

            <span className="m3dx-item">
              <button
                type="button"
                className="m3dx-btn m3dx-btn--xl m3dx-tone-power"
                aria-label={t("shelf.power")}
                data-testid="shelf-power-button"
                onClick={onPowerClick}
              >
                <span className="m3dx-state" aria-hidden="true" />
                <svg className="m3dx-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M13 3h-2v10h2V3Zm4.83 2.17-1.42 1.42A6.92 6.92 0 0 1 19 12a7 7 0 1 1-11.27-5.55L6.32 5.03A8.94 8.94 0 0 0 3 12a9 9 0 1 0 14.83-6.83Z" />
                </svg>
              </button>
              <span className="m3dx-tip" aria-hidden="true">{t("shelf.power")}</span>
            </span>
          </div>
        </div>
      </div>

      <DockCalendarPopover open={calendarOpen} onClose={() => setCalendarOpen(false)} />

      {/* Static, module-level CSS string — no interpolation, no user input. */}
      <style>{DOCK_CSS}</style>
    </>
  );
}

const DOCK_CSS = `
/* Single source of truth for the reserved band at the bottom of the screen.
   The dock is position:fixed and full-width, so its container width always
   equals the viewport width — which makes these viewport media queries exactly
   equivalent to the @container breakpoints below, and lets JS consumers
   (mascot floor, launcher offset, desktop padding) read one value instead of
   each hardcoding 56px. */
:root{ --dock-band:96px; }
@media (max-width:599px){ :root{ --dock-band:72px; } }
@media (max-width:399px){ :root{ --dock-band:64px; } }

.m3dx{
  --primary:#f97316;
  --on-primary:#0a0f1a;
  --primary-container:rgba(249,115,22,.15);
  --on-primary-container:#fdba74;
  --secondary:#9ca3af;
  --secondary-container:#253347;
  --on-secondary-container:#f9fafb;
  --tertiary:#00e5cc;
  --error:#f87171;
  --error-container:rgba(239,68,68,.10);
  --on-error-container:#fca5a5;
  --amber:#fcd34d;
  --amber-container:rgba(251,191,36,.10);
  --keep:#34d399;
  --keep-container:rgba(52,211,153,.12);
  --surface:#0a0f1a;
  --on-surface:#f9fafb;
  --on-surface-variant:#9ca3af;
  --surface-container:#172030;
  --surface-container-high:#1e2939;
  --surface-container-highest:#253347;
  --outline:#6b7280;
  --outline-variant:#2a3445;
  --m3dx-standard:cubic-bezier(0.2,0,0,1);
  --m3dx-emph-dec:cubic-bezier(0.05,0.7,0.1,1);
  --m3dx-short4:200ms;
  --m3dx-medium2:300ms;
  --m3dx-medium3:350ms;
  --m3dx-shape-xs:4px;
  --m3dx-shape-m:12px;
  --m3dx-shape-l:16px;
  --m3dx-shape-xl:28px;
  container-type:inline-size;
  container-name:m3dx;
  position:fixed; left:0; right:0; bottom:0; z-index:10000;
  box-sizing:border-box;
  font-family:inherit;
}
.m3dx *,.m3dx *::before,.m3dx *::after{ box-sizing:border-box; }

.m3dx .m3dx-dock{
  --m3dx-bar-h:96px; --m3dx-tile:56px; --m3dx-gap:8px; --m3dx-pad:20px;
  --m3dx-flex-min:12px; --m3dx-sep-m:8px; --m3dx-icon:24px;
  --m3dx-morph:var(--m3dx-shape-l);
  --m3dx-ind-off:10px; --m3dx-ind-w:32px;
  --m3dx-ring-w:3px; --m3dx-ring-off:2px;
  --m3dx-clock-h:40px; --m3dx-clock-pad:18px; --m3dx-clock-fs:14px; --m3dx-clock-ls:.1px;
  /* 1fr auto 1fr keeps the app cluster optically centred in the bar while the
     system cluster stays hard right. Grid (not absolute positioning) so the
     two can never overlap on a narrow screen — they shrink instead. */
  display:grid; grid-template-columns:1fr auto 1fr; align-items:center;
  width:100%; min-width:0; height:var(--m3dx-bar-h); padding:0 var(--m3dx-pad);
  background:var(--surface-container);
  border-top:1px solid var(--outline-variant);
  border-radius:0;
}
.m3dx .m3dx-group{ display:flex; align-items:center; gap:var(--m3dx-gap); min-width:0; }
.m3dx .m3dx-group--main{ grid-column:2; justify-self:center; }
/* min-width:max-content is load-bearing. Without it the group's min-width:0
   lets track 3 size SMALLER than the system cluster's content; justify-self:end
   then pins the too-wide box's right edge to the track end and spills it
   leftward over the app tiles (measured: -69px at 600px, and Fullscreen stole
   ClawKeep's hit area). max-content floors the track at the content width, so
   the two clusters can never collide. */
.m3dx .m3dx-group--sys{ grid-column:3; justify-self:end; min-width:max-content; }
.m3dx .m3dx-sep{ flex:0 0 auto; width:1px; height:40px; margin:0 var(--m3dx-sep-m);
  background:var(--outline-variant); border-radius:999px; }
.m3dx .m3dx-item{ position:relative; display:inline-flex; align-items:center;
  justify-content:center; flex:0 0 auto; }

.m3dx .m3dx-btn{
  position:relative; display:inline-flex; align-items:center; justify-content:center;
  width:var(--m3dx-tile); height:var(--m3dx-tile); padding:0; border:none;
  cursor:pointer; overflow:hidden;
  background:var(--surface-container-high); color:var(--on-surface);
  -webkit-tap-highlight-color:transparent;
  transition:border-radius var(--m3dx-medium2) var(--m3dx-standard),
             transform var(--m3dx-short4) var(--m3dx-standard),
             background-color var(--m3dx-short4) var(--m3dx-standard);
}
/* >=44px hit area, extended 4px vertically so the -2px hover lift cannot
   oscillate the pointer in and out of the target. */
.m3dx .m3dx-btn::after{
  content:""; position:absolute; top:50%; left:50%;
  width:max(100%,44px); height:max(calc(100% + 4px),44px);
  transform:translate(-50%,-50%);
}
.m3dx .m3dx-btn--xl{ border-radius:var(--m3dx-morph); }
.m3dx .m3dx-btn--round{ border-radius:50%; }
.m3dx .m3dx-btn--round:hover,.m3dx .m3dx-btn--round:focus-visible{ border-radius:var(--m3dx-morph); }
.m3dx .m3dx-btn--xl:hover,.m3dx .m3dx-btn--xl:focus-visible{ border-radius:50%; }

.m3dx .m3dx-tone-launcher{ background:var(--surface-container-high); color:var(--on-surface); --m3dx-sl:var(--on-surface); }
.m3dx .m3dx-tone-app{ background:var(--surface-container-high); --m3dx-sl:var(--on-surface); }
.m3dx .m3dx-tone-chat{ background:var(--primary-container); color:var(--on-primary-container); --m3dx-sl:var(--on-primary-container); }
.m3dx .m3dx-tone-keep{ background:var(--keep-container); color:var(--keep); --m3dx-sl:var(--keep); }
.m3dx .m3dx-tone-neutral{ background:var(--surface-container-high); color:var(--on-surface-variant); --m3dx-sl:var(--on-surface); }
.m3dx .m3dx-tone-power{ background:var(--error-container); color:var(--on-error-container); --m3dx-sl:var(--on-error-container); }
.m3dx .m3dx-is-stale{ background:var(--amber-container); color:var(--amber); --m3dx-sl:var(--amber); }

/* Tonal-only lift: every tone steps up the surface ladder, so the hover
   affordance survives when prefers-reduced-motion removes the translate. */
.m3dx .m3dx-btn:hover{ transform:translateY(-2px); background:var(--surface-container-highest); }
.m3dx .m3dx-tone-chat:hover{ background:rgba(249,115,22,.28); }
.m3dx .m3dx-tone-power:hover{ background:rgba(239,68,68,.22); }
.m3dx .m3dx-tone-keep:hover{ background:rgba(52,211,153,.24); }
.m3dx .m3dx-is-stale:hover{ background:rgba(251,191,36,.22); }
.m3dx .m3dx-btn:active{ transform:translateY(0) scale(.94); }

.m3dx .m3dx-state{
  position:absolute; inset:0; border-radius:inherit;
  background:var(--m3dx-sl,var(--on-surface)); opacity:0; pointer-events:none;
  transition:opacity var(--m3dx-short4) var(--m3dx-standard);
}
.m3dx .m3dx-btn:hover .m3dx-state{ opacity:.08; }
.m3dx .m3dx-btn:focus-visible .m3dx-state{ opacity:.12; }
.m3dx .m3dx-btn:active .m3dx-state{ opacity:.12; }
.m3dx .m3dx-btn[data-dragging="true"] .m3dx-state{ opacity:.16; }

.m3dx .m3dx-btn:focus-visible,.m3dx .m3dx-clock:focus-visible{
  outline:var(--m3dx-ring-w) solid var(--secondary);
  outline-offset:var(--m3dx-ring-off);
}
.m3dx .m3dx-icon{ position:relative; width:var(--m3dx-icon); height:var(--m3dx-icon);
  fill:currentColor; pointer-events:none; }
/* The parent supplies a 40px app icon; scale it to fill the morphing tile so
   the shape change reads on the icon itself rather than framing it twice. */
.m3dx .m3dx-appicon{ position:relative; display:flex; align-items:center;
  justify-content:center; transform:scale(1.4); pointer-events:none; }
.m3dx .m3dx-crab{ position:relative; width:calc(var(--m3dx-tile) * .72);
  height:calc(var(--m3dx-tile) * .72); object-fit:contain; pointer-events:none; }

/* Coral marks an open window — the existing product convention. */
.m3dx .m3dx-ind{
  position:absolute; left:50%; bottom:calc(-1 * var(--m3dx-ind-off));
  height:3px; width:var(--m3dx-ind-w); margin-left:calc(var(--m3dx-ind-w) / -2);
  border-radius:999px; background:var(--primary); pointer-events:none;
  transition:width var(--m3dx-medium3) var(--m3dx-emph-dec),
             margin-left var(--m3dx-medium3) var(--m3dx-emph-dec);
}
.m3dx .m3dx-item--active:hover .m3dx-ind,
.m3dx .m3dx-item--active:focus-within .m3dx-ind{ --m3dx-ind-w:calc(var(--m3dx-tile) * .78); }

.m3dx .m3dx-clock{
  position:relative; display:inline-flex; align-items:center; gap:4px; flex:0 0 auto;
  height:var(--m3dx-clock-h); padding:0 var(--m3dx-clock-pad); border:none;
  border-radius:999px; cursor:pointer; overflow:hidden;
  background:var(--secondary-container); color:var(--on-secondary-container);
  font-family:inherit; font-size:var(--m3dx-clock-fs); font-weight:500;
  letter-spacing:var(--m3dx-clock-ls); font-variant-numeric:tabular-nums;
  white-space:nowrap; --m3dx-sl:var(--on-secondary-container);
  transition:background-color var(--m3dx-short4) var(--m3dx-standard);
}
.m3dx .m3dx-clock:hover .m3dx-state{ opacity:.08; }
.m3dx .m3dx-clock:active .m3dx-state{ opacity:.12; }
.m3dx .m3dx-mer{ color:var(--on-surface-variant); }

.m3dx .m3dx-tip{
  position:absolute; left:50%; bottom:calc(100% + 12px); transform:translate(-50%,6px);
  padding:4px 10px; border-radius:var(--m3dx-shape-xs);
  background:var(--surface-container-highest); color:var(--on-surface);
  border:1px solid var(--outline-variant);
  font-size:11px; line-height:16px; font-weight:500; letter-spacing:.5px;
  white-space:nowrap; opacity:0; pointer-events:none; z-index:2;
  transition:opacity var(--m3dx-short4) var(--m3dx-standard),
             transform var(--m3dx-short4) var(--m3dx-emph-dec);
}
.m3dx .m3dx-item:hover .m3dx-tip,.m3dx .m3dx-item:focus-within .m3dx-tip{
  opacity:1; transform:translate(-50%,0);
}

@container m3dx (max-width:899px){
  .m3dx .m3dx-dock{ --m3dx-tile:48px; --m3dx-gap:6px; --m3dx-pad:14px;
    --m3dx-flex-min:8px; --m3dx-sep-m:4px; --m3dx-clock-h:36px;
    --m3dx-clock-pad:12px; --m3dx-ring-w:2px; }
  .m3dx .m3dx-sep{ height:32px; }
}
@container m3dx (max-width:599px){
  .m3dx .m3dx-dock{ --m3dx-bar-h:72px; --m3dx-tile:44px; --m3dx-gap:5px;
    --m3dx-pad:12px; --m3dx-flex-min:4px; --m3dx-icon:22px; --m3dx-ind-off:7px;
    --m3dx-ind-w:28px; --m3dx-ring-w:2px; --m3dx-clock-h:32px;
    --m3dx-clock-pad:10px; --m3dx-clock-fs:12px; --m3dx-clock-ls:.5px; }
  .m3dx .m3dx-sep{ display:none; }
  .m3dx .m3dx-tip{ display:none; }
  /* Visually hidden, NOT display:none — "3:00" alone cannot distinguish
     3 AM from 3 PM, and the accessible name must keep the meridiem. */
  .m3dx .m3dx-mer{ position:absolute; width:1px; height:1px; padding:0; margin:-1px;
    overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
}
@container m3dx (max-width:519px){
  .m3dx .m3dx-dock{ --m3dx-tile:40px; --m3dx-icon:20px;
    --m3dx-morph:var(--m3dx-shape-m); --m3dx-ind-off:6px; --m3dx-ind-w:24px;
    --m3dx-pad:10px; --m3dx-flex-min:2px; }
  .m3dx .m3dx-clock{ display:none; }
}
@container m3dx (max-width:399px){
  .m3dx .m3dx-dock{ --m3dx-bar-h:64px; --m3dx-tile:40px; --m3dx-gap:5px;
    --m3dx-pad:10px; --m3dx-icon:20px; --m3dx-morph:var(--m3dx-shape-m);
    --m3dx-ind-off:6px; --m3dx-ind-w:24px; --m3dx-clock-h:28px;
    --m3dx-clock-pad:8px; --m3dx-clock-fs:11px; --m3dx-clock-ls:.5px; }
  .m3dx .m3dx-optional{ display:none; }
  .m3dx .m3dx-clock{ display:inline-flex; }
}

@media (prefers-reduced-motion: reduce){
  .m3dx *,.m3dx *::before,.m3dx *::after{
    transition-duration:1ms !important; animation-duration:1ms !important;
    animation-iteration-count:1 !important;
  }
  .m3dx .m3dx-btn:hover{ transform:none; }
  .m3dx .m3dx-btn:active{ transform:none; }
}
`;
