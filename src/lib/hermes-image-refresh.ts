import { bounceHermesDashboard } from "@/lib/hermes-dashboard-control";
import { dashboardRpc } from "@/lib/hermes-dashboard-rpc";
import { reloadMcpServers, reportMcpReloadRefused } from "@/lib/hermes-mcp-reload";

/**
 * Make the RUNNING Hermes serve the image backend that linking just installed.
 *
 * WHY THIS EXISTS. Linking ClawBox AI writes everything a Hermes box needs in
 * order to draw — the backend into `~/.hermes/plugins/image_gen/clawai/`, the
 * device token into `~/.hermes/.env`, and `image_gen.provider` into
 * `config.yaml`. Two of those three are read ONCE, when the agent process
 * starts, and the agent that serves chat is a long-lived service:
 *
 *   - the CREDENTIAL. `plugins/image_gen/clawai/__init__.py` reads it through
 *     `agent.secret_scope.get_secret`, which on a single-profile box is
 *     `os.environ` — and `~/.hermes/.env` reaches `os.environ` only via
 *     `load_hermes_dotenv()` at entrypoint startup. Upstream knows: its own
 *     `/reload` exists to "pick up new API keys without restarting".
 *   - the BACKEND. `check_image_generation_requirements()` resolves it with
 *     `get_provider(image_gen.provider)`, a plain registry lookup filled by
 *     plugin discovery. `_ensure_plugins_discovered()` returns early once the
 *     manager has run, and nothing reachable over the dashboard socket passes
 *     its `force` flag — so a plugin installed after that is never seen.
 *
 * Measured on the owner's box (2026-08-27): linking at 09:08:52 into a
 * dashboard that had started the previous day at 08:30:58, then a picture asked
 * for at 09:10:07 —
 *
 *   tools.registry: check_fn check_image_generation_requirements returned
 *   False; dependent tools will be unavailable this turn
 *
 * The box's own `/setup-api/chat/capabilities` said `hermesAgentDrawsImages:
 * true` the whole time, because that fact reads `config.yaml`, which IS re-read
 * per turn. So the chat promised a picture the agent had no tool to make, and
 * the agent did what an agent with no tool does: it improvised. At 09:11:54 it
 * had hand-written a script that produced a PNG outside the tool path, and by
 * 09:13:27 it had written ITSELF a skill to do it again.
 *
 * THE THIRD THING this fixes is the ClawBox MCP server's own view. It probes
 * `canGenerateImages` once at startup (mcp/lib/context.ts) and registers an
 * honest-refusal `image_generate` only where the answer is no. Left stale, that
 * refusal survives the link and tells a linked owner to go and link — the exact
 * failure #486 fixed for `email_list`/`email_read`, and with the same mechanism.
 *
 * THE DEEPER FIX, named here so this reads as the bridge it is: install the
 * backend BEFORE the process that scans for it starts, and a link changes only
 * the credential — which is exactly what `reload.env` is for, and the probe and
 * the bounce below both disappear. That does nothing for the boxes already
 * running, which is why this ships first.
 */

/**
 * Bound on the two CHEAP dashboard calls.
 *
 * `dashboardRpc`'s own default is 20 s, sized for `reload.mcp` — which kills and
 * respawns every MCP child and waits for each to hand back its tool list.
 * `reload.env` and the probe are in-process reads that answer in milliseconds,
 * and this whole helper runs inside a request the owner is holding open. The two
 * branches below are exclusive, so the worst case is bounded at roughly half a
 * minute either way: 6 + 6 + 20 through the reload, 6 + 6 + 5 + 15 through the
 * bounce.
 */
const QUICK_RPC_TIMEOUT_MS = 6_000;

/**
 * What the RUNNING agent says about its own ability to draw, or null when it
 * could not be asked.
 *
 * `image.generate` with `probe: true` is upstream's own availability question
 * and it runs `check_image_generation_requirements()` INSIDE the process that
 * will serve the next turn — which is the only process whose answer matters
 * here. Nothing is generated and no allowance is spent.
 *
 * THE NULL IS LOAD-BEARING and must not be folded into `false`: the penalty for
 * a false is a SIGTERM, and the likeliest reason a local dashboard fails to
 * answer in six seconds is that it is busy serving a turn. Bouncing a box for
 * being busy would be this helper damaging a device that was working.
 */
async function runningAgentCanDraw(): Promise<boolean | null> {
  const result = (await dashboardRpc(
    "image.generate",
    { probe: true },
    { timeoutMs: QUICK_RPC_TIMEOUT_MS },
  ).catch(() => null)) as { available?: unknown } | null;
  return typeof result?.available === "boolean" ? result.available : null;
}

/**
 * Ask for the MCP tool list to be rebuilt, and say so when it is not.
 *
 * @returns true when the children were actually respawned. The caller passes
 *          that on, because the respawn is GLOBAL: it rebuilt every other
 *          family's tool list too, and a second family must not pay for a
 *          second one.
 */
async function reloadMcpTools(why: string): Promise<boolean> {
  if (await reloadMcpServers().catch(() => false)) return true;
  // Logged, not surfaced, and in the words that are true for this edition. Worth
  // a line because "the agent still refuses to draw" is otherwise invisible from
  // the outside, and this is the one place that knows the refresh was wanted and
  // did not happen.
  await reportMcpReloadRefused("hermes/image-refresh", why);
  return false;
}

/**
 * Reconcile every surface that answers "can this box draw" with the state
 * linking just wrote.
 *
 * NEVER THROWS AND NEVER REPORTS, exactly like its email sibling. It runs on a
 * path the owner is already waiting on, the writes it is catching up to have
 * ALREADY happened, and a box whose dashboard is down is a perfectly ordinary
 * box — so the worst case is a logged line and a tool list that catches up at
 * the next restart, which is the behaviour of every box before this existed.
 *
 * TWO GATES, not one, because the two stale things have two lifetimes. The MCP
 * tool list depends only on WHETHER the box can draw, so it is reloaded only on
 * a FLIP — the same rule, and the same prompt-cache reason, as the email
 * sibling's, and it matters more here than there because this path is also the
 * Settings AI save and every tier change. The running agent's own state depends
 * on the CREDENTIAL too, so it is reconciled whenever the box can draw at all:
 * a re-link with a fresh device token leaves `before === after` and would
 * otherwise strand the agent on a credential that no longer works.
 *
 * @param before what `hermesAgentDrawsImages()` said BEFORE the writes
 * @param after  what it says after — the same fact
 *               `/setup-api/chat/capabilities` serves, so the agent's tools and
 *               the customer's chat cannot disagree about this box.
 * @returns true when this call respawned the box's MCP children — by reloading
 *          them or by bouncing the dashboard that owns them. Both rebuild EVERY
 *          family's tool list, not just the image one, so a caller that also
 *          moved another family (the coding agent, on the ClawBox AI connect
 *          path) can skip a second global reload and the second prompt-cache
 *          invalidation that comes with it.
 */
export async function refreshHermesImageTools(before: boolean, after: boolean): Promise<boolean> {
  if (!after) {
    // The box cannot draw. The only stale thing is the MCP server's view, and
    // the tool it owes an owner here is the honest refusal — a linked-looking
    // box with no backend must say so rather than let the agent improvise.
    if (before) return await reloadMcpTools("this box can no longer draw");
    return false;
  }

  // 1. The credential. Cheap, and on a box whose agent already knows the
  //    backend it is the whole fix.
  await dashboardRpc("reload.env", {}, { timeoutMs: QUICK_RPC_TIMEOUT_MS }).catch(() => null);

  // 2. Ask the agent itself whether that was enough. The answer separates the
  //    two failures that look identical from out here: a stale credential
  //    (fixed above) and a backend the process never discovered (not fixable
  //    from out here at all).
  const live = await runningAgentCanDraw();

  if (live === true) {
    // The agent can draw. The MCP server may still be holding the refusal tool
    // it registered when it could not — drop it now, in the same breath.
    if (!before) return await reloadMcpTools("the agent can draw");
    return false;
  }

  if (live === null) {
    // Asked and got no answer. Nothing here knows whether this box needs a
    // bounce, and a bounce is not the kind of thing to do on a guess.
    console.error("[hermes/image-refresh] the Hermes dashboard did not say whether it can draw; left it alone");
    return false;
  }

  // 3. The agent SAYS no with the credential freshly loaded, so the backend was
  //    installed into a process that had already scanned for plugins. Only a
  //    restart re-scans, and the bounce respawns the MCP child with it, so no
  //    reload is wanted after this one.
  if (await bounceHermesDashboard()) {
    console.log("[hermes/image-refresh] bounced the Hermes dashboard so it picks up the image backend");
    // The bounce takes the MCP children down with the dashboard and brings them
    // back, so every family's tool list is rebuilt — the same effect a reload
    // would have had, by a bigger hammer.
    return true;
  }

  console.error(
    "[hermes/image-refresh] the image backend is installed but the running agent cannot see it; restart the agent to enable pictures",
  );
  return false;
}
