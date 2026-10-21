import { NextResponse } from "next/server";
import { readJsonObject } from "@/lib/bounded-json";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import {
  assistantSecretSources,
  getSecretImportEnabled,
  importAssistantSecret,
  listAssistantSecrets,
} from "@/lib/assistant-secrets";
import {
  BOX_SCOPE,
  getInjectSecrets,
  listSecrets,
  MAX_SECRET_VALUE_CHARS,
  MAX_SECRETS,
  SecretStoreError,
} from "@/lib/project-secrets";

export const dynamic = "force-dynamic";

/**
 * "Import from assistant": copy a key the main assistant already holds into
 * the owner's secret store (src/lib/assistant-secrets.ts).
 *
 * THE OWNER ONLY — `hasOwnerSession`, narrower than the secrets route's
 * `hasPersonSession`. A second ClawBox user may keep secrets of their own on the
 * shared list, but the assistant's keys are the owner's credentials, and moving
 * one towards an unattended run is the owner's call. The MCP bearer, which
 * middleware admits to every /setup-api/* path, is refused here in-handler: a
 * grant the agent could make to itself would be no grant at all, which is also
 * why there is no MCP tool for this.
 *
 * SAME ORIGIN FOR THE COPY, like every write on the secrets route, so another
 * page in the owner's browser cannot trigger one while they read it.
 *
 * NAMES ONLY, EVERYWHERE. The list answers names and where they live; the copy
 * answers the name and scope it stored and the re-read list. The value is read
 * on this box, sealed by the store and never put in an answer, a refusal or a
 * log line — not even its length.
 *
 * GET               → { names: [{ name, source }], sources }
 * POST { name, scope } → { imported: { name, scope }, secrets, max, maxValueChars, injectSecrets }
 *
 * The copy lands UN-TICKED and refuses to replace an entry already there (409):
 * the owner's three gates on the secrets card decide the rest.
 */

function refuse(status: number, kind: string, error: string, code?: string) {
  return NextResponse.json({ error, kind, ...(code ? { code } : {}) }, { status });
}

/** Owner session and, for the copy, this box's own page — in that order. */
async function guard(request: Request, write: boolean): Promise<NextResponse | null> {
  if (!(await hasOwnerSession(request))) {
    return refuse(403, "owner_only", "Copying the assistant's keys needs the owner's signed-in browser session.");
  }
  if (write && !isSameOriginRequest(request)) {
    return refuse(403, "cross_origin", "The assistant's keys can only be copied from this ClawBox's own pages.");
  }
  // After the owner check, so the switch's state is the owner's to learn.
  if (!(await getSecretImportEnabled())) {
    return refuse(404, "disabled", "Importing keys from the assistant is switched off on this ClawBox.", "disabled");
  }
  return null;
}

/** The same re-read answer the secrets route gives, so the card renders the box's own list. */
async function payload() {
  const [secrets, injectSecrets] = await Promise.all([listSecrets(), getInjectSecrets()]);
  return { secrets, max: MAX_SECRETS, maxValueChars: MAX_SECRET_VALUE_CHARS, injectSecrets };
}

function failed(err: unknown) {
  if (err instanceof SecretStoreError) {
    const status = err.code === "not_found" || err.code === "not_held"
      ? 404
      : err.code === "exists"
        ? 409
        : err.code === "store_unreadable" || err.code === "store_unwritable" || err.code === "key_unavailable" || err.code === "source_unreadable"
          ? 500
          : 400;
    const kind = status === 404 ? "not_found" : status === 409 ? "conflict" : "invalid";
    return NextResponse.json({ error: err.message, kind, code: err.code }, { status });
  }
  return NextResponse.json({ error: "Could not copy the assistant's key" }, { status: 500 });
}

/** A name and a scope, and nothing else: a few hundred bytes is generous. */
const MAX_BODY_BYTES = 4_096;
const TOO_LONG = "That request is larger than a name and a scope can be.";

export async function GET(request: Request) {
  const denied = await guard(request, false);
  if (denied) return denied;
  try {
    return NextResponse.json({ names: await listAssistantSecrets(), sources: assistantSecretSources() });
  } catch (err) {
    return failed(err);
  }
}

export async function POST(request: Request) {
  const denied = await guard(request, true);
  if (denied) return denied;
  const read = await readJsonObject(request, MAX_BODY_BYTES, TOO_LONG);
  if (!read.ok) {
    return read.reason === "too_long"
      ? refuse(413, "invalid", TOO_LONG, "too_long")
      : refuse(400, "invalid", "Invalid body. Expected { name, scope }.", "malformed");
  }
  try {
    const copied = await importAssistantSecret({ name: read.body.name, scope: read.body.scope });
    // The NAME, the scope and where it came from — never the value or its
    // length. The audit trail has its own line (src/lib/secrets-audit.ts).
    console.error(
      `[secrets] ${copied.name} copied from the assistant by the owner for ${copied.scope === BOX_SCOPE ? "the whole box" : `project ${copied.scope}`}, not yet given to runs`,
    );
    return NextResponse.json({ imported: { name: copied.name, scope: copied.scope }, ...(await payload()) });
  } catch (err) {
    return failed(err);
  }
}
