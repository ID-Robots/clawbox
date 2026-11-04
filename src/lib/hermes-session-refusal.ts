import { dashboardWsTicket } from "@/lib/hermes-dashboard-auth";

/**
 * THE FIRST MESSAGE AFTER HERMES RESTARTED (TASK-2152), and the one retry
 * that answers it.
 *
 * A chat turn is offered to the dashboard first and falls to `hermes chat -q
 * --resume <id>` when the dashboard turn cannot be opened. From Hermes v0.22.4
 * that CLI runs through the gateway, and the gateway authorizes a resume
 * against the conversation's stored OWNER: a conversation the dashboard
 * started belongs to the dashboard's account, while the CLI attaches as the
 * device's own socket identity. Hermes' own words for the rule, in
 * `hermes_cli/web_server_sessions.py`: "`authorize_history` compares the actor
 * subject against the row's stored owner". So for the conversation a web chat
 * is actually in, the fallback is refused, every time, as
 *
 *   Error: permission_denied        (stderr, exit 1)
 *
 * after auto-starting a gateway to be refused by (~13-20 s on a board). Measured
 * on a board, v0.22.5: refused with the gateway cold, and refused again with it
 * already running.
 *
 * Nothing about that is visible while the dashboard answers, which is why it
 * surfaced as "the first message after X fails, the next works": the gateway's
 * idle exit, a provider or model switch, a dashboard restart — anything that
 * makes ONE dashboard turn fail to open sends that one turn to a fallback that
 * cannot serve it, and the next turn finds the dashboard back.
 *
 * The answer is to take the turn back to the dashboard, once: wait until it
 * answers again (bounded), then open the same turn there. Never a loop, and
 * only for this refusal — any other failure is reported as it was. The refusal
 * comes before Hermes commits anything (`permission_denied` is in
 * `_REFUSED_BEFORE_COMMIT`, tui_gateway/owner_forward.py), so the retry cannot
 * run the turn twice.
 */

/**
 * The CLI's refusal line, whole. `launch_from_args` prints `"Error: " + message`
 * and the gateway's reason is the bare code, so anything looser could match a
 * tool's output that merely mentions the word.
 */
const SESSION_REFUSAL_LINE = /^Error: permission_denied[ \t\r]*$/m;

/** Was this `hermes chat` run refused the conversation it was asked to resume? */
export function cliRefusedSession(stderr: string): boolean {
  return SESSION_REFUSAL_LINE.test(stderr);
}

/**
 * What the owner reads when the retry could not be made either.
 *
 * Not the code: "permission_denied" reads as something the owner did wrong,
 * and nothing they did caused it. Sending again is the honest advice — by then
 * the dashboard has normally come back — and a new chat is the way out when it
 * has not.
 */
export const SESSION_REFUSED_MESSAGE =
  "Hermes could not reopen this conversation just now — it was most likely still starting up. "
  + "Send your message again in a moment; if it keeps happening, start a new chat.";

/**
 * The same refusal on a turn the dashboard was never offered — one carrying a
 * picture (`--image` is a CLI flag), or a caller that cannot be streamed to.
 * There is no retry to make there and sending again is refused the same way,
 * so the advice is the one that works: a new chat, which the CLI creates and
 * may therefore continue.
 */
export const SESSION_REFUSED_NO_DASHBOARD_MESSAGE =
  "Hermes would not continue this conversation for this kind of message (a picture, "
  + "or a request that cannot be streamed). Start a new chat to send it.";

/**
 * How long a refused turn waits for the dashboard before giving up.
 *
 * Long enough for a dashboard restart, which loads every plugin and the MCP
 * server before it serves; short enough that a dashboard that is not coming
 * back still ends the turn in well under a minute after the CLI gave up.
 */
export const DASHBOARD_READY_BUDGET_MS = 30_000;
const DASHBOARD_READY_POLL_MS = 1_000;

export interface DashboardReadyOptions {
  /** Ends the wait at once — the owner's Stop. */
  readonly signal?: AbortSignal;
  readonly budgetMs?: number;
  readonly pollMs?: number;
  /** Test seams. */
  readonly probe?: (signal?: AbortSignal) => Promise<string | null>;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Wait until the dashboard can take a turn again, or the budget runs out.
 *
 * "Can take a turn" is asked the way `openDashboardTurn` starts one: mint a
 * WebSocket ticket. That one call proves the process is up, the stored
 * password opens it and the socket endpoint is on; the ticket itself is thrown
 * away (single-use, thirty seconds). Whether the conversation then mounts is
 * the retry's own `session.resume` to answer, not this probe's.
 *
 * True when it answered in time; false when it did not, or the wait was
 * stopped. Bounded by the budget plus one probe's own timeout: a probe started
 * just before the deadline is let finish rather than cut off.
 */
export async function waitForDashboard(opts: DashboardReadyOptions = {}): Promise<boolean> {
  const probe = opts.probe ?? dashboardWsTicket;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const pollMs = opts.pollMs ?? DASHBOARD_READY_POLL_MS;
  const deadline = now() + (opts.budgetMs ?? DASHBOARD_READY_BUDGET_MS);
  for (;;) {
    if (opts.signal?.aborted) return false;
    const ticket = await probe(opts.signal).catch(() => null);
    if (opts.signal?.aborted) return false;
    if (ticket) return true;
    const left = deadline - now();
    if (left <= 0) return false;
    await sleep(Math.min(pollMs, left), opts.signal);
  }
}
