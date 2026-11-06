"use client";

import { useId } from "react";

/**
 * Prime Radiant's mark: a tesseract-like wireframe — a cuboctahedron seen
 * down its threefold axis (hexagon outline, front triangle), a smaller copy
 * nested inside it joined vertex to vertex, and a golden core. The owner's
 * reference was a recursive "vector equilibrium" sculpture; the nesting is the
 * wiki's facts inside pages inside domains.
 *
 * Vector, so it stays sharp from the 16px shelf to the 96px tile. Its colours
 * are its own (pale blue lines, a gold core), drawn for the app's dark blue
 * tile (`desktop-apps.ts`) and the app's own dark header; the hidden-edge and
 * linking lines are faint so the outline still reads at small sizes.
 * Path data is precomputed (outer radius 21 in a 48 box, inner copy at 0.42,
 * core at 0.14).
 */
const BACK = "M24 36.12L34.5 17.94M34.5 17.94L13.5 17.94M13.5 17.94L24 36.12M24 36.12L13.5 42.19M24 36.12L34.5 42.19M34.5 17.94L45 24M34.5 17.94L34.5 5.81M13.5 17.94L13.5 5.81M13.5 17.94L3 24";
const LINKS = "M45 24L32.82 24M34.5 5.81L28.41 16.36M13.5 5.81L19.59 16.36M3 24L15.18 24M13.5 42.19L19.59 31.64M34.5 42.19L28.41 31.64M24 11.88L24 18.91M13.5 30.06L19.59 26.55M34.5 30.06L28.41 26.55";
const INNER = "M32.82 24L28.41 16.36M28.41 16.36L19.59 16.36M19.59 16.36L15.18 24M15.18 24L19.59 31.64M19.59 31.64L28.41 31.64M28.41 31.64L32.82 24M24 18.91L19.59 26.55M19.59 26.55L28.41 26.55M28.41 26.55L24 18.91M24 18.91L28.41 16.36M24 18.91L19.59 16.36M19.59 26.55L15.18 24M19.59 26.55L19.59 31.64M28.41 26.55L28.41 31.64M28.41 26.55L32.82 24";
const INNER_BACK = "M24 29.09L28.41 21.45M28.41 21.45L19.59 21.45M19.59 21.45L24 29.09M24 29.09L19.59 31.64M24 29.09L28.41 31.64M28.41 21.45L32.82 24M28.41 21.45L28.41 16.36M19.59 21.45L19.59 16.36M19.59 21.45L15.18 24";
const CORE = "M26.94 24L25.47 21.45M25.47 21.45L22.53 21.45M22.53 21.45L21.06 24M21.06 24L22.53 26.55M22.53 26.55L25.47 26.55M25.47 26.55L26.94 24M24 22.3L22.53 24.85M22.53 24.85L25.47 24.85M25.47 24.85L24 22.3M24 22.3L25.47 21.45M24 22.3L22.53 21.45M22.53 24.85L21.06 24M22.53 24.85L22.53 26.55M25.47 24.85L25.47 26.55M25.47 24.85L26.94 24";
const OUTER = "M45 24L34.5 5.81M34.5 5.81L13.5 5.81M13.5 5.81L3 24M3 24L13.5 42.19M13.5 42.19L34.5 42.19M34.5 42.19L45 24M24 11.88L13.5 30.06M13.5 30.06L34.5 30.06M34.5 30.06L24 11.88M24 11.88L34.5 5.81M24 11.88L13.5 5.81M13.5 30.06L3 24M13.5 30.06L13.5 42.19M34.5 30.06L34.5 42.19M34.5 30.06L45 24";

export default function PrimeRadiantIcon({ className = "w-6 h-6", style }: { className?: string; style?: React.CSSProperties }) {
  // Several copies render at once (tile, shelf, window header): one gradient id each.
  const gradient = `prime-radiant-${useId().replace(/:/g, "")}`;
  return (
    <svg
      viewBox="0 0 48 48"
      className={className}
      style={style}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-testid="prime-radiant-icon"
    >
      <defs>
        <linearGradient id={gradient} x1="8" y1="4" x2="40" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#e6f4ff" />
          <stop offset="1" stopColor="#7cc4ff" />
        </linearGradient>
      </defs>
      <path d={BACK} stroke="#7cc4ff" strokeOpacity={0.35} strokeWidth={0.9} />
      <path d={LINKS} stroke="#9fd3ff" strokeOpacity={0.35} strokeWidth={0.7} />
      <path d={INNER} stroke="#bfe3ff" strokeOpacity={0.75} strokeWidth={0.9} />
      <path d={INNER_BACK} stroke="#7cc4ff" strokeOpacity={0.3} strokeWidth={0.6} />
      <path d={CORE} stroke="#f5c451" strokeWidth={0.9} />
      <path d={OUTER} stroke={`url(#${gradient})`} strokeWidth={2} />
    </svg>
  );
}
