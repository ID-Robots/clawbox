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

export async function runBrowserAction(action: BrowserAction): Promise<BrowserActionResult> {
  try {
    const res = await fetch("/setup-api/browser/manage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
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

/** The owner's settings, written by the wizard and the settings page alike. */
export async function saveBrowserSetup(
  patch: { setupComplete?: boolean; autoOpen?: boolean; startUrl?: string | null },
): Promise<BrowserActionResult> {
  try {
    const res = await fetch("/setup-api/browser/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
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
