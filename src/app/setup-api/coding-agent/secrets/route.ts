import { NextResponse } from "next/server";
import { boundedBody } from "@/lib/bounded-body";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import {
  BOX_SCOPE,
  deleteSecret,
  getInjectSecrets,
  listSecrets,
  MAX_SECRET_VALUE_CHARS,
  MAX_SECRETS,
  SecretStoreError,
  setInjectSecrets,
  setSecret,
  setSecretInject,
} from "@/lib/project-secrets";

export const dynamic = "force-dynamic";

/**
 * The owner's secret store: the credentials a delegated coding run may be
 * handed (src/lib/project-secrets.ts).
 *
 * OWNER ONLY, AND SAME ORIGIN FOR THE WRITES — the same fence
 * `coding-agent/permissions` and `coding-agent/enable` carry, and for a reason
 * that is if anything sharper here. Middleware admits every /setup-api/* call
 * on the MCP bearer and the agent holds that bearer: a POST it could make would
 * let a prompt-injected agent plant a value of its own under a name a run then
 * trusts, and a DELETE would let it take the owner's away. The origin check on
 * top is what keeps another page in the owner's browser from doing either while
 * they read it.
 *
 * READING IS OWNER-ONLY TOO, even though no answer here holds a value: the
 * shape of what a box has stored — which projects have deploy tokens, which
 * services it talks to — is the owner's, and the agent has its own narrower
 * door for the one fact it legitimately needs (`secrets/names`, behind the
 * `coding_secret_list` tool).
 *
 * NO VERB ANSWERS WITH A VALUE. Not this GET, not the POST that has just
 * written one, not an error message. The store is write-only from every
 * surface: a value goes in through the owner's own keystrokes and comes out
 * only into a run's environment.
 *
 * GET                                            → { secrets, max, maxValueChars, injectSecrets }
 * POST   { injectSecrets: boolean }              → the master switch
 * POST   { name, value, scope?, inject? }        → save (or replace) a value
 * POST   { name, scope?, inject: boolean }       → tick or un-tick one entry
 * DELETE ?name=…&scope=…                         → take one back
 *
 * Every write answers with the re-read list, so the card renders the box's own
 * answer rather than the list it hoped for.
 *
 * THE MASTER SWITCH IS HERE rather than on `coding-agent/enable` with the
 * feature's other switches, and that is the point: it is the consent for
 * handing credentials to an unattended shell, so it needs the same-origin check
 * as well as the cookie, and `enable` carries only the cookie. Its config key
 * (`coding_agent_inject_secrets`) and the `injectSecrets` field in the coding
 * agent's status are unchanged — reading it is not the half that needs a fence.
 */

function refuse(status: number, kind: string, error: string, code?: string) {
  return NextResponse.json({ error, kind, ...(code ? { code } : {}) }, { status });
}

/** Owner session, and — for the two writes — this box's own page. */
async function guard(request: Request, write: boolean): Promise<NextResponse | null> {
  if (!(await hasOwnerSession(request))) {
    return refuse(403, "owner_only", "Reading or changing this ClawBox's stored secrets needs a signed-in browser session.");
  }
  if (write && !isSameOriginRequest(request)) {
    return refuse(403, "cross_origin", "Stored secrets can only be changed from this ClawBox's own pages.");
  }
  return null;
}

/** The whole answer: the list, the bounds the card shows, and the master switch. */
async function payload() {
  const [secrets, injectSecrets] = await Promise.all([listSecrets(), getInjectSecrets()]);
  return { secrets, max: MAX_SECRETS, maxValueChars: MAX_SECRET_VALUE_CHARS, injectSecrets };
}

/**
 * The one place a store-level failure becomes an HTTP answer.
 *
 * The store's `code` travels beside the HTTP kind so the card can word
 * "that name is one the box uses itself" in the owner's language, and an older
 * card falls back to the box's own sentence. A store the device cannot read or
 * write is a 500 — the request was fine and the box is not — while everything
 * else is a 400 or a 404, because it is the request that was refused.
 */
function failed(err: unknown) {
  if (err instanceof SecretStoreError) {
    const status = err.code === "not_found"
      ? 404
      : err.code === "store_unreadable" || err.code === "store_unwritable" || err.code === "key_unavailable"
        ? 500
        : 400;
    return NextResponse.json({ error: err.message, kind: status === 404 ? "not_found" : "invalid", code: err.code }, { status });
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Could not change this ClawBox's stored secrets" },
    { status: 500 },
  );
}

/**
 * The most this route will read before it decides anything.
 *
 * A body here is one secret: a name, a scope, two flags and a value bounded by
 * `MAX_SECRET_VALUE_CHARS`. The slack over that covers JSON escaping — a value
 * of nothing but quotes or non-BMP characters serialises several times its
 * length — plus the keys, and nothing else.
 */
const MAX_BODY_BYTES = MAX_SECRET_VALUE_CHARS * 8 + 4_096;

/** A body too big to be one secret, refused with the status that says so. */
const TOO_LONG = "That request is larger than one secret can be.";

/**
 * A JSON body, as an object or nothing — METERED on the way in.
 *
 * `request.json()` buffers and parses whatever arrives, and neither Next's
 * config nor `production-server.js` puts a limit in front of it, so a caller
 * past the owner gate could have made this appliance hold and parse an
 * arbitrary body before the value-length check downstream ever looked at it
 * (found in review). The meter is the one the upload routes already use
 * (src/lib/bounded-body.ts): it counts what actually arrives and errors the
 * source past the cap, which is what a chunked body needs — `Content-Length`
 * is checked too, but a chunked request declares none, so the header bounds
 * only the callers that were never the problem.
 *
 * Answers `"too_long"` rather than null for an oversized body, so the caller
 * gets 413 and not "invalid body": one says "send less", the other "send
 * something else".
 */
async function objectBody(request: Request): Promise<Record<string, unknown> | "too_long" | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return "too_long";
  if (!request.body) return null;
  const bounded = boundedBody(request.body, { limit: MAX_BODY_BYTES, message: TOO_LONG });
  let text: string;
  try {
    text = await new Response(bounded.stream).text();
  } catch {
    // The meter cut the source, or the connection dropped. Only the first is
    // the caller's fault, and `overflowed()` is what tells them apart — never
    // the message, for the reason bounded-body's own header gives.
    return bounded.overflowed() ? "too_long" : null;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

export async function GET(request: Request) {
  const denied = await guard(request, false);
  if (denied) return denied;
  try {
    return NextResponse.json(await payload());
  } catch (err) {
    return failed(err);
  }
}

export async function POST(request: Request) {
  const denied = await guard(request, true);
  if (denied) return denied;
  const body = await objectBody(request);
  if (body === "too_long") return refuse(413, "invalid", TOO_LONG, "value_too_long");
  if (!body) {
    return refuse(400, "invalid", "Invalid body. Expected { injectSecrets }, { name, value, scope?, inject? } or { name, scope?, inject }.", "malformed");
  }
  // The MASTER switch, which names no entry — checked first, so `{ injectSecrets }`
  // is never mistaken for a body missing its `name`.
  if (typeof body.injectSecrets === "boolean") {
    try {
      const saved = await setInjectSecrets(body.injectSecrets);
      console.error(`[secrets] handing runs the owner's stored secrets switched ${saved ? "on" : "off"} by the owner`);
      return NextResponse.json(await payload());
    } catch (err) {
      return failed(err);
    }
  }
  // Which of the two entry writes this is. `value` present means "save a
  // value"; `inject` alone means "tick or un-tick the entry that is already
  // there". Bounded before the store sees it, so an eight-megabyte paste is
  // refused at the door rather than after it has been read into a string and a
  // cipher.
  const hasValue = "value" in body;
  if (hasValue && typeof body.value === "string" && body.value.length > MAX_SECRET_VALUE_CHARS) {
    return refuse(400, "invalid", `A secret's value may be at most ${MAX_SECRET_VALUE_CHARS} characters.`, "value_too_long");
  }
  try {
    if (hasValue) {
      const saved = await setSecret({ name: body.name, value: body.value, scope: body.scope, inject: body.inject });
      // The NAME and the scope, never the value and never its length — this
      // line goes to the journal, which is not a place a credential belongs
      // even in outline.
      console.error(`[secrets] ${saved.name} saved by the owner for ${saved.scope === BOX_SCOPE ? "the whole box" : `project ${saved.scope}`}`);
    } else if ("inject" in body) {
      const saved = await setSecretInject({ name: body.name, scope: body.scope, inject: body.inject });
      console.error(`[secrets] ${saved.name} (${saved.scope}) ${saved.inject ? "ticked for" : "taken out of"} a run's environment by the owner`);
    } else {
      return refuse(400, "invalid", "Invalid body. Expected { injectSecrets }, { name, value, scope?, inject? } or { name, scope?, inject }.", "malformed");
    }
    return NextResponse.json(await payload());
  } catch (err) {
    return failed(err);
  }
}

/**
 * Take one back.
 *
 * The name and the scope are read from the query and from a JSON body alike,
 * for the reason the permissions route reads both: a body on a DELETE is legal
 * but not every client sends one, and the one this route cannot see must never
 * be the reason a removal fails.
 */
export async function DELETE(request: Request) {
  const denied = await guard(request, true);
  if (denied) return denied;
  const query = new URL(request.url).searchParams;
  let name: unknown = query.get("name");
  let scope: unknown = query.get("scope");
  if (name === null) {
    const body = await objectBody(request);
    if (body === "too_long") return refuse(413, "invalid", TOO_LONG, "value_too_long");
    name = body?.name;
    scope = body?.scope;
  }
  // An absent `?scope=` is the whole box, which is what the store reads `null`
  // as; an empty one is a caller that meant something it did not say.
  if (scope === null) scope = undefined;
  try {
    const secrets = await deleteSecret({ name, scope });
    console.error(`[secrets] a stored secret was removed by the owner (${secrets.length} left)`);
    return NextResponse.json(await payload());
  } catch (err) {
    return failed(err);
  }
}
