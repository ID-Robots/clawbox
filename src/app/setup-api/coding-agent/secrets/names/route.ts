import { NextResponse } from "next/server";
import { hasValidSession } from "@/lib/route-auth";
import { listSecrets, SecretStoreError } from "@/lib/project-secrets";

export const dynamic = "force-dynamic";

/**
 * The NAMES of this ClawBox's stored secrets, and nothing else.
 *
 * WHY THIS EXISTS BESIDE THE OWNER-ONLY LIST. The agent has a legitimate need
 * for exactly one fact from this store: what a run can expect to find in its
 * environment, so it can say "the deploy will work, VERCEL_TOKEN is set" rather
 * than guessing, and so it can tell the owner which name is missing when a run
 * fails for the want of one. That is a name. It is not the shape of the whole
 * store, which is why the owner's own list
 * (`/setup-api/coding-agent/secrets`) stays cookie-only and this is a separate,
 * narrower door rather than a flag on that one.
 *
 * WHAT IT DELIBERATELY DOES NOT ANSWER: a value, under any parameter. There is
 * no verb anywhere that does — see the store's header.
 *
 * The MCP bearer is ADMITTED here, which is the whole point, so `hasValidSession`
 * (cookie OR bearer) is the right gate and `hasOwnerSession` would be the wrong
 * one. It is read-only, so it carries no origin check: nothing here changes.
 */
export async function GET(request: Request) {
  if (!(await hasValidSession(request))) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  try {
    const secrets = await listSecrets();
    return NextResponse.json({
      // `inject` and `readable` travel with each name because both change what
      // a run will actually find: an un-ticked entry is stored and not handed
      // over, and an unreadable one cannot be handed over at all. An agent told
      // only the name would promise a credential that never arrives.
      names: secrets.map((s) => ({ name: s.name, scope: s.scope, inject: s.inject, readable: s.readable })),
    });
  } catch (err) {
    if (err instanceof SecretStoreError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 500 });
    }
    return NextResponse.json({ error: "Could not read this ClawBox's stored secret names" }, { status: 500 });
  }
}
