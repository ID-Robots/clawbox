// Window-level CustomEvent names shared between page.tsx and components.
// Defining them in one place avoids typo drift between the dispatch and
// listen sites.

export const OPEN_APP_EVENT = "clawbox:open-app";
export const FIX_ERROR_EVENT = "clawbox:fix-error";
/**
 * "Send this as the owner's next chat turn."
 *
 * The Coding Agent app's New wizard ends here rather than at the run route:
 * the assistant is the party that scaffolds, delegates and verifies, and the
 * owner continues the conversation in the chat they were handed to. Same
 * shape as FIX_ERROR_EVENT — ChatPopup queues the text through the one send
 * path it has, and page.tsx opens the popup so the owner can watch.
 */
export const CHAT_MESSAGE_EVENT = "clawbox:chat-message";

/**
 * "Open the mascot chat and put the New app card in it."
 *
 * The card composes one message and hands it to the assistant, so the chat is
 * where it belongs: the Coding Agent window used to host the same form inline,
 * which meant two places asked for a new app and only one of them could show
 * the reply. The Coding Agent's button is a hand-off now, not a second form.
 */
export const NEW_APP_EVENT = "clawbox:new-app";

/** What the Create App card should open on: an existing project, and whether the work is for a team. */
export interface NewAppCardOptions {
  /** The absolute directory of a project to preselect in the existing-project mode. */
  project?: string;
  /** Compose the message for a coding TEAM (coding_team_run) rather than one run. */
  team?: boolean;
}

/** Ask the desktop to open the chat with the New app card. */
export function openNewAppCard(opts: NewAppCardOptions = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<NewAppCardOptions>(NEW_APP_EVENT, { detail: opts }));
}
export const OPEN_SETTINGS_SECTION_EVENT = "clawbox:open-settings-section";

/**
 * "Open the Coding Agent app on this run's page."
 *
 * Two handoffs, like the settings section: the `window` property survives a
 * COLD open (the app's listener mounts after this fires), the event reaches
 * an app already on screen. The finish card's Open button ends here rather
 * than at a bare `openApp("coding")`, which dropped the owner on the home
 * page and left them to find the run.
 */
export const OPEN_CODING_RUN_EVENT = "clawbox:open-coding-run";

/** How the run should open: `maximize` brings the window full-screen. */
export interface OpenCodingRunOptions {
  maximize?: boolean;
}

type PendingRunWindow = Window & { __clawboxPendingCodingRun?: unknown };

/** The handoff WITHOUT opening the app — for a desktop that opens it itself. */
export function handoffCodingRun(runId: string): void {
  if (typeof window === "undefined") return;
  const w = window as PendingRunWindow;
  w.__clawboxPendingCodingRun = runId;
  window.dispatchEvent(new CustomEvent(OPEN_CODING_RUN_EVENT, { detail: { runId } }));
}

/**
 * Open the Coding Agent app on a run. `maximize` opens (or brings) the window
 * full-screen: the chat's View button lands the owner on the run's page with
 * the whole desktop for it. (The page's separate Live view is gone: the run
 * page itself carries the browser preview, the terminal and the timeline.)
 */
export function dispatchOpenCodingRun(runId: string, opts: OpenCodingRunOptions = {}): void {
  if (typeof window === "undefined") return;
  handoffCodingRun(runId);
  dispatchOpenApp("coding", { maximize: opts.maximize });
}

/** The run handed off before the app mounted, taken exactly once. */
export function takePendingCodingRun(): string | null {
  if (typeof window === "undefined") return null;
  const w = window as PendingRunWindow;
  const id = typeof w.__clawboxPendingCodingRun === "string" ? w.__clawboxPendingCodingRun : null;
  delete w.__clawboxPendingCodingRun;
  return id;
}



/**
 * "The chat's model or provider selection changed."
 *
 * The OpenClaw-side counterpart to `HERMES_MODEL_STATE_EVENT`, and a signal
 * rather than data for the same reason: every listener re-asks the server.
 * Named here because it has three listen sites and an emit site in three
 * different files — as a bare string, a rename in one of them would leave the
 * others silently deaf, with the capability stale until a page reload.
 */
export const CHAT_MODEL_STATE_EVENT = "clawbox:chat-model-state-changed";

/**
 * What the desktop is asked for: which app, whether its window should be
 * maximized, whether a window of its own is wanted even while one is up,
 * and what rides on that window's record — strings only, the way a
 * Terminal's command does (the Files app's starting folder).
 */
export interface OpenAppDetail {
  appId: string;
  maximize?: boolean;
  forceNew?: boolean;
  meta?: Record<string, string>;
}

export interface OpenAppOptions {
  maximize?: boolean;
  forceNew?: boolean;
  meta?: Record<string, string>;
}

export function dispatchOpenApp(appId: string, opts: OpenAppOptions = {}): void {
  if (typeof window === "undefined") return;
  const detail: OpenAppDetail = {
    appId,
    ...(opts.maximize ? { maximize: true } : {}),
    ...(opts.forceNew ? { forceNew: true } : {}),
    ...(opts.meta ? { meta: opts.meta } : {}),
  };
  window.dispatchEvent(new CustomEvent<OpenAppDetail>(OPEN_APP_EVENT, { detail }));
}

/**
 * Open Settings on a given section, whether or not the window is already up.
 *
 * Two handoffs, both load-bearing: the `window` property is read by
 * `SettingsApp` on mount and so survives a COLD open (its listener mounts
 * after this fires); the event reaches an already-open Settings window. This
 * is the sequence `page.tsx` open-a-section helpers also perform — named here
 * so the event string and the `__clawboxPendingSettingsSection` handoff live
 * in one place instead of drifting across each dispatch site.
 */
export function dispatchOpenSettingsSection(section: string): void {
  if (typeof window === "undefined") return;
  handoffSettingsSection(section);
  dispatchOpenApp("settings");
}

/**
 * The two handoffs above WITHOUT opening the app — for a page that is already
 * rendering Settings and only has to tell it which section: the standalone
 * `/app/settings?section=…` route, where there is no desktop to open a window
 * into and nothing listens for OPEN_APP_EVENT.
 */
export function handoffSettingsSection(section: string): void {
  if (typeof window === "undefined") return;
  (window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection = section;
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section } }));
}

/** The query parameter `/app/settings` reads its opening section from. */
export const STANDALONE_SETTINGS_SECTION_PARAM = "section";

/**
 * True on `/app/<id>` — the page behind "Open in new tab", which a phone lands
 * on. It hosts ONE app and no desktop: nothing there listens for
 * OPEN_APP_EVENT or OPEN_SETTINGS_SECTION_EVENT, so a control that only
 * dispatches them is inert. A link that wants to reach Settings from that
 * page has to navigate to `standaloneSettingsHref()` instead.
 */
export function onStandaloneAppPage(): boolean {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/app/");
}

/** Where the standalone Settings page opens on `section` — the one spelling
 *  of the address, shared by the link that navigates there and the page that
 *  reads it. */
export function standaloneSettingsHref(section: string): string {
  return `/app/settings?${STANDALONE_SETTINGS_SECTION_PARAM}=${encodeURIComponent(section)}`;
}

export interface FixErrorContext {
  source: string;
  message: string;
  details?: string;
}

export function dispatchFixError(ctx: FixErrorContext): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FIX_ERROR_EVENT, { detail: ctx }));
}

export interface ChatMessageDetail {
  text: string;
}

export function dispatchChatMessage(text: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ChatMessageDetail>(CHAT_MESSAGE_EVENT, { detail: { text } }));
}

/** The starter a new app is scaffolded from — initProject's two templates. */
/** The wizard's starters, in the order the select shows them; "nextjs" is the default. */
export type NewAppTemplate = "nextjs" | "react" | "app" | "blank";
export const NEW_APP_TEMPLATES: readonly NewAppTemplate[] = ["nextjs", "react", "app", "blank"];
export const DEFAULT_NEW_APP_TEMPLATE: NewAppTemplate = "nextjs";

/**
 * What "scaffold it" means per starter. The two static ones are code projects
 * (initProject's templates, built into one HTML file on the desktop). The two
 * framework starters are real git folders under the owner's project folder,
 * served from a port — the desktop registers them as web apps pointing at
 * that address, since a Next.js or Vite build cannot be inlined into one file.
 */
/**
 * Every template scaffolds into a NEW GIT FOLDER UNDER THE OWNER'S PROJECT
 * FOLDER — never as a "code project".
 *
 * A code project lives at data/code-projects/<id>, which is inside ClawBox's
 * own checkout. Three things went wrong there, all visible on the project page:
 * `git` in that folder resolves to ClawBox's repository, so the project showed
 * the PRODUCT's branch, its 1600 commits and its remote as if they were the
 * app's; the Back up button would have pushed the product; and the work was in
 * a directory the owner never browses. The two single-file templates keep their
 * simple shape — one HTML file, or an HTML/CSS/JS trio — they just get a folder
 * of their own like everything else.
 */
const SCAFFOLD_SENTENCE: Record<NewAppTemplate, string> = {
  nextjs: "Scaffold it as a Next.js full-stack app (App Router, TypeScript, Bun) in a new git folder under my project folder, build it with the coding agent, run it on a free local port, verify it in the browser, and register it on my desktop as a web app pointing at that address, with an icon.",
  react: "Scaffold it as a React app (Vite, TypeScript, Bun) in a new git folder under my project folder, build it with the coding agent, serve its production build on a free local port, verify it in the browser, and register it on my desktop as a web app pointing at that address, with an icon.",
  app: "Scaffold it as a small HTML/CSS/JS app in a new git folder under my project folder — not as a code project under ClawBox's own data directory — build it with the coding agent, verify it in the browser, and put it on my desktop with an icon.",
  blank: "Scaffold it as a single-page HTML app in a new git folder under my project folder — not as a code project under ClawBox's own data directory — build it with the coding agent, verify it in the browser, and put it on my desktop with an icon.",
};

export interface NewAppRequest {
  name: string;
  description: string;
  template: NewAppTemplate;
}

/**
 * The one message the New wizard hands to the chat.
 *
 * English on purpose, like buildFixErrorPrompt: it is addressed to the
 * assistant, not shown as UI copy, and it names the steps the assistant has
 * tools for — code_project_init, coding_agent_run, the browser, the desktop
 * — so the request lands as a plan rather than a wish. The template is named
 * the way code_project_init's argument is spelled.
 */
export function buildNewAppPrompt(req: NewAppRequest): string {
  const name = req.name.trim();
  // One sentence, whatever punctuation the owner typed: strip a trailing full
  // stop so the description does not end "...timer.." after ours.
  const what = req.description.trim().replace(/[.\s]+$/u, "");
  return [
    `Create a new ClawBox app called "${name}": ${what}.`,
    SCAFFOLD_SENTENCE[req.template],
  ].join("\n");
}

/** An existing project the wizard can point the next run at — the projects route's row, trimmed. */
export interface ResumeProjectRequest {
  name: string;
  directory: string;
  kind: "folder" | "codeProject";
  /** For a code project: its id under data/code-projects, what code_project_build takes. */
  folder: string;
  /** What the next run should do, in the owner's words. */
  instructions: string;
  /** The newest run that worked in this folder, if any has. */
  latestRun?: { id: string; status: string; task: string } | null;
}

/**
 * The one message the wizard hands to the chat for an EXISTING project.
 *
 * English, addressed to the assistant like buildNewAppPrompt, and it names
 * the steps that make a second run pick up where the first left off: the
 * folder (never a fresh scaffold), the last run's summary and the commits
 * before any change, the verification and commit after, and — for a code
 * project — the rebuild that puts the result back on the desktop.
 */
export function buildResumeProjectPrompt(req: ResumeProjectRequest): string {
  const what = req.instructions.trim().replace(/[.\s]+$/u, "");
  const last = req.latestRun;
  const lastTask = last ? last.task.trim().split(/\r?\n/)[0].slice(0, 160) : "";
  const lines = [
    `Continue the existing ClawBox project "${req.name.trim()}" in ${req.directory}: ${what}.`,
    `Start a coding agent run in that folder (coding_agent_run with directory "${req.directory}") — do not scaffold a new project.`,
    last
      ? `Its last run (${last.id}, ${last.status}) was: "${lastTask}". Read that run's summary and the project's recent commits before changing anything, so this run picks up where it left off.`
      : "Read the project's recent commits and its files before changing anything, so this run picks up where the last work left off.",
    req.kind === "codeProject"
      ? `This is a code project (id "${req.folder}"): when the run is done, rebuild it with code_project_build so the desktop app shows the change.`
      : "When the run is done, tell me what changed, what was verified, and what is left for the next run.",
  ];
  if (req.kind === "codeProject") lines.push("Then tell me what changed, what was verified, and what is left for the next run.");
  return lines.join("\n");
}

/**
 * The message that asks the assistant for a coding TEAM on an existing
 * project — the multi-agent shape (coding_team_run): a planner splits the
 * goal, workers do the parts one after another, a reviewer checks each. The
 * project page's "Plan with the assistant" button opens the Create App card
 * with the team switch on, and this is what the card then hands the chat.
 */
export function buildTeamProjectPrompt(req: Omit<ResumeProjectRequest, "latestRun">): string {
  // Trailing periods come off so the sentence reads as one; a goal that is
  // nothing but periods keeps what the owner typed rather than becoming an
  // empty request.
  const trimmed = req.instructions.trim();
  const goal = trimmed.replace(/[.\s]+$/u, "") || trimmed;
  const target = req.kind === "codeProject" ? `project_id "${req.folder}"` : `directory "${req.directory}"`;
  return [
    `Run a coding TEAM on the existing ClawBox project "${req.name.trim()}" in ${req.directory}: ${goal}.`,
    `Start it with coding_team_run (${target}) — the planner reads the folder and splits the goal into tasks, workers do them one after another, and a reviewer checks each result. Do not start single runs for the parts yourself.`,
    "Tell me when it is running, and check on it later with coding_team_status; when it is done, summarise what each task did and what was verified.",
    ...(req.kind === "codeProject" ? ["When the team is done, rebuild the code project with code_project_build so the desktop app shows the change."] : []),
  ].join("\n");
}

export function buildFixErrorPrompt(ctx: FixErrorContext): string {
  const lines = [
    `I just hit an error in the ${ctx.source || "ClawBox UI"}. Please investigate why and fix it.`,
    "",
    "Error message:",
    ctx.message,
  ];
  if (ctx.details) lines.push("", "Extra context:", ctx.details);
  lines.push(
    "",
    // Deliberately does NOT name units. It used to say `journalctl -u
    // clawbox-setup -u clawbox-gateway`, and clawbox-gateway does not exist on
    // Hermes — install removes and masks it — so on that edition the command
    // read an empty log and never mentioned clawbox-hermes-dashboard, which is
    // the one holding the answer. This module is bundled into the browser, so
    // it cannot read the root-owned edition file to pick the right list.
    //
    // It does not need to: the agent has `logs_tail`, whose unit enum is
    // already built per edition in mcp/tools/system.ts. Pointing at the tool
    // instead of at a guessed command is both shorter and incapable of going
    // stale the next time the unit set changes.
    "Steps: read the relevant service logs with the `logs_tail` tool (it lists the services this device actually runs), check the failing command directly, and apply a concrete fix. Report back what you found and what you changed.",
  );
  return lines.join("\n");
}

/**
 * "The set of configured providers, or which one is default, changed."
 *
 * The EDITION-NEUTRAL signal. `HERMES_MODEL_STATE_EVENT` and
 * `CHAT_MODEL_STATE_EVENT` above each say the same thing for one harness, and
 * a listener that subscribed to only one of them went deaf on the other
 * edition — which is how the connection strip could sit on "Not connected"
 * after a successful sign-in on a box that had just connected.
 *
 * New emit sites should use `notifyProvidersChanged()` and new listen sites
 * `onProvidersChanged()`, which spans all three names so neither direction has
 * to know which harness it is running under.
 */
export const PROVIDERS_CHANGED_EVENT = "clawbox:providers-changed";

/**
 * "The device's Hermes provider set or selection changed."
 *
 * DEFINED HERE, not in the hook that used to own it, so that the module which
 * knows every provider signal does not have to import a React hook to name one
 * — that import would be a cycle, since the hook listens through this file.
 * `@/hooks/useHermesModelOptions` re-exports it, so its existing importers and
 * the test that pins its value are unaffected.
 */
export const HERMES_MODEL_STATE_EVENT = "clawbox:hermes-model-state-changed";

/** Emit the signal above. Call it wherever a provider configure SUCCEEDED. */
export function notifyHermesModelState(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(HERMES_MODEL_STATE_EVENT));
}

/**
 * Every name that means "re-ask the box about its providers".
 *
 * The two harness-specific names are included deliberately rather than migrated
 * away from: they have emit sites in components this feature does not touch,
 * and a listener that ignored them would be stale exactly where the old code
 * was already correct.
 */
const PROVIDER_SIGNAL_EVENTS = [
  PROVIDERS_CHANGED_EVENT,
  HERMES_MODEL_STATE_EVENT,
  CHAT_MODEL_STATE_EVENT,
] as const;

/**
 * Emit the signal above. Call it wherever a provider auth or default change
 * SUCCEEDED — a key saved, an OAuth flow approved, a provider removed, a new
 * default chosen.
 *
 * A signal, not data: every listener re-asks the server, because the write that
 * preceded this already dropped the server-side caches the answer comes from.
 * Passing the new state as `detail` would give each listener a second, older
 * source of truth to disagree with.
 */
export function notifyProvidersChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PROVIDERS_CHANGED_EVENT));
}

/**
 * Subscribe to "providers changed", DEBOUNCED, and return the unsubscribe.
 *
 * Debounced because one user action legitimately emits more than once: saving a
 * key POSTs the credential and then the pairing, and both succeed, and both
 * notify. Undebounced, each listener then fired a duplicate round-trip — and on
 * a Jetson the provider status call is a `hermes` spawn, so the duplicate is
 * measured in seconds, not milliseconds.
 *
 * `events` narrows the set for the rare listener that must NOT wake on all
 * three. It exists for the model CATALOGUE, which is a fact about the box and
 * not about the chat's current selection: `CHAT_MODEL_STATE_EVENT` means "the
 * selection changed", and re-enumerating a catalogue for that would ask a
 * Jetson for a ~3-minute `openclaw models list` over a pick the customer made
 * from the list it already had. Narrowing stays an OPTION rather than a second
 * helper so the debounce, the unsubscribe and the pending-timer cancellation
 * below have exactly one implementation — the copy of them that briefly lived
 * in `useProviderCatalog` is what this parameter deletes.
 *
 * The debounce lives HERE, on the listen side, rather than inside
 * `notifyProvidersChanged`. An emitter-side debounce would collapse two
 * genuinely different writes from two different components into one, and the
 * second write's result would never be read. On this side each listener
 * coalesces only what it would itself have re-fetched.
 */
export const PROVIDER_SIGNAL_DEBOUNCE_MS = 150;

export function onProvidersChanged(
  listener: () => void,
  options: { debounceMs?: number; events?: readonly string[] } = {},
): () => void {
  if (typeof window === "undefined") return () => {};
  const wait = options.debounceMs ?? PROVIDER_SIGNAL_DEBOUNCE_MS;
  const names = options.events ?? PROVIDER_SIGNAL_EVENTS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onSignal = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      listener();
    }, wait);
  };
  for (const name of names) window.addEventListener(name, onSignal);
  return () => {
    // Cancel the pending call as well as unsubscribing: a listener that fires
    // after its component unmounted is a setState on a dead tree, and this is
    // the one place the timer is reachable.
    if (timer) clearTimeout(timer);
    for (const name of names) window.removeEventListener(name, onSignal);
  };
}

/**
 * "The coding agent's settings changed" — the switch, the folder, the effort,
 * a ceiling, or the GitHub account.
 *
 * Needed because the settings and the runs are two components now. While the
 * switch lived in the Coding Agent app, the app's On/Off chip, its readiness
 * checklist and a run's Backup button could not disagree with it; in Settings
 * the switch is a different window, and the app only re-reads the box on
 * mount and while a run is live. Without this, the owner flipped the switch
 * and came back to a window still saying Off.
 *
 * A signal, not data, for the reason `notifyProvidersChanged` gives: the
 * listener re-asks the routes, so there is one source of truth.
 */
export const CODING_AGENT_CHANGED_EVENT = "clawbox:coding-agent-changed";

/** Emit the signal above. Call it wherever a coding agent setting was SAVED
 *  — after the route answered, never on the click. */
export function notifyCodingAgentChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CODING_AGENT_CHANGED_EVENT));
}

/** Subscribe to "coding agent changed" and return the unsubscribe. Undebounced:
 *  one save is one event, and a listener already coalesces its own fetches. */
export function onCodingAgentChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CODING_AGENT_CHANGED_EVENT, listener);
  return () => window.removeEventListener(CODING_AGENT_CHANGED_EVENT, listener);
}

/**
 * "Memory Shard's switch, or its setup, changed."
 *
 * The same need the coding agent's signal answers, for the same reason: the
 * switch lives on a settings page that can be open while a second Memory Shard
 * window — or the standalone /app/memory-shard on a phone — shows the On/Off
 * chip and the indexing buttons the switch governs. Without this the owner
 * switched it off in one window and the other kept offering "Index now".
 *
 * A signal, not data: the listener re-reads the status route, so there stays
 * one source of truth for what the box is doing.
 */
export const MEMORY_SHARD_CHANGED_EVENT = "clawbox:memory-shard-changed";

/** Emit the signal above — after the route answered, never on the click. */
export function notifyMemoryShardChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(MEMORY_SHARD_CHANGED_EVENT));
}

/** Subscribe to "memory shard changed" and return the unsubscribe. */
export function onMemoryShardChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(MEMORY_SHARD_CHANGED_EVENT, listener);
  return () => window.removeEventListener(MEMORY_SHARD_CHANGED_EVENT, listener);
}

/**
 * "A coding run was just started, or just finished, somewhere this browser
 * can see."
 *
 * The chat's run cards (useCodingAgentActivity) probe the box once when the
 * chat opens and again when a coding-agent tool call passes through the chat
 * itself — nothing else, by design: an idle box is not polled. That left one
 * gap: a run the owner started from the Coding Agent app while the chat sat
 * open was never adopted, because nothing told the chat to look. This is
 * that signal. Deliberately NOT `CODING_AGENT_CHANGED_EVENT`, whose contract
 * is "a setting was SAVED" and whose listener in the app reloads the whole
 * window — the app emitting it on its own start would reload itself.
 *
 * A signal, not data, like the others here: the listener re-asks the runs
 * route, which is the one source of truth for what a run is doing.
 */
export const CODING_RUN_STARTED_EVENT = "clawbox:coding-run-started";

/** Emit the signal above. Call it once the run route has ANSWERED that a run
 *  is on its way (202), or when the desktop hears that one finished — never
 *  on the click. */
export function notifyCodingRunStarted(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CODING_RUN_STARTED_EVENT));
}

/** Subscribe to "a coding run started" and return the unsubscribe. */
export function onCodingRunStarted(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CODING_RUN_STARTED_EVENT, listener);
  return () => window.removeEventListener(CODING_RUN_STARTED_EVENT, listener);
}

/**
 * Settings → Voice saved the spoken-replies switch: `{ autoReply: boolean }`.
 * The open chat listens so its next voice turn honours the new position
 * without a reopen.
 */
export const VOICE_SETTINGS_CHANGED_EVENT = "clawbox:voice-settings-changed";
