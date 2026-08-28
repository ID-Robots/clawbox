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
export const OPEN_SETTINGS_SECTION_EVENT = "clawbox:open-settings-section";

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

export function dispatchOpenApp(appId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_APP_EVENT, { detail: { appId } }));
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
export type NewAppTemplate = "app" | "blank";

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
    `Scaffold it as a code project from the "${req.template}" template, build it with the coding agent, verify it in the browser, and put it on my desktop.`,
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
 * The debounce lives HERE, on the listen side, rather than inside
 * `notifyProvidersChanged`. An emitter-side debounce would collapse two
 * genuinely different writes from two different components into one, and the
 * second write's result would never be read. On this side each listener
 * coalesces only what it would itself have re-fetched.
 */
export const PROVIDER_SIGNAL_DEBOUNCE_MS = 150;

export function onProvidersChanged(
  listener: () => void,
  options: { debounceMs?: number } = {},
): () => void {
  if (typeof window === "undefined") return () => {};
  const wait = options.debounceMs ?? PROVIDER_SIGNAL_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onSignal = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      listener();
    }, wait);
  };
  for (const name of PROVIDER_SIGNAL_EVENTS) window.addEventListener(name, onSignal);
  return () => {
    // Cancel the pending call as well as unsubscribing: a listener that fires
    // after its component unmounted is a setState on a dead tree, and this is
    // the one place the timer is reachable.
    if (timer) clearTimeout(timer);
    for (const name of PROVIDER_SIGNAL_EVENTS) window.removeEventListener(name, onSignal);
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
