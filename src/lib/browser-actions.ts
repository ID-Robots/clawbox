/**
 * The Browser app's writes, in one place: the manage route's actions and the
 * owner's settings, plus the one function that turns a refusal into a sentence
 * the owner can read.
 *
 * Three components post to these two routes now — the app, its setup wizard
 * and its settings page — and each of them used to be free to invent its own
 * fallback string for a failure. A refusal has a stable `code`; the wording
 * belongs to the locale files, not to whichever component happened to make
 * the call.
 */

export type BrowserAction =
  | "install-chromium"
  | "enable"
  | "disable"
  | "open-browser"
  | "close-browser";

export interface BrowserActionResult {
  ok: boolean;
  /** The route's own English sentence, for a refusal we have no wording for. */
  error?: string;
  /** The stable reason, when the route named one. */
  code?: string;
}

/**
 * How long each action may take before the app stops waiting for it.
 *
 * Not a guess at how fast the box is — every number here is well past the
 * route's OWN worst case, so a deadline that trips means the request is wedged
 * rather than merely slow. It exists because without one a stalled request
 * leaves `actionLoading` (or the settings page's `busy`) set for the life of
 * the window, with no way back but a reload; a timeout becomes the
 * `unreachable` refusal, which every locale already words.
 */
export const ACTION_DEADLINE_MS: Record<BrowserAction, number> = {
  // dpkg, apt, snap, apt again and then the Playwright runtime, in series.
  "install-chromium": 900_000,
  // A pair of config writes and a gateway restart.
  enable: 180_000,
  disable: 180_000,
  // Clearing the agent's hold on the CDP port, systemctl, then ten one-second
  // readiness probes.
  "open-browser": 120_000,
  "close-browser": 120_000,
};

export async function runBrowserAction(action: BrowserAction): Promise<BrowserActionResult> {
  try {
    const res = await fetch("/setup-api/browser/manage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(ACTION_DEADLINE_MS[action]),
    });
    const data = await res.json().catch(() => null) as { error?: string; code?: string } | null;
    if (!res.ok) {
      return {
        ok: false,
        error: data?.error,
        // A 409 is the one refusal the route states without a code: the
        // agent's own headless browser still holds the CDP port.
        code: data?.code ?? (res.status === 409 ? "agent_holds_cdp" : undefined),
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : undefined, code: "unreachable" };
  }
}

/** Three small writes and a file; anything past this is a wedged request. */
export const SETUP_DEADLINE_MS = 15_000;

/** The owner's settings, written by the wizard and the settings page alike. */
export async function saveBrowserSetup(
  patch: { setupComplete?: boolean; autoOpen?: boolean; startUrl?: string | null },
): Promise<BrowserActionResult> {
  try {
    const res = await fetch("/setup-api/browser/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(SETUP_DEADLINE_MS),
    });
    const data = await res.json().catch(() => null) as { error?: string; code?: string } | null;
    if (!res.ok) return { ok: false, error: data?.error, code: data?.code };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : undefined, code: "unreachable" };
  }
}

/**
 * What to show the owner for a refusal.
 *
 * The device's own sentence is the fallback, not the first choice: it is
 * English on a box whose desktop may be in any of ten languages, and every
 * failure this flow can actually produce has a code and therefore a key.
 */
export function browserErrorText(
  t: (key: string, params?: Record<string, string | number>) => string,
  result: BrowserActionResult,
  fallbackKey = "browser.actionFailed",
): string {
  const keyed: Record<string, string> = {
    chromium_not_installed: "browser.errorNotInstalled",
    chromium_not_service_safe: "browser.errorNotServiceSafe",
    agent_holds_cdp: "browser.errorAgentHoldsCdp",
    unreachable: "browser.errorUnreachable",
    owner_only: "browser.errorOwnerOnly",
    cross_origin: "browser.errorOwnerOnly",
    bad_start_url: "browser.errorStartUrl",
  };
  const key = result.code ? keyed[result.code] : undefined;
  if (key) return t(key);
  return result.error || t(fallbackKey);
}
