"use client";

import { useSyncExternalStore } from "react";
import { getDeskScreens, subscribeDeskScreens, type DeskScreen } from "./desktop-screens";

/**
 * The monitors the desktop is spread over (null with one screen), re-rendering
 * the caller when they change. Kept out of `desktop-screens.ts`, which server
 * code reaches through `window-snap.ts` and must not import React hooks.
 */
export function useDeskScreens(): DeskScreen[] | null {
  return useSyncExternalStore(subscribeDeskScreens, getDeskScreens, () => null);
}
