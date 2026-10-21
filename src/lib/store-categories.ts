// Shared between the AppStore UI (`src/components/AppStore.tsx`) and the
// server-side install route (`src/app/setup-api/apps/install/route.ts`), so a
// skill installed via MCP / CLI ends up with the same on-desktop colouring
// as one installed through the Store UI.

export const CATEGORY_COLORS: Record<string, string> = {
  "smart-home": "#3b82f6",
  "productivity": "#8b5cf6",
  "social-media": "#ec4899",
  "finance": "#22c55e",
  "developer": "#a78bfa",
  "security": "#ef4444",
  "health": "#10b981",
  "shopping": "#f97316",
  "entertainment": "#8b5cf6",
  "weather-travel": "#06b6d4",
  "writing": "#6366f1",
  "ai-automation": "#eab308",
  // Upstream category ids the categories list omits but listings carry — the
  // bulk of the catalogue ("ai" alone is thousands of apps); without an entry
  // their tiles all fall to the grey default.
  "ai": "#eab308",
  "weather": "#06b6d4",
  // Apps published from a ClawBox (src/lib/store-publish.ts).
  "clawbox-apps": "#f97316",
};

export const DEFAULT_CATEGORY_COLOR = "#6b7280";

// ── ClawBox Apps ─────────────────────────────────────────────────────────────
//
// The Store lists two things: ClawHub skills, installed through the OpenClaw
// CLI, and ClawBox apps — Coding Agent projects another box published, with
// `source: "clawbox"`, filed under the `clawbox-apps` category, installed by
// downloading their package (src/lib/store-install.ts). The listing's
// `source` is what tells them apart; the category is only where they are shown.

export const CLAWBOX_APP_SOURCE = "clawbox";
export const CLAWBOX_APPS_CATEGORY = "clawbox-apps";
export const CLAWBOX_APPS_CATEGORY_NAME = "ClawBox Apps";

export interface StoreCategory {
  id: string;
  name: string;
  count: number;
}

/** True for a ClawBox app published from a box, false for a ClawHub skill. */
export function isClawboxListing(listing: { source?: unknown } | null | undefined): boolean {
  return listing?.source === CLAWBOX_APP_SOURCE;
}

/**
 * The category tabs with "ClawBox Apps" among them, FIRST: named and counted
 * even when the portal's category list does not carry it yet but the apps
 * do, and never twice. No ClawBox app anywhere, no tab — an empty one would
 * only be a dead end.
 */
export function mergeStoreCategories(
  categories: readonly StoreCategory[],
  apps: ReadonlyArray<{ source?: unknown; category?: unknown }>,
): StoreCategory[] {
  const listed = apps.filter((app) => isClawboxListing(app) || app.category === CLAWBOX_APPS_CATEGORY).length;
  const seen = new Set<string>();
  let clawbox: StoreCategory | null = null;
  const rest: StoreCategory[] = [];
  for (const category of categories) {
    if (!category || typeof category.id !== "string" || seen.has(category.id)) continue;
    seen.add(category.id);
    if (category.id === CLAWBOX_APPS_CATEGORY) {
      clawbox = {
        id: CLAWBOX_APPS_CATEGORY,
        name: category.name?.trim() ? category.name : CLAWBOX_APPS_CATEGORY_NAME,
        count: Math.max(Number.isFinite(category.count) ? category.count : 0, listed),
      };
    } else {
      rest.push(category);
    }
  }
  if (!clawbox && listed > 0) clawbox = { id: CLAWBOX_APPS_CATEGORY, name: CLAWBOX_APPS_CATEGORY_NAME, count: listed };
  return clawbox ? [clawbox, ...rest] : rest;
}

export interface InstalledMeta {
  name: string;
  color: string;
  iconUrl: string;
  // Webapp-style installs (created via `webapp_create`) carry the launch URL
  // in meta so the desktop can route clicks to an <iframe> instead of the
  // skills path. Left undefined for regular skills.
  webappUrl?: string;
  // ClawHub publisher. Recorded at install because ClawHub namespaces every
  // skill under its publisher, so the slug alone cannot address the page.
  // Undefined for installs made before this was kept, and for webapps, which
  // have no ClawHub page at all — InstalledAppSettings resolves the gap from
  // the store rather than linking somewhere that does not exist.
  developer?: string;
  // How the desktop opens a webapp. "window" opens a real top-level browser
  // window instead of the sandboxed desktop iframe — for apps that need what
  // the iframe blocks (pointer lock for a first-person game, fullscreen).
  // Undefined means the iframe, as for every app before this existed.
  launch?: "window";
  // Served without a session over GET /setup-api/webapps?app=<id> so it can be
  // shared over the tunnel. Read-only serving of that one app's files only;
  // the middleware consults it and nothing else is opened by it.
  public?: boolean;
}
