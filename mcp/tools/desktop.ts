// Desktop UI, the OpenClaw app store, webapps and code projects.
//
// The app store tools are OpenClaw-only. On a Hermes device /setup-api/apps/*
// answers 404 "Not found", which a small model reads as "no such app" and
// retries forever — and a chronically-404ing tool is exactly what trips
// Hermes' per-server circuit breaker and takes EVERY ClawBox tool offline.

import { apiGet, apiPost } from "../lib/api";
import { ToolError } from "../lib/errors";
import { json, text, type Registrar } from "../lib/register";
import { zBool, zConfirm, zEnumOf, zInt, zOptText, zSlug, zText } from "../lib/schema";
import { builtInApps, type McpContext } from "../lib/context";

const UI_PICKUP_DELAY_MS = 2_500;

/** The desktop picks pending actions up out of the KV store. */
async function pushUiAction(action: Record<string, unknown>): Promise<void> {
  await apiPost(
    "/setup-api/kv",
    { key: "ui:pending-action", value: JSON.stringify({ ...action, ts: Date.now() }) },
    { timeoutMs: 10_000 },
  );
}

interface PrefsBody {
  installed_apps?: unknown;
  installed_meta?: unknown;
}

/** Webapps and store apps the user has installed, by id. */
async function installedAppIds(): Promise<string[]> {
  const prefs = await apiGet<PrefsBody>("/setup-api/preferences", {
    query: { keys: "installed_apps" },
    timeoutMs: 10_000,
  }).catch(() => null);
  const raw = prefs?.installed_apps;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

interface InstalledSkillsBody {
  skills?: { name: string; category?: string }[];
}

export function registerDesktopTools(reg: Registrar, ctx: McpContext): void {
  const apps = builtInApps(ctx.edition);
  const builtInIds = apps.map((a) => a.id);
  const appLine = apps.map((a) => a.id).join(", ");

  reg.tool(
    "ui_open_app",
    `Open a window on the ClawBox desktop, so the user can see or do something themselves. Built-in apps here: ${appLine}. For an app the user installed or you built, pass "installed-<id>" — call ui_list_apps first to get the id. To browse the web, use browser_open, not the "browser" app.`,
    {
      app_id: zText(80, `A built-in app id (${appLine}) or "installed-<id>" for an installed app.`),
    },
    { editions: ["openclaw", "hermes"], readOnly: false, profile: "core" },
    async ({ app_id }: { app_id: string }) => {
      if (!/^(installed-)?[a-z0-9][a-z0-9-]{0,63}$/.test(app_id)) {
        throw new ToolError(
          "BAD_ARGUMENT",
          "That is not a valid app id.",
          `Call ui_list_apps and pass an id from its list. Built-in ids: ${appLine}.`,
        );
      }
      // Order matters: check the app EXISTS on this edition before writing the
      // pending action. The previous version wrote first and then answered
      // "Opening X" for apps that are not installed on this harness at all.
      const isInstalled = app_id.startsWith("installed-");
      if (!isInstalled && !builtInIds.includes(app_id)) {
        throw new ToolError(
          "NOT_FOUND",
          "There is no such app on this ClawBox.",
          `Call ui_list_apps to see what exists here. Built-in ids: ${appLine}.`,
        );
      }
      if (isInstalled) {
        const ids = await installedAppIds();
        if (!ids.includes(app_id.slice("installed-".length))) {
          throw new ToolError(
            "NOT_FOUND",
            "That installed app is not on this device.",
            "Call ui_list_apps to see which installed apps exist, and use one of those ids.",
          );
        }
      }
      await pushUiAction({ type: "open_app", appId: app_id });
      if (app_id === "browser") {
        return text("Opened the Browser Setup panel. That is the settings panel — to actually browse the web, use browser_open.");
      }
      const known = apps.find((a) => a.id === app_id);
      return text(`Opened ${known?.name ?? app_id} on the desktop.`);
    },
  );

  reg.tool(
    "ui_list_apps",
    "List what is available on this ClawBox desktop: the built-in apps, and everything the user has installed or you have built. Call this before ui_open_app so you use an id that exists here.",
    {},
    { editions: ["openclaw", "hermes"], readOnly: true, profile: "core", maxChars: 4_000 },
    async () => {
      const builtIn = apps.map((a) => ({ id: a.id, name: a.name, what: a.description }));
      const installed = (await installedAppIds()).map((id) => ({ id: `installed-${id}`, name: id }));
      // On Hermes the agent's own capabilities come from the skills store, not
      // from ~/.openclaw/skills (which does not exist there — listing it was
      // why installed skills always showed up empty on a Hermes device).
      let skills: string[] = [];
      if (ctx.edition === "hermes") {
        const body = await apiGet<InstalledSkillsBody>("/setup-api/hermes/skills/installed", {
          timeoutMs: 10_000,
        }).catch(() => null);
        skills = (body?.skills ?? []).map((s) => s.name);
      }
      return json({
        built_in: builtIn,
        installed_apps: installed,
        ...(ctx.edition === "hermes" ? { agent_skills: skills } : {}),
      });
    },
  );

  reg.tool(
    "ui_notify",
    "Show a short notification on the ClawBox desktop, so the user sees it on the monitor. Use it to report that a long job finished. It is one-way — it cannot ask a question.",
    { message: zText(280, "What to show, at most 280 characters.") },
    { editions: ["openclaw", "hermes"], readOnly: false, profile: "core" },
    async ({ message }: { message: string }) => {
      await pushUiAction({ type: "notify", message });
      return text("Notification shown on the desktop.");
    },
  );

  // ── OpenClaw app store ─────────────────────────────────────────────────────

  reg.tool(
    "app_search",
    "Search the ClawBox app store for apps this device can install. Returns each app's id; pass that id to app_install unchanged.",
    {
      query: zOptText(80, "What the app should do. Omit to list popular apps."),
      limit: zInt(1, 25, 10, "How many results to return."),
    },
    { editions: ["openclaw"], readOnly: true, openWorld: true, maxChars: 6_000 },
    async ({ query, limit }: { query?: string; limit: number }) => {
      const body = await apiGet("/setup-api/apps/store", {
        query: { ...(query ? { q: query } : {}), limit },
        timeoutMs: 20_000,
      });
      return json(body);
    },
  );

  reg.tool(
    "app_install",
    "Install an app from the ClawBox app store. Takes the exact id from app_search. Tell the user what it does before installing it.",
    { app_id: zSlug("App id from app_search") },
    { editions: ["openclaw"], readOnly: false },
    async ({ app_id }: { app_id: string }) => {
      await apiPost("/setup-api/apps/install", { appId: app_id }, { timeoutMs: 120_000 });
      return text(`Installed "${app_id}". Open it with ui_open_app using "installed-${app_id}".`);
    },
  );

  reg.tool(
    "app_uninstall",
    "Remove an app the user installed from the ClawBox app store. On a Hermes device use skill_uninstall instead — that is where its capabilities come from. Ask the user to confirm first.",
    { app_id: zSlug("App id, as ui_list_apps reports it without the installed- prefix") },
    { editions: ["openclaw", "hermes"], readOnly: false, destructive: true },
    async ({ app_id }: { app_id: string }) => {
      await apiPost("/setup-api/apps/uninstall", { appId: app_id }, { timeoutMs: 60_000 });
      return text(`Removed "${app_id}" from the desktop.`);
    },
  );

  // ── Webapps ────────────────────────────────────────────────────────────────

  reg.tool(
    "webapp_create",
    "Create a one-file web app and put it on the ClawBox desktop. Give it complete standalone HTML with the CSS and JavaScript inline and no links to the internet. For an app of more than one file, use code_project_init instead. Call clawbox_context first for the storage and styling rules.",
    {
      app_id: zSlug("Unique id, lowercase with hyphens, e.g. \"todo-list\""),
      name: zText(60, "Name shown under the desktop icon"),
      html: zText(400_000, "The complete HTML document, with CSS and JS inline"),
      color: zOptText(7, "Icon colour as a hex code, e.g. \"#f97316\""),
      open_after_create: zBool(true, "Open it on the desktop straight away."),
    },
    { editions: ["openclaw", "hermes"], readOnly: false },
    async ({
      app_id,
      name,
      html,
      color,
      open_after_create,
    }: { app_id: string; name: string; html: string; color?: string; open_after_create: boolean }) => {
      const iconColor = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#f97316";
      const saved = await apiPost<{ url?: string }>(
        "/setup-api/webapps",
        { appId: app_id, html, name, color: iconColor },
        { timeoutMs: 30_000 },
      );
      const url = saved.url || `/setup-api/webapps?app=${app_id}`;
      await pushUiAction({ type: "register_webapp", appId: app_id, name, color: iconColor, url });
      if (open_after_create) {
        await new Promise((r) => setTimeout(r, UI_PICKUP_DELAY_MS));
        await pushUiAction({ type: "open_app", appId: `installed-${app_id}` });
      }
      return text(`Created "${name}" on the desktop${open_after_create ? " and opened it" : ""}. Update it later with webapp_update using the id "${app_id}".`);
    },
  );

  reg.tool(
    "webapp_update",
    "Replace the HTML of a web app you created earlier with webapp_create. The whole document is replaced, so send the complete HTML, not just the changed part.",
    {
      app_id: zSlug("The id you passed to webapp_create"),
      html: zText(400_000, "The complete replacement HTML document"),
    },
    { editions: ["openclaw", "hermes"], readOnly: false },
    async ({ app_id, html }: { app_id: string; html: string }) => {
      await apiPost("/setup-api/webapps", { appId: app_id, html }, { timeoutMs: 30_000 });
      return text(`Updated the web app "${app_id}". The user may need to reopen its window to see the change.`);
    },
  );

  // ── Code projects ──────────────────────────────────────────────────────────

  const codeApi = <T = unknown>(action: string, body: Record<string, unknown> = {}, timeoutMs = 30_000) =>
    apiPost<T>("/setup-api/code", { action, ...body }, { timeoutMs });

  reg.tool(
    "code_project_init",
    "Start a multi-file web app project on the ClawBox. It creates a folder with index.html, style.css and app.js and returns the path. Write the files with your own file-editing tools, then call code_project_build to bundle and install it on the desktop. Call clawbox_context first for the storage rules.",
    {
      project_id: zSlug("Unique id, lowercase with hyphens"),
      name: zText(60, "Name shown under the desktop icon"),
      template: zEnumOf(["app", "blank"], "app = index.html + style.css + app.js. blank = index.html only.").default("app"),
      color: zOptText(7, "Icon colour as a hex code"),
    },
    { editions: ["openclaw", "hermes"], readOnly: false, maxChars: 3_000 },
    async ({ project_id, name, template, color }: { project_id: string; name: string; template: string; color?: string }) => {
      const iconColor = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#f97316";
      await codeApi("init", { projectId: project_id, name, template, color: iconColor });
      const files = await codeApi<{ files?: { name: string; type: string }[] }>("file-list", { projectId: project_id });
      const list = (files.files ?? []).map((f) => `  ${f.name}${f.type === "directory" ? "/" : ""}`).join("\n");
      return text(
        `Created the project "${name}".\nIts files live in data/code-projects/${project_id}/ inside the ClawBox project folder:\n${list}\n`
        + `Edit them there, then call code_project_build with the id "${project_id}".`,
      );
    },
  );

  reg.tool(
    "code_project_list",
    "List the multi-file app projects on this ClawBox, with the id each one is built and deleted by.",
    {},
    { editions: ["openclaw", "hermes"], readOnly: true, maxChars: 3_000 },
    async () => {
      const data = await codeApi<{ projects?: { projectId: string; name: string; updated: string }[] }>("list-projects");
      const projects = data.projects ?? [];
      if (!projects.length) return text("There are no code projects on this ClawBox yet. Create one with code_project_init.");
      return json(projects.map((p) => ({ id: p.projectId, name: p.name, updated: p.updated })));
    },
  );

  reg.tool(
    "code_project_build",
    "Bundle a code project into a single page and install it on the ClawBox desktop. Call this after every set of edits — the desktop shows the last build, not the source files.",
    {
      project_id: zSlug("The project id from code_project_list"),
      open_after_build: zBool(true, "Open it on the desktop after building."),
    },
    { editions: ["openclaw", "hermes"], readOnly: false },
    async ({ project_id, open_after_build }: { project_id: string; open_after_build: boolean }) => {
      let name = project_id;
      let color = "#f97316";
      try {
        const proj = await codeApi<{ project?: { name?: string; color?: string } }>("get-project", { projectId: project_id });
        name = proj.project?.name || name;
        color = proj.project?.color || color;
      } catch {
        // Missing metadata is not a reason to refuse the build.
      }
      const data = await codeApi<{ url: string; filesInlined: number }>(
        "build",
        { projectId: project_id, name, color },
        60_000,
      );
      await pushUiAction({ type: "register_webapp", appId: project_id, name, color, url: data.url });
      if (open_after_build) {
        await new Promise((r) => setTimeout(r, UI_PICKUP_DELAY_MS));
        await pushUiAction({ type: "open_app", appId: `installed-${project_id}` });
      }
      return text(`Built "${name}" from ${data.filesInlined} file(s) and installed it on the desktop.`);
    },
  );

  reg.tool(
    "code_project_delete",
    "Delete a code project and all of its source files from the ClawBox. This cannot be undone. Ask the user to confirm before calling it.",
    {
      project_id: zSlug("The project id from code_project_list"),
      confirm: zConfirm("Must be true. Set it only when the user asked for this project to be deleted."),
    },
    { editions: ["openclaw", "hermes"], readOnly: false, destructive: true },
    async ({ project_id }: { project_id: string; confirm: true }) => {
      await codeApi("delete-project", { projectId: project_id });
      return text(
        `Deleted the project "${project_id}": its source files are gone permanently. `
        + `Any copy already installed on the desktop stays until it is removed with app_uninstall.`,
      );
    },
  );
}
