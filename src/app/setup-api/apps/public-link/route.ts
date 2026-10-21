import { NextResponse } from "next/server";
import { sessionIdentity } from "@/lib/route-auth";
import { PublicLinkError, createPublicLink, disablePublicLink, listPublicLinks, setPublicLinkPassword } from "@/lib/public-app-links";

export const dynamic = "force-dynamic";

/**
 * /setup-api/apps/public-link (TASK-1478) — the owner's switch for an app's
 * public link. See src/lib/public-app-links.ts and
 * scripts/public-app-links.js.
 *
 *   GET                       every link, with its URL once the tunnel is up
 *   POST   {appId, mode, ttlMinutes?, apiAccess?, apiAllow?, password?}   publish
 *                             (apiAccess: read — the default, the app's /api
 *                             answers GET/HEAD — full, or none; apiAllow adds
 *                             prefixes)
 *   PATCH  {appId, password}  set or change the link's password (a string),
 *                             or remove it (null); the link stays the same
 *   DELETE {appId}            disable — immediate
 *
 * A PERSON'S SESSION COOKIE, and only that: the owner's or any other ClawBox
 * user's, who all get the owner's desktop. Middleware would let the MCP
 * bearer reach any /setup-api route, but that bearer is the agent, and
 * putting something on the public internet is a decision the agent must not
 * be able to take for a person (the same line email/pending and
 * coding-agent/enable draw). The e2e-install harness's test mode is the one
 * documented exception.
 *
 * A link's URL carries its access token (`?k=…`), and a token is a secret the
 * owner alone sees in clear: everyone else is answered the URL with the token
 * masked (`tokenMasked: true`).
 */
async function personOnly(request: Request): Promise<{ denied: NextResponse } | { owner: boolean }> {
  if (process.env.CLAWBOX_TEST_MODE === "1") return { owner: true };
  const identity = await sessionIdentity(request);
  if (identity) return { owner: identity.isOwner };
  return { denied: NextResponse.json({ error: "Sign in to manage public links.", code: "owner_session_required" }, { status: 401 }) };
}

const MASK = "••••••••";

/** A link URL with its access token masked, for anyone but the owner. */
function maskLinkUrl(url: unknown): unknown {
  if (typeof url !== "string" || !url) return url;
  return url.replace(/([?&]k=)[^&#]*/g, `$1${MASK}`);
}

function forViewer<T>(owner: boolean, link: T): T {
  if (owner || !link || typeof link !== "object") return link;
  const record = link as Record<string, unknown>;
  if (typeof record.url !== "string" || !record.url) return link;
  return { ...record, url: maskLinkUrl(record.url), tokenMasked: true } as T;
}

function failure(err: unknown): NextResponse {
  if (err instanceof PublicLinkError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  console.error("[public-link]", err instanceof Error ? err.message : err);
  return NextResponse.json({ error: "Could not update the public link." }, { status: 500 });
}

const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: Request) {
  const who = await personOnly(request);
  if ("denied" in who) return who.denied;
  try {
    const links = await listPublicLinks();
    return NextResponse.json({ links: links.map((link) => forViewer(who.owner, link)) }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

export async function POST(request: Request) {
  const who = await personOnly(request);
  if ("denied" in who) return who.denied;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  try {
    const link = await createPublicLink({ appId: body.appId, mode: body.mode, ttlMinutes: body.ttlMinutes, apiAllow: body.apiAllow, apiAccess: body.apiAccess, password: body.password });
    return NextResponse.json({ link: forViewer(who.owner, link) }, { status: 201, headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

export async function PATCH(request: Request) {
  const who = await personOnly(request);
  if ("denied" in who) return who.denied;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  // `password` must be named: a body that forgot it must not read as "remove".
  if (!("password" in body) || (body.password !== null && typeof body.password !== "string")) {
    return NextResponse.json({ error: "password must be a text, or null to remove it.", code: "bad_password" }, { status: 400 });
  }
  try {
    const passwordProtected = await setPublicLinkPassword(body.appId, body.password);
    return NextResponse.json({ ok: true, passwordProtected }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

export async function DELETE(request: Request) {
  const who = await personOnly(request);
  if ("denied" in who) return who.denied;
  let appId: unknown;
  try {
    appId = ((await request.json()) as { appId?: unknown })?.appId;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (typeof appId !== "string") return NextResponse.json({ error: "appId is required." }, { status: 400 });
  try {
    const removed = await disablePublicLink(appId);
    return NextResponse.json({ ok: true, removed }, { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}
