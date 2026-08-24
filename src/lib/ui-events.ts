// Window-level CustomEvent names shared between page.tsx and components.
// Defining them in one place avoids typo drift between the dispatch and
// listen sites.

export const OPEN_APP_EVENT = "clawbox:open-app";
export const FIX_ERROR_EVENT = "clawbox:fix-error";

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

export interface FixErrorContext {
  source: string;
  message: string;
  details?: string;
}

export function dispatchFixError(ctx: FixErrorContext): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FIX_ERROR_EVENT, { detail: ctx }));
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
    "Steps: read relevant logs (e.g. `journalctl -u clawbox-setup -u clawbox-gateway -n 200`), check the failing command directly, and apply a concrete fix. Report back what you found and what you changed.",
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
export function onProvidersChanged(
  listener: () => void,
  options: { debounceMs?: number } = {},
): () => void {
  if (typeof window === "undefined") return () => {};
  const wait = options.debounceMs ?? 150;
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
