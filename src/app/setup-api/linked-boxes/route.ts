export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { readJsonObject } from "@/lib/bounded-json";
import { readFailureKind } from "@/lib/config-store";
import { boxSwitcherLabels, readLinkedBoxes, thisBoxName, writeLinkedBoxes } from "@/lib/linked-boxes";
import { MAX_LINKED_BOXES, parseLinkedBoxesWrite } from "@/lib/linked-boxes-shape";
import { personSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * /setup-api/linked-boxes — the owner's other ClawBoxes, in the order
 * Ctrl+Shift+2 … Ctrl+Shift+9 switch to them (slot 1 is always this box).
 * The rules are src/lib/linked-boxes-shape.ts; the store src/lib/linked-boxes.ts.
 *
 * GET `{ self: { name }, boxes: [{ name, url }], max, labels: { empty } }` —
 *     `self.name` is what slot 1 is called (this box's hostname), `max` how
 *     many boxes the list holds, `labels` the kiosk extension's indicator
 *     words in the box's language (`{n}` left in for the slot).
 * PUT `{ boxes: [{ name, url }] }` — the whole list, replaced; answers what GET
 *     answers. 400 `invalid_body` / `too_many` / `invalid_name` /
 *     `invalid_url` / `duplicate` / `self` (this box: the address the request
 *     came in by, or a loopback one), with `index`, the entry at fault.
 *
 * OWNER ONLY, both ways: the owner's cookie (never another user's, never the
 * agent's MCP bearer — `personSession` is a person) and, for the write, our
 * own page (403 `cross_origin`). The list names the owner's other boxes, and a
 * write decides where the owner's next key press takes them.
 */

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 16 * 1024;

function refuse(status: number, code: string, error: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ...extra, error, code }, { status, headers: NO_STORE });
}

async function ownerOnly(req: Request, write: boolean): Promise<NextResponse | null> {
  const who = await personSession(req);
  if (!who?.isOwner) return refuse(403, "owner_only", "Only the box owner can see or change the linked ClawBoxes.");
  if (write && !isSameOriginRequest(req)) return refuse(403, "cross_origin", "The linked ClawBoxes can only be changed from this ClawBox's own pages.");
  return null;
}

async function answer(boxes: Awaited<ReturnType<typeof readLinkedBoxes>>): Promise<NextResponse> {
  const [name, labels] = await Promise.all([thisBoxName(), boxSwitcherLabels()]);
  return NextResponse.json({ self: { name }, boxes, max: MAX_LINKED_BOXES, labels }, { headers: NO_STORE });
}

export async function GET(req: Request) {
  const refused = await ownerOnly(req, false);
  if (refused) return refused;
  try {
    return await answer(await readLinkedBoxes());
  } catch (err) {
    console.error("[linked-boxes] the list could not be read:", readFailureKind(err));
    return refuse(500, "store_read_failed", "The linked ClawBoxes could not be read.");
  }
}

const ERRORS: Record<string, string> = {
  invalid_body: "Send { boxes: [{ name, url }] }.",
  too_many: `At most ${MAX_LINKED_BOXES} other ClawBoxes can be linked.`,
  invalid_name: "Each ClawBox needs a name of 1 to 40 characters.",
  invalid_url: "Each ClawBox needs the http:// or https:// address of its desktop.",
  duplicate: "That ClawBox is already in the list.",
  self: "That is this ClawBox, which is always number 1.",
};

/** The host:port this request reached the box by. */
function requestHost(req: Request): string {
  const header = req.headers.get("host")?.trim();
  if (header) return header.toLowerCase();
  try {
    return new URL(req.url).host.toLowerCase();
  } catch {
    return "";
  }
}

export async function PUT(req: Request) {
  const refused = await ownerOnly(req, true);
  if (refused) return refused;
  const read = await readJsonObject(req, MAX_BODY_BYTES);
  if (!read.ok) {
    return read.reason === "too_long"
      ? refuse(413, "body_too_large", "That request body is too large.")
      : refuse(400, "invalid_body", ERRORS.invalid_body);
  }
  const parsed = parseLinkedBoxesWrite(read.body.boxes, { selfHosts: [requestHost(req)] });
  if (!parsed.ok) {
    return refuse(400, parsed.code, ERRORS[parsed.code] ?? ERRORS.invalid_body, parsed.index === undefined ? {} : { index: parsed.index });
  }
  let kept;
  try {
    kept = await writeLinkedBoxes(parsed.boxes);
  } catch (err) {
    console.error("[linked-boxes] the list could not be saved:", readFailureKind(err));
    return refuse(500, "store_write_failed", "The linked ClawBoxes could not be saved. Nothing was changed.");
  }
  return answer(kept);
}
