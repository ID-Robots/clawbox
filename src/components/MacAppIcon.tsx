"use client";

import type { CSSProperties, ReactNode } from "react";

/**
 * App icon tiles for the desktop, the launcher and anywhere else a bare surface
 * needs an app to read as an app.
 *
 * The original of this file was lost with a reflashed device. The palette below
 * is not invented: it was sampled pixel-by-pixel out of a 2026-08-12 screenshot
 * of the running desktop, so each tile keeps the colours it actually shipped
 * with. That is also why the tints live here rather than coming from `app.color`
 * — several apps deliberately differ from their window colour (ClawKeep is
 * emerald, not forest green; Skills is bright violet, not near-black; Browser is
 * a pale tile so the Chrome mark reads against it).
 *
 * Each tile is a vertical gradient rather than a flat fill. That is the whole
 * visual signature of the set — a flat `backgroundColor` cannot reproduce it,
 * and a tile without it looks like an ordinary coloured div.
 */

interface Tint {
  /** Gradient stops, top then bottom. */
  from: string;
  to: string;
}

/**
 * Sampled from the shipped desktop. Values are the real gradient endpoints, so
 * changing one here changes what the user sees — they are not decoration.
 */
const TINTS: Record<string, Tint> = {
  settings: { from: "#b8bdc3", to: "#6c727c" },
  hermes: { from: "#927bdc", to: "#393644" },
  clawbox: { from: "#73636b", to: "#101623" },
  "hermes-skills": { from: "#dcd1f8", to: "#5e2cb3" },
  terminal: { from: "#767980", to: "#292c31" },
  files: { from: "#fcc57f", to: "#df7d21" },
  clawkeep: { from: "#77e2b3", to: "#1a9b67" },
  system_update: { from: "#7bc8f6", to: "#157bc7" },
  browser: { from: "#95b9e8", to: "#9eb4d8" },
  // Not present on the captured desktop; derived from each app's own colour on
  // the same light-top/saturated-bottom ramp as the sampled ones.
  openclaw: { from: "#6b7280", to: "#0a0f1a" },
  store: { from: "#86efac", to: "#16a34a" },
  vnc: { from: "#c4b5fd", to: "#6d28d9" },
};

const FALLBACK: Tint = { from: "#4b5563", to: "#253347" };

interface AssetSpec {
  src: string;
  /** Multiplier on the tile edge; >1 lets art bleed toward the rim. */
  scale: number;
  fit: "contain" | "cover";
  /** Circle-crops the art at this radius, expressed at a 40px tile. */
  circle?: number;
}

/** Apps whose identity is a picture rather than a glyph. */
const ASSETS: Record<string, AssetSpec> = {
  clawbox: { src: "/clawbox-crab.png", scale: 1.18, fit: "contain" },
  hermes: { src: "/hermes-agent.png", scale: 0.78, fit: "cover", circle: 30 },
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
  openclaw: "chat",
};

/**
 * Glyphs on a 24x24 grid. Filled shapes, not strokes: at 28px inside a 56px
 * tile a stroked glyph reads as thin and washed out against a saturated
 * gradient, which is why the shipped set used solid marks.
 */
const GLYPHS: Record<GlyphName, ReactNode> = {
  apps: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="2.2" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="2.2" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="2.2" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2.2" />
    </>
  ),
  settings: (
    <path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6m0 2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6M10.6 2l-.5 2.6a8 8 0 0 0-1.7 1L5.9 4.7 3.5 8.8l2 1.7a8 8 0 0 0 0 2l-2 1.7 2.4 4.1 2.5-.9a8 8 0 0 0 1.7 1l.5 2.6h4.8l.5-2.6a8 8 0 0 0 1.7-1l2.5.9 2.4-4.1-2-1.7a8 8 0 0 0 0-2l2-1.7-2.4-4.1-2.5.9a8 8 0 0 0-1.7-1L13.4 2z" />
  ),
  terminal: (
    <>
      <rect x="2.4" y="4.4" width="19.2" height="15.2" rx="2.6" opacity=".28" />
      <path d="M6.6 9.2 9.8 12l-3.2 2.8a1 1 0 0 1-1.3-1.5L6.9 12 5.3 10.7a1 1 0 0 1 1.3-1.5M12.6 14h5a1 1 0 0 1 0 2h-5a1 1 0 0 1 0-2" />
    </>
  ),
  files: (
    <path d="M3 7.4A1.9 1.9 0 0 1 4.9 5.5h3.6l2.1 2.5h6.5A1.9 1.9 0 0 1 19 9.9v.6H3zM3 12h16v6.1a1.9 1.9 0 0 1-1.9 1.9H4.9A1.9 1.9 0 0 1 3 18.1z" />
  ),
  clawkeep: (
    <path d="M12 2.6 4.6 5.6v6.1c0 4.6 3.2 8.6 7.4 9.7 4.2-1.1 7.4-5.1 7.4-9.7V5.6zm0 5.2a2.4 2.4 0 0 1 1.2 4.5v2.4a1.2 1.2 0 0 1-2.4 0v-2.4A2.4 2.4 0 0 1 12 7.8" />
  ),
  store: (
    <path d="M6 2.5h12a1.5 1.5 0 0 1 1.5 1.4l.5 4.3a3.2 3.2 0 0 1-6.3.9 3.2 3.2 0 0 1-3.4 0 3.2 3.2 0 0 1-6.3-.9L4.5 3.9A1.5 1.5 0 0 1 6 2.5M5 11.6a5 5 0 0 0 1.4.3v7.6A1.5 1.5 0 0 0 7.9 21h8.2a1.5 1.5 0 0 0 1.5-1.5v-7.6a5 5 0 0 0 1.4-.3v7.9A3.5 3.5 0 0 1 15.5 23h-7A3.5 3.5 0 0 1 5 19.5z" />
  ),
  browser: (
    <>
      <circle cx="12" cy="12" r="9.2" opacity=".22" />
      <circle cx="12" cy="12" r="4.1" />
    </>
  ),
  vnc: (
    <path d="M3.6 5.2A1.8 1.8 0 0 1 5.4 3.4h13.2a1.8 1.8 0 0 1 1.8 1.8v9.6a1.8 1.8 0 0 1-1.8 1.8h-4.7l.5 2h2a1 1 0 0 1 0 2H7.6a1 1 0 0 1 0-2h2l.5-2H5.4a1.8 1.8 0 0 1-1.8-1.8z" />
  ),
  update: (
    <path d="M12 2.8a1.2 1.2 0 0 1 1.2 1.2v8.3l2.5-2.5a1.2 1.2 0 0 1 1.7 1.7l-4.5 4.6a1.2 1.2 0 0 1-1.8 0L6.6 11.5a1.2 1.2 0 1 1 1.7-1.7l2.5 2.5V4a1.2 1.2 0 0 1 1.2-1.2M4.6 17.4a1.2 1.2 0 0 1 1.2 1.2v.6h12.4v-.6a1.2 1.2 0 0 1 2.4 0v1a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2v-1a1.2 1.2 0 0 1 1.2-1.2" />
  ),
  skills: (
    <path d="M13.6 2.4 5.2 13.1a.9.9 0 0 0 .7 1.5h4.3l-1.4 7.2a.9.9 0 0 0 1.6.7l8.5-10.7a.9.9 0 0 0-.7-1.5h-4.3l1.4-7.2a.9.9 0 0 0-1.7-.7" />
  ),
  chat: (
    <path d="M12 3.4c-5 0-9 3.4-9 7.7 0 2.4 1.3 4.6 3.3 6l-1 3.6a.7.7 0 0 0 1 .8l4-2.1c.5.1 1.1.1 1.7.1 5 0 9-3.4 9-7.7s-4-8.4-9-8.4" />
  ),
  generic: (
    <>
      <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="4.6" opacity=".24" />
      <circle cx="12" cy="12" r="3.2" />
    </>
  ),
};

function parseTint(color?: string): Tint | null {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return null;
  // Build the same light-top ramp used by the sampled set, so an unknown app
  // passed only a flat colour still looks like it belongs to the family.
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const lift = (v: number) => Math.min(255, Math.round(v + (255 - v) * 0.42));
  return {
    from: `#${[lift(r), lift(g), lift(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`,
    to: color,
  };
}

/** True when the tile is pale enough that white art on it would fail contrast. */
function isPale(t: Tint): boolean {
  const hex = t.to;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.58;
}

interface MacAppIconProps {
  /** App id — selects tint, asset and glyph. */
  id: string;
  /** Edge length of the tile in px. */
  size?: number;
  /** Only consulted for ids with no entry in TINTS; the sampled palette wins. */
  color?: string;
  /** "app" when the tile sits on a wallpaper or a bare grid. */
  shadow?: "app" | "none";
  /** Replaces the asset/glyph entirely — used for installed store apps. */
  children?: ReactNode;
  className?: string;
}

export default function MacAppIcon({
  id,
  size = 56,
  color,
  shadow = "app",
  children,
  className,
}: MacAppIconProps) {
  const tint = TINTS[id] ?? parseTint(color) ?? FALLBACK;
  const asset = ASSETS[id];
  const glyph = GLYPHS[GLYPH_FOR[id] ?? "generic"];
  const ink = isPale(tint) ? "rgba(10,15,26,.92)" : "#fff";
  // macOS squircle proportion. Tracking size keeps a 40px launcher tile and a
  // 56px desktop tile visibly the same shape.
  const radius = Math.round(size * 0.28);

  const style = {
    "--mai-size": `${size}px`,
    "--mai-radius": `${radius}px`,
    "--mai-from": tint.from,
    "--mai-to": tint.to,
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
          className="mai-art"
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
          width={Math.round(size * 0.52)}
          height={Math.round(size * 0.52)}
          fill="currentColor"
        >
          {glyph}
        </svg>
      )}
      <style>{TILE_CSS}</style>
    </span>
  );
}

interface MacGlyphTileProps {
  symbol: GlyphName;
  /** Flat colour; ramped into a gradient like the rest of the set. */
  tint?: string;
  size?: number;
  shadow?: "app" | "none";
  className?: string;
}

/**
 * A tile that is only a glyph — no app behind it. The launcher button uses
 * this, which is why it takes a symbol rather than an id.
 */
export function MacGlyphTile({
  symbol,
  tint = "#7C8595",
  size = 40,
  shadow = "app",
  className,
}: MacGlyphTileProps) {
  const t = parseTint(tint) ?? FALLBACK;
  const style = {
    "--mai-size": `${size}px`,
    "--mai-radius": `${Math.round(size * 0.28)}px`,
    "--mai-from": t.from,
    "--mai-to": t.to,
    "--mai-ink": isPale(t) ? "rgba(10,15,26,.92)" : "#fff",
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
        width={Math.round(size * 0.52)}
        height={Math.round(size * 0.52)}
        fill="currentColor"
      >
        {GLYPHS[symbol] ?? GLYPHS.generic}
      </svg>
      <style>{TILE_CSS}</style>
    </span>
  );
}

const TILE_CSS = `
.mai{
  position:relative;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  flex:0 0 auto;
  width:var(--mai-size);
  height:var(--mai-size);
  border-radius:var(--mai-radius);
  /* The signature of the set. Flat fills read as a plain coloured div. */
  background:linear-gradient(180deg,var(--mai-from) 0%,var(--mai-to) 100%);
  color:var(--mai-ink);
  overflow:hidden;
  isolation:isolate;
}
.mai *,.mai *::before,.mai *::after{ box-sizing:border-box; }

/* A bright hairline along the top edge and a dark one around the whole tile:
   the first sells the gradient as a lit surface, the second keeps a pale tile
   from dissolving into a pale wallpaper. */
.mai::after{
  content:"";
  position:absolute;
  inset:0;
  border-radius:inherit;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.34),
    inset 0 0 0 .5px rgba(255,255,255,.10),
    0 0 0 .5px rgba(0,0,0,.34);
  pointer-events:none;
  z-index:2;
}

.mai--app{
  box-shadow:
    0 1px 2px rgba(0,0,0,.30),
    0 8px 18px -6px rgba(0,0,0,.48);
}
.mai--none{ box-shadow:none; }

.mai-art{
  position:relative;
  z-index:1;
  display:block;
  user-select:none;
  -webkit-user-drag:none;
}
.mai-glyph{
  position:relative;
  z-index:1;
  display:block;
  filter:drop-shadow(0 1px 1px rgba(0,0,0,.22));
}
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
`;
