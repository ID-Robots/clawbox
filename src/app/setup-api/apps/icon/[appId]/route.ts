import { NextResponse } from "next/server";
import fs from "fs/promises";
import { getAll as configGetAll } from "@/lib/config-store";
import { ICONS_DIR, safeAppId, webappIconPath } from "@/lib/webapp-icon";

export const dynamic = "force-dynamic";

const STORE_ICONS_BASE = "https://clawbox.com/store/icons";

// Ids the store has no icon for, remembered so a card re-render does not cost
// another outbound request. Most of the catalogue past the first screens has
// no icon, and one Store session used to make ~850 such fetches at ~0.3 s
// each. Only a genuine upstream 404 lands here — a timeout or 5xx is retried
// next time — and the local-file check above it always runs first, so an icon
// that arrives on disk meanwhile (an install, a generated web-app icon) is
// found regardless.
const MISSING_UPSTREAM_TTL_MS = 60 * 60_000;
const MISSING_UPSTREAM_MAX = 2_000;
const missingUpstream = new Map<string, number>();

function rememberMissing(appId: string): void {
  if (missingUpstream.size >= MISSING_UPSTREAM_MAX) {
    const oldest = missingUpstream.keys().next().value;
    if (oldest !== undefined) missingUpstream.delete(oldest);
  }
  missingUpstream.set(appId, Date.now() + MISSING_UPSTREAM_TTL_MS);
}

function knownMissing(appId: string): boolean {
  const until = missingUpstream.get(appId);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  missingUpstream.delete(appId);
  return false;
}

// Short enough that an icon added later is not hidden for long, long enough
// that switching a category and back does not re-request every missing one.
const MISSING_HEADERS = { "Cache-Control": "public, max-age=600" };

async function isInstalled(appId: string): Promise<boolean> {
  try {
    const list = (await configGetAll())["pref:installed_apps"];
    return Array.isArray(list) && list.includes(appId);
  } catch {
    return false;
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ appId: string }> }
) {
  const { appId: requestedId } = await params;
  // The id is REBUILT from the alphabet (safeAppId, webapp-icon.ts) rather than
  // tested and passed through — the same rule as the whitelist it replaces, one
  // to sixty-four of `[A-Za-z0-9_-]`, applied so the value that reaches a path
  // is made of those characters instead of merely having matched them. A
  // `.test()` guard leaves the caller's string in play; the rebuild is the
  // discipline safeProjectId and safeSkillName already apply for the same
  // reason. It also puts this route on the one function that says where an
  // app's icon lives, rather than a second spelling of `<data>/icons/<id>.png`.
  const appId = safeAppId(requestedId);
  if (!appId) {
    return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
  }
  const iconPath = webappIconPath(appId);

  // Try local cached icon first. Served with `no-cache` plus an ETag rather
  // than `immutable`: the file under an id can CHANGE now — a web app's
  // generated icon (src/lib/webapp-icon.ts) is removed with the app, and a
  // different app can take the same id and get a different picture. Under
  // `immutable` a browser that had seen the first icon would show it for a
  // year without asking. `no-cache` costs one conditional request per icon
  // per desktop load, answered 304 from a stat when nothing changed.
  try {
    const stat = await fs.stat(iconPath);
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const cacheHeaders = { ETag: etag, "Cache-Control": "public, no-cache" };
    if (req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers: cacheHeaders });
    }
    const data = await fs.readFile(iconPath);
    return new NextResponse(data, {
      headers: { "Content-Type": "image/png", ...cacheHeaders },
    });
  } catch {
    // Not cached locally
  }

  if (knownMissing(appId)) {
    return NextResponse.json({ error: "Icon not found" }, { status: 404, headers: MISSING_HEADERS });
  }

  // Proxy from the remote store. The desktop cannot load clawbox.com itself
  // (CSP img-src, and the store proxy rule), so every card's icon comes
  // through here.
  try {
    const res = await fetch(`${STORE_ICONS_BASE}/${appId}.png`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());

      // data/icons holds INSTALLED apps' icons — the install route downloads
      // one, uninstall removes it, webapp-icon.ts generates one. Persisting
      // every browsed card's icon too left 62 MB behind after one Store
      // session, with nothing that ever pruned it. The write here is only the
      // repair for an install whose own download failed; a browsed icon is
      // served with `max-age` and left to the browser's cache.
      if (await isInstalled(appId)) {
        fs.mkdir(ICONS_DIR, { recursive: true })
          .then(() => fs.writeFile(iconPath, buffer))
          .catch(() => {});
      }

      return new NextResponse(buffer, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }
    if (res.status === 404) {
      rememberMissing(appId);
      return NextResponse.json({ error: "Icon not found" }, { status: 404, headers: MISSING_HEADERS });
    }
  } catch {
    // Remote failed
  }

  return NextResponse.json({ error: "Icon not found" }, { status: 404 });
}
