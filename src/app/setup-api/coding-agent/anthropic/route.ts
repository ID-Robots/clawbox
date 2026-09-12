import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import {
  clearAnthropicKey,
  getAnthropicConnection,
  looksLikeAnthropicKey,
  MAX_ANTHROPIC_KEY_CHARS,
  setAnthropicKey,
  verifyAnthropicKey,
} from "@/lib/coding-anthropic";
import { ANTHROPIC_MODELS, DEFAULT_ANTHROPIC_MODEL } from "@/lib/coding-provider";

export const dynamic = "force-dynamic";

/**
 * The owner's OWN Anthropic access for coding runs — connect it, check it,
 * take it back.
 *
 * OWNER-ONLY, all three verbs, like `enable` and `github-login`: this route
 * decides which account a delegated shell spends, and the party that would do
 * the spending must not be the party that can grant it. The MCP bearer gets
 * the same 403 as no credential at all.
 *
 * And OUR PAGE ONLY on the writes: the owner's browser attaches its session
 * cookie to a POST any other site fires at the box, so "signed in" alone would
 * let a cross-site page plant a key — or delete one — in the owner's name. The
 * origin guard runs after the owner gate, so the answer to the agent's bearer
 * is the one every owner-only route gives. The GET is left readable with the
 * cookie alone: it says whether an account is connected and never what with,
 * which is exactly what the Coding Agent app polls for.
 *
 * NOTHING HERE EVER ANSWERS WITH THE CREDENTIAL. Not the stored key, not a
 * masked form of it, not its length: the only facts that leave are whether one
 * is there and which of the two kinds of access a run would use. Nor is a key
 * ever logged — the console lines below name the verb and nothing else.
 */
function forbidden() {
  return NextResponse.json(
    { error: "Connecting an Anthropic account needs a signed-in browser session.", kind: "owner_only" },
    { status: 403 },
  );
}

function crossOrigin() {
  return NextResponse.json(
    { error: "Connecting an Anthropic account only works from this ClawBox's own pages.", kind: "cross_origin" },
    { status: 403 },
  );
}

/** The payload every verb here answers with, re-read from the box. */
async function state() {
  const connection = await getAnthropicConnection();
  return NextResponse.json({
    ...connection,
    models: ANTHROPIC_MODELS,
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
  });
}

/**
 * GET → `{ connected, hasKey, hasLogin, source, models, defaultModel }`.
 *
 * `hasLogin` is a `claude` sign-in the owner made themselves in the Terminal
 * app. ClawBox does not own it, cannot create it and never deletes it; it is
 * reported because a run would use it, and an owner looking at "not connected"
 * next to a working terminal login would have no way to make sense of it.
 */
export async function GET(request: Request) {
  if (!(await hasOwnerSession(request))) return forbidden();
  return state();
}

/**
 * POST { apiKey } → save the owner's Anthropic API key.
 *
 * Checked live against Anthropic before it is stored, but only a definite
 * refusal stops the save: this appliance is regularly offline or behind a
 * captive portal, and a correctly pasted key must still be storable there. A
 * 401/403 from Anthropic is different — storing that buys a run that fails
 * several minutes in with a message the owner cannot act on — so it is
 * answered 400 `rejected` and nothing is written. When the box could not ask,
 * the key is stored and the answer says so with `verified: false`, so the
 * panel can say "saved, not checked" rather than claim a test that never ran.
 */
export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) return forbidden();
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
  const raw = (body as { apiKey?: unknown }).apiKey;
  if (typeof raw !== "string" || raw.trim() === "") {
    return NextResponse.json({ error: "An API key is required.", kind: "invalid" }, { status: 400 });
  }
  // Bounded before anything is done with it, so a megabyte of paste never
  // reaches the shape check, the network or the config file.
  if (raw.length > MAX_ANTHROPIC_KEY_CHARS) {
    return NextResponse.json({ error: "That API key is too long.", kind: "invalid" }, { status: 400 });
  }
  const apiKey = raw.trim();
  // THE SHAPE FIRST, AND ONLY THEN THE NETWORK. Whatever was pasted here is
  // about to be sent to a third party, so something that cannot be a key —
  // the contents of the clipboard, a password typed into the wrong field —
  // must be refused by this box rather than forwarded to Anthropic to be
  // refused there. `setAnthropicKey` applies the same rule again before it
  // writes; this is the copy that runs before anything leaves the device.
  if (!looksLikeAnthropicKey(apiKey)) {
    return NextResponse.json(
      { error: `That does not look like an Anthropic API key — they start with "sk-ant-".`, kind: "invalid" },
      { status: 400 },
    );
  }

  const verdict = await verifyAnthropicKey(apiKey);
  if (verdict === "rejected") {
    return NextResponse.json(
      { error: "Anthropic did not accept that API key.", kind: "rejected" },
      { status: 400 },
    );
  }
  try {
    await setAnthropicKey(apiKey);
  } catch (err) {
    // The shape again, as the library's own last word before the write. It
    // cannot fire after the check above; kept because this route is not the
    // only thing that may ever call it.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not save that API key.", kind: "invalid" },
      { status: 400 },
    );
  }
  console.error(`[coding-agent] an Anthropic API key was saved by the owner (checked: ${verdict === "ok"})`);
  const connection = await getAnthropicConnection();
  return NextResponse.json({
    ...connection,
    models: ANTHROPIC_MODELS,
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
    verified: verdict === "ok",
  });
}

/**
 * DELETE → forget the stored key.
 *
 * Deliberately does NOT touch a `claude` login the owner made in the Terminal
 * app: that credential is theirs, made outside this app, and a button about
 * the key this box holds must not end somebody's session as a side effect. The
 * answer says so — `hasLogin` stays true — so the panel can tell the owner the
 * account is still reachable and where that comes from.
 */
export async function DELETE(request: Request) {
  if (!(await hasOwnerSession(request))) return forbidden();
  if (!isSameOriginRequest(request)) return crossOrigin();
  await clearAnthropicKey();
  console.error("[coding-agent] the stored Anthropic API key was removed by the owner");
  return state();
}
