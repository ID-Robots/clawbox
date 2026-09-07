/**
 * The ONE preference read a page may make before a session exists.
 *
 * /login renders inside the same I18nProvider as the desktop, which asks for
 * the box's UI language on mount so the page can greet the owner in it;
 * answered 401, it fell back to the browser's language, and a box set to
 * German greeted its owner in English (UI sweep 2026-09-07, shell-5).
 *
 * Three places have to agree on what that request IS — the provider that
 * sends it (src/lib/i18n.tsx), the middleware that admits it with no session
 * (src/middleware.ts, an exact match on the raw path and query, never a
 * prefix) and the route that answers it (src/app/setup-api/preferences/route.ts,
 * which tells a caller with no session nothing but these keys). Each used to
 * spell it as a literal of its own, so a key added to the provider's fetch
 * alone would have put /login back on the browser's language with every
 * gate's own test still green. They all build from this object now: widen
 * `keys` and every one of them widens with it — a change to make
 * deliberately, in one place, and never by accident in one of the three.
 *
 * A plain object with no imports, because a client component, the middleware
 * and a route handler all read it.
 */
const PATHNAME = "/setup-api/preferences";

/** The keys an anonymous caller may name — the box's UI language, nothing else. */
const KEYS = ["ui_language"] as const;

const SEARCH = `?keys=${KEYS.join(",")}`;

export const UI_LANGUAGE_READ = {
  pathname: PATHNAME,
  keys: KEYS,
  /** The query string, byte for byte: what the provider sends and the middleware matches. */
  search: SEARCH,
  /** What the provider fetches. */
  url: `${PATHNAME}${SEARCH}`,
} as const;
