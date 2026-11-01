/**
 * The Store's search, made to find an app by its slug.
 *
 * The search itself is the portal's (clawbox.com/api/store/apps?q=), and it
 * matches words, not slugs: "audiobook player" finds Audiobook Player while
 * "audiobook-player" — the id the app is installed, linked and talked about
 * under — finds nothing. Turning every '-' into a space is not the answer
 * either: "one-mail" finds One-mail and "one mail" does not.
 *
 * So a slug-shaped query is asked three ways and the answers merged: as typed,
 * as words, and as an exact slug (the listing's own record). Never fewer
 * results than the query alone gave. Everything else goes to the portal as it
 * always did.
 */

/** Lower-case words joined by single '-' or '_', the shape a Store slug has. */
const SLUG_QUERY_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;
const MAX_SLUG_CHARS = 64;

export interface SlugSearch {
  /** The query as a slug, for the portal's per-app record. */
  slug: string;
  /** The same query as words, for the portal's search. */
  words: string;
}

/** A slug-shaped query's two other spellings; null for any other query. */
export function slugSearch(q: string): SlugSearch | null {
  const slug = q.trim().toLowerCase();
  if (slug.length > MAX_SLUG_CHARS || !SLUG_QUERY_RE.test(slug)) return null;
  return { slug, words: slug.replace(/[-_]/g, " ") };
}

type Listing = Record<string, unknown>;

function listingsOf(body: unknown): Listing[] {
  const apps = (body as { apps?: unknown } | null)?.apps;
  return Array.isArray(apps) ? apps.filter((a): a is Listing => !!a && typeof a === "object") : [];
}

/**
 * One list out of the three answers: the exact slug first, then the query's
 * own results, then the words', each app once and at most `limit` of them.
 *
 * The exact record joins only when the search would have shown it: its slug
 * is the query, it is not hidden, and it sits in the category being browsed.
 */
export function mergeSlugSearch(input: {
  slug: string;
  limit: number;
  category: string | null;
  asTyped: unknown;
  asWords: unknown;
  exact: unknown;
}): { total: number; apps: Listing[] } {
  const exact = input.exact && typeof input.exact === "object" ? (input.exact as Listing) : null;
  const exactShown = exact
    && exact.slug === input.slug
    && exact.hidden !== true
    && (!input.category || exact.category === input.category);
  const seen = new Set<string>();
  const apps: Listing[] = [];
  for (const app of [...(exactShown ? [exact] : []), ...listingsOf(input.asTyped), ...listingsOf(input.asWords)]) {
    const key = typeof app.slug === "string" ? app.slug : null;
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    apps.push(app);
    if (apps.length >= input.limit) break;
  }
  const reported = Number((input.asTyped as { total?: unknown } | null)?.total);
  return { total: Math.max(Number.isFinite(reported) ? reported : 0, apps.length), apps };
}
