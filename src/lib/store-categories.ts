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
};

export const DEFAULT_CATEGORY_COLOR = "#6b7280";

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
