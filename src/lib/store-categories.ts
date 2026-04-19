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
}
