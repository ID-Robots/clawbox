// Which agent skin the setup wizard wears.
//
// globals.css ships a Hermes layer keyed on `[data-agent="hermes"]` sitting on
// an ANCESTOR of `.setup-shell`. Until now nothing in the product ever set that
// attribute, so the layer was dead code and a Hermes box wore ClawBox colours.
// This module decides the value; `src/app/setup/layout.tsx` is the only thing
// that stamps it.
//
// WHY the ACTIVE HARNESS and not the raw edition: the skin describes the agent
// the customer is about to meet, and that is exactly what `getActiveHarness()`
// answers. On the single-harness "hermes" SKU the edition lock pins it to
// "hermes" regardless of config.json; on a licensed "dual" box it follows the
// picker; on "openclaw" — and on an unlicensed "dual", which degrades to the
// default harness — it is "openclaw" and no attribute is emitted at all.

import { getActiveHarness } from "@/lib/harness";

/** The only agent skin the stylesheet defines. */
export type AgentSkin = "hermes";

/**
 * Map a harness id to the skin it wears. Anything that is not exactly "hermes"
 * — including null, undefined and unknown ids — wears the default ClawBox skin,
 * which is expressed by emitting no `data-agent` attribute at all.
 */
export function skinForHarness(harness: string | null | undefined): AgentSkin | undefined {
  return harness === "hermes" ? "hermes" : undefined;
}

/**
 * Resolve the skin for this device.
 *
 * Never throws and never rejects. An unreadable /etc/clawbox/edition.env, an
 * unreadable config.json, anything at all — we could not PROVE this is a Hermes
 * box, so the wizard renders in ClawBox colours and carries on. Failing to
 * resolve the edition is not an error state: a wrong tint is cosmetic, a setup
 * wizard that refuses to render is a brick on a customer's first boot.
 */
export async function resolveAgentSkin(): Promise<AgentSkin | undefined> {
  try {
    return skinForHarness(await getActiveHarness());
  } catch {
    return undefined;
  }
}
