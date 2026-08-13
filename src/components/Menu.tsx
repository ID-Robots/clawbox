"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";

/**
 * Menu primitives for dock and desktop context menus.
 *
 * `MenuSurface` owns the behaviour every menu needs and is easy to get wrong:
 * roving-focus arrow keys, Escape and outside-click dismissal, and returning
 * focus to whatever opened it. `MenuItem` / `MenuLabel` / `MenuSeparator` are
 * presentational, so a caller composes a menu without re-implementing any of it.
 *
 * Colour comes from the M3 tokens the dock declares on `.m3dx`, with local
 * fallbacks so a menu is equally correct when opened over the wallpaper.
 */

type Align = "start" | "center" | "end";

interface MenuSurfaceProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name — required, since a menu with no name is unusable by
   *  screen reader users who arrive at it out of context. */
  label: string;
  /** Which edge the menu aligns to relative to its positioned parent. */
  align?: Align;
  /** Opens upward (dock menus) rather than downward. */
  side?: "top" | "bottom";
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** Enabled, focusable items inside a surface, in DOM order. */
function itemsOf(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'),
  );
}

export function MenuSurface({
  open,
  onClose,
  label,
  align = "start",
  side = "top",
  children,
  className,
  style,
}: MenuSurfaceProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Captured on open so focus can go back where it came from on close.
  const openerRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    onClose();
    // Restoring focus is what makes a menu usable from the keyboard twice in a
    // row; without it focus falls to <body> and the next Tab starts over.
    const opener = openerRef.current;
    if (opener && document.contains(opener)) opener.focus();
    openerRef.current = null;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Focus the first item so the menu is immediately drivable by arrows.
    const first = itemsOf(ref.current)[0];
    first?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const items = itemsOf(ref.current);
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);

      switch (e.key) {
        case "Escape":
          e.stopPropagation();
          e.preventDefault();
          close();
          break;
        case "ArrowDown":
          e.preventDefault();
          items[i < 0 ? 0 : (i + 1) % items.length].focus();
          break;
        case "ArrowUp":
          e.preventDefault();
          items[i <= 0 ? items.length - 1 : i - 1].focus();
          break;
        case "Home":
          e.preventDefault();
          items[0].focus();
          break;
        case "End":
          e.preventDefault();
          items[items.length - 1].focus();
          break;
        case "Tab":
          // A menu is a modal-ish surface; tabbing out closes it rather than
          // leaving an orphaned popup behind the focus ring.
          close();
          break;
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };

    document.addEventListener("keydown", onKeyDown, true);
    // pointerdown, not click: a menu must close before the click lands on
    // whatever is underneath, or the first click outside is swallowed.
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      className={`m3menu m3menu--${side} m3menu--${align}${className ? ` ${className}` : ""}`}
      style={style}
    >
      {children}
      <style>{MENU_CSS}</style>
    </div>
  );
}

interface MenuItemProps {
  onSelect?: () => void;
  /** Leading glyph or tile. Purely decorative — the label carries the meaning. */
  icon?: ReactNode;
  /** Trailing hint, e.g. a shortcut or a window count. */
  hint?: ReactNode;
  disabled?: boolean;
  /** Destructive actions get the error token rather than a bespoke red. */
  danger?: boolean;
  children: ReactNode;
}

export function MenuItem({
  onSelect,
  icon,
  hint,
  disabled = false,
  danger = false,
  children,
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`m3menu-item${danger ? " m3menu-item--danger" : ""}`}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      tabIndex={-1}
      onClick={() => {
        if (!disabled) onSelect?.();
      }}
    >
      {icon ? (
        <span className="m3menu-item-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="m3menu-item-label">{children}</span>
      {hint ? <span className="m3menu-item-hint">{hint}</span> : null}
    </button>
  );
}

/** A group heading. Presentational only — it is not a focus stop. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="m3menu-label">{children}</div>;
}

export function MenuSeparator() {
  return <div className="m3menu-sep" role="separator" />;
}

const MENU_CSS = `
.m3menu{
  --m3menu-surface:var(--surface-container-high,#1e2939);
  --m3menu-on:var(--on-surface,#f9fafb);
  --m3menu-on-var:var(--on-surface-variant,#9ca3af);
  --m3menu-outline:var(--outline-variant,#2a3445);
  --m3menu-primary:var(--primary,#f97316);
  --m3menu-error:var(--error,#f87171);
  --m3menu-shape:var(--m3dx-shape-m,12px);
  --m3menu-ease:var(--m3dx-emph-dec,cubic-bezier(0.05,0.7,0.1,1));
  --m3menu-dur:var(--m3dx-medium2,300ms);

  position:absolute;
  z-index:10050;
  min-width:180px;
  max-width:min(300px,90vw);
  max-height:min(360px,60vh);
  overflow-y:auto;
  overscroll-behavior:contain;
  padding:6px;
  border-radius:var(--m3menu-shape);
  background:var(--m3menu-surface);
  color:var(--m3menu-on);
  /* Tonal elevation plus a real shadow: the tone alone is not enough to
     separate the menu from a same-tone dock sitting directly behind it. */
  box-shadow:0 2px 6px rgba(0,0,0,.34),0 12px 28px -8px rgba(0,0,0,.5);
  animation:m3menu-in var(--m3menu-dur) var(--m3menu-ease) both;
}
.m3menu *,.m3menu *::before,.m3menu *::after{ box-sizing:border-box; }

.m3menu--top{ bottom:calc(100% + 8px); transform-origin:bottom center; }
.m3menu--bottom{ top:calc(100% + 8px); transform-origin:top center; }
.m3menu--start{ left:0; }
.m3menu--center{ left:50%; translate:-50% 0; }
.m3menu--end{ right:0; }

@keyframes m3menu-in{
  from{ opacity:0; scale:.96; }
  to{ opacity:1; scale:1; }
}

.m3menu-item{
  appearance:none;
  -webkit-appearance:none;
  width:100%;
  min-height:44px;            /* touch target */
  display:flex;
  align-items:center;
  gap:10px;
  padding:8px 10px;
  border:none;
  border-radius:8px;
  background:transparent;
  color:inherit;
  font:inherit;
  font-size:13px;
  text-align:left;
  cursor:pointer;
  transition:background 120ms var(--m3menu-ease);
}
.m3menu-item:hover:not([aria-disabled="true"]),
.m3menu-item:focus-visible{
  background:color-mix(in srgb,var(--m3menu-primary) 14%,transparent);
}
.m3menu-item:focus-visible{
  outline:2px solid var(--m3menu-primary);
  outline-offset:-2px;
}
.m3menu-item[aria-disabled="true"]{ opacity:.42; cursor:default; }
.m3menu-item--danger{ color:var(--m3menu-error); }
.m3menu-item--danger:hover:not([aria-disabled="true"]),
.m3menu-item--danger:focus-visible{
  background:color-mix(in srgb,var(--m3menu-error) 14%,transparent);
}

.m3menu-item-icon{
  flex:0 0 auto;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  width:20px;
  height:20px;
}
.m3menu-item-label{
  flex:1 1 auto;
  min-width:0;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.m3menu-item-hint{
  flex:0 0 auto;
  color:var(--m3menu-on-var);
  font-size:11px;
  font-variant-numeric:tabular-nums;
}

.m3menu-label{
  padding:8px 10px 4px;
  color:var(--m3menu-on-var);
  font-size:11px;
  font-weight:600;
  letter-spacing:.06em;
  text-transform:uppercase;
}

.m3menu-sep{
  height:1px;
  margin:5px 6px;
  background:var(--m3menu-outline);
}

@media (prefers-reduced-motion:reduce){
  .m3menu{ animation:none; }
  .m3menu-item{ transition:none; }
}
`;
