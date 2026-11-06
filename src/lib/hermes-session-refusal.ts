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
 * already running. (While the dashboard still holds the conversation the same
 * refusal reads `SESSION_NOT_OWNED` instead — see SESSION_REFUSAL_LINE.)
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
 * The CLI's refusal lines, whole, in the two shapes the same refusal takes.
 *
 * `Error: permission_denied` is the gateway's: `launch_from_args` prints
 * `"Error: " + message` and the reason is the bare code. That is what a COLD
 * conversation gets — the dashboard that owns it has just restarted, or let
 * it go.
 *
 * `hermes-refusal-reason: SESSION_NOT_OWNED` is the active-session lease's
 * (`format_refusal_stderr`, hermes_cli/active_sessions.py), followed by "This
 * chat is open in another Hermes window/terminal". That is what a conversation
 * the dashboard is STILL holding gets — measured on a board right after a
 * dashboard turn on it. Same owner, same answer: take the turn to the
 * dashboard.
 *
 * Anything looser could match a tool's output that merely mentions the word.
 */
const SESSION_REFUSAL_LINE = /^(?:Error: permission_denied|hermes-refusal-reason: SESSION_NOT_OWNED)[ \t\r]*$/m;

/** Was this `hermes chat` run refused the conversation it was asked to resume? */
export function cliRefusedSession(stderr: string): boolean {
  return SESSION_REFUSAL_LINE.test(stderr);
}

/**
 * Is this a conversation the DASHBOARD started, by the shape of its id?
 *
 * The dashboard mints timestamped ids (`20260810_194609_7568b9`); `hermes chat`
 * from v0.22.4 names its sessions `local-` + 64 hex. Only the first kind is
 * refused to the CLI — so only for the first kind is it worth WAITING for a
 * dashboard that is down before the CLI is tried at all: for the second, the
 * CLI is the right door and a wait would only delay it.
 */
const DASHBOARD_SESSION_ID = /^[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$/;

export function dashboardStartedSession(sessionId: string): boolean {
  return DASHBOARD_SESSION_ID.test(sessionId);
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
 * The same refusal on the one kind of turn the dashboard cannot carry: a turn
 * with a PICTURE on it (`--image` is a CLI flag, and the dashboard transport
 * has not been taught `image.attach`). There is no retry to make there and
 * sending again is refused the same way, so the advice is the one that works:
 * a new chat, which the CLI creates and may therefore continue.
 *
 * Only ever for a picture. It used to stand for "the dashboard was not
 * offered" and so reached TEXT turns whose page had not asked to be streamed
 * to, telling an owner that their "hey" was a picture (TASK-2152); every text
 * turn is offered to the dashboard now.
 */
export const SESSION_REFUSED_PICTURE_MESSAGE =
  "Hermes can't add a picture to a conversation that is already under way. "
  + "Start a new chat to send the picture.";

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
  const probe = opts.probe ?? ((signal?: AbortSignal) => dashboardWsTicket(signal));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const pollMs = opts.pollMs ?? DASHBOARD_READY_POLL_MS;
  const deadline = now() + (opts.budgetMs ?? DASHBOARD_READY_BUDGET_MS);
  for (;;) {
    if (opts.signal?.aborted) return false;
    // A probe that throws — even synchronously — is a dashboard that did not
    // answer, never a reason to fail the turn.
    let ticket: string | null = null;
    try {
      ticket = await probe(opts.signal);
    } catch {
      ticket = null;
    }
    if (opts.signal?.aborted) return false;
    if (ticket) return true;
    const left = deadline - now();
    if (left <= 0) return false;
    await sleep(Math.min(pollMs, left), opts.signal);
  }
}
