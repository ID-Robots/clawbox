export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { logSafe } from "@/lib/log-safe";
import { hasOwnerSession } from "@/lib/owner-session";
import { setProviderEnabled } from "@/lib/provider-enablement";
import { readProviderStatus } from "@/lib/provider-status";

/**
 * "Switch this provider off (or back on)."
 *
 * POST { provider: string, enabled: boolean } → the same payload as GET
 * /setup-api/providers/status, re-read after the change, so the strip can
 * repaint from the answer without a second round-trip.
 *
 * OWNER ONLY. Middleware admits every /setup-api/* call on the MCP bearer, and
 * the agent holds that bearer; a route that trusted it here would let a
 * prompt-injected agent switch a provider off — or back on — behind the
 * owner's back. Same rule and same helper as coding-agent/enable: a real
 * browser session or a 403, identical for "no credential" and "valid bearer".
 *
 * The refusals are the rule's, passed through with their own status: 409 for
 * the default (the fix is to pick another default first, and the message says
 * so) and 404 for an id this harness has no row for.
 */
export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Changing an AI provider's switch needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  // `in` throws on a body that is a bare string, number or boolean — all legal
  // JSON — so the shape is checked before any field is read.
  const fields = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as { provider?: unknown; enabled?: unknown })
    : {};
  const provider = typeof fields.provider === "string" ? fields.provider.trim() : "";
  if (!provider || typeof fields.enabled !== "boolean") {
    return NextResponse.json(
      { error: "Invalid body. Expected { provider: string, enabled: boolean }." },
      { status: 400 },
    );
  }

  const result = await setProviderEnabled(provider, fields.enabled);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, kind: result.kind },
      { status: result.kind === "is_default" ? 409 : 404 },
    );
  }
  // The id the box FLIPPED, reported back by the rule from its own row —
  // `deepseek` in the body is `clawai` here, and that is the id an operator
  // greps the journal for. Nothing off the REQUEST reaches the line any more,
  // which is what clears js/log-injection (TASK-723): CodeQL does not read
  // `logSafe` as a barrier, and the note in ai-models/configure/route.ts says
  // so.
  //
  // `logSafe` STAYS, and it is now guarding a different thing. A row id is
  // ours in the sense that the box wrote it, not in the sense that it has a
  // shape: `provider-status.ts` pushes the prefix of
  // `agents.defaults.model.primary` as a row of its own, and
  // `normalizeProviderId` only trims and lowercases it — so an agent holding
  // the MCP bearer, which may run `openclaw config set` but may not POST here,
  // can put an embedded newline or a megabyte into that id and have the
  // owner's next flip write it. Both of `log-safe.ts`'s rules are about the
  // record's SHAPE rather than who chose it: one value stays one line, and one
  // caller does not decide how much gets written. Sanitising a value that is
  // not a taint source cannot resurrect the alert — a barrier CodeQL fails to
  // recognise is one that never creates a finding either.
  console.error(`[providers] ${logSafe(result.provider)} switched ${fields.enabled ? "on" : "off"} by the owner`);

  // DELIBERATELY no catalogue signal here, and the reason is worth writing
  // down because it looks like one is missing. This flip writes exactly one
  // thing: ClawBox's own `ai_disabled_providers` key in ClawBox's own config
  // store (`provider-enablement.ts`). It does not touch `~/.openclaw`, it does
  // not re-gate a plugin, and `openclaw models list` has never heard of that
  // key — so what the catalogue enumerates for this provider is byte-for-byte
  // what it was a moment ago, and the catalogue route never reads the disabled
  // list either (the strip's greying comes from `readProviderStatus`, below).
  //
  // The switch DOES eventually change an enumeration, but not here: switching
  // anthropic off makes `hasUsableAnthropicCredential` false, so the NEXT save
  // or chat-model pick re-gates the plugin — and that write counts its own
  // change (`setProviderPlugins` returns the id it flipped, and the ON half is
  // answered by `providerPluginSwitchedOnBy`). Counting the flip here as well
  // spent a full ~3-minute, ~2-core `openclaw models list` on a Jetson per
  // click, twice for an off-and-on, and cleared the failed-refresh backoff
  // each time, to be told the same rows again.

  const summary = await readProviderStatus();
  return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
}
