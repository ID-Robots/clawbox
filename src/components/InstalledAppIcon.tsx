"use client";

import { useState } from "react";

/**
 * The icon of an installed app: the box's cached copy first
 * (`/setup-api/apps/icon/<appId>`), then the store URL, then the generic
 * glyph on the colour tile.
 *
 * A source that failed is REMEMBERED, and rightly so — the alternative is an
 * <img> that re-requests a 404 on every render. But "failed" has to be scoped
 * to the sources it was observed against. A web app is registered on the
 * desktop before the icon ClawBox AI draws for it exists (src/lib/webapp-icon.ts
 * generates it after the create has already answered), so the first request
 * for the local icon 404s, and a component that never looked again would show
 * the placeholder until the next reload. When the icon lands the server
 * re-pushes `register_webapp` with a fresh `iconUrl`, which changes the props
 * here, and a changed source list starts the walk over from the top.
 *
 * The top is the VERSIONED local URL when there is one. The bare local URL
 * was served with a year-long `immutable` cache by every ClawBox before this
 * one, and a browser that has it cached never asks again — so once an id has
 * shown an icon in a browser, the bare URL shows that icon for good, even
 * after the app was uninstalled and a different app took the id. Store icons
 * never changed under an id; generated ones do. A `?v=` URL is one the
 * browser has never seen, so it is asked for, and it comes first so a cache
 * hit on the bare URL cannot stop the walk before it gets there.
 *
 * Derived rather than reset in an effect: the failure record carries the
 * source list it belongs to, and is simply ignored once the list is different.
 * No effect, no extra render, nothing to get out of order.
 */

interface InstalledAppIconProps {
  iconUrl?: string;
  appId?: string;
  name?: string;
  /**
   * The FALLBACK GLYPH's size, and only that. The picture itself fills
   * whatever box the caller puts this in, because every desktop caller is a
   * colour tile the icon is meant to reach the edge of — the glyph then sits
   * inset in the middle of it, which is why `size` is about half the tile at
   * every call site. A caller that hands this component no box of its own
   * gets a picture as wide as its container; see ProjectIcon in
   * CodingAgentApp for what that box looks like when there is no tile.
   */
  size?: string;
}

interface Attempt {
  /** The source list this record is about. */
  key: string;
  /** Which entry is being tried. */
  idx: number;
  /** Every entry failed. */
  failed: boolean;
}

export default function InstalledAppIcon({ iconUrl, appId, name, size = "w-6 h-6" }: InstalledAppIconProps) {
  const px = size.includes("w-12") ? 48 : size.includes("w-7") ? 28 : size.includes("w-6") ? 24 : size.includes("w-3") ? 12 : 24;
  const localSrc = appId ? `/setup-api/apps/icon/${appId}` : undefined;
  // An iconUrl that is this app's own local icon with a version on it (what
  // the server pushes when a generated icon lands) outranks the bare URL.
  const versionedLocal = localSrc && iconUrl?.startsWith(`${localSrc}?`) ? iconUrl : undefined;
  const sources = [versionedLocal, localSrc, versionedLocal ? undefined : iconUrl].filter(Boolean) as string[];
  const key = sources.join("\n");
  const [attempt, setAttempt] = useState<Attempt>({ key, idx: 0, failed: false });
  // A record from a different source list is stale: start again at the top.
  const current: Attempt = attempt.key === key ? attempt : { key, idx: 0, failed: false };

  const src = sources[current.idx];
  if (src && !current.failed) {
    return (
      <img
        src={src}
        alt={name || ""}
        className="w-full h-full object-cover rounded-[inherit]"
        onError={() => {
          setAttempt(
            current.idx + 1 < sources.length
              ? { key, idx: current.idx + 1, failed: false }
              : { key, idx: current.idx, failed: true },
          );
        }}
      />
    );
  }
  return <span className="material-symbols-rounded text-white" style={{ fontSize: px }}>extension</span>;
}
