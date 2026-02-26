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
