// /setup-api/email/draft-approval — where approved e-mail drafts are sent from.
//
//   GET     the configuration, without the secret header value
//   POST    {enabled?, endpoint?, authHeader?, authValue?} to change it, or
//           {action: "test"} to ask the backend whether it answers
//   DELETE  forget the backend and switch the cards off
//
// THE OWNER'S BROWSER ONLY. Whoever can point this setting somewhere decides
// where every approved draft is sent from and which service receives the auth
// header, so neither the MCP bearer nor another ClawBox user may change it —
// the same reasoning as /setup-api/email/chat-approval, narrowed to the owner
// because the send credential behind the backend is the box's, not a user's.
// Writes also have to come from this ClawBox's own pages.

import { NextResponse } from "next/server";
import { getSystemUsername } from "@/lib/auth";
import { readJsonObject } from "@/lib/bounded-json";
import {
  clearDraftApprovalConfig,
  parseDraftApprovalUpdate,
  publicDraftApprovalConfig,
  readDraftApprovalConfig,
  saveDraftApprovalConfig,
} from "@/lib/mail-draft-approval-config";
import { probeBackend } from "@/lib/mail-draft-backend";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8192;

function refusal(error: string, kind: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, kind, ...extra }, { status, headers: { "cache-control": "no-store" } });
}

const FORBIDDEN = () => refusal("Changing where approved e-mail is sent from needs the owner's signed-in browser.", "owner_only", 403);
const CROSS_ORIGIN = () => refusal("This setting can only be changed from this ClawBox's own pages.", "cross_origin", 403);

const FIELD_ERRORS: Record<string, string> = {
  "endpoint:not_loopback": "The send backend must run on this ClawBox: use http://127.0.0.1:<port>.",
  "endpoint:credentials": "Put the credential in the auth header, not in the address.",
  "endpoint:query": "The address cannot carry a query string or a #fragment.",
  "endpoint:invalid": "That is not an http:// or https:// address.",
  "authHeader:invalid": "That is not a header name ClawBox can send.",
  "authValue:invalid": "The header value must be one line of plain text.",
  "enabled:invalid": "enabled must be true or false.",
};

async function snapshot() {
  const { config, known } = await readDraftApprovalConfig();
  return { ...publicDraftApprovalConfig(config), unknown: !known };
}

export async function GET(request: Request) {
  if (!(await hasOwnerSession(request))) return FORBIDDEN();
  return NextResponse.json(await snapshot(), { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) return FORBIDDEN();
  if (!isSameOriginRequest(request)) return CROSS_ORIGIN();

  const parsed = await readJsonObject(request, MAX_BODY_BYTES);
  if (!parsed.ok) return refusal("Invalid request body.", "invalid", 400);
  const body = parsed.body;

  if (body.action === "test") {
    const { config, known } = await readDraftApprovalConfig();
    if (!known) return refusal("Could not read this ClawBox's settings.", "unknown", 503);
    if (!config.endpoint) return refusal("Save the send backend's address first.", "no_endpoint", 409);
    const result = await probeBackend(config, getSystemUsername());
    return NextResponse.json({ result }, { headers: { "cache-control": "no-store" } });
  }

  const update = parseDraftApprovalUpdate(body);
  if (!update.ok) {
    return refusal(FIELD_ERRORS[`${update.field}:${update.reason}`] ?? "Invalid value.", "invalid_field", 400, { field: update.field });
  }

  const { config, known } = await readDraftApprovalConfig();
  if (!known) return refusal("Could not read this ClawBox's settings.", "unknown", 503);
  const endpointAfter = update.update.endpoint !== undefined ? update.update.endpoint : config.endpoint;
  const enabledAfter = update.update.enabled ?? config.enabled;
  if (enabledAfter && !endpointAfter) {
    return refusal("Add the send backend's address before switching this on.", "no_endpoint", 409);
  }

  try {
    await saveDraftApprovalConfig(update.update);
  } catch {
    return refusal("Could not save the setting.", "save_failed", 500);
  }
  return NextResponse.json({ success: true, ...(await snapshot()) }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(request: Request) {
  if (!(await hasOwnerSession(request))) return FORBIDDEN();
  if (!isSameOriginRequest(request)) return CROSS_ORIGIN();
  try {
    await clearDraftApprovalConfig();
  } catch {
    return refusal("Could not save the setting.", "save_failed", 500);
  }
  return NextResponse.json({ success: true, ...(await snapshot()) }, { headers: { "cache-control": "no-store" } });
}
