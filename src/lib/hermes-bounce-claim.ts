import {
  bounceHermesDashboard,
  hermesDashboardMainPid,
  type HermesBounceOutcome,
} from "@/lib/hermes-dashboard-control";
import { readHermesPluginDeclaration } from "@/lib/hermes-plugin-set";
import { logSafe } from "@/lib/log-safe";
import { processStore } from "@/lib/process-store";

/**
 * WHO IS ALLOWED TO STOP THE HERMES DASHBOARD RIGHT NOW, and what the
 * replacement will have read when it comes back.
 *
 * A module of its own, and a small one on purpose. The bounce has three callers
 * in the product — the plugin watcher and its route, a ClawKeep restore, and the
 * image refresh — and the two that are not the watcher used to call
 * `bounceHermesDashboard()` directly, so neither raised the watcher’s gate nor
 * moved its baseline: one ClawKeep restore was TWO chat outages, its own and the
 * watcher’s eight seconds later, with two "open a new chat" notices about a
 * plugin set nobody had touched. The claim belongs to the BOUNCE rather than to
 * one of its callers, so it lives here, where every caller can reach it without
 * dragging in the owner-notice machinery the watcher needs.
 */

export interface PluginReloadState {
  /** The signature the running dashboard is believed to have read. */
  baseline: string | null;
  /** A bounce is in flight, from the watcher, the route, or anything else. */
  bouncing: boolean;
  /**
   * A bounce was TAKEN for this signature and the replacement was not serving
   * by the end of the budget. The baseline must not move on that — "the stop
   * took" is not "the new process is up" — but the answer is to WAIT and look
   * again, never to stop it once more. See the watcher's reconcile step.
   */
  awaiting: string | null;
  /**
   * The main pid that bounce tried to stop, so the reconcile can tell a
   * REPLACEMENT from the process that never went away.
   *
   * `bounceHermesDashboard` answers `pending` for any unit state that is not
   * `running`/`down`, and "systemd could not be asked, twice" is one of those —
   * with the old process still serving. The port probe then succeeds, because it
   * is the OLD process answering, and the reconcile recorded the change as
   * loaded and stopped trying. Null when it could not be read, which is not a
   * fact about anything and leaves the probe alone.
   */
  awaitingPid: number | null;
  /**
   * WHAT THE BOUNCE THAT HOLDS THE CLAIM IS FOR, so a second caller can be
   * told apart from a duplicate of the one already running. Null while nothing
   * is in flight.
   */
  activeKind: HermesBounceKind | null;
  /**
   * The declaration signature the in-flight PLUGIN RELOAD is acting on, when it
   * is known. Null for every other kind of bounce and whenever the caller could
   * not read one — and null is "cannot be compared", never "the same".
   */
  activeSignature: string | null;
  /**
   * A caller arrived while the claim was held, so ONE more bounce is owed.
   *
   * `"in_flight"` says another restart owns the dashboard. It does NOT say the
   * replacement will have read what THAT caller just wrote: every caller here
   * mutates `~/.hermes` and then asks for the restart, and the running bounce
   * read the files at the moment IT started — a ClawKeep restore that rewrites
   * the whole directory a second later is served by a process that never saw
   * it, and nothing tried again. The declaration signature cannot catch it
   * either: a restore can put back a byte-identical plugin set beside a
   * completely different `state.db`.
   *
   * Recorded rather than acted on inside the running bounce, because the
   * running bounce is somebody's REQUEST — the route budgets 45 s and the MCP
   * tool 60 — and a second stop chained onto it would answer that request
   * ~80 s late over a restart that had already succeeded.
   */
  owed: boolean;
}

/**
 * The baseline of a box the first look found BEHIND the files: a value no
 * declaration signature can take, so every comparison with it says "changed".
 */
export const BASELINE_BEHIND = "behind";

/**
 * WHAT A CALLER IS BOUNCING FOR, and the only thing that decides whether a
 * second one arriving mid-bounce owes another restart.
 *
 * `"plugin_reload"` is the one mutation this module can COMPARE: it is entirely
 * described by the declaration signature, so two of them for the same signature
 * are the same request and the replacement already coming up serves both.
 * `"mutation"` is everything else — a ClawKeep restore, the image refresh — and
 * it is the DEFAULT on purpose: a caller that has not said what it changed is a
 * caller whose change the signature cannot represent.
 */
export type HermesBounceKind = "plugin_reload" | "mutation";

export function hermesBounceState(): PluginReloadState {
  return processStore<PluginReloadState>("clawbox.hermes-plugin-reload", () => ({
    baseline: null,
    bouncing: false,
    awaiting: null,
    awaitingPid: null,
    activeKind: null,
    activeSignature: null,
    owed: false,
  }));
}

/** Exported for the suites, which build several watchers in one process. */
export function _resetHermesPluginReloadStateForTests(): void {
  const state = hermesBounceState();
  state.baseline = null;
  state.bouncing = false;
  state.awaiting = null;
  state.awaitingPid = null;
  state.activeKind = null;
  state.activeSignature = null;
  state.owed = false;
}


/**
 * Restart the dashboard under the shared claim, and record what the replacement
 * will have read. NEVER THROWS — `bounceHermesDashboard` does not either.
 *
 * `"in_flight"` is its own answer and not a failure: another caller owns this
 * restart, its replacement reads the files as they are NOW, and a second stop
 * would add an outage and prove nothing.
 *
 * @param reason why, in the caller's words, for the journal line.
 */
export async function bounceHermesDashboardShared(
  reason: string,
  opts: { signature?: string; kind?: HermesBounceKind } = {},
): Promise<HermesBounceOutcome | "in_flight"> {
  const shared = hermesBounceState();
  // UNSAID IS "MUTATION": a caller that has not named its kind has changed
  // something this module cannot compare, and it keeps the debt.
  const kind: HermesBounceKind = opts.kind ?? "mutation";
  // THE CLAIM IS TAKEN BEFORE THE FIRST AWAIT. It used to be set AFTER reading
  // the declaration, so two callers arriving together — the owner's card and the
  // agent's `hermes_plugins_reload` — both got past the check and both stopped
  // the dashboard, and the first `finally` then cleared a flag the second bounce
  // was still relying on. That cleared flag is the window the watcher SIGTERMs a
  // restarting dashboard through. Only the caller that SET it clears it.
  //
  // A CLAIM AND NOT A QUEUE, deliberately — `createSerialLock` is the other tool
  // this codebase has for "one at a time" and it is the wrong one here: the
  // second caller would WAIT and then stop the dashboard a second time for a
  // plugin set the first bounce's replacement has already read, and pay the
  // whole of a second bounce inside its own request to do it.
  //
  // WHAT IT OWES INSTEAD is one more bounce, recorded and handed to the watcher
  // (see `owed`): this caller's own mutation landed after the running bounce
  // read the files, so the replacement coming up may not carry it.
  //
  // UNLESS IT IS THE SAME REQUEST. A debt for EVERY in-flight caller made the
  // commonest pair of all — the owner's card and the agent's
  // `hermes_plugins_reload`, pressed within a second of each other — cost the
  // owner's chat a SECOND restart: two plugin reloads for one declaration, the
  // replacement already coming up carrying it, and `BASELINE_BEHIND` on its way
  // out telling the watcher to bounce again for nothing. Two plugin reloads with
  // the same signature ARE one request; anything else is not, and an unknown
  // signature on either side is not a match. A restore or an image refresh keeps
  // the debt whatever the signature says — see `HermesBounceKind`.
  if (shared.bouncing) {
    const duplicate =
      kind === "plugin_reload" &&
      shared.activeKind === "plugin_reload" &&
      typeof opts.signature === "string" &&
      shared.activeSignature !== null &&
      opts.signature === shared.activeSignature;
    if (!duplicate) shared.owed = true;
    return "in_flight";
  }
  shared.bouncing = true;
  shared.activeKind = kind;
  // From the caller when it read one, and filled in below from this module's own
  // reading when it did not. Never left over from the previous bounce.
  shared.activeSignature = kind === "plugin_reload" ? opts.signature ?? null : null;
  try {
    // WHAT THE REPLACEMENT WILL HAVE READ, captured BEFORE the stop and never
    // after it. A bounce is up to 45 s long and `hermes plugins install` can
    // land another write inside that window; recording the post-bounce
    // signature would mark a change the new process never saw as loaded, and
    // nothing would ever try again. The pre-bounce reading is the conservative
    // one: a write that landed during the bounce simply stays outstanding and
    // the watcher catches it. The caller passes the signature it already read
    // rather than paying for a second reading of the same two files.
    const acted =
      opts.signature ?? (await readHermesPluginDeclaration().then((d) => d.signature).catch(() => null));
    // The reading above is this bounce's answer to "which plugin set is the
    // replacement getting", so a caller arriving from here on can be compared
    // against it. Before it lands `activeSignature` is null, and null refuses
    // the comparison rather than guessing at it.
    if (kind === "plugin_reload" && shared.activeSignature === null) shared.activeSignature = acted;
    // One local `systemctl show` on a path about to spend up to 45 s, so a
    // `pending` outcome can be reconciled against the process it tried to stop.
    const outgoing = await hermesDashboardMainPid().catch(() => ({ read: false, pid: null }));
    const outcome = await bounceHermesDashboard();
    // THE BASELINE IS THIS MODULE'S, not the watcher's, so a reload asked for
    // through the route, the MCP tool, a ClawKeep restore or the image refresh
    // moves it too — see `PluginReloadState`. Only a bounce whose replacement is
    // SERVING moves it: `pending` means the stop took and systemd owns the unit,
    // which is a reason to look again rather than to call the change loaded.
    if (acted !== null) {
      if (outcome === "restarted") {
        shared.baseline = acted;
        shared.awaiting = null;
        shared.awaitingPid = null;
      } else if (outcome === "pending") {
        shared.awaiting = acted;
        shared.awaitingPid = outgoing.read ? outgoing.pid : null;
      }
    }
    if (outcome === "failed") {
      console.error(`[hermes/bounce] ${logSafe(reason, 120)}: the Hermes dashboard could not be restarted`);
    }
    return outcome;
  } finally {
    // THE DEBT IS PAID BY THE WATCHER, not by a second stop chained onto this
    // caller's request. `BASELINE_BEHIND` is the sentinel that already means
    // "whatever the running dashboard loaded, it is not what is on disk" — no
    // 32-hex signature can equal it — so the next tick opens a window and takes
    // exactly ONE more bounce, debounced with anything else that arrives. That
    // is what makes this work for a restore whose plugin set did not move: the
    // watcher's own comparison is on the signature, and this is not.
    //
    // `awaiting` goes with it: a `pending` recorded above would otherwise have
    // the next tick reconcile the very restart we have just decided is not
    // enough.
    //
    // Wholly SYNCHRONOUS, with no await between the read and the clear, so a
    // caller arriving mid-way cannot have its request dropped here — it either
    // set the flag before this runs, or finds `bouncing` false and takes the
    // claim itself.
    if (shared.owed) {
      shared.owed = false;
      shared.baseline = BASELINE_BEHIND;
      shared.awaiting = null;
      shared.awaitingPid = null;
    }
    shared.bouncing = false;
    shared.activeKind = null;
    shared.activeSignature = null;
  }
}
