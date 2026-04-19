import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR, CONFIG_ROOT, getAll as configGetAll, setMany as configSetMany } from "@/lib/config-store";
import { reloadGateway, getSkillsDir, findOpenclawBin } from "@/lib/openclaw-config";
import { CATEGORY_COLORS, DEFAULT_CATEGORY_COLOR, type InstalledMeta } from "@/lib/store-categories";

const STORE_SEARCH_API = "https://openclawhardware.dev/api/store/apps";

const STORE_ICONS_BASE = "https://openclawhardware.dev/store/icons";

function titleCaseFromSlug(slug: string): string {
  // Split on `-` and `_` since the appId validator accepts either. All-
  // separator inputs (e.g. "---") would otherwise return "" and the desktop
  // would render a blank label; fall back to the raw slug in that case.
  const parts = slug.split(/[-_]+/).filter(Boolean);
  if (parts.length === 0) return slug;
  return parts.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

async function lookupStoreMeta(appId: string): Promise<InstalledMeta> {
  // Use the remote Store icon URL as the fallback iconUrl so the client's
  // <InstalledAppIcon> has a second source when the local icon download
  // in the POST handler failed. Matches what AppStore.tsx's apiToStoreApp
  // stores for UI-initiated installs, so both paths produce identical meta.
  const remoteIconUrl = `${STORE_ICONS_BASE}/${appId}.png`;
  const fallback: InstalledMeta = {
    name: titleCaseFromSlug(appId),
    color: DEFAULT_CATEGORY_COLOR,
    iconUrl: remoteIconUrl,
  };
  try {
    const q = appId.replace(/-/g, " ");
    const res = await fetch(`${STORE_SEARCH_API}?q=${encodeURIComponent(q)}&limit=50`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return fallback;
    const data = await res.json() as { apps?: Array<{ slug?: string; name?: string; category?: string }> };
    const match = (data.apps ?? []).find((a) => a.slug === appId);
    if (!match) return fallback;
    // hasOwnProperty.call so a malicious `category: "__proto__"` from the
    // remote Store doesn't resolve to an inherited property.
    const category = match.category;
    const color = typeof category === "string"
      && Object.prototype.hasOwnProperty.call(CATEGORY_COLORS, category)
      ? CATEGORY_COLORS[category]
      : DEFAULT_CATEGORY_COLOR;
    return {
      name: match.name ?? fallback.name,
      color,
      iconUrl: remoteIconUrl,
    };
  } catch (err) {
    console.warn(`[apps/install] Store metadata lookup failed for ${appId}:`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const ICONS_DIR = path.join(DATA_DIR, "icons");


export async function POST(req: Request) {
  try {
    const { appId } = await req.json();
    if (!appId || typeof appId !== "string" || !/^[A-Za-z0-9_-]+$/.test(appId)) {
      return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
    }

    // Ensure icons directory exists
    await fs.mkdir(ICONS_DIR, { recursive: true });

    // Download icon from store
    const iconUrl = `${STORE_ICONS_BASE}/${appId}.png`;
    const iconPath = path.join(ICONS_DIR, `${appId}.png`);
    let iconSaved = false;

    try {
      const res = await fetch(iconUrl);
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        await fs.writeFile(iconPath, buffer);
        iconSaved = true;
      }
    } catch (err) {
      console.warn(`[apps/install] Failed to download icon for ${appId}:`, err);
    }

    // Run openclaw skills install
    const openclawBin = findOpenclawBin();
    const skillsDir = getSkillsDir();
    await fs.mkdir(path.join(skillsDir, "skills"), { recursive: true });

    let clawhubResult: { success: boolean; output?: string; error?: string } = { success: false };
    try {
      const { stdout, stderr } = await execFileAsync(openclawBin, [
        "skills", "install", appId,
        "--force",
      ], {
        timeout: 60_000,
        env: { ...process.env, PATH: `${path.dirname(openclawBin)}:${process.env.PATH}` },
      });
      clawhubResult = { success: true, output: stdout || stderr };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[apps/install] openclaw skills install ${appId} failed:`, msg);
      clawhubResult = { success: false, error: msg };
    }

    // Reload the OpenClaw gateway so it picks up the new skill
    let reloadError: string | undefined;
    let preferenceSyncError: string | undefined;
    if (clawhubResult.success) {
      // Keep the desktop's `installed_apps` and `installed_meta` preferences
      // in sync. Without this, installs through MCP / CLI land on disk but
      // are invisible on the desktop — the UI filters out apps that have no
      // meta (see page.tsx), and it only refreshes on page mount.
      try {
        const all = await configGetAll();
        const list = Array.isArray(all["pref:installed_apps"]) ? (all["pref:installed_apps"] as string[]) : [];
        const metaMap = (all["pref:installed_meta"] && typeof all["pref:installed_meta"] === "object"
          ? all["pref:installed_meta"]
          : {}) as Record<string, InstalledMeta>;

        const alreadyListed = list.includes(appId);
        const hasMeta = !!metaMap[appId];
        const nextUpdates: Record<string, unknown> = {};

        // Only fetch Store metadata when we don't already have it. Preserves
        // any previously-written (possibly richer) meta — including handling
        // the partial-state case where the list entry is missing but the
        // meta entry still exists.
        //
        // Sticky-fallback caveat: if the very first install happened while
        // the Store was unreachable, `lookupStoreMeta` wrote the title-cased
        // fallback and subsequent re-installs won't refresh it. The user
        // gets the real name/color back by uninstalling + reinstalling.
        // Accepted because thrashing the Store API on every retry is worse.
        if (!hasMeta) {
          const storeMeta = await lookupStoreMeta(appId);
          nextUpdates["pref:installed_meta"] = { ...metaMap, [appId]: storeMeta };
        }
        if (!alreadyListed) {
          nextUpdates["pref:installed_apps"] = [...list, appId];
        }
        if (Object.keys(nextUpdates).length > 0) {
          await configSetMany(nextUpdates);
        }
      } catch (err) {
        preferenceSyncError = err instanceof Error ? err.message : String(err);
        console.warn("[apps/install] Failed to update installed_apps/meta preferences:", preferenceSyncError);
      }

      try {
        await reloadGateway();
      } catch (err) {
        reloadError = err instanceof Error ? err.message : "Gateway reload failed";
        console.warn("[apps/install] Gateway reload failed after successful install:", reloadError);
      }
    }

    // `ok` flips to false when preference sync failed so MCP/CLI callers
    // can detect it — install+icon succeeded on disk but the desktop
    // won't see the new skill without the prefs being written.
    return NextResponse.json({
      ok: !preferenceSyncError,
      appId,
      iconSaved,
      iconPath: iconSaved ? `/setup-api/apps/icon/${appId}` : null,
      clawhub: clawhubResult,
      reloadError,
      preferenceSyncError,
    });
  } catch (err) {
    console.error("[apps/install] Install failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Install failed" }, { status: 500 });
  }
}
