// Making a Hermes plugin the assistant just installed actually reach the chat.
//
// THE FAILURE THIS TOOL REMOVES, from the owner's own transcript (2026-09-18).
// The assistant installed and enabled the `superpowers` plugin, verified it
// worked by running `hermes chat -q` — a FRESH process — and reported success.
// The chat the owner was looking at is served by a long-lived process that had
// started hours earlier, and Hermes scans for plugins exactly once per process.
// So the plugin was installed, provably working, and invisible to every chat the
// owner opened, including new sessions.
//
// The assistant then did the only sensible thing and tried `sudo systemctl
// restart clawbox-hermes-dashboard`. It was refused — agent shells run with
// `no_new_privs`, and no such grant exists or should — and it stopped there.
//
// This tool is what it should have reached for instead. What it asks for is not
// privileged: the route behind it stops a process the clawbox user already owns
// and lets systemd's `Restart=always` bring it back.

import { apiPost, type ApiOptions } from "../lib/api";
import { type ErrorRule } from "../lib/errors";
import { json, type Registrar } from "../lib/register";

/** What POST /setup-api/hermes/plugins/reload answers. */
interface ReloadBody {
  restarted?: unknown;
  inFlight?: unknown;
  ready?: unknown;
  plugins?: unknown;
  loaded?: unknown;
  stale?: unknown;
  detail?: unknown;
}

/**
 * The restart takes seconds, not milliseconds: a stop, systemd's `RestartSec=5`,
 * two `ExecStartPre` steps and the process binding its socket. This waits out
 * the route's whole worst case plus the round trip rather than abandoning a
 * restart that is working — timing out here is a FALSE FAILURE on the one call
 * whose purpose is to say whether the plugin is live.
 *
 * THE ARITHMETIC, spelled out because it was wrong once and drifted:
 *
 *   - the bounce waits `DASHBOARD_RESPAWN_WAIT_MS` (45 s) for a new main pid and
 *     the socket, and may spend one more `systemctl show` (5 s) deciding whether
 *     anything is still coming — 50 s (`src/lib/hermes-dashboard-control.ts`);
 *   - the post-bounce read is capped at `POST_BOUNCE_READ_BUDGET_MS` (10 s)
 *     rather than the ~33 s its three RPC budgets allow
 *     (`src/lib/hermes-plugin-reload.ts`);
 *   - plus the owner notice and the round trip.
 *
 * 60 s used to sit under that sum, so a slow box answered the agent "the restart
 * was started but did not report back in time" over a dashboard that was already
 * serving the plugin. 90 s clears it with room, and the note below is why
 * waiting is the right trade in the first place.
 */
const RELOAD_TIMEOUT_MS = 90_000;

const RELOAD_RULES: ErrorRule[] = [
  {
    status: 404,
    code: "NOT_SUPPORTED_HERE",
    message: "This ClawBox does not run the Hermes agent, so it has no plugins to reload.",
    next: "Do not retry. Report that this device has no Hermes plugins.",
  },
  {
    status: 502,
    code: "ENDPOINT_DOWN",
    message: "The Hermes agent could not be restarted, so the plugin change is not active yet.",
    next: "Tell the owner the plugin change was saved but could not be applied to the running agent, and that a reboot from Settings will apply it.",
  },
];

/**
 * Timing out is NOT a reason to call this again. The restart is already under
 * way on the box, and a second call would stop a dashboard that is in the middle
 * of coming back — turning one bounce into two outages for the owner.
 */
const RELOAD_TIMEOUT_NOTE = {
  message: "The restart was started but did not report back in time.",
  next: "Do not call this again. Wait about a minute, then use clawbox_health or simply tell the owner to open a new chat.",
};

export function registerHermesPluginTools(reg: Registrar): void {
  reg.tool(
    "hermes_plugins_reload",
    "Restart this device's Hermes agent so a plugin added with `hermes plugins install`, `enable`, "
      + "`disable` or `remove` reaches the chat — not even a new chat session sees it until then. Call it "
      + "once, right after any of those. The owner's open chat window closes, so tell them to open a new chat.",
    {},
    // HERMES ONLY. On OpenClaw there is no dashboard and no plugin system, and a
    // tool that 404s for ever there trips the per-server circuit breaker that
    // takes every ClawBox tool offline for the agent.
    { editions: ["hermes"], destructive: true, profile: "core" },
    async () => {
      const options: ApiOptions = {
        timeoutMs: RELOAD_TIMEOUT_MS,
        rules: RELOAD_RULES,
        onTimeout: RELOAD_TIMEOUT_NOTE,
      };
      const body = await apiPost<ReloadBody>("/setup-api/hermes/plugins/reload", {}, options);
      const plugins = Array.isArray(body.plugins) ? body.plugins.map(String) : [];
      // `loaded` is null when the running agent could not be asked what it
      // registered, and that is NOT "it loaded nothing" — passing an empty list
      // on would have the assistant tell the owner their plugin is missing from a
      // device that is serving it. The null is carried through as an explicit
      // "could not be established".
      const loaded = Array.isArray(body.loaded) ? body.loaded.map(String) : null;
      // On most devices `loaded` cannot be read at all — the dashboard publishes
      // no plugin-registration lines — so THIS is the fact that proves the
      // restart took: the process now serving chat is no longer behind the files.
      const stale = typeof body.stale === "boolean" ? body.stale : null;
      // Another caller — the owner pressing the card's own reload — already owns
      // this restart. Reported as a distinct fact rather than as a failure, and
      // with the same instruction the timeout note carries: the restart IS
      // happening, and calling again would stop a dashboard mid-recovery.
      if (body.inFlight === true) {
        return json({
          restarted: false,
          restart_already_under_way: true,
          plugins,
          tell_the_owner: "The assistant is already restarting — open a new chat in a moment to use the plugin.",
          next: "Do not call this again.",
        });
      }
      return json({
        restarted: body.restarted === true,
        // `restarted` without `ready` means systemd owns the restart and it is on
        // its way back. That is not a failure and must not be retried.
        serving_again: body.ready === true,
        plugins,
        ...(loaded ? { loaded } : { loaded: "could not be established on this device" }),
        ...(stale === null
          ? {}
          : stale
            ? { warning: "the agent is still behind the files — the plugin is NOT loaded yet" }
            : { up_to_date: "the agent now serving chat has read the current plugin set" }),
        tell_the_owner: "Open a new chat to use the plugin — the previous chat window closed with the restart.",
      });
    },
  );
}
