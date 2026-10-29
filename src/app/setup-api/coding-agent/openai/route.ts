import { NextResponse } from "next/server";
import { hasPersonSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import {
  cancelCodexLogin,
  clearOpenAIKey,
  getOpenAIConnection,
  looksLikeOpenAIKey,
  MAX_OPENAI_KEY_CHARS,
  readCodexLogin,
  setOpenAIKey,
  signOutCodex,
  startCodexLogin,
  verifyOpenAIKey,
} from "@/lib/coding-openai";
import { DEFAULT_OPENAI_MODEL, OPENAI_MODELS } from "@/lib/coding-provider";

export const dynamic = "force-dynamic";

/**
 * The owner's OWN OpenAI access for coding runs — an API key, or a ChatGPT
 * sign-in through the Codex CLI's device flow — connect it, check it, take it
 * back. The twin of `anthropic/route.ts`, under the same three rules:
 *
 * OWNER-ONLY on every verb: this decides which account a delegated shell
 * spends, and the MCP bearer gets the same 403 as no credential at all.
 *
 * OUR PAGE ONLY on the writes (POST, DELETE): the owner's cookie rides along
 * on a request any other site fires at the box, so "signed in" alone would let
 * a cross-site page plant a key, start a sign-in or sign the box out.
 *
 * NOTHING HERE EVER ANSWERS WITH THE CREDENTIAL — not the key, not a masked
 * form of it, not a token. A sign-in in progress answers OpenAI's own device
 * page and the one-time code the owner types there, which is what that code is
 * for; the console lines name the verb and nothing else.
 */
function forbidden() {
  return NextResponse.json(
    { error: "Connecting an OpenAI account needs a signed-in browser session.", kind: "owner_only" },
    { status: 403 },
  );
}

function crossOrigin() {
  return NextResponse.json(
    { error: "Connecting an OpenAI account only works from this ClawBox's own pages.", kind: "cross_origin" },
    { status: 403 },
  );
}

/** The payload every verb answers with, re-read from the box. */
async function payload(extra: Record<string, unknown> = {}) {
  const connection = await getOpenAIConnection();
  return NextResponse.json({
    ...connection,
    models: OPENAI_MODELS,
    defaultModel: DEFAULT_OPENAI_MODEL,
    ...extra,
  });
}

/**
 * GET → `{ connected, hasKey, hasLogin, source, status, limitedUntil,
 * codexInstalled, models, defaultModel }`. `status` is "connected",
 * "disconnected" or "limited" — the last while OpenAI's usage limit, as a run
 * last met it, is still ahead (`limitedUntil`).
 */
export async function GET(request: Request) {
  if (!(await hasPersonSession(request))) return forbidden();
  return payload();
}

const LOGIN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function missingSignInId() {
  return NextResponse.json({ error: "A sign-in id is required.", kind: "invalid" }, { status: 400 });
}

function signInId(id: unknown): string | null {
  return typeof id === "string" && LOGIN_ID_RE.test(id) ? id : null;
}

async function beginSignIn() {
  const login = await startCodexLogin();
  console.error(`[coding-agent] a ChatGPT sign-in for coding runs was started by the owner (${login.status})`);
  return payload({ login });
}

async function pollSignIn(id: unknown) {
  const loginId = signInId(id);
  if (!loginId) return missingSignInId();
  const login = readCodexLogin(loginId);
  if (!login) return NextResponse.json({ error: "That sign-in is no longer running. Start it again.", kind: "not_found" }, { status: 404 });
  return payload({ login });
}

async function endSignIn(id: unknown) {
  const loginId = signInId(id);
  if (!loginId) return missingSignInId();
  cancelCodexLogin(loginId);
  return payload({ login: readCodexLogin(loginId) });
}

/**
 * The sign-in verbs by name. A table rather than a chain of comparisons on the
 * posted `action`: the owner and same-origin checks above are what guard these,
 * and the name only picks which one runs, so the dispatch reads as just that.
 */
const SIGN_IN_VERBS: Record<string, (id: unknown) => Promise<NextResponse>> = {
  "login-start": beginSignIn,
  "login-poll": pollSignIn,
  "login-cancel": endSignIn,
};

function signInVerb(action: unknown, id: unknown) {
  const verb = typeof action === "string" && Object.hasOwn(SIGN_IN_VERBS, action) ? SIGN_IN_VERBS[action] : undefined;
  if (!verb) return NextResponse.json({ error: "Unknown action.", kind: "invalid" }, { status: 400 });
  return verb(id);
}

/**
 * POST, one of:
 *   { apiKey }                         save the owner's key (checked live first)
 *   { action: "login-start" }          `codex login --device-auth` → { login }
 *   { action: "login-poll", id }       how that sign-in stands → { login }
 *   { action: "login-cancel", id }     end it
 *
 * The key is checked against OpenAI before it is stored, and only a definite
 * refusal (401/403 in OpenAI's own JSON) stops the save: this appliance is often
 * offline, and a correctly pasted key must still be storable there. When the box
 * could not ask, the answer says so with `verified: false`.
 */
export async function POST(request: Request) {
  if (!(await hasPersonSession(request))) return forbidden();
  if (!isSameOriginRequest(request)) return crossOrigin();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { apiKey: raw, action, id } = body as { apiKey?: unknown; action?: unknown; id?: unknown };

  if (action !== undefined) return signInVerb(action, id);

  if (typeof raw !== "string" || raw.trim() === "") {
    return NextResponse.json({ error: "An API key is required.", kind: "invalid" }, { status: 400 });
  }
  // Bounded before anything is done with it.
  if (raw.length > MAX_OPENAI_KEY_CHARS) {
    return NextResponse.json({ error: "That API key is too long.", kind: "invalid" }, { status: 400 });
  }
  const apiKey = raw.trim();
  // THE SHAPE FIRST, AND ONLY THEN THE NETWORK: whatever was pasted is about to
  // go to a third party, so something that cannot be a key — an Anthropic key
  // in the wrong field, a password — is refused here, not forwarded to OpenAI.
  if (!looksLikeOpenAIKey(apiKey)) {
    return NextResponse.json(
      { error: `That does not look like an OpenAI API key — they start with "sk-".`, kind: "invalid" },
      { status: 400 },
    );
  }
  const verdict = await verifyOpenAIKey(apiKey);
  if (verdict === "rejected") {
    return NextResponse.json({ error: "OpenAI did not accept that API key.", kind: "rejected" }, { status: 400 });
  }
  try {
    await setOpenAIKey(apiKey);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not save that API key.", kind: "invalid" },
      { status: 400 },
    );
  }
  console.error(`[coding-agent] an OpenAI API key was saved by the owner (checked: ${verdict === "ok"})`);
  return payload({ verified: verdict === "ok" });
}

/**
 * DELETE → forget the stored key; DELETE ?what=login → sign the coding agent's
 * Codex out of ChatGPT (`codex logout` in its own CODEX_HOME). Two separate
 * buttons for two separate credentials: removing a key never ends a sign-in.
 */
export async function DELETE(request: Request) {
  if (!(await hasPersonSession(request))) return forbidden();
  if (!isSameOriginRequest(request)) return crossOrigin();
  const what = new URL(request.url).searchParams.get("what") ?? "key";
  if (what === "login") {
    await signOutCodex();
    console.error("[coding-agent] the ChatGPT sign-in for coding runs was ended by the owner");
    return payload();
  }
  if (what !== "key") {
    return NextResponse.json({ error: "Nothing to remove by that name.", kind: "invalid" }, { status: 400 });
  }
  await clearOpenAIKey();
  console.error("[coding-agent] the stored OpenAI API key was removed by the owner");
  return payload();
}
