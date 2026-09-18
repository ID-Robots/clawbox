import { hasHermesHarness } from "@/lib/edition-source";
import { notifyOwner } from "@/lib/email-notify";
import { bounceHermesDashboard } from "@/lib/hermes-dashboard-control";
import { logSafe } from "@/lib/log-safe";
import {
  readHermesPluginDeclaration,
  readHermesPluginState,
  type HermesPluginState,
} from "@/lib/hermes-plugin-set";

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

/** What one `reloadHermesPlugins` call did. */
export interface HermesPluginReloadResult {
  /** The restart was TAKEN — the stop landed over a unit that restarts itself. */
  readonly restarted: boolean;
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
 * @param names  the plugins the notice should name. Read from the declaration
 *               when the caller has none.
 */
export async function reloadHermesPlugins(
  reason: string,
  names?: readonly string[],
): Promise<HermesPluginReloadResult> {
  const outcome = await bounceHermesDashboard();
  // Read AFTER the bounce, so `plugins` is what the box declares now and
  // `loaded` is what the REPLACEMENT registered — the process whose answer is
  // the only one that ever mattered here.
  const state: HermesPluginState = await readHermesPluginState().catch(() => ({
    declared: names ?? [],
    loaded: null,
    stale: null,
    dashboardStartedAt: null,
  }));

  if (outcome === "failed") {
    // NOT a restart, and the caller must not be told otherwise: the plugin is
    // still invisible to the running agent and the owner's chat still works.
    const detail =
      "the Hermes dashboard could not be restarted, so the plugin is installed but not loaded";
    console.error(`[hermes/plugin-reload] ${logSafe(reason, 120)}: ${detail}`);
    return { restarted: false, ready: false, plugins: state.declared, loaded: state.loaded, stale: state.stale, detail };
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

  return { restarted: true, ready, plugins: state.declared, loaded: state.loaded, stale: state.stale, detail };
}

/** What one `tick()` decided. Named so a test — and a journal — can read it. */
export type HermesPluginTick =
  | "baseline"
  | "unchanged"
  | "waiting"
  | "restarted"
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

  /**
   * The set the RUNNING dashboard is assumed to have loaded.
   *
   * Seeded from the first look and never from a restart that failed. The seeding
   * is what stops this being a boot loop: the web server restarts far more often
   * than the plugin set changes (every update, every `clawbox-setup` bounce), and
   * a watcher that treated its first reading as news would restart the box's chat
   * backend on each one.
   */
  let baseline: string | null = null;
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

      if (baseline === null) {
        baseline = declaration.signature;
        return "baseline";
      }

      if (declaration.signature === baseline) {
        // Includes a change that was UNDONE inside the window — installed and
        // removed again. Nothing is different from what the dashboard is running,
        // so there is nothing to restart for, and a backoff earned by the change
        // that has just gone away is not owed by the next one.
        pending = null;
        retryDelayMs = 0;
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
      const result = await reloadHermesPlugins(
        "the box's Hermes plugin set changed",
        declaration.names,
      );
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
        retryDelayMs = Math.min(
          retryDelayMs ? retryDelayMs * 2 : debounceMs * 2,
          HERMES_PLUGIN_RETRY_MAX_MS,
        );
        return "failed";
      }
      pending = null;
      retryDelayMs = 0;
      baseline = acted;
      return "restarted";
    },
  };
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
