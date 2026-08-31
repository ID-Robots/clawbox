import { NextResponse } from "next/server";
import { openclawAppsGuard } from "@/lib/openclaw-apps-server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR, getAll as configGetAll } from "@/lib/config-store";
import { getSkillsDir, findOpenclawBin } from "@/lib/openclaw-config";
import { CATEGORY_COLORS, DEFAULT_CATEGORY_COLOR, type InstalledMeta } from "@/lib/store-categories";
import { boundPreferenceText } from "@/lib/preference-schema";
import { setPreferences } from "@/lib/preference-store";
import { isClawhubHandle, lookupClawhubOwner, pickClawhubMatch } from "@/lib/clawhub-url";
import { refreshSkillsCache } from "@/lib/openclaw-skill-info";

const STORE_API = "https://clawbox.com/api/store/apps";
const STORE_ICONS_BASE = "https://clawbox.com/store/icons";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const ICONS_DIR = path.join(DATA_DIR, "icons");

// Worst-case backoff ≈26s — rides out ClawHub's typical 10–20s rate-limit window.
const RATE_LIMIT_BACKOFF_MS = [3_000, 8_000, 15_000];

type InstallFailureCode =
  | "rate_limited" | "timeout" | "offline" | "not_found" | "blocked" | "review_required" | "upstream" | "failed";

type ClawhubResult = {
  success: boolean;
  output?: string;
  error?: string;
  code?: InstallFailureCode;
  /** False when another attempt with the same request cannot succeed (the Store hides Retry on it). */
  retryable?: boolean;
  rateLimited?: boolean;
};

// Same-app concurrent calls share one subprocess so we don't double the rate-limit budget.
const inFlightInstalls = new Map<string, Promise<ClawhubResult>>();

// The id everything local is keyed by — the skill folder, the icon file, the
// preference entries, the desktop's `installed-<id>` — is the bare slug, and
// that is where the CLI puts an `@owner/slug` install too. Reject a leading
// hyphen: the ref is passed positionally to `openclaw skills install`, so
// "-x"/"--force" would be parsed as a CLI flag rather than a package name (the
// `@` of a namespaced ref keeps that guard for free).
const SLUG = /^(?!-)[A-Za-z0-9_-]+$/;
const REF = /^@([A-Za-z0-9][A-Za-z0-9._-]{0,39})\/([A-Za-z0-9_-]+)$/;

/**
 * `{ appId, owner? }` where appId is a bare slug or a `@owner/slug` ref (what
 * ClawHub's ambiguity answer lists, and what app_search may hand the agent).
 * The owner is only ever the CLI argument; `appId` in the answer is the slug.
 */
function parseInstallRequest(body: unknown): { appId: string; owner?: string } | { error: string } {
  const { appId, owner } = (body && typeof body === "object" ? body : {}) as { appId?: unknown; owner?: unknown };
  if (typeof appId !== "string") return { error: "Invalid appId" };
  let slug = appId;
  let refOwner: string | undefined;
  const ref = REF.exec(appId);
  if (ref) [, refOwner, slug] = ref;
  if (!SLUG.test(slug)) return { error: "Invalid appId" };
  if (owner !== undefined && !isClawhubHandle(owner)) return { error: "Invalid owner" };
  if (owner && refOwner && owner.toLowerCase() !== refOwner.toLowerCase()) return { error: "owner does not match appId" };
  return { appId: slug, owner: owner || refOwner };
}

function titleCaseFromSlug(slug: string): string {
  // Split on `-` and `_` since the appId validator accepts either. All-
  // separator inputs (e.g. "---") would otherwise return "" and the desktop
  // would render a blank label; fall back to the raw slug in that case.
  const parts = slug.split(/[-_]+/).filter(Boolean);
  if (parts.length === 0) return slug;
  return parts.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

interface StoreDetail { slug?: string; name?: string; category?: string; developer?: string }

// The store's own detail record: name and category for the desktop entry, and
// `developer`, which names the right publisher when ClawHub lists several.
// Started alongside the ClawHub lookup so the install pays one round trip.
async function fetchStoreDetail(appId: string): Promise<StoreDetail | null> {
  try {
    const res = await fetch(`${STORE_API}/${encodeURIComponent(appId)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const detail = await res.json() as StoreDetail;
    return detail && detail.slug === appId ? detail : null;
  } catch (err) {
    console.warn(`[apps/install] Store metadata lookup failed for ${appId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function storeMeta(appId: string, detail: StoreDetail | null): InstalledMeta {
  // Use the remote Store icon URL as the fallback iconUrl so the client's
  // <InstalledAppIcon> has a second source when the local icon download
  // in the POST handler failed. Matches what AppStore.tsx's apiToStoreApp
  // stores for UI-initiated installs, so both paths produce identical meta.
  const remoteIconUrl = `${STORE_ICONS_BASE}/${appId}.png`;
  // The name ends up in a stored preference, so bound it to what one may hold.
  const fallbackName = boundPreferenceText(titleCaseFromSlug(appId), appId);
  if (!detail) return { name: fallbackName, color: DEFAULT_CATEGORY_COLOR, iconUrl: remoteIconUrl };
  // hasOwnProperty.call so a malicious `category: "__proto__"` from the
  // remote Store doesn't resolve to an inherited property.
  const category = detail.category;
  const color = typeof category === "string"
    && Object.prototype.hasOwnProperty.call(CATEGORY_COLORS, category)
    ? CATEGORY_COLORS[category]
    : DEFAULT_CATEGORY_COLOR;
  const meta: InstalledMeta = { name: boundPreferenceText(detail.name, fallbackName), color, iconUrl: remoteIconUrl };
  // What a UI-initiated install records too, so an MCP/CLI install gets the
  // same "View on ClawHub" link.
  const developer = boundPreferenceText(detail.developer, "");
  if (developer) meta.developer = developer;
  return meta;
}

async function downloadIcon(appId: string): Promise<{ saved: boolean }> {
  const iconUrl = `${STORE_ICONS_BASE}/${appId}.png`;
  const iconPath = path.join(ICONS_DIR, `${appId}.png`);
  try {
    // Bound the icon fetch: it's awaited inline before the install returns, so
    // a stalled ClawHub host would otherwise hang the whole install request.
    const [res] = await Promise.all([
      fetch(iconUrl, { signal: AbortSignal.timeout(10_000) }),
      fs.mkdir(ICONS_DIR, { recursive: true }),
    ]);
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
// the openclaw binary, which leaks local layout and is incomprehensible. The
// CLI's stable shape is `ClawHub <path> failed (<status>): <body>`, so the
// ClawHub rows key on the status number. The two trust rows are the CLI's
// own gate: a `blocked` release is refused outright, and a `review-required`
// one is refused without a TTY to confirm on — which is why the route does
// NOT pass --acknowledge-clawhub-risk: that would install a release the owner
// never saw the warning for.
const FAILURES: Array<{
  pattern: RegExp;
  code: InstallFailureCode;
  status: number;
  retryable: boolean;
  message: (ref: string) => string;
}> = [
  { pattern: /\b429\b|rate ?limit/i, code: "rate_limited", status: 429, retryable: true,
    message: () => "ClawHub is rate-limiting installs. Please wait a moment and try again." },
  { pattern: /failed \(404\)|Skill not found/i, code: "not_found", status: 404, retryable: false,
    message: (ref) => `ClawHub has no skill named "${ref}".` },
  { pattern: /blocked this release|DOWNLOAD_BLOCKED/i, code: "blocked", status: 422, retryable: false,
    message: () => "ClawHub has blocked this release, so it cannot be installed." },
  { pattern: /Install cancelled|acknowledge-clawhub-risk|RISK_ACKNOWLEDGEMENT/i, code: "review_required", status: 422, retryable: false,
    message: (ref) => `ClawHub flagged this release for review. Read its warning and, if you accept it, install from the Terminal: openclaw skills install ${ref} --acknowledge-clawhub-risk` },
  { pattern: /failed \(5\d\d\)/, code: "upstream", status: 502, retryable: true,
    message: () => "ClawHub is having trouble right now. Try again in a few minutes." },
  { pattern: /timeout|ETIMEDOUT|timed out/i, code: "timeout", status: 504, retryable: true,
    message: () => "Install timed out. Check your connection and try again." },
  { pattern: /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo/i, code: "offline", status: 502, retryable: true,
    message: () => "Could not reach ClawHub. Check your internet connection." },
];
const UNKNOWN_FAILURE = { code: "failed" as const, status: 502, retryable: true, message: () => "Install failed. Please try again." };

/**
 * Request-derived text on its way into a log line: JSON-quoted so every
 * newline and control character is escaped (the one sanitizer CodeQL models
 * for js/log-injection), bounded so a CLI dump cannot flood the journal, and
 * never handed to console.* as a format string (js/tainted-format-string).
 * The ref is validated upstream; the sink carries its own guard.
 */
function logSafe(value: string): string {
  return JSON.stringify(value.slice(0, 200));
}

function classifyInstallError(rawMsg: string, killed: boolean) {
  if (killed) return FAILURES.find((f) => f.code === "timeout") ?? UNKNOWN_FAILURE;
  return FAILURES.find((f) => f.pattern.test(rawMsg)) ?? UNKNOWN_FAILURE;
}

function httpStatusForInstallFailure(code: InstallFailureCode | undefined): number {
  return FAILURES.find((f) => f.code === code)?.status ?? UNKNOWN_FAILURE.status;
}

async function runOpenclawInstall(openclawBin: string, ref: string): Promise<ClawhubResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout, stderr } = await execFileAsync(openclawBin, [
        "skills", "install", ref,
        "--force",
      ], {
        timeout: 60_000,
        env: { ...process.env, PATH: `${path.dirname(openclawBin)}:${process.env.PATH}` },
      });
      return { success: true, output: stdout || stderr };
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      // execFile's timeout kills the child with SIGTERM and says nothing about
      // a timeout in the message.
      const killed = !!(err as { killed?: boolean })?.killed;
      const failure = classifyInstallError(rawMsg, killed);
      if (failure.code === "rate_limited" && attempt < RATE_LIMIT_BACKOFF_MS.length) {
        const delay = RATE_LIMIT_BACKOFF_MS[attempt];
        console.warn("[apps/install] ClawHub 429 on %s (attempt %d); backing off %dms", logSafe(ref), attempt + 1, delay);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      console.warn("[apps/install] openclaw skills install %s failed: %s", logSafe(ref), logSafe(rawMsg));
      return {
        success: false,
        error: failure.message(ref),
        code: failure.code,
        retryable: failure.retryable,
        rateLimited: failure.code === "rate_limited",
      };
    }
  }
}

async function installSkill(openclawBin: string, appId: string, ref: string): Promise<ClawhubResult> {
  // Reuse the existing in-flight subprocess if one is already running for
  // this appId — see comment on `inFlightInstalls`.
  const existing = inFlightInstalls.get(appId);
  if (existing) return existing;
  const promise = runOpenclawInstall(openclawBin, ref);
  inFlightInstalls.set(appId, promise);
  try {
    return await promise;
  } finally {
    inFlightInstalls.delete(appId);
  }
}

// Sticky-fallback caveat: if the first install happened while the Store was
// unreachable, `storeMeta` wrote the title-cased fallback and re-installs
// won't refresh it — uninstall+reinstall to recover. Accepted because hitting
// the Store API on every install retry is worse. The install and uninstall
// routes are the only writers of these two keys; the desktop reads them.
async function syncInstalledPreferences(appId: string, detail: Promise<StoreDetail | null>): Promise<string | undefined> {
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
      nextUpdates["pref:installed_meta"] = { ...metaMap, [appId]: storeMeta(appId, await detail) };
    }
    if (!alreadyListed) {
      nextUpdates["pref:installed_apps"] = [...list, appId];
    }
    // setPreferences applies the preference rules — this does not go through
    // POST /setup-api/preferences, and the update carries over every entry read
    // above alongside the one being added.
    await setPreferences(nextUpdates);
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[apps/install] Failed to update installed_apps/meta preferences:", msg);
    return msg;
  }
}

export async function POST(req: Request) {
  // The App Store is OpenClaw-only; refuse on a Hermes device (the UI hides
  // it, this makes HTTP agree). See src/lib/openclaw-apps-server.ts.
  const blocked = await openclawAppsGuard();
  if (blocked) return blocked;

  try {
    const parsed = parseInstallRequest(await req.json());
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { appId } = parsed;
    let owner = parsed.owner;

    const openclawBin = findOpenclawBin();
    const skillsDir = getSkillsDir();
    const storeDetail = fetchStoreDetail(appId);
    await fs.mkdir(path.join(skillsDir, "skills"), { recursive: true });

    // `openclaw skills install` takes `@owner/slug`; handed a bare slug it asks
    // ClawHub the same question and fails with "Skill not found" for every slug
    // more than one publisher uses — all of the Store's "Top rated" first
    // screen. So the publisher is resolved here first. Nothing installs on a
    // guess: an ambiguous slug is settled only by the store listing's own
    // developer, otherwise the candidates go back for the owner to choose.
    if (!owner) {
      const lookup = await lookupClawhubOwner(appId);
      if (lookup.status === "found") {
        owner = lookup.ownerHandle;
      } else if (lookup.status === "not_found") {
        return NextResponse.json(
          { ok: false, error: `ClawHub has no skill named "${appId}".`, code: "not_found", appId },
          { status: 404 },
        );
      } else if (lookup.status === "ambiguous") {
        const picked = pickClawhubMatch(lookup.matches, (await storeDetail)?.developer);
        if (picked) {
          owner = picked.ownerHandle;
        } else {
          return NextResponse.json({
            ok: false,
            error: `"${appId}" is published by ${lookup.matches.length} people on ClawHub. Choose one and install it by its full name.`,
            code: "ambiguous",
            appId,
            matches: lookup.matches,
          }, { status: 409 });
        }
      }
      // `unavailable`: the CLI asks ClawHub itself, and its answer is mapped
      // honestly below — a unique slug still installs through a lookup blip.
    }

    const ref = owner ? `@${owner}/${appId}` : appId;
    const clawhubResult = await installSkill(openclawBin, appId, ref);
    if (!clawhubResult.success) {
      // Non-2xx so a caller that only reads the status (the MCP tools, curl)
      // is not told an install happened; the body keeps the `clawhub` shape
      // the Store reads its message from.
      return NextResponse.json(
        { ok: false, error: clawhubResult.error, code: clawhubResult.code, retryable: clawhubResult.retryable, appId, ref, clawhub: clawhubResult },
        { status: httpStatusForInstallFailure(clawhubResult.code) },
      );
    }

    // The icon is fetched only now: data/icons holds installed apps' icons,
    // and a failed install used to leave one behind. No gateway bounce here on
    // purpose: the skill landed under `<workspace>/skills`, which OpenClaw
    // watches itself, so the running gateway picks it up without being
    // signalled. See openclaw-config.ts.
    const [iconResult, preferenceSyncError] = await Promise.all([
      downloadIcon(appId),
      syncInstalledPreferences(appId, storeDetail),
    ]);
    const iconSaved = iconResult.saved;
    // The installed-app window's skill-info rescans behind this reply, so the
    // window opened right after the install finds the skill already listed.
    refreshSkillsCache();

    // `ok: false` lets MCP/CLI callers detect the case where install+icon
    // succeeded on disk but the desktop won't see it because pref sync failed.
    return NextResponse.json({
      ok: !preferenceSyncError,
      appId,
      ref,
      iconSaved,
      iconPath: iconSaved ? `/setup-api/apps/icon/${appId}` : null,
      clawhub: clawhubResult,
      preferenceSyncError,
    });
  } catch (err) {
    console.error("[apps/install] Install failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Install failed" }, { status: 500 });
  }
}
