// Desktop UI, the OpenClaw app store, webapps and code projects.
//
// The app store tools are OpenClaw-only. On a Hermes device /setup-api/apps/*
// answers 404 "Not found", which a small model reads as "no such app" and
// retries forever — and a chronically-404ing tool is exactly what trips
// Hermes' per-server circuit breaker and takes EVERY ClawBox tool offline.
// STORE_EDITION_RULE below is what turns that 404 into "stop".

import { apiGet, apiPost, CLAWBOX_ROOT } from "../lib/api";
import { ApiError, ToolError, type ErrorRule } from "../lib/errors";
import { json, text, type Registrar } from "../lib/register";
import { INSTALLED_APP_ID_RE, zBool, zConfirm, zEnumOf, zInstalledAppId, zInt, zOptText, zSlug, zText } from "../lib/schema";
import { builtInApps, openedAppNotice, UNKNOWN_HARNESS_NOTE, type McpContext } from "../lib/context";
import { HARNESS_ONLY_APP_IDS, isInstalledAppVisible } from "../../src/lib/desktop-app-editions";
import type { InstalledHermesSkill } from "../../src/lib/hermes-skills";

const UI_PICKUP_DELAY_MS = 2_500;

/**
 * Hand the desktop an action. This process cannot append to the owner-notice
 * ring itself (src/lib/pending-actions.ts — the web server's file, and one
 * writer is what keeps it consistent), so it posts the action under the
 * legacy single-slot key and /setup-api/kv folds it into the ring, where
 * every open desktop picks it up.
 *
 * A notice pushed from here can never be CLICKABLE: that route strips the
 * `action` field a notice may carry, because `ui_notify`'s text is the
 * agent's and a click destination would be a target it chose on the owner's
 * desktop. Only ClawBox's in-process producers attach one, through
 * notifyOwner() (src/lib/email-notify.ts) and the allowlist in
 * src/lib/notify-action.ts.
 */
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

/**
 * Webapps and store apps the user has installed AND the desktop would open, by
 * id.
 *
 * `installed_apps` alone is not that list. A store-installed OpenClaw skill is
 * unusable on Hermes — its window shells out to the openclaw binary — so the
 * desktop drops it from `getAllApps()` through `isInstalledAppVisible`, and a
 * gate that checked only membership answered "Opened <name>" over a window
 * that never appeared. Both facts come out of one preferences read.
 *
 * `harness: null` asks for the list UNFILTERED, which is what a REMOVAL wants:
 * an app this harness cannot open is still the owner's to delete.
 */
async function installedAppIds(harness: string | null): Promise<string[]> {
  const prefs = await apiGet<PrefsBody>("/setup-api/preferences", {
    query: { keys: "installed_apps,installed_meta" },
    timeoutMs: 10_000,
  }).catch(() => null);
  const raw = prefs?.installed_apps;
  const meta = (prefs?.installed_meta ?? {}) as Record<string, { webappUrl?: unknown } | undefined>;
  const ids = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  return ids.filter((id) => isInstalledAppVisible(meta[id], harness));
}

/**
 * The rows of /setup-api/hermes/skills/installed this tool reads. `id` is the
 * hub lock key — the only string skill_uninstall resolves — and `name` is
 * SKILL.md's, which is not always the same one (a ClawHub `martin-weather`
 * shows as `weather`). Taken from the route's own type so the two cannot drift.
 */
interface InstalledSkillsBody {
  skills?: Pick<InstalledHermesSkill, "id" | "name">[];
}

// /setup-api/code answers 404 for a project id that does not exist. Without a
// rule that is the generic "this endpoint is not available on this device"
// mapping, which sends the agent to device_status to re-check its EDITION over
// a typo'd id it could have fixed itself.
const CODE_RULES: ErrorRule[] = [
  {
    status: 404,
    code: "NOT_FOUND",
    message: "There is no code project with that id on this ClawBox.",
    next: "Call code_project_list for the ids that exist here, or create one with code_project_init.",
  },
];

// openclawAppsGuard() answers 404 `{"error":"Not found","code":"not_openclaw"}`
// from every store route. Matched on the CODE, not the status: the store routes
// also 404 for an app id that does not exist, and the two need opposite advice.
// The tools are registered off an edition probe taken once when the MCP child
// spawned, so the window is a device whose harness changed since then.
const STORE_EDITION_RULE: ErrorRule = {
  status: 404,
  match: /"code"\s*:\s*"not_openclaw"/,
  code: "NOT_SUPPORTED_HERE",
  message: "This ClawBox is not running the OpenClaw harness, so it has no app store.",
  next:
    "Do not retry and do not call the app store tools again this session. "
    + "Call device_status and tell the user which harness the device is on.",
};

const WEBAPP_RULES: ErrorRule[] = [
  {
    status: 404,
    code: "NOT_FOUND",
    message: "There is no web app with that id on this ClawBox.",
    next: "Call ui_list_apps for the ids that exist here, or create the app first with webapp_create.",
  },
];

export function registerDesktopTools(reg: Registrar, ctx: McpContext): void {
  // The APP harness, not the tool-set edition: an unreadable edition lock
  // resolves the tool set to hermes (the smaller, nested one) and must not
  // therefore hide `store`/`openclaw`/`memory-shard` from a box that has them
  // or advertise `hermes` on a box that may not. `null` shows what both
  // harnesses have, the answer the desktop uses while its own fetch is in
  // flight. A startup snapshot, like the registration itself — on the dual SKU
  // a harness switched after this child spawned is seen at the next restart.
  const apps = builtInApps(ctx.appHarness);
  const builtInIds = apps.map((a) => a.id);
  const appLine = apps.map((a) => a.id).join(", ");

  reg.tool(
    "ui_open_app",
    `Open a window on the ClawBox desktop, so the user can see or do something themselves. Built-in apps here: ${appLine}. For an app the user installed or you built, pass "installed-<id>" — call ui_list_apps first to get the id. To browse the web, use browser_open, not the "browser" app.`,
    {
      app_id: zText(80, "A built-in app id, or \"installed-<id>\" for an installed app."),
    },
    { editions: ["openclaw", "hermes"], readOnly: false, profile: "core" },
    async ({ app_id }: { app_id: string }) => {
      // Order matters: check the app EXISTS on this edition before writing the
      // pending action. The previous version wrote first and then answered
      // "Opening X" for apps that are not installed on this harness at all.
      //
      // A built-in is gated on MEMBERSHIP, never on a slug shape. It used to be
      // matched against a hyphen-only regex first, which rejected
      // `system_update` — an id this tool's own description advertises — as
      // "not a valid app id", and then told the agent to pass an id from that
      // same list. The shape check survives only where it is the injection
      // guard: an `installed-<id>` the caller invented.
      const isInstalled = app_id.startsWith("installed-");
      if (isInstalled) {
        if (!INSTALLED_APP_ID_RE.test(app_id)) {
          throw new ToolError(
            "BAD_ARGUMENT",
            "That is not a valid installed-app id.",
            "Call ui_list_apps and pass an id from its installed_apps list, unchanged.",
          );
        }
        const ids = await installedAppIds(ctx.appHarness);
        if (!ids.includes(app_id.slice("installed-".length))) {
          throw new ToolError(
            "NOT_FOUND",
            "That installed app is not on this device, or this harness cannot open it.",
            "Call ui_list_apps to see which installed apps exist, and use one of those ids.",
          );
        }
      } else if (!builtInIds.includes(app_id)) {
        // AN UNDETERMINED HARNESS IS NOT "NO SUCH APP". The box may well have
        // this one — the harness simply could not be resolved — and saying it
        // does not exist tells the agent as a durable fact that a dual box has
        // no dashboard, which is how it stops asking. The CLI has drawn this
        // distinction since the gate existed; the tool now says the same
        // sentence, from the same constant.
        throw ctx.appHarness === null && HARNESS_ONLY_APP_IDS.includes(app_id)
          ? new ToolError(
            "NOT_FOUND",
            `Cannot open "${app_id}" right now. ${UNKNOWN_HARNESS_NOTE}`,
            "Do not conclude the device lacks this app. Report the reason to the user and try again once the device can name its harness.",
          )
          : new ToolError(
            "NOT_FOUND",
            "There is no such app on this ClawBox.",
            `Call ui_list_apps to see what exists here. Built-in ids: ${appLine}.`,
          );
      }
      await pushUiAction({ type: "open_app", appId: app_id });
      if (app_id === "browser") {
        return text("Opened the Browser Setup panel. That is the settings panel — to actually browse the web, use browser_open.");
      }
      // The same sentence `clawbox app open` prints, from one place — an
      // `external` app is hedged about on both surfaces or on neither.
      return text(openedAppNotice(apps.find((a) => a.id === app_id), app_id));
    },
  );

  reg.tool(
    "ui_list_apps",
    "List what is available on this ClawBox desktop: the built-in apps, and everything the user has installed or you have built. Call this before ui_open_app so you use an id that exists here.",
    {},
    // 6,000, the cap skill_list already carries for this exact volume. A stock
    // Hermes device ships ~77 skills, and capText() hard-SLICES at the cap:
    // 4,000 cut the JSON mid-object and told the agent to "narrow the query" on
    // a tool that takes no arguments. The rows below are compact for the same
    // reason — one line each rather than a pretty-printed object per skill.
    { editions: ["openclaw", "hermes"], readOnly: true, profile: "core", maxChars: 6_000 },
    async () => {
      const builtIn = apps.map((a) => ({ id: a.id, name: a.name, what: a.description }));
      const installed = (await installedAppIds(ctx.appHarness)).map((id) => ({ id: `installed-${id}`, name: id }));
      // On Hermes the agent's own capabilities come from the skills store, not
      // from ~/.openclaw/skills (which does not exist there — listing it was
      // why installed skills always showed up empty on a Hermes device).
      let skills: string[] = [];
      if (ctx.edition === "hermes") {
        const body = await apiGet<InstalledSkillsBody>("/setup-api/hermes/skills/installed", {
          timeoutMs: 10_000,
        }).catch(() => null);
        // BOTH names, in skill_list's own shape: the lock id leads, because it
        // is the one string skill_uninstall resolves, and the display name is
        // added only when it differs. Printing the display name alone put the
        // two agent-facing lists on different strings for one skill; printing a
        // pretty-printed {id, name} pair for each of ~77 rows overran this
        // tool's output cap and truncated the JSON mid-object.
        skills = (body?.skills ?? []).map((s) => (s.name === s.id ? s.id : `${s.id} (${s.name})`));
      }
      return json({
        built_in: builtIn,
        installed_apps: installed,
        ...(ctx.edition === "hermes" ? { agent_skills: skills } : {}),
        // Said out loud rather than five apps quietly missing from the list:
        // the agent cannot tell "this box has no dashboard" from "nobody could
        // say" unless one of them is written down.
        ...(ctx.appHarness === null ? { note: UNKNOWN_HARNESS_NOTE } : {}),
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
        rules: [STORE_EDITION_RULE],
      });
      return json(body);
    },
  );

  reg.tool(
    "app_install",
    "Install an app from the ClawBox app store. Takes the exact id from app_search. Tell the user what it does before installing it.",
    {
      app_id: zSlug("App id from app_search"),
      owner: zOptText(64, "ClawHub publisher handle. Only needed when a previous call answered that more than one publisher uses this id."),
    },
    { editions: ["openclaw"], readOnly: false },
    async ({ app_id, owner }: { app_id: string; owner?: string }) => {
      try {
        await apiPost(
          "/setup-api/apps/install",
          { appId: app_id, ...(owner ? { owner } : {}) },
          { timeoutMs: 120_000, rules: [STORE_EDITION_RULE] },
        );
      } catch (err) {
        // ClawHub namespaces skills by publisher, so a slug more than one
        // publisher uses answers 409 `ambiguous` with the candidates. The
        // generic CONFLICT mapping says "do not retry" — here the retry with
        // an owner is exactly the fix, so name the handles.
        if (err instanceof ApiError && err.status === 409 && /"code"\s*:\s*"ambiguous"/.test(err.body)) {
          let handles = "";
          try {
            const parsed = JSON.parse(err.body) as { matches?: { ownerHandle?: unknown }[] };
            handles = (parsed.matches ?? [])
              .map((m) => (typeof m.ownerHandle === "string" ? m.ownerHandle : ""))
              .filter(Boolean)
              .join(", ");
          } catch { /* the message below still stands without the list */ }
          throw new ToolError(
            "CONFLICT",
            `More than one ClawHub publisher uses the id "${app_id}"${handles ? ` (publishers: ${handles})` : ""}.`,
            "Ask the user which publisher they want, then call app_install again with that handle as `owner`.",
          );
        }
        throw err;
      }
      return text(`Installed "${app_id}". Open it with ui_open_app using "installed-${app_id}".`);
    },
  );

  // Registered on BOTH editions, unlike app_search / app_install, because this
  // is also the removal path for a web app made by webapp_create or
  // code_project_build — and both of those exist on Hermes. What it actually
  // does is remove the DESKTOP ENTRY (and, on OpenClaw, the store app's skill
  // folder). It used to describe itself as the app-store uninstaller on Hermes
  // too, where /setup-api/apps/uninstall deletes an OpenClaw skills directory
  // that does not exist and still answers 200 — the "silently half-works" case.
  // The installed-list pre-check below is what closes that: a skill name now
  // gets a clear NOT_FOUND pointing at skill_uninstall instead of a cheerful
  // "Removed" for something that was never touched.
  reg.tool(
    "app_uninstall",
    ctx.edition === "hermes"
      ? "Remove an app icon from the ClawBox desktop: a web app you built, or something the user installed. It does NOT remove one of your own skills — use skill_uninstall for those. Call ui_list_apps first to get the id, and ask the user to confirm."
      : "Remove an app the user installed from the ClawBox app store, or a web app you built, from the desktop. Call ui_list_apps first to get the id, and ask the user to confirm.",
    // The producers' alphabet, not zSlug's: `ui_open_app` and `clawbox app
    // open` accept `Foo_Bar` and `_drafts`, so removal must too — an app the
    // agent can create and open and cannot delete is the worse half of the
    // defect this file's widening fixed. The membership check below is
    // deliberately unfiltered for the same reason.
    { app_id: zInstalledAppId("App id, as ui_list_apps reports it without the installed- prefix") },
    { editions: ["openclaw", "hermes"], readOnly: false, destructive: true },
    async ({ app_id }: { app_id: string }) => {
      // Unfiltered: removing an app this harness cannot open is legitimate.
      const installed = await installedAppIds(null);
      if (!installed.includes(app_id)) {
        throw new ToolError(
          "NOT_FOUND",
          "There is no installed app with that id on this ClawBox.",
          ctx.edition === "hermes"
            ? "Call ui_list_apps for the desktop apps. To remove one of your own skills, call skill_list and then skill_uninstall."
            : "Call ui_list_apps and use an id from its installed_apps list, without the \"installed-\" prefix.",
        );
      }
      const removed = (await apiPost<{ skillRemoved?: boolean | null }>(
        "/setup-api/apps/uninstall",
        { appId: app_id },
        {
          timeoutMs: 60_000,
          // The route refuses rather than half-uninstalling when it cannot
          // read the device's OpenClaw configuration or remove the skill
          // folder. Without this the 503 renders as "the service is not
          // answering", which sends the agent to clawbox_health over a route
          // that answered precisely and told it to try again.
          rules: [
            {
              status: 503,
              code: "ENDPOINT_DOWN",
              message: "The ClawBox could not finish the removal, so nothing was removed and the app is still on the desktop.",
              next: "Wait a few seconds and call app_uninstall once more. If it refuses again, tell the user the app is still installed and what the device said.",
            },
          ],
        },
      )) as { skillRemoved?: boolean | null } | undefined;
      // Anything but a 2xx has thrown by here, so the desktop entry IS gone.
      // The SKILL half depends on what was there. `skillRemoved: false` — the
      // id is in the desktop's list and no skill of that name was on disk — is
      // the one an agent must not report as a skill removal, because the next
      // thing it does is tell the user the skill is gone. `null` is a device
      // with no OpenClaw skills root at all (the hermes SKU).
      if (removed?.skillRemoved === false) {
        return text(
          `Removed "${app_id}" from the desktop. There was no skill of that name on disk, so nothing was removed from the agent's skills.`,
        );
      }
      return text(`Removed "${app_id}" from the desktop.`);
    },
  );

  // ── Webapps ────────────────────────────────────────────────────────────────

  reg.tool(
    "webapp_create",
    "Create a one-file web app on the ClawBox desktop from complete standalone HTML, with CSS and JavaScript inline and no links to the internet. For an app of more than one file, use code_project_init. Call clawbox_context first for the storage and styling rules.",
    {
      app_id: zSlug("Unique id, lowercase with hyphens, e.g. \"todo-list\""),
      name: zText(60, "Name shown under the desktop icon"),
      html: zText(400_000, "The complete HTML document"),
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
      // Widened for the same reason `app_uninstall` was: `APP_ID_RE` is what
      // /setup-api/webapps enforces, and it mints ids with upper case and
      // underscores. An app this family LISTS and OPENS must be one it can
      // also act on. (`webapp_create` stays narrow — constraining what the
      // agent MINTS is a choice; refusing what the device made is a defect.)
      app_id: zInstalledAppId("The id you passed to webapp_create"),
      html: zText(400_000, "The complete replacement HTML"),
    },
    { editions: ["openclaw", "hermes"], readOnly: false },
    async ({ app_id, html }: { app_id: string; html: string }) => {
      await apiPost("/setup-api/webapps", { appId: app_id, html }, { timeoutMs: 30_000, rules: WEBAPP_RULES });
      return text(`Updated the web app "${app_id}". The user may need to reopen its window to see the change.`);
    },
  );

  // ── Code projects ──────────────────────────────────────────────────────────

  const codeApi = <T = unknown>(action: string, body: Record<string, unknown> = {}, timeoutMs = 30_000) =>
    apiPost<T>("/setup-api/code", { action, ...body }, { timeoutMs, rules: CODE_RULES });

  // The one string in this whole server that HAS to be absolute.
  //
  // The agent edits project files with its harness's own file tools, and those
  // resolve a relative path against the HARNESS process's working directory —
  // /home/clawbox on a Hermes device — while the project lives under the WEB
  // tier's, /home/clawbox/clawbox. Handing out "data/code-projects/<id>/" made
  // every read answer "File not found" and every write report verified:true
  // into /home/clawbox/data/..., a parallel tree code_project_build never looks
  // at: three success messages and an untouched scaffold on the desktop.
  //
  // The route now reports its own absolute directory, which is the only place
  // that actually knows it; CLAWBOX_ROOT is the fallback for an older device
  // whose /setup-api/code predates that field.
  const projectDirOf = (projectId: string, reported?: unknown): string =>
    typeof reported === "string" && reported.startsWith("/")
      ? reported
      : `${CLAWBOX_ROOT}/data/code-projects/${projectId}`;

  reg.tool(
    "code_project_init",
    "Start a multi-file web app project on the ClawBox. It creates a folder of starter files and returns the ABSOLUTE path of that folder; edit the files with your own file-editing tools using that absolute path exactly as given, never a shortened or relative form, then call code_project_build to install it on the desktop. Call clawbox_context first for the storage rules.",
    {
      project_id: zSlug("Unique id, lowercase with hyphens"),
      name: zText(60, "Name shown under the desktop icon"),
      template: zEnumOf(["app", "blank"], "app = HTML, CSS and JS files. blank = one HTML file.").default("app"),
      color: zOptText(7, "Icon colour as a hex code"),
    },
    { editions: ["openclaw", "hermes"], readOnly: false, maxChars: 3_000 },
    async ({ project_id, name, template, color }: { project_id: string; name: string; template: string; color?: string }) => {
      const iconColor = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#f97316";
      const created = await codeApi<{ path?: string }>("init", { projectId: project_id, name, template, color: iconColor });
      const files = await codeApi<{ files?: { name: string; type: string }[]; path?: string }>("file-list", { projectId: project_id });
      const dir = projectDirOf(project_id, created.path ?? files.path);
      const list = (files.files ?? []).map((f) => `  ${dir}/${f.name}${f.type === "directory" ? "/" : ""}`).join("\n");
      return text(
        `Created the project "${name}".\nIts files live in ${dir}/ — these are full paths, use them exactly as written:\n${list}\n`
        + `Read and edit them with your own file tools at those absolute paths, then call code_project_build with the id "${project_id}".`,
      );
    },
  );

  reg.tool(
    "code_project_list",
    "List the multi-file app projects on this ClawBox, with the id each one is built and deleted by.",
    {},
    { editions: ["openclaw", "hermes"], readOnly: true, maxChars: 3_000 },
    async () => {
      const data = await codeApi<{ projects?: { projectId: string; name: string; updated: string; path?: string }[] }>("list-projects");
      const projects = data.projects ?? [];
      if (!projects.length) return text("There are no code projects on this ClawBox yet. Create one with code_project_init.");
      return json(
        projects.map((p) => ({
          id: p.projectId,
          name: p.name,
          updated: p.updated,
          // Absolute, for the same reason code_project_init reports one.
          path: projectDirOf(p.projectId, p.path),
        })),
      );
    },
  );

  reg.tool(
    "code_project_build",
    "Bundle a code project into a single page and install it on the ClawBox desktop. Call this after every set of edits — the desktop shows the last build, not the source files. The source files are the ones under the absolute path code_project_init and code_project_list report; edits written anywhere else are not part of the build.",
    {
      // From `code_project_list`, so it carries whatever alphabet
      // /setup-api/code minted it with (`APP_ID_RE`: upper case and
      // underscores included). Refusing it here made the tool reject an id
      // its own sibling had just reported.
      project_id: zInstalledAppId("The project id from code_project_list"),
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
      // From `code_project_list`, so it carries whatever alphabet
      // /setup-api/code minted it with (`APP_ID_RE`: upper case and
      // underscores included). Refusing it here made the tool reject an id
      // its own sibling had just reported.
      project_id: zInstalledAppId("The project id from code_project_list"),
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
