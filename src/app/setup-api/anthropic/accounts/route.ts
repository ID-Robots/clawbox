import { NextResponse } from "next/server";
import {
  AnthropicAccountError,
  addApiKeyAccount,
  addOAuthAccount,
  clearLimit,
  describePool,
  markLimited,
  readAccounts,
  relistLogin,
  removeAccount,
  renameAccount,
  reorderAccounts,
  replaceCredential,
  type OAuthTokens,
} from "@/lib/anthropic-accounts";
import { pickAccount } from "@/lib/anthropic-limit";
import { looksLikeAnthropicKey, MAX_ANTHROPIC_KEY_CHARS, verifyAnthropicKey } from "@/lib/coding-anthropic";
import { simulateAnthropicLimit } from "@/lib/coding-agent";
import { announceAnthropicLimit } from "@/lib/coding-agent-notify";
import { clearHandoffTokens, readHandoffTokens } from "@/lib/oauth-handoff";
import { hasOwnerSession } from "@/lib/owner-session";
import { hasValidSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * /setup-api/anthropic/accounts — the box's Anthropic ACCOUNT POOL (TASK-902):
 * more than one Claude/Anthropic account, in the owner's order, with the one a
 * limit has set aside and when it is back (src/lib/anthropic-accounts.ts).
 *
 * GET is the pool's STATE — labels, emails, kinds, statuses, reset times, the
 * order, which account a run starting now would use, and the pool's health
 * (`healthy`, `allLimited`, `nextResetAt`). Readable with the owner's cookie AND
 * with the MCP bearer: it is what the `anthropic_accounts` tool reads, so the
 * assistant running a queue knows how many accounts can answer and waits for
 * the reset instead of spending attempts. It never carries a credential — not
 * a key, not a token, not a masked form of either.
 *
 * POST is OWNER-ONLY and OUR PAGE ONLY, like `coding-agent/anthropic`: it
 * decides which accounts a delegated shell and the assistant spend, and the
 * party that would do the spending must not be the party that can grant it —
 * the MCP bearer gets the same 403 as no credential at all. `{ action, … }`:
 *
 *  - `connect_oauth` `{ label? }` — take the Claude account the box's EXISTING
 *    Anthropic sign-in just completed (`/setup-api/ai-models/oauth/start` →
 *    `…/exchange`, which leaves the tokens in the 0600 handoff file) into the
 *    pool, at the end of the order. The same email again is the same account
 *    signing in again: its credential is replaced, its place kept.
 *  - `reauth_oauth` `{ id }` — the same, onto an account that is already there,
 *    and only when the sign-in IS that account (by its email): a different
 *    Claude account is refused, never filed under this one's label.
 *  - `add_key` `{ apiKey, label? }` / `replace_key` `{ id, apiKey }` — an API key,
 *    checked live the way the Coding Agent's key form checks it (only a
 *    definite 401/403 refuses; an offline box still stores it).
 *  - `add_login` — put this box's `claude` sign-in (back) on the list.
 *  - `rename` `{ id, label }`, `reorder` `{ ids }`, `remove` `{ id }`.
 *  - `clear_limit` `{ id }` — take a recorded limit back.
 *  - `simulate_limit` `{ id, minutes? }` — THE TEST HOOK: every live coding run
 *    on that account ends as if Anthropic had answered "You've hit your session
 *    limit · resets <then>", and the real switch path takes it from there; with
 *    no live run the account is simply marked limited. Owner-only like the rest.
 *
 * Every answer is the re-read GET shape (plus `verified` for a key and
 * `interrupted` for the test hook), so the panel never has to guess.
 */

function forbidden() {
  return NextResponse.json(
    { error: "Changing the Anthropic accounts needs a signed-in browser session.", code: "owner_only" },
    { status: 403 },
  );
}

function crossOrigin() {
  return NextResponse.json(
    { error: "The Anthropic accounts can only be changed from this ClawBox's own pages.", code: "cross_origin" },
    { status: 403 },
  );
}

function refusal(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status });
}

const REFUSAL_STATUS: Record<AnthropicAccountError["code"], number> = {
  not_found: 404,
  invalid: 400,
  full: 409,
  duplicate: 409,
  wrong_account: 409,
  store_unavailable: 503,
};

export async function GET(request: Request) {
  if (!(await hasValidSession(request))) {
    return refusal("Sign in first.", "unauthorized", 401);
  }
  try {
    return NextResponse.json(await describePool());
  } catch (err) {
    return refusal(`The Anthropic accounts could not be read: ${err instanceof Error ? err.message : String(err)}`, "store_unavailable", 503);
  }
}

/** How long the test hook sets an account aside when the caller does not say. */
const SIMULATED_LIMIT_MINUTES = 30;
const MAX_SIMULATED_LIMIT_MINUTES = 24 * 60;

async function readKey(body: Record<string, unknown>): Promise<{ key: string; verified: boolean } | NextResponse> {
  const raw = body.apiKey;
  if (typeof raw !== "string" || !raw.trim()) return refusal("An API key is required.", "invalid", 400);
  if (raw.length > MAX_ANTHROPIC_KEY_CHARS) return refusal("That API key is too long.", "invalid", 400);
  const key = raw.trim();
  // The shape BEFORE the network: whatever was pasted is about to go to a third
  // party, and something that cannot be a key must be refused here.
  if (!looksLikeAnthropicKey(key)) {
    return refusal('That does not look like an Anthropic API key — they start with "sk-ant-".', "invalid", 400);
  }
  const verdict = await verifyAnthropicKey(key);
  if (verdict === "rejected") return refusal("Anthropic did not accept that API key.", "rejected", 400);
  return { key, verified: verdict === "ok" };
}

/** The sign-in the box just completed, as tokens the pool can keep. */
async function takeHandoff(): Promise<{ tokens: OAuthTokens; email: string | null } | NextResponse> {
  const handoff = await readHandoffTokens();
  if (!handoff.ok) return refusal(handoff.error, "no_sign_in", 400);
  // Positively Anthropic's, not merely "not someone else's": every writer names
  // its provider, and a handoff with none is the device flow's older shape,
  // which meant OpenAI — its tokens must never be filed as a Claude account.
  if (handoff.tokens.provider !== "anthropic") {
    return refusal("The sign-in that just completed was not an Anthropic one. Start it again from here.", "wrong_provider", 400);
  }
  const { accessToken, refreshToken, expiresIn, accountEmail } = handoff.tokens;
  return {
    tokens: {
      access: accessToken,
      refresh: refreshToken,
      expires: expiresIn !== null ? Date.now() + expiresIn * 1000 : null,
    },
    email: accountEmail,
  };
}

export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) return forbidden();
  if (!isSameOriginRequest(request)) return crossOrigin();

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json() as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return refusal("Invalid request body.", "invalid", 400);
  }

  const extra: Record<string, unknown> = {};
  try {
    // One fixed operation per action, each in its own case. The action only
    // SELECTS among things the owner may do — who may do them was settled by
    // the two checks above, which read the session and the request's origin,
    // never the body — and no branch re-tests a body field to pick which
    // credential write runs.
    switch (body.action) {
      case "connect_oauth": {
        const taken = await takeHandoff();
        if (taken instanceof NextResponse) return taken;
        const account = await addOAuthAccount({ label: body.label, email: taken.email, tokens: taken.tokens });
        // Consumed only once it is stored: a failure above leaves the handoff
        // for a retry inside its TTL rather than forcing a whole new sign-in.
        await clearHandoffTokens();
        extra.accountId = account.id;
        console.error(`[anthropic-accounts] the owner connected a Claude account (${account.id})`);
        break;
      }
      case "reauth_oauth": {
        const taken = await takeHandoff();
        if (taken instanceof NextResponse) return taken;
        // The pool refuses a sign-in that is a DIFFERENT Claude account from the
        // one named here (`wrong_account`, `duplicate`): the id says which row,
        // only the sign-in says whose tokens these are. Kept for a retry, as above.
        const account = await replaceCredential(body.id, { kind: "oauth", tokens: taken.tokens, email: taken.email });
        await clearHandoffTokens();
        extra.accountId = account.id;
        console.error(`[anthropic-accounts] the owner re-authenticated a Claude account (${account.id})`);
        break;
      }
      case "add_key": {
        const checked = await readKey(body);
        if (checked instanceof NextResponse) return checked;
        const account = await addApiKeyAccount({ label: body.label, key: checked.key });
        extra.accountId = account.id;
        extra.verified = checked.verified;
        console.error(`[anthropic-accounts] the owner saved an API-key account (${account.id}, checked: ${checked.verified})`);
        break;
      }
      case "replace_key": {
        const checked = await readKey(body);
        if (checked instanceof NextResponse) return checked;
        const account = await replaceCredential(body.id, { kind: "api_key", key: checked.key });
        extra.accountId = account.id;
        extra.verified = checked.verified;
        console.error(`[anthropic-accounts] the owner replaced an API-key account's key (${account.id}, checked: ${checked.verified})`);
        break;
      }
      case "add_login":
        extra.accountId = (await relistLogin()).id;
        break;
      case "rename":
        await renameAccount(body.id, body.label);
        break;
      case "reorder":
        await reorderAccounts(body.ids);
        break;
      case "remove":
        await removeAccount(body.id);
        console.error("[anthropic-accounts] the owner removed an account");
        break;
      case "clear_limit":
        await clearLimit(body.id);
        break;
      case "simulate_limit": {
        const minutes = typeof body.minutes === "number" && Number.isFinite(body.minutes)
          ? Math.min(Math.max(Math.round(body.minutes), 1), MAX_SIMULATED_LIMIT_MINUTES)
          : SIMULATED_LIMIT_MINUTES;
        const accounts = await readAccounts();
        const account = accounts.find((a) => a.id === body.id);
        if (!account) throw new AnthropicAccountError("not_found", "There is no Anthropic account with that id on this ClawBox.");
        const until = Date.now() + minutes * 60_000;
        const interrupted = simulateAnthropicLimit(account.id, until);
        if (interrupted.length === 0) {
          // No run to move: the account is set aside for the runs that come
          // next, and the owner is told the way a real limit would tell them.
          const recorded = await markLimited(account.id, until, "session");
          const next = pickAccount(await readAccounts(), Date.now());
          if (recorded.newlyLimited && next) {
            void announceAnthropicLimit({ kind: "switched", fromLabel: account.label, toLabel: next.label, resetAt: until, runId: null }).catch(() => {});
          } else if (recorded.becameAllLimited) {
            void announceAnthropicLimit({ kind: "all_limited", resetAt: recorded.health.nextResetAt, runId: null }).catch(() => {});
          }
        }
        extra.interrupted = interrupted;
        console.error(`[anthropic-accounts] the owner's test hook set account ${account.id} aside for ${minutes} min (${interrupted.length} run(s) interrupted)`);
        break;
      }
      default:
        return refusal("Unknown action.", "invalid", 400);
    }
  } catch (err) {
    if (err instanceof AnthropicAccountError) return refusal(err.message, err.code, REFUSAL_STATUS[err.code]);
    return refusal(`The Anthropic accounts could not be changed: ${err instanceof Error ? err.message : String(err)}`, "store_unavailable", 503);
  }
  return NextResponse.json({ ...(await describePool()), ...extra });
}
