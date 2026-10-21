export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { readJsonObject } from "@/lib/bounded-json";
import { readClawboxMcpEnabled } from "@/lib/clawbox-mcp-switch";
import { hasOwnerSession } from "@/lib/owner-session";
import {
  CLAWBOX_READ_ONLY_ENTRY,
  isProjectScope,
  listingOf,
  MAX_PROJECT_MCP_SERVERS,
  ProjectMcpServersError,
  readHarnessMcpServers,
  readProjectMcpAllowlist,
  setProjectMcpAllowlist,
} from "@/lib/project-mcp-servers";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * /setup-api/coding-agent/mcp-servers — which MCP servers a project's coding
 * runs may use (src/lib/project-mcp-servers.ts), the checklist in a project's
 * settings in the Coding Agent app.
 *
 * GET ?project=<id> answers `{ project, selected, options, unreadable,
 * clawboxMcpEnabled, max }`: what the project has ticked, and what there is to
 * tick — every server this box's harness is configured with (names,
 * transports, and why one cannot be used; never a value) plus "ClawBox
 * read-only tools" while the owner's ClawBox MCP switch is on. A ticked name
 * that is no longer configured is still listed, so it can be unticked.
 *
 * POST `{ project, servers }` replaces the project's list.
 *
 * THE OWNER ONLY, both verbs — `hasOwnerSession`, the gate `secrets/import`
 * uses and narrower than `harness/mcp`'s `hasPersonSession`. The middleware
 * admits the MCP bearer everywhere under /setup-api, and an agent that could
 * tick a server for a project would be granting its own next run a tool the
 * owner never chose. A second ClawBox user is refused for the same reason
 * from the other side: a ticked harness server carries the credentials the
 * owner wired into it (env, headers) into every run of that project, so a
 * tick by anyone else would hand them the owner's tokens. Even the GET —
 * which servers the box is wired to is the owner's. The write also needs this
 * box's own page, so a cross-site page riding the owner's cookie cannot tick
 * one either.
 */

/** A project id and at most MAX_PROJECT_MCP_SERVERS short names: a few KB is generous. */
const MAX_BODY_BYTES = 8 * 1024;

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}

async function guard(req: Request, write: boolean): Promise<NextResponse | null> {
  if (!(await hasOwnerSession(req))) {
    return refuse(403, "owner_only", "Only the owner of this ClawBox can choose a project's MCP servers, from a signed-in browser session.");
  }
  if (write && !isSameOriginRequest(req)) {
    return refuse(403, "cross_origin", "A project's MCP servers can only be changed from this ClawBox's own pages.");
  }
  return null;
}

interface Option {
  id: string;
  kind: "clawbox" | "harness";
  harness?: "openclaw" | "hermes";
  transport?: "stdio" | "http" | "sse" | null;
  usable: boolean;
  reason?: string;
  /** For the page's own wording: an UnusableReason, or the two this route adds. */
  reasonCode?: string;
}

async function payload(project: string) {
  const [selected, harness, clawboxMcpEnabled] = await Promise.all([
    readProjectMcpAllowlist(project),
    readHarnessMcpServers(),
    readClawboxMcpEnabled(),
  ]);
  const options: Option[] = [];
  // Offered only while the switch is on; a project that ticked it before the
  // owner switched the server off still sees it, greyed, to untick.
  if (clawboxMcpEnabled || selected.includes(CLAWBOX_READ_ONLY_ENTRY)) {
    options.push({
      id: CLAWBOX_READ_ONLY_ENTRY,
      kind: "clawbox",
      usable: clawboxMcpEnabled,
      ...(clawboxMcpEnabled ? {} : { reason: "the ClawBox MCP server is switched off in Settings", reasonCode: "switchOff" }),
    });
  }
  const configured = new Set<string>();
  for (const server of harness.servers) {
    const listing = listingOf(server);
    configured.add(listing.name);
    options.push({ id: listing.name, kind: "harness", harness: listing.harness, transport: listing.transport, usable: listing.usable, ...(listing.reason ? { reason: listing.reason } : {}), ...(listing.reasonCode ? { reasonCode: listing.reasonCode } : {}) });
  }
  for (const name of selected) {
    if (name === CLAWBOX_READ_ONLY_ENTRY || configured.has(name)) continue;
    options.push({ id: name, kind: "harness", transport: null, usable: false, reason: "not configured on this box any more", reasonCode: "notConfigured" });
  }
  return { project, selected, options, unreadable: harness.unreadable, clawboxMcpEnabled, max: MAX_PROJECT_MCP_SERVERS };
}

export async function GET(req: Request) {
  const refused = await guard(req, false);
  if (refused) return refused;
  const project = new URL(req.url).searchParams.get("project");
  if (!isProjectScope(project)) return refuse(400, "invalid_project", "project must be a project's id or folder name.");
  return NextResponse.json(await payload(project), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const refused = await guard(req, true);
  if (refused) return refused;
  const read = await readJsonObject(req, MAX_BODY_BYTES);
  if (!read.ok) return read.reason === "too_long" ? refuse(413, "too_long", "That request body is too large.") : refuse(400, "bad_body", "Send { project, servers }.");
  const body = read.body;
  try {
    await setProjectMcpAllowlist(body.project, body.servers);
  } catch (err) {
    if (err instanceof ProjectMcpServersError) {
      return refuse(err.code === "store_unreadable" ? 500 : 400, err.code, err.message);
    }
    console.error("[coding-agent/mcp-servers] the list could not be saved:", err instanceof Error ? err.message : err);
    return refuse(500, "store_write_failed", "The list could not be saved — the ClawBox settings file could not be written. Nothing was changed.");
  }
  return NextResponse.json(await payload(body.project as string), { headers: { "Cache-Control": "no-store" } });
}
