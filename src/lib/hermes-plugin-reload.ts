import { hasHermesHarness } from "@/lib/edition-source";
import { notifyOwner } from "@/lib/email-notify";
import {
  hermesDashboardMainPid,
  hermesDashboardServing,
  hermesDashboardUnitState,
} from "@/lib/hermes-dashboard-control";
import {
  BASELINE_BEHIND,
  bounceHermesDashboardShared,
  hermesBounceState,
  _resetHermesPluginReloadStateForTests,
} from "@/lib/hermes-bounce-claim";
import { logSafe } from "@/lib/log-safe";
import {
  readHermesPluginDeclaration,
  readHermesPluginState,
  type HermesPluginState,
} from "@/lib/hermes-plugin-set";

// Re-exported from the module the CLAIM lives in, so the route, the watcher and
// the suites keep one import path for the whole mechanism.
export { bounceHermesDashboardShared, _resetHermesPluginReloadStateForTests };

/**
 * Make a Hermes plugin installed after boot reach the chat.
 *
 * ── THE MECHANISM IS HERMES' OWN, AND IT IS A RESTART ────────────────────────
 *
 * Hermes has NO runtime plugin reload, and this was checked before anything here
 * was written rather than assumed. Skills have `/reload-skills`; MCP has
 * `reload.mcp` on the dashboard socket, which ClawBox already drives
 * (`src/lib/hermes-mcp-reload.ts`); the dashboard even has
 * `/api/dashboard/plugins/rescan` — but that one re-scans the dashboard's own UI
 * extensions, not the agent's plugin registry. For the agent's plugins there is
 * exactly one instruction, and Hermes prints it itself at the end of every
 * install (`hermes_cli/plugins_cmd.py:857`):
 *
 *     Restart the gateway for the plugin to take effect:
 *       hermes gateway restart
 *
 * On this SKU the process that serves chat is not `hermes-gateway` — that unit
 * carries Telegram and friends and is inactive on the owner's box. It is
 * ClawBox's own `clawbox-hermes-dashboard.service`. So the instruction reads:
 * restart the dashboard.
 *
 * ── THERE IS NO NEW PRIVILEGE HERE, AND THERE MUST NOT BE ────────────────────
 *
 * The obvious fix is a sudoers grant for `systemctl restart
 * clawbox-hermes-dashboard`, and it is the wrong one twice over.
 *
 * It is unnecessary: `bounceHermesDashboard()` already restarts this exact unit
 * with no root at all. It runs `hermes dashboard --stop`, which is upstream's
 * own SIGTERM-grace-SIGKILL path over a process the clawbox user owns — the
 * unit's own `ExecStartPre` runs the same command — and the unit's
 * `Restart=always` brings it back. It then proves the restart rather than
 * assuming it: a NEW main PID from systemd, and :9119 answering again.
 *
 * And it is unsafe: `systemctl restart` STARTS a stopped unit, so the grant
 * would let anything with clawbox-level access on an OPENCLAW box resurrect the
 * Hermes dashboard that `step_edition_foreign_teardown` had just stopped and
 * disabled — the state that had two harnesses long-polling one Telegram token
 * and the box unable to receive a message for hours.
 * `src/tests/unit/install-foreign-edition-teardown.test.ts` owns that invariant
 * and `src/tests/unit/install-sudoers-migration.test.ts` asserts it from the
 * installed file ("still grants nothing over a Hermes dashboard unit").
 *
 * So this module adds no grant, changes no sudoers file, and the route above it
 * contains the string `sudo` nowhere — which its own suite asserts.
 *
 * ── WHAT IS ACTUALLY NEW ─────────────────────────────────────────────────────
 *
 * Knowing WHEN to restart, doing it once per burst, proving what the replacement
 * loaded, and telling the owner — because the restart drops their open chat
 * window. That is not a side effect to be minimised; it is the visible half of
 * the feature, and the notice is what turns it from a glitch into an answer.
 *
 * ── WHAT IS NOT GUARDED, SAID OUT LOUD ───────────────────────────────────────
 *
 * A turn in flight is interrupted. The dashboard exposes no active-run signal
 * this could ask — the socket's method surface has `reload.mcp`, `reload.env`,
 * `commands.catalog`, `image.generate`, the session methods and the turn
 * transport, and none of them reports "a turn is running". Inferring it from a
 * slow reply would be a guess, and a guess here either bounces a box that was
 * merely busy or defers for ever on a box that is merely slow. The debounce
 * window below is what keeps this to one interruption per action, and the notice
 * is what explains it.
 */

/**
 * How long the declaration must hold still before a restart.
 *
 * `hermes plugins install` is several writes, not one: the plugin directory, the
 * install ledger, then `plugins.enabled` in config.yaml if `--enable` was
 * passed, and an `enable` afterwards is another. Each is a change, and one
 * restart per write is four outages for one action — and the first of them would
 * restart into a half-declared set and have to do it again.
 *
 * Sized against the action rather than the file system: eight seconds is longer
 * than any single `hermes plugins` invocation spends between its writes, and
 * short enough that an owner who installs a plugin and opens the chat finds it
 * there.
 */
export const HERMES_PLUGIN_DEBOUNCE_MS = 8_000;

/** How often the declaration is read. Two small local file reads. */
export const HERMES_PLUGIN_POLL_MS = 5_000;

/**
 * The ceiling on retrying a restart that failed.
 *
 * A bounce spends up to its whole 45 s budget before answering "failed", and the
 * commonest reason for that answer is a unit systemd has GIVEN UP on — a
 * crash-looping dashboard past its start limit, which this module is
 * unprivileged to `reset-failed`. Retrying such a box every debounce window is a
 * SIGTERM every few seconds against a process that is already failing to start,
 * for the life of the web server. The same shape, and the same answer, as the
 * two child supervisors in `src/instrumentation-node.ts`: double the wait, cap
 * it, and keep trying — because the plugin really is still not loaded.
 */
export const HERMES_PLUGIN_RETRY_MAX_MS = 5 * 60_000;

/**
 * WHAT THE RUNNING DASHBOARD IS BELIEVED TO HAVE LOADED, once per PROCESS.
 *
 * In `process-store.ts` and not in a module-level `let`, for the reason that
 * module exists: `src/instrumentation.ts` reaches this file through
 * `require('./lib/hermes-plugin-reload')` while the route `import`s it, and Next
 * compiles those into two different module instances inside the one web server.
 * Kept per copy, the watcher's baseline could not be moved by a reload the ROUTE
 * performed — so the assistant calling `hermes_plugins_reload` right after
 * `hermes plugins install` (which is exactly what the tool tells it to do)
 * bounced the dashboard at once, and the watcher, which had seen the same
 * signature change, bounced it again eight seconds later, inside the first
 * bounce's 45 s budget: the owner's chat dropped twice in fifteen seconds and
 * they were told to open a new one twice. `POST /setup-api/clawkeep/restore` has
 * the same shape — it rewrites `~/.hermes` and bounces the dashboard itself.
 *
 * `bouncing` closes the other half of that: while ANY caller is mid-bounce the
 * watcher opens no window, so it cannot SIGTERM a dashboard that is in the
 * middle of coming back.
 */
/** What one `reloadHermesPlugins` call did. */
export interface HermesPluginReloadResult {
  /** The restart was TAKEN — the stop landed over a unit that restarts itself. */
  readonly restarted: boolean;
  /**
   * Nothing was done because ANOTHER caller's bounce is already under way.
   *
   * Its own field beside `restarted: false`, because the two need opposite
   * things said: a bounce that could not be taken is a failure the caller must
   * report, while this one means the restart the caller asked for is happening
   * and asking again would add an outage.
   */
  readonly inFlight: boolean;
  /** …and the replacement is SERVING again. `restarted && !ready` is "on its way". */
  readonly ready: boolean;
  /** What the box declares now. Always answered. */
  readonly plugins: readonly string[];
  /** What the replacement proved it registered, or null when it could not be asked. */
  readonly loaded: readonly string[] | null;
  /**
   * Is the process now serving chat STILL behind the files? False is the proof a
   * restart actually took, and on most boxes it is the ONLY proof available —
   * measured on the owner's device, the dashboard publishes no registration
   * lines at all, so `loaded` is null there and this is what answers. Null means
   * even this could not be established.
   */
  readonly stale: boolean | null;
  /** One sentence for a journal line and for the route's body. */
  readonly detail: string;
}

/**
 * The owner-facing sentence. ClawBox's words, never a plugin's own: the names
 * come from a directory a publisher chose, so they are bounded and never used as
 * anything but text.
 */
function noticeFor(names: readonly string[]): string {
  const named = names.slice(0, 3).map((n) => logSafe(n, 40)).join(", ");
  const subject = named ? `the plugin ${named}` : "a new plugin";
  return `The assistant restarted to load ${subject} — open a new chat to use it.`;
}

/**
 * Restart the dashboard so it re-scans for plugins, and report what came back.
 *
 * NEVER THROWS. Every caller is either a poll loop that must not die or a route
 * that has to answer something; `bounceHermesDashboard` never throws either, and
 * the readers below answer null rather than raising.
 *
 * @param reason why, in the caller's words, for the journal line.
 */
/**
 * How long the POST-BOUNCE read may take before the answer goes out without it.
 *
 * THE RESTART IS THE OUTCOME; `loaded` and `stale` are a courtesy beside it, and
 * they are the only thing this read produces. It is not cheap — `plugins.list`
 * is budgeted at 8 s, its journal fallback at 10 s and `plugins.manage` at 15 s,
 * and the deny-list branch makes that last one ordinary on any box whose owner
 * has switched a plugin off — so unbounded it stacked up to ~33 s on top of the
 * bounce's own 45-50 s ceiling. The MCP tool waits 60 s and would then have told
 * the agent "the restart was started but did not report back in time" over a
 * restart that had succeeded and was serving: a false failure, on the one call
 * whose whole purpose is to say whether the plugin is live.
 *
 * Cut short, the read answers what a read that could not be made answers —
 * `loaded: null`, `stale: null`, "could not be asked" — which every caller here
 * already handles and none reads as "not loaded". The RPCs left running carry
 * their own timeouts and end on their own.
 *
 * The WATCHER's reads are deliberately not bounded by this: nobody is waiting on
 * a tick, and its reconcile read is proof rather than a courtesy.
 */
const POST_BOUNCE_READ_BUDGET_MS = 10_000;

/**
 * `readHermesPluginState()` within the budget above, or the caller's fallback.
 *
 * The `catch` is attached to the read itself rather than to the race, so a
 * rejection that lands after the budget has expired is still handled.
 */
async function readStateWithin<T>(fallback: T): Promise<HermesPluginState | T> {
  const read = readHermesPluginState().catch(() => fallback);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), POST_BOUNCE_READ_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function reloadHermesPlugins(
  reason: string,
  opts: ReloadOptions = {},
): Promise<HermesPluginReloadResult> {
  const names = opts.names;
  // READ BEFORE THE CLAIM IS ASKED FOR, not inside it. The claim compares this
  // caller's declaration signature with the one the in-flight bounce is acting
  // on, and that comparison has to be made without an await — a debt recorded
  // after the running bounce's `finally` is a debt nothing will ever pay. The
  // watcher passes the signature it has already read; the route and the MCP tool
  // behind it pass none, and this is where theirs comes from. A read that failed
  // leaves it undefined, which the claim treats as "cannot be compared".
  const signature =
    opts.signature ?? (await readHermesPluginDeclaration().then((d) => d.signature).catch(() => undefined));
  const outcome = await bounceHermesDashboardShared(reason, { signature, kind: "plugin_reload" });

  if (outcome === "in_flight") {
    // ANOTHER CALLER OWNS THIS RESTART, and its replacement reads the files as
    // they are NOW — so a second bounce would add an outage and prove nothing.
    // Reported as its own fact rather than as a failure: `restarted: false`
    // alone would have the route answer 502 and the agent tell the owner the
    // plugin could not be loaded, over a restart that is happening.
    const running = await readStateWithin(null);
    return {
      restarted: false,
      inFlight: true,
      ready: false,
      plugins: running?.declared ?? names ?? [],
      loaded: running?.loaded ?? null,
      stale: running?.stale ?? null,
      detail: "a restart of the Hermes dashboard is already under way",
    };
  }

  // Read AFTER the bounce, so `plugins` is what the box declares now and
  // `loaded` is what the REPLACEMENT registered — the process whose answer is
  // the only one that ever mattered here.
  const state: HermesPluginState = await readStateWithin<HermesPluginState>({
    declared: names ?? [],
    loaded: null,
    stale: null,
    dashboardStartedAt: null,
    changedAfterStart: null,
    signature: signature ?? "",
  });

  if (outcome === "failed") {
    // NOT a restart, and the caller must not be told otherwise: the plugin change is
    // still not applied to the running agent and the owner's chat still works.
    const detail =
      "the Hermes dashboard could not be restarted, so the plugin change is not active yet";
    console.error(`[hermes/plugin-reload] ${logSafe(reason, 120)}: ${detail}`);
    return { restarted: false, inFlight: false, ready: false, plugins: state.declared, loaded: state.loaded, stale: state.stale, detail };
  }

  const ready = outcome === "restarted";
  const detail = ready
    ? "the Hermes dashboard restarted and is serving again"
    : "the Hermes dashboard was stopped and systemd is bringing it back";
  console.log(`[hermes/plugin-reload] ${logSafe(reason, 120)}: ${detail}`);

  // The owner's open chat window has just gone. Best effort and never awaited
  // for its own sake — a notice that fails to appear must not turn a restart
  // that worked into a failure — but awaited here so a route's answer and the
  // toast cannot race on a box that is about to be told the plugin is live.
  await notifyOwner(noticeFor(names ?? state.declared)).catch(() => undefined);

  return { restarted: true, inFlight: false, ready, plugins: state.declared, loaded: state.loaded, stale: state.stale, detail };
}

export interface ReloadOptions {
  /** The plugins the notice should name. Read from the declaration when absent. */
  readonly names?: readonly string[];
  /**
   * The declaration signature this reload is FOR, when the caller has already
   * read it. Absent, it is read here — before the CLAIM, which is the only
   * moment at which it both means "what the replacement will have loaded" and
   * is in time to tell this reload apart from the one already in flight.
   */
  readonly signature?: string;
}

/** What one `tick()` decided. Named so a test — and a journal — can read it. */
export type HermesPluginTick =
  | "baseline"
  | "unchanged"
  | "waiting"
  | "restarted"
  /** A bounce was taken, the replacement has come up, and nothing was stopped. */
  | "reconciled"
  /** A bounce was taken and the replacement is not serving yet. */
  | "pending"
  | "failed"
  | "unreadable";

export interface HermesPluginWatcher {
  /** Look once and act if it is time. Never throws. */
  tick(): Promise<HermesPluginTick>;
}

export interface HermesPluginWatcherOptions {
  /** The clock, so a test can move it instead of waiting. */
  readonly now?: () => number;
  readonly debounceMs?: number;
}

/**
 * The watcher, as a thing that can be ticked.
 *
 * A TIMER IS NOT THE LOGIC, which is why the loop is somewhere else. Everything
 * that can be got wrong here — a boot that must not count as a change, a burst
 * that must collapse, a rewrite whose content is identical, a failed restart
 * that must not be recorded as done — is a decision about two signatures and a
 * clock, and all four are exercised by moving that clock by hand.
 */
export function createHermesPluginWatcher(
  opts: HermesPluginWatcherOptions = {},
): HermesPluginWatcher {
  const now = opts.now ?? Date.now;
  const debounceMs = opts.debounceMs ?? HERMES_PLUGIN_DEBOUNCE_MS;

  // The set the RUNNING dashboard is assumed to have loaded lives in
  // `PluginReloadState`, shared with every other caller that bounces the
  // dashboard — see that type for what kept it here cost.
  const shared = hermesBounceState();
  /** The signature the current debounce window is waiting on, and since when. */
  let pending: { signature: string; since: number } | null = null;
  /**
   * How long the NEXT window must be, after a restart that failed. Zero while
   * nothing has failed, so an ordinary change waits only the debounce.
   */
  let retryDelayMs = 0;

  /** The window this tick is measuring against: the debounce, or the backoff. */
  const windowMs = () => Math.max(debounceMs, retryDelayMs);

  return {
    async tick(): Promise<HermesPluginTick> {
      let declaration;
      try {
        declaration = await readHermesPluginDeclaration();
      } catch (err) {
        // A read that failed establishes nothing, so nothing is decided from it
        // — the baseline stands and the window, if one is open, stays open. The
        // poll loop must survive this: it runs for the life of the web server.
        console.warn(
          `[hermes/plugin-watch] could not read the plugin declaration: ${
            err instanceof Error ? logSafe(err.message, 160) : "unknown error"
          }`,
        );
        return "unreadable";
      }

      // A BOUNCE IS ALREADY IN FLIGHT — this one's or another caller's. Opening
      // a window over it is how one action became two outages: the route bounces
      // at once, the watcher sees the same change and SIGTERMs a dashboard that
      // is in the middle of coming back.
      if (shared.bouncing) return "waiting";

      if (shared.baseline === null) {
        // THE FIRST LOOK IS NOT AUTOMATICALLY A BASELINE, which is the whole of
        // what this asks. Adopting whatever is on disk is right when the running
        // dashboard has already read it, and wrong when it has not — and the
        // dashboard OUTLIVES the web server, so an update or a `clawbox-setup`
        // restart re-seeds from a file the chat backend has never seen.
        // `scripts/register-mcp.sh` makes that concrete: it runs at EVERY
        // web-server boot and can append the EMAIL-directive hook plugin to
        // `plugins.enabled`, and whether the plugin stayed invisible for the
        // rest of that dashboard's life was a race between its write and this
        // tick five seconds later.
        //
        // TWO FACTS, AND NEITHER ALONE. `stale` is about the RUNNING registry —
        // the box declares a plugin as enabled that the process does not have —
        // and it is the honest answer, but it is not self-limiting: a box whose
        // declaration and registry can never agree (a name that resolves to
        // nothing, a plugin that fails to load) would be behind for ever, and a
        // seed rule that read it alone would bounce the owner's chat at EVERY
        // web-server boot, for good. `changedAfterStart` is an mtime, so every
        // Settings save makes it true and it may not stand alone either — but it
        // IS self-limiting: once the dashboard has restarted, its start is newer
        // than those files. Together: bounce only when the process is
        // demonstrably missing something AND the files were touched after it
        // started, which is exactly the `register-mcp.sh` case and is true at
        // most once per dashboard. Unknown on either side seeds, because a
        // watcher that bounced the chat over what it could not establish would
        // be worse than one that waits for the next real change.
        const state = await readHermesPluginState().catch(() => null);
        if (state?.stale !== true || state.changedAfterStart !== true) {
          shared.baseline = declaration.signature;
          return "baseline";
        }
        console.log("[hermes/plugin-watch] the running dashboard is behind ~/.hermes; a restart is owed");
        // A baseline IS recorded — the sentinel, which no content hash can be
        // (`readHermesPluginDeclaration` answers 32 hex characters). Without one
        // this branch would be re-entered on every tick and the window it opens
        // would never close. What it says is exactly true: whatever the running
        // dashboard loaded, it is not what is on disk.
        shared.baseline = BASELINE_BEHIND;
        pending = { signature: declaration.signature, since: now() };
        return "waiting";
      }

      if (declaration.signature === shared.baseline) {
        // Includes a change that was UNDONE inside the window — installed and
        // removed again. Nothing is different from what the dashboard is running,
        // so there is nothing to restart for, and a backoff earned by the change
        // that has just gone away is not owed by the next one.
        pending = null;
        retryDelayMs = 0;
        shared.awaiting = null;
        shared.awaitingPid = null;
        return "unchanged";
      }

      if (!pending || pending.signature !== declaration.signature) {
        // Either the first sight of this change or another write on top of it.
        // Restarting the window rather than the clock is what makes a burst ONE
        // restart: `hermes plugins install` writes the directory, the ledger and
        // the config within a second or two of each other.
        pending = { signature: declaration.signature, since: now() };
        return "waiting";
      }

      if (now() - pending.since < windowMs()) return "waiting";

      const acted = pending.signature;

      // A BOUNCE ALREADY TAKEN FOR THIS SIGNATURE IS RECONCILED, NOT REPEATED.
      // `pending` from `bounceHermesDashboard` means the stop landed and
      // `Restart=always` owns the unit — the replacement, whenever it arrives,
      // reads the files as they are now. What is unproven is that it ARRIVED, so
      // the answer is to look, not to stop a process that is coming up. Only
      // once recovery is established as FAILED — systemd says the unit is down,
      // nothing is coming on its own — does this fall through to a new bounce.
      if (shared.awaiting === acted) {
        // IS THE PROCESS ANSWERING THE PORT A REPLACEMENT, or the one the bounce
        // tried to stop? `pending` covers "systemd could not be asked, twice",
        // where nothing was stopped at all and the OLD process answers the probe
        // perfectly well — reconciled on the probe alone, the watcher recorded
        // the change as loaded and never tried again. `false` here is that case
        // and is a reason to bounce AGAIN, not to wait for ever.
        const current = await hermesDashboardMainPid().catch(() => ({ read: false, pid: null }));
        const replaced =
          shared.awaitingPid !== null && current.read && current.pid !== null
            ? current.pid !== shared.awaitingPid
            : null;
        // A PORT THAT ANSWERS IS NOT A REPLACEMENT, and `null` is not a pid that
        // moved. `awaitingPid` is null whenever the pre-bounce read failed or
        // systemd reported the perfectly valid `MainPID=0`, and `current` is
        // null whenever this read fails — so a bounce that stopped nothing could
        // still be reconciled here on the probe alone, which is the same false
        // success the pid was added to close, one step further out.
        //
        // The other proof is the one the baseline is actually ABOUT: ask the
        // process that is serving whether it has the set the box declares.
        // `stale === false` is that answer and is stronger than a pid; `true` is
        // the running registry saying it has NOT read the change, which makes
        // this the same case as a pid that never moved. A `null` from either
        // establishes nothing and falls through to the wait below, where systemd
        // is asked whether anything is still coming.
        let loaded: boolean | null = replaced;
        if (replaced !== false && (await hermesDashboardServing())) {
          if (replaced === null) {
            const running = await readHermesPluginState().catch(() => null);
            loaded = running?.stale === false ? true : running?.stale === true ? false : null;
          }
          if (loaded === true) {
            shared.baseline = acted;
            shared.awaiting = null;
            shared.awaitingPid = null;
            pending = null;
            retryDelayMs = 0;
            return "reconciled";
          }
        }
        if (loaded === false) {
          // Nothing was replaced — either the same process is still the unit's
          // main one, or it is serving a registry that has not read the change.
          // Waiting longer changes nothing in either case, so the bounce is
          // retaken.
          console.error("[hermes/plugin-watch] the dashboard serving now has not loaded the change; bouncing again");
          shared.awaiting = null;
          shared.awaitingPid = null;
        } else {
          const unitState = await hermesDashboardUnitState().catch(() => "unknown" as const);
          if (unitState !== "down") {
            // Still on its way, in the RestartSec gap, or a state that cannot be
            // read. Wait longer each time rather than asking every poll.
            pending = { signature: acted, since: now() };
            retryDelayMs = widened(retryDelayMs, debounceMs);
            return "waiting";
          }
          console.error("[hermes/plugin-watch] the dashboard did not come back after its stop; bouncing again");
          shared.awaiting = null;
          shared.awaitingPid = null;
        }
      }

      const result = await reloadHermesPlugins("the box's Hermes plugin set changed", {
        names: declaration.names,
        signature: acted,
      });
      if (!result.restarted) {
        // THE BASELINE DOES NOT MOVE. A bounce that failed left the dashboard on
        // the OLD plugin set, so recording this signature as done would mean
        // nothing ever tried again and the plugin stayed invisible until the next
        // reboot — with the box reporting no work outstanding.
        //
        // The window re-opens rather than the retry firing on the next poll, and
        // it widens each time: a dashboard systemd has given up on would
        // otherwise take a SIGTERM every few seconds for ever. `pending` is kept
        // (not re-created) so a further write during the backoff is still seen as
        // a new change and resets it.
        pending = { signature: acted, since: now() };
        retryDelayMs = widened(retryDelayMs, debounceMs);
        return "failed";
      }
      if (!result.ready) {
        // TAKEN BUT NOT SERVING. `reloadHermesPlugins` has recorded this
        // signature as awaited rather than loaded; the next window reconciles it
        // above. The baseline deliberately does not move — a replacement that
        // never came up has read nothing.
        pending = { signature: acted, since: now() };
        retryDelayMs = widened(retryDelayMs, debounceMs);
        return "pending";
      }
      pending = null;
      retryDelayMs = 0;
      // NOT over a baseline the claim marked BEHIND on its way out. A caller
      // arrived while THIS bounce was in flight — a ClawKeep restore is the
      // worked example — so one more restart is owed, and writing the signature
      // this tick acted on would erase the only record of that debt: the
      // restore's own plugin set can be byte-identical, so nothing else here
      // would ever see a change again.
      if (shared.baseline !== BASELINE_BEHIND) shared.baseline = acted;
      return "restarted";
    },
  };
}

/** Double the wait, from the debounce, and never past the ceiling. */
function widened(current: number, debounceMs: number): number {
  return Math.min(current ? current * 2 : debounceMs * 2, HERMES_PLUGIN_RETRY_MAX_MS);
}

/** The live loop's handle, held so a dev hot-reload can replace it. */
let watcherTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start watching, on the editions that have a dashboard to restart.
 *
 * `hasHermesHarness()` — edition `hermes` or `dual` — is the predicate, and it is
 * the same one `install.sh` uses to decide whether to enable the dashboard unit
 * at all. Asking which harness is ACTIVE would be the wrong question on the dual
 * SKU, where the dashboard runs whichever agent is serving the owner.
 */
export function startHermesPluginWatcher(opts: HermesPluginWatcherOptions = {}): boolean {
  if (!hasHermesHarness()) return false;
  if (watcherTimer) clearInterval(watcherTimer);
  const watcher = createHermesPluginWatcher(opts);
  let running = false;
  watcherTimer = setInterval(() => {
    // One tick at a time. A restart holds a tick for up to the bounce's whole
    // budget (45 s), which is nine poll intervals, and a second tick inside it
    // would open a window over a box that is mid-restart.
    if (running) return;
    running = true;
    void watcher
      .tick()
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  }, opts.debounceMs ? Math.min(HERMES_PLUGIN_POLL_MS, opts.debounceMs) : HERMES_PLUGIN_POLL_MS);
  // Never hold the process open for a poll: this is a background reconciliation,
  // not work anything is waiting on.
  watcherTimer.unref?.();
  console.log("[hermes/plugin-watch] watching ~/.hermes for a plugin change");
  return true;
}
