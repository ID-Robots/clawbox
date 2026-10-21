/**
 * What a public app link lets visitors do with the app's own `/api` tree,
 * shared by the owner's dialog (src/components/PublicAppLink.tsx) and the
 * server side (src/lib/public-app-links.ts). No Node imports: the dialog
 * bundles this file.
 */

/**
 * Use it (`full`), read it (`read`: GET/HEAD only, the default for a new
 * link), or nothing beyond the prefixes the owner typed (`none`).
 */
export type PublicLinkApiAccess = "full" | "read" | "none";
export const API_ACCESS_VALUES: readonly PublicLinkApiAccess[] = ["full", "read", "none"];
/** The prefix `full` and `read` open: the app's own API, under its base path. */
export const DEFAULT_API_PREFIX = "/api";

/** Does this prefix open the app's own /api tree? The serving side matches by prefix, so "/" opens everything and "/api/" is "/api". */
export function opensAppApi(prefix: string): boolean {
  const p = prefix.replace(/\/+$/, "");
  return p === "" || p === DEFAULT_API_PREFIX;
}
