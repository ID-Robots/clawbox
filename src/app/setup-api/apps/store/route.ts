import { NextResponse } from "next/server";
import { openclawAppsGuard } from "@/lib/openclaw-apps-server";
import { clawhubSkillUrl, lookupClawhubOwner, pickClawhubMatch } from "@/lib/clawhub-url";
import { isClawboxListing } from "@/lib/store-categories";
import { mergeSlugSearch, slugSearch, type SlugSearch } from "@/lib/store-search";

export const dynamic = "force-dynamic";

const STORE_API = "https://clawbox.com/api/store/apps";
// Upstream caps any response at 200; reject anything outside [1, 200] rather
// than forwarding arbitrary/malformed values to ClawHub.
const MAX_LIMIT = 200;

// Thin authenticated proxy to ClawHub so the desktop never talks to it directly.
async function proxy(target: string, failMsg: string) {
  try {
    const res = await fetch(target, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Store API error" }, { status: res.status });
    }
    return NextResponse.json(await res.json(), { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (err) {
    console.error("[apps/store] proxy failed:", err);
    return NextResponse.json({ error: failMsg }, { status: 502 });
  }
}

// A slug-shaped search ("audiobook-player"), asked as typed, as words and as
// an exact slug, merged (src/lib/store-search.ts): the portal matches words,
// so the app's own id found nothing. The query as typed decides success the
// way `proxy` does; the other two are best-effort and never fail the search.
async function slugAwareSearch(params: URLSearchParams, search: SlugSearch, limit: number, category: string | null) {
  const optional = async (target: string): Promise<unknown> => {
    try {
      const res = await fetch(target, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(8000) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  const asWordsParams = new URLSearchParams(params);
  asWordsParams.set("q", search.words);
  const [asWords, exact] = [optional(`${STORE_API}?${asWordsParams}`), optional(`${STORE_API}/${search.slug}`)];
  try {
    const res = await fetch(`${STORE_API}?${params}`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Store API error" }, { status: res.status });
    }
    const asTyped = await res.json() as Record<string, unknown>;
    const merged = mergeSlugSearch({ slug: search.slug, limit, category, asTyped, asWords: await asWords, exact: await exact });
    return NextResponse.json({ ...asTyped, ...merged }, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (err) {
    console.error("[apps/store] proxy failed:", err);
    return NextResponse.json({ error: "Failed to fetch store" }, { status: 502 });
  }
}

// Per-skill detail (richer metadata the list omits: featured, updatedAt,
// installsAllTime, executesCode), plus the publisher ClawHub itself names.
// The store's `developer` is a display label — "ClawHub Community" for most
// listings, and a placeholder like "weatherpro" for some whose real owner is
// someone else — and its `clawhubUrl` lacks the publisher segment, so neither
// can build the skill's real page. The ClawHub call is best-effort with its
// own short timeout: it never fails the detail, and an unanswered one leaves
// `ownerHandle` null and `clawhubUrl` absent rather than wrong.
//
// Adds to the store's record:
//   ownerHandle     the publisher, or null when ClawHub could not name one
//   clawhubUrl      rewritten to the real page when resolved, removed otherwise
//   clawhubMatches  on an ambiguous slug, every publisher's { ownerHandle, ref, url }
async function detail(slug: string) {
  const lookup = lookupClawhubOwner(slug, { timeoutMs: 4_000 });
  try {
    const res = await fetch(`${STORE_API}/${slug}`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Store API error" }, { status: res.status });
    }
    const app = await res.json() as Record<string, unknown>;
    // A ClawBox app (`source: "clawbox"`, published from a box) has no ClawHub
    // page and no ClawHub publisher: its record is the Store's alone.
    if (isClawboxListing(app)) {
      void lookup.catch(() => undefined);
      return NextResponse.json(app, { headers: { "Cache-Control": "public, max-age=300" } });
    }
    const owner = await lookup;
    let ownerHandle: string | null = null;
    if (owner.status === "found") {
      ownerHandle = owner.ownerHandle;
    } else if (owner.status === "ambiguous") {
      const developer = typeof app.developer === "string" ? app.developer : undefined;
      ownerHandle = pickClawhubMatch(owner.matches, developer)?.ownerHandle ?? null;
      app.clawhubMatches = owner.matches;
    }
    app.ownerHandle = ownerHandle;
    const url = ownerHandle ? clawhubSkillUrl(slug, ownerHandle) : undefined;
    if (url) app.clawhubUrl = url;
    else delete app.clawhubUrl;
    return NextResponse.json(app, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (err) {
    console.error("[apps/store] proxy failed:", err);
    return NextResponse.json({ error: "Failed to fetch app" }, { status: 502 });
  }
}

export async function GET(req: Request) {
  // The App Store is OpenClaw-only; refuse on a Hermes device (the UI hides
  // it, this makes HTTP agree). See src/lib/openclaw-apps-server.ts.
  const blocked = await openclawAppsGuard();
  if (blocked) return blocked;

  const url = new URL(req.url);

  const slug = url.searchParams.get("slug");
  if (slug) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) {
      return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
    }
    return detail(slug);
  }

  const params = new URLSearchParams();
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return NextResponse.json({ error: "Invalid limit" }, { status: 400 });
  }
  params.set("limit", String(limit));
  const category = url.searchParams.get("category");
  if (category) params.set("category", category);
  const q = url.searchParams.get("q");
  if (q) params.set("q", q);

  const search = q ? slugSearch(q) : null;
  if (search) return slugAwareSearch(params, search, limit, category);
  return proxy(`${STORE_API}?${params}`, "Failed to fetch store");
}
