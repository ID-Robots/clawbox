"use client";

import type { CSSProperties, ReactNode } from "react";

/**
 * App icon tiles for the desktop and the dock.
 *
 * A tile is a rounded square carrying either a bitmap asset, a hand-drawn glyph
 * or caller-supplied children. Two rims (a light inner hairline and a dark outer
 * one) keep the silhouette readable against both dark and pale wallpapers, and a
 * layered drop shadow lifts it off the background. Glyphs are hand-drawn rather
 * than an icon-font dependency so each one can be tuned to the 24px grid.
 *
 * Colour comes from the same M3 tokens the dock declares on `.m3dx`, with local
 * fallbacks so a tile is equally correct on the wallpaper, where no `.m3dx`
 * ancestor exists. Nothing below hardcodes a brand colour: `--primary` stays
 * ACTION and is never re-declared here, so a retint remains a token override.
 */

interface AssetSpec {
  src: string;
  /** Multiplier on the tile's inner box; >1 lets art bleed to the rim. */
  scale: number;
  fit: "contain" | "cover";
  /** When set, the art is circle-cropped at this radius (px at size 40). */
  circle?: number;
}

/** Apps whose identity is a picture, not a glyph. */
const ASSETS: Record<string, AssetSpec> = {
  clawbox: { src: "/clawbox-crab.png", scale: 1.18, fit: "contain" },
  openclaw: { src: "/clawbox-icon.png", scale: 0.82, fit: "contain" },
  hermes: { src: "/hermes-agent.png", scale: 0.78, fit: "cover", circle: 30 },
};

/** Tile background per app id. Falls back to the app's own colour. */
const TINTS: Record<string, string> = {
  settings: "#6b7280",
  clawbox: "#0a0f1a",
  openclaw: "#0a0f1a",
  hermes: "#1a1230",
  "hermes-skills": "#1a1230",
  terminal: "#1a1a2e",
  files: "#f97316",
  clawkeep: "#14532d",
  system_update: "#0ea5e9",
  store: "#22c55e",
  browser: "#4285f4",
  vnc: "#7c3aed",
};

type GlyphName =
  | "apps"
  | "settings"
  | "terminal"
  | "files"
  | "clawkeep"
  | "store"
  | "browser"
  | "vnc"
  | "update"
  | "skills"
  | "chat"
  | "generic";

/** Which glyph an app id draws when it has no bitmap asset. */
const GLYPH_FOR: Record<string, GlyphName> = {
  settings: "settings",
  terminal: "terminal",
  files: "files",
  clawkeep: "clawkeep",
  store: "store",
  browser: "browser",
  vnc: "vnc",
  system_update: "update",
  "hermes-skills": "skills",
};

/**
 * Hand-drawn glyphs on a 24x24 grid. Every path is stroked, never filled, so a
 * single `currentColor` drives the whole set and the weight stays even when a
 * tile is scaled. Inset to 3px so no stroke is clipped by the rounded corner.
 */
const GLYPHS: Record<GlyphName, ReactNode> = {
  apps: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.25" />
      <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="m7.5 10 2.6 2.4-2.6 2.4M13 15.2h4" />
    </>
  ),
  files: (
    <path d="M3.5 7.2a1.7 1.7 0 0 1 1.7-1.7h3.4l2 2.4h6.2a1.7 1.7 0 0 1 1.7 1.7v7.6a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z" />
  ),
  clawkeep: (
    <>
      <path d="M12 3.6 19 6.4v5.1c0 4-2.9 7.4-7 8.9-4.1-1.5-7-4.9-7-8.9V6.4z" />
      <path d="m9 12 2.2 2.2L15.4 10" />
    </>
  ),
  store: (
    <>
      <path d="M4.5 8.5h15l-1.1 9.2a1.8 1.8 0 0 1-1.8 1.6H7.4a1.8 1.8 0 0 1-1.8-1.6z" />
      <path d="M9 8.5V7a3 3 0 0 1 6 0v1.5" />
    </>
  ),
  browser: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M3.6 12h16.8M12 3.6c2.1 2.3 3.2 5.3 3.2 8.4s-1.1 6.1-3.2 8.4c-2.1-2.3-3.2-5.3-3.2-8.4S9.9 5.9 12 3.6Z" />
    </>
  ),
  vnc: (
    <>
      <rect x="3" y="5" width="18" height="11.5" rx="2" />
      <path d="M9 20h6M12 16.5V20" />
    </>
  ),
  update: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20.2 4.6v4.2H16" />
    </>
  ),
  skills: (
    <>
      <path d="m12 3.5 2.5 5.3 5.6.8-4.1 4.1 1 5.8-5-2.7-5 2.7 1-5.8L3.9 9.6l5.6-.8z" />
    </>
  ),
  chat: (
    <path d="M20.5 11.6c0 4-3.8 7.2-8.5 7.2a10 10 0 0 1-2.6-.34L4.5 20.2l1.3-3.6A6.9 6.9 0 0 1 3.5 11.6c0-4 3.8-7.2 8.5-7.2s8.5 3.2 8.5 7.2Z" />
  ),
  generic: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
};

/** True for hex colours light enough that white art on them would fail AA. */
function isPale(hex?: string): boolean {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return false;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Rec. 709 luma — cheaper than a full contrast ratio and enough to pick ink.
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.62;
}

interface MacAppIconProps {
  /** App id — selects the asset, glyph and default tint. */
  id: string;
  /** Edge length of the tile in px. */
  size?: number;
  /** Tile background; overrides the id's default tint. */
  color?: string;
  /** "app" when the tile sits on the wallpaper or the dock rather than in a
   *  list, where the extra lift would read as clutter. */
  shadow?: "app" | "none";
  /** Replaces the asset/glyph entirely — used for installed store apps. */
  children?: ReactNode;
  className?: string;
}

export default function MacAppIcon({
  id,
  size = 40,
  color,
  shadow = "app",
  children,
  className,
}: MacAppIconProps) {
  const tint = color || TINTS[id] || "#253347";
  const asset = ASSETS[id];
  const glyph = GLYPHS[GLYPH_FOR[id] ?? "generic"];
  const ink = isPale(tint) ? "rgba(10,15,26,.92)" : "rgba(255,255,255,.94)";
  // The 40px design was drawn against a 10px radius; keep that ratio at any size
  // so a 24px tile in a list and a 56px tile on the wallpaper look like siblings.
  const radius = Math.round(size * 0.25);

  const style = {
    "--mai-size": `${size}px`,
    "--mai-radius": `${radius}px`,
    "--mai-tint": tint,
    "--mai-ink": ink,
  } as CSSProperties;

  return (
    <span
      className={`mai mai--${shadow}${className ? ` ${className}` : ""}`}
      style={style}
      data-app={id}
      aria-hidden="true"
    >
      {children ? (
        <span className="mai-slot">{children}</span>
      ) : asset ? (
        <img
          className={`mai-art${asset.circle ? " mai-art--circle" : ""}`}
          src={asset.src}
          alt=""
          draggable={false}
          style={{
            width: `${Math.round(size * asset.scale)}px`,
            height: `${Math.round(size * asset.scale)}px`,
            objectFit: asset.fit,
            borderRadius: asset.circle
              ? `${Math.round((asset.circle / 40) * size)}px`
              : undefined,
          }}
        />
      ) : (
        <svg
          className="mai-glyph"
          viewBox="0 0 24 24"
          width={Math.round(size * 0.55)}
          height={Math.round(size * 0.55)}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {glyph}
        </svg>
      )}
      <style>{TILE_CSS}</style>
    </span>
  );
}

interface MacGlyphTileProps {
  /** Which hand-drawn glyph to draw. */
  symbol: GlyphName;
  /** Tile background. */
  tint?: string;
  size?: number;
  shadow?: "app" | "none";
  className?: string;
}

/**
 * A tile that is only a glyph — no app identity behind it. The launcher button
 * uses this, which is why it takes a symbol rather than an id.
 */
export function MacGlyphTile({
  symbol,
  tint = "#253347",
  size = 40,
  shadow = "app",
  className,
}: MacGlyphTileProps) {
  const ink = isPale(tint) ? "rgba(10,15,26,.92)" : "rgba(255,255,255,.94)";
  const style = {
    "--mai-size": `${size}px`,
    "--mai-radius": `${Math.round(size * 0.25)}px`,
    "--mai-tint": tint,
    "--mai-ink": ink,
  } as CSSProperties;

  return (
    <span
      className={`mai mai--${shadow}${className ? ` ${className}` : ""}`}
      style={style}
      data-glyph={symbol}
      aria-hidden="true"
    >
      <svg
        className="mai-glyph"
        viewBox="0 0 24 24"
        width={Math.round(size * 0.55)}
        height={Math.round(size * 0.55)}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {GLYPHS[symbol] ?? GLYPHS.generic}
      </svg>
      <style>{TILE_CSS}</style>
    </span>
  );
}

const TILE_CSS = `
.mai{
  /* Local fallbacks: a tile on the wallpaper has no .m3dx ancestor to inherit
     the dock's tokens from, so every var() below has to stand alone. */
  --mai-rim-light:rgba(255,255,255,.16);
  --mai-rim-dark:rgba(0,0,0,.42);
  --mai-ease:var(--m3dx-standard,cubic-bezier(0.2,0,0,1));
  --mai-dur:var(--m3dx-short4,200ms);

  position:relative;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  flex:0 0 auto;
  width:var(--mai-size);
  height:var(--mai-size);
  border-radius:var(--mai-radius);
  background:var(--mai-tint);
  color:var(--mai-ink);
  overflow:hidden;
  isolation:isolate;
  transition:transform var(--mai-dur) var(--mai-ease);
}
.mai *,.mai *::before,.mai *::after{ box-sizing:border-box; }

/* Two rims in one pseudo-element: the inset light hairline reads as a bevel on
   dark wallpapers, the outer dark one keeps a pale tile from dissolving into a
   pale wallpaper. Inset slightly so neither stroke is clipped. */
.mai::after{
  content:"";
  position:absolute;
  inset:0;
  border-radius:inherit;
  box-shadow:
    inset 0 0 0 .5px var(--mai-rim-light),
    0 0 0 .5px var(--mai-rim-dark);
  pointer-events:none;
  z-index:2;
}

/* Layered rather than one big blur: the tight shadow anchors the tile to the
   surface, the wide one gives it height. */
.mai--app{
  box-shadow:
    0 1px 2px rgba(0,0,0,.34),
    0 6px 14px -4px rgba(0,0,0,.46);
}
.mai--none{ box-shadow:none; }

.mai-art{
  position:relative;
  z-index:1;
  display:block;
  user-select:none;
  -webkit-user-drag:none;
}
.mai-art--circle{ overflow:hidden; }

.mai-glyph{ position:relative; z-index:1; display:block; }

.mai-slot{
  position:relative;
  z-index:1;
  display:flex;
  align-items:center;
  justify-content:center;
  width:100%;
  height:100%;
}
.mai-slot > *{ max-width:100%; max-height:100%; }

@media (prefers-reduced-motion:reduce){
  .mai{ transition:none; }
}
`;
