import type { MutableRefObject } from "react";

/**
 * Try to close an OAuth popup window and return a hint message if it couldn't be closed.
 */
export function tryCloseOAuthWindow(
  ref: MutableRefObject<Window | null>
): { tabClosed: boolean; closeHint: string } {
  let tabClosed = false;
  try {
    if (ref.current && !ref.current.closed) {
      ref.current.close();
      tabClosed = ref.current.closed;
    } else {
      tabClosed = true;
    }
  } catch { /* cross-origin */ }
  ref.current = null;
  const closeHint = tabClosed ? "" : " You can close the authorization tab.";
  return { tabClosed, closeHint };
}

/**
 * Parse OAuth callback input — accepts either a raw authorization code
 * or a full redirect URL (extracting code + state from query params).
 */
export function parseAuthInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (code) return state ? `${code}#${state}` : code;
    } catch (err) {
      console.debug("[oauth-utils] URL parse failed for input:", trimmed, err);
    }
  }
  return trimmed;
}
