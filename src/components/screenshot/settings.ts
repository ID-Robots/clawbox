import type { CaptureEngineId } from "@/lib/screenshot/session";

/**
 * The Screenshot app's two remembered options: "Capture with" (the engine) and
 * "Hide this window while capturing".
 *
 * They persist through the desktop's preferences (`/setup-api/preferences`,
 * one JSON value under `ui_screenshot_settings`), the store the Terminal keeps
 * its settings in (src/lib/terminal-settings.ts). They survive closing the
 * window and reloading the page. The route only takes names with one of its
 * prefixes and silently drops any other, hence `ui_`.
 *
 * What is loaded is checked field by field: a value this app does not
 * recognise leaves that field at its default. A failed read or write is never
 * an error the owner sees; the app keeps working with what it has.
 */

export const SCREENSHOT_SETTINGS_KEY = "ui_screenshot_settings";

export interface ScreenshotSettings {
  engine: CaptureEngineId;
  hideWindow: boolean;
}

export const DEFAULT_SCREENSHOT_SETTINGS: Readonly<ScreenshotSettings> = Object.freeze({
  engine: "dom",
  hideWindow: true,
});

const ENGINES: ReadonlySet<string> = new Set<CaptureEngineId>(["dom", "display"]);

/** A stored value made into settings: anything unrecognised falls back to the default for that field. */
export function normalizeScreenshotSettings(raw: unknown): ScreenshotSettings {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    engine: typeof record.engine === "string" && ENGINES.has(record.engine)
      ? (record.engine as CaptureEngineId)
      : DEFAULT_SCREENSHOT_SETTINGS.engine,
    hideWindow: typeof record.hideWindow === "boolean" ? record.hideWindow : DEFAULT_SCREENSHOT_SETTINGS.hideWindow,
  };
}

/**
 * The settings this page last read or wrote, so a window reopened in the same
 * page starts on them instead of flashing the defaults. The store stays the
 * source of truth: every mount reads it again.
 */
let lastKnown: ScreenshotSettings | null = null;

export function cachedScreenshotSettings(): ScreenshotSettings | null {
  return lastKnown;
}

/** The stored settings, or null when there are none or they could not be read. */
export async function loadScreenshotSettings(): Promise<ScreenshotSettings | null> {
  try {
    const res = await fetch(`/setup-api/preferences?keys=${SCREENSHOT_SETTINGS_KEY}`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown> | null;
    const raw = data?.[SCREENSHOT_SETTINGS_KEY];
    if (raw === undefined || raw === null) return null;
    lastKnown = normalizeScreenshotSettings(raw);
    return lastKnown;
  } catch {
    // Offline, or no session yet: the defaults stand.
    return null;
  }
}

/** Write the settings. Resolves to whether the store took them; never throws. */
export async function saveScreenshotSettings(settings: ScreenshotSettings): Promise<boolean> {
  const value = normalizeScreenshotSettings(settings);
  lastKnown = value;
  try {
    const res = await fetch("/setup-api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [SCREENSHOT_SETTINGS_KEY]: value }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
