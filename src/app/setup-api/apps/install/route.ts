import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR, getAll as configGetAll, setMany as configSetMany } from "@/lib/config-store";
import { reloadGateway, getSkillsDir, findOpenclawBin } from "@/lib/openclaw-config";
import { CATEGORY_COLORS, DEFAULT_CATEGORY_COLOR, type InstalledMeta } from "@/lib/store-categories";

const STORE_SEARCH_API = "https://openclawhardware.dev/api/store/apps";
const STORE_ICONS_BASE = "https://openclawhardware.dev/store/icons";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const ICONS_DIR = path.join(DATA_DIR, "icons");

// Worst-case backoff ≈26s — rides out ClawHub's typical 10–20s rate-limit window.
const RATE_LIMIT_BACKOFF_MS = [3_000, 8_000, 15_000];

type ClawhubResult = { success: boolean; output?: string; error?: string; rateLimited?: boolean };

// Same-app concurrent calls share one subprocess so we don't double the rate-limit budget.
const inFlightInstalls = new Map<string, Promise<ClawhubResult>>();

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

async function downloadIcon(appId: string): Promise<{ saved: boolean }> {
  const iconUrl = `${STORE_ICONS_BASE}/${appId}.png`;
  const iconPath = path.join(ICONS_DIR, `${appId}.png`);
  try {
    const [res] = await Promise.all([fetch(iconUrl), fs.mkdir(ICONS_DIR, { recursive: true })]);
    if (!res.ok) return { saved: false };
    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(iconPath, buffer);
    return { saved: true };
  } catch (err) {
    console.warn(`[apps/install] Failed to download icon for ${appId}:`, err);
    return { saved: false };
  }
}

// Sanitize raw subprocess errors — the message embeds the absolute path of
// the openclaw binary, which leaks local layout and is incomprehensible.
const FRIENDLY_ERRORS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\b429\b|rate ?limit/i, message: "ClawHub is rate-limiting installs. Please wait a moment and try again." },
  { pattern: /timeout|ETIMEDOUT|timed out/i, message: "Install timed out. Check your connection and try again." },
  { pattern: /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo/i, message: "Could not reach ClawHub. Check your internet connection." },
];

function friendlyInstallError(rawMsg: string): string {
  for (const { pattern, message } of FRIENDLY_ERRORS) {
    if (pattern.test(rawMsg)) return message;
  }
  return "Install failed. Please try again.";
}

async function runOpenclawInstall(openclawBin: string, appId: string): Promise<ClawhubResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout, stderr } = await execFileAsync(openclawBin, [
        "skills", "install", appId,
        "--force",
      ], {
        timeout: 60_000,
        env: { ...process.env, PATH: `${path.dirname(openclawBin)}:${process.env.PATH}` },
      });
      return { success: true, output: stdout || stderr };
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const isRateLimited = FRIENDLY_ERRORS[0].pattern.test(rawMsg);
      if (isRateLimited && attempt < RATE_LIMIT_BACKOFF_MS.length) {
        const delay = RATE_LIMIT_BACKOFF_MS[attempt];
        console.warn(`[apps/install] ClawHub 429 on ${appId} (attempt ${attempt + 1}); backing off ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      console.warn(`[apps/install] openclaw skills install ${appId} failed:`, rawMsg);
      return { success: false, error: friendlyInstallError(rawMsg), rateLimited: isRateLimited };
    }
  }
}

async function installSkill(openclawBin: string, appId: string): Promise<ClawhubResult> {
  // Reuse the existing in-flight subprocess if one is already running for
  // this appId — see comment on `inFlightInstalls`.
  const existing = inFlightInstalls.get(appId);
  if (existing) return existing;
  const promise = runOpenclawInstall(openclawBin, appId);
  inFlightInstalls.set(appId, promise);
  try {
    return await promise;
  } finally {
    inFlightInstalls.delete(appId);
  }
}

// Sticky-fallback caveat: if the first install happened while the Store was
// unreachable, `lookupStoreMeta` wrote the title-cased fallback and re-installs
// won't refresh it — uninstall+reinstall to recover. Accepted because hitting
// the Store API on every install retry is worse.
async function syncInstalledPreferences(appId: string): Promise<string | undefined> {
  try {
    const all = await configGetAll();
    const list = Array.isArray(all["pref:installed_apps"]) ? (all["pref:installed_apps"] as string[]) : [];
    const metaMap = (all["pref:installed_meta"] && typeof all["pref:installed_meta"] === "object"
      ? all["pref:installed_meta"]
      : {}) as Record<string, InstalledMeta>;

    const alreadyListed = list.includes(appId);
    const hasMeta = !!metaMap[appId];
    const nextUpdates: Record<string, unknown> = {};

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
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[apps/install] Failed to update installed_apps/meta preferences:", msg);
    return msg;
  }
}

async function reloadGatewaySafely(): Promise<string | undefined> {
  try {
    await reloadGateway();
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Gateway reload failed";
    console.warn("[apps/install] Gateway reload failed after successful install:", msg);
    return msg;
  }
}

export async function POST(req: Request) {
  try {
    const { appId } = await req.json();
    if (!appId || typeof appId !== "string" || !/^[A-Za-z0-9_-]+$/.test(appId)) {
      return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
    }

    const openclawBin = findOpenclawBin();
    const skillsDir = getSkillsDir();
    // Icon fetch + skills-dir prep are independent of the openclaw subprocess.
    const [, iconResult] = await Promise.all([
      fs.mkdir(path.join(skillsDir, "skills"), { recursive: true }),
      downloadIcon(appId),
    ]);
    const iconSaved = iconResult.saved;

    const clawhubResult = await installSkill(openclawBin, appId);

    let reloadError: string | undefined;
    let preferenceSyncError: string | undefined;
    if (clawhubResult.success) {
      // Pref sync (config-store writes) and gateway reload (HTTP) are
      // independent — run them in parallel.
      [preferenceSyncError, reloadError] = await Promise.all([
        syncInstalledPreferences(appId),
        reloadGatewaySafely(),
      ]);
    }

    // `ok: false` lets MCP/CLI callers detect the case where install+icon
    // succeeded on disk but the desktop won't see it because pref sync failed.
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
