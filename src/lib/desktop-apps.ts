// The built-in desktop apps, shared so that every surface naming an app reads
// the SAME entry: the desktop grid, shelf and launcher (src/app/page.tsx) and
// the standalone `/app/<id>` window (src/app/app/[id]/page.tsx). It used to be
// private to the desktop page, with the standalone window keeping its own map
// of English names — which is how the Skills app stayed "Skills" on a Bulgarian
// box while the desktop translated around it.
//
// `name` is a TRANSLATION KEY, not copy: both surfaces resolve it with
// `t(name) || name`, so a product name (Hermes, ClawKeep) carries no key and
// falls through as itself. Everything else must have an `app.*` key in every
// locale — src/tests/unit/desktop-app-names-i18n.test.ts holds that.
import type { StoreApp } from "@/components/AppStore";

export interface AppDef {
  id: string;
  name: string;
  color: string;
  type: "settings" | "placeholder" | "external" | "store" | "hermes_skills" | "installed" | "terminal" | "coding" | "files" | "browser" | "vnc" | "webapp" | "setup" | "clawkeep" | "memory_shard" | "system_update" | "chat";
  url?: string;
  // Webapps only: how the desktop opens it (InstalledMeta.launch).
  launch?: "window";
  pinned: boolean;
  defaultWidth?: number;
  defaultHeight?: number;
  storeApp?: StoreApp;
}

export const apps: AppDef[] = [
  { id: "settings", name: "app.settings", color: "#6b7280", type: "settings", pinned: true, defaultWidth: 800, defaultHeight: 600 },
  { id: "clawbox", name: "app.chat", color: "#0a0f1a", type: "chat", pinned: true },
  { id: "openclaw", name: "app.openclaw", color: "#0a0f1a", type: "external", url: "/chat", pinned: true },
  // Hermes dashboard — only shown on the Hermes edition. Opened via the
  // auth-gated dashboard proxy (url computed at click time from the host).
  { id: "hermes", name: "Hermes", color: "#1a1230", type: "external", url: "hermes-dashboard", pinned: true },
  // Hermes Skills Store — only shown on the Hermes edition (gated below via
  // HERMES_ONLY_APP_IDS / harnessHiddenAppIds, same mechanism as `hermes`).
  { id: "hermes-skills", name: "app.skills", color: "#1a1230", type: "hermes_skills", pinned: true, defaultWidth: 900, defaultHeight: 600 },
  { id: "terminal", name: "app.terminal", color: "#1a1a2e", type: "terminal" as const, pinned: false, defaultWidth: 900, defaultHeight: 600 },
  // The coding agent: the owner's switch for letting the assistant delegate a
  // whole task to a headless `claude-ds` run, what such a run needs, and the
  // recent runs. Pinned like OpenClaw because it is a headline capability, not
  // a power-user shortcut, and shown on both harnesses — the harness needs only
  // the portal token and the CLI, both of which every edition installs. (It
  // used to open an interactive terminal running the harness; that is still a
  // `claude-ds` away in the Terminal app.)
  { id: "coding", name: "app.codingAgent", color: "#14304d", type: "coding" as const, pinned: true, defaultWidth: 960, defaultHeight: 640 },
  { id: "files", name: "app.files", color: "#f97316", type: "files", pinned: true },
  { id: "clawkeep", name: "ClawKeep", color: "#14532d", type: "clawkeep", pinned: true, defaultWidth: 980, defaultHeight: 720 },
  // The memory index — health, "Index now", the schedule — as its own window.
  // It used to be a card inside ClawKeep and borrowed its green; it has its own
  // tile colour now, because the app was rebuilt on the Coding Agent's pattern
  // and green is reserved there for a STATE (on, healthy) rather than for an
  // identity. Sized for the single card it shows.
  { id: "memory-shard", name: "app.memoryShard", color: "#2f2a52", type: "memory_shard", pinned: true, defaultWidth: 720, defaultHeight: 640 },
  { id: "system_update", name: "app.systemUpdate", color: "#0ea5e9", type: "system_update", pinned: false, defaultWidth: 900, defaultHeight: 720 },
  { id: "store", name: "app.store", color: "#22c55e", type: "store", pinned: true, defaultWidth: 900, defaultHeight: 600 },
  { id: "browser", name: "app.browser", color: "#4285f4", type: "browser", pinned: false, defaultWidth: 1000, defaultHeight: 700 },
  { id: "vnc", name: "app.remoteDesktop", color: "#7c3aed", type: "vnc", pinned: false, defaultWidth: 1000, defaultHeight: 700 },
];
