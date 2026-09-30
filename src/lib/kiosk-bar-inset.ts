"use client";

import { useEffect, useState } from "react";

/**
 * The strip the KIOSK bar takes at the top of the desktop page.
 *
 * On the x64 laptop the desktop is one tab of a `--kiosk` Chrome, and every
 * page it opens is another. The kiosk extension (`kiosk/extension/bar.js`)
 * draws its bar — ClawBox, the open tabs, an address box, "+" — on each of
 * those pages, and on the desktop page too, always, as the kiosk's tab strip
 * (in the shelf's glass there, so the wallpaper runs on behind it, and with no
 * address box). The bar is
 * `position: fixed` at the top at the largest z-index there is, so anything of
 * the desktop's own under that strip would be hidden and could not be
 * clicked.
 *
 * The extension says how tall the strip is by setting `KIOSK_BAR_VAR` on
 * `<html>` (inline, so the page can read it) and firing `KIOSK_BAR_EVENT` on
 * `window` whenever it shows or hides. The desktop reads it through
 * `kioskBarInset()` / `useKioskBarInset()` and re-lays out on the event.
 * On every other browser — a Jetson's, a phone, a
 * laptop reaching the box over the LAN — nothing sets the variable and the
 * inset is 0, which is the layout the desktop always had.
 */

/** The custom property the extension sets on `<html>`: the bar's height in px. */
export const KIOSK_BAR_VAR = "--clawbox-kiosk-bar-h";
/** Fired on `window` by the extension once its bar is up on the desktop. */
export const KIOSK_BAR_EVENT = "clawbox:kiosk-bar";
/**
 * The bar's height as `kiosk/extension/bar.js` draws it (its `BAR_H`; the
 * extension test holds the two together). Only for the room the icon grid
 * keeps on the kiosk from the first paint, before the extension has mounted
 * the bar; everything else reads the live `kioskBarInset()`.
 */
export const KIOSK_BAR_HEIGHT = 40;
/** Anything larger is not the bar, and is not allowed to swallow the desktop. */
const MAX_INSET = 120;

/** The bar's height in CSS px, 0 when there is no bar. Never throws. */
export function kioskBarInset(): number {
  if (typeof document === "undefined") return 0;
  const raw = document.documentElement.style.getPropertyValue(KIOSK_BAR_VAR);
  const px = Number.parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? Math.min(px, MAX_INSET) : 0;
}

/**
 * The inset, re-read whenever the extension shows or hides the bar (and on a
 * resize, which is when every other piece of desktop geometry is re-read).
 */
export function useKioskBarInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const read = () => setInset(kioskBarInset());
    window.addEventListener(KIOSK_BAR_EVENT, read);
    window.addEventListener("resize", read);
    // Read AFTER listening: a bar that mounts between the two is not missed.
    read();
    return () => {
      window.removeEventListener(KIOSK_BAR_EVENT, read);
      window.removeEventListener("resize", read);
    };
  }, []);
  return inset;
}
