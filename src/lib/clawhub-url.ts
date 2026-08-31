/**
 * Canonical ClawHub page for a store listing, and the lookup that names the
 * publisher it is under.
 *
 * ClawHub namespaces every skill under its publisher: the real page for
 * `security-audit-toolkit` by `gitgoodordietrying` is
 *
 *   https://clawhub.ai/gitgoodordietrying/skills/security-audit-toolkit
 *
 * We build that ourselves rather than trusting the store API, because the
 * `clawhubUrl` the detail endpoint returns drops the publisher segment
 * (`https://clawhub.ai/skills/<slug>`) and the desktop was also pasting the
 * raw app id into a `https://clawhub.ai/skills/${appId}` template — which
 * doubles the segment to `/skills/skills/<slug>` for any id that already
 * carries a namespace. clawhub.ai is a client-routed SPA, so every one of
 * those wrong shapes answers 200 and then renders nothing useful.
 *
 * Returns undefined when the publisher is unknown or unusable; callers fall
 * back to whatever link the API gave them rather than shipping a URL that
 * 404s in the browser.
 */

/**
 * A ClawHub publisher handle, as it appears in a URL path.
 *
 * The store's `developer` field is NOT reliably a handle. It carries a real
 * one for a minority of listings (`anotb`, `gitgoodordietrying`, `maxsumrall`)
 * and the DISPLAY NAME "ClawHub Community" for the rest — 162 of the first 200
 * apps, so this is the common case, not an edge one. Percent-encoding a display
 * name produces `/ClawHub%20Community/skills/<slug>`, which ClawHub answers with
 * "We couldn't find that page."
 *
 * And a handle-shaped `developer` is not always the publisher either:
 * `weather-forecast` is listed under "weatherpro" while ClawHub's owner is
 * `alex098929`. So the field is only usable when it is shaped like a path
 * segment, and the store proxy asks ClawHub for the real handle
 * ({@link lookupClawhubOwner}) so the desktop can prefer that.
 */
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** ClawHub's own handle rule (1–40 chars, no leading or trailing punctuation). Handles are case-insensitive there. */
const CLAWHUB_HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}[A-Za-z0-9])?$/;

export function isClawhubHandle(value: unknown): value is string {
  return typeof value === "string" && CLAWHUB_HANDLE.test(value);
}

export function clawhubSkillUrl(
  appId: string,
  developer: string | undefined,
): string | undefined {
  if (!developer || !HANDLE.test(developer)) return undefined;
  // Installed ids can arrive namespaced (`skills/foo`, `clawhub/foo`); the
  // slug ClawHub knows is the last segment.
  const slug = appId.split("/").filter(Boolean).pop();
  if (!slug) return undefined;
  return `https://clawhub.ai/${developer}/skills/${encodeURIComponent(slug)}`;
}

// ── Publisher lookup ────────────────────────────────────────────────────────

const CLAWHUB_API = "https://clawhub.ai/api/v1/skills";

/** One publisher's skill under an ambiguous slug, as ClawHub's 409 lists them. */
export interface ClawhubMatch {
  ownerHandle: string;
  /** `@owner/slug` — what `openclaw skills install` takes. */
  ref: string;
  url: string;
}

export type ClawhubOwnerLookup =
  | { status: "found"; ownerHandle: string }
  | { status: "ambiguous"; matches: ClawhubMatch[] }
  | { status: "not_found" }
  | { status: "unavailable"; error: string };

/**
 * Ask ClawHub who publishes `slug`.
 *
 * `openclaw skills install` (2026.7 and later) takes `@owner/slug`; a bare
 * slug is resolved through this same endpoint and fails for every slug more
 * than one publisher uses — which is all of the Store's "Top rated" first
 * screen. GET /api/v1/skills/<slug> answers 200 with the one owner, 409
 * AMBIGUOUS_SKILL_SLUG with the candidates, or a bare 404. Never throws: a
 * network failure is `unavailable`, so a caller can decide whether to go on
 * without an owner.
 */
export async function lookupClawhubOwner(
  slug: string,
  opts: { timeoutMs?: number } = {},
): Promise<ClawhubOwnerLookup> {
  try {
    const res = await fetch(`${CLAWHUB_API}/${encodeURIComponent(slug)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 6_000),
    });
    if (res.status === 404) return { status: "not_found" };
    if (res.status === 409) {
      const body = await res.json().catch(() => null) as { matches?: unknown[] } | null;
      const matches = (body?.matches ?? []).flatMap((m) => {
        const match = m as Partial<ClawhubMatch> | null;
        if (!match || !isClawhubHandle(match.ownerHandle)) return [];
        return [{
          ownerHandle: match.ownerHandle,
          ref: typeof match.ref === "string" ? match.ref : `@${match.ownerHandle}/${slug}`,
          url: typeof match.url === "string" ? match.url : `https://clawhub.ai/${match.ownerHandle}/skills/${slug}`,
        }];
      });
      return matches.length > 0
        ? { status: "ambiguous", matches }
        : { status: "unavailable", error: "ClawHub listed no publishers" };
    }
    if (!res.ok) return { status: "unavailable", error: `ClawHub answered ${res.status}` };
    const body = await res.json() as { owner?: { handle?: unknown } };
    const handle = body.owner?.handle;
    return isClawhubHandle(handle)
      ? { status: "found", ownerHandle: handle }
      : { status: "unavailable", error: "ClawHub named no publisher" };
  } catch (err) {
    return { status: "unavailable", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The one candidate the store's `developer` field names, if it names exactly
 * one. Handles are case-insensitive on ClawHub. Never the first match by
 * default: an ambiguous slug's candidates are different publishers' skills,
 * and the store listing was for one of them.
 */
export function pickClawhubMatch(
  matches: ClawhubMatch[],
  developer: string | undefined,
): ClawhubMatch | undefined {
  if (!developer) return undefined;
  const wanted = developer.toLowerCase();
  const hits = matches.filter((m) => m.ownerHandle.toLowerCase() === wanted);
  return hits.length === 1 ? hits[0] : undefined;
}
