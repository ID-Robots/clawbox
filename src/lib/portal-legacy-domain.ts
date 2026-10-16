/** The portal moved from openclawhardware.dev to clawbox.com (TASK-1600).
 * Boxes paired before the move kept the old origin in config.toml or env
 * overrides; map that origin (with or without www) to the current one and
 * leave every other URL — custom or self-hosted portals — untouched. */
export const CURRENT_PORTAL_ORIGIN = "https://clawbox.com";

const LEGACY_HOSTS = new Set(["openclawhardware.dev", "www.openclawhardware.dev"]);

export function migrateLegacyPortalUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (!LEGACY_HOSTS.has(url.hostname.toLowerCase())) return value;
  if (url.protocol !== "https:" && url.protocol !== "http:") return value;
  if (url.port) return value;
  const rest = value.replace(/^[a-z]+:\/\/[^/?#]+/i, "");
  return `${CURRENT_PORTAL_ORIGIN}${rest}`;
}
