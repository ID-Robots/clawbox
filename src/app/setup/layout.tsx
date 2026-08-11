import type { ReactNode } from "react";
import { resolveAgentSkin } from "@/lib/setup-skin";

// ── Why this segment is force-dynamic ────────────────────────────────────────
//
// The edition is a property of the INSTALLED DEVICE, and it must be read on the
// device, per request. Rendering it into a prerendered shell would bake the
// BUILD's answer into static HTML — and on this product the build genuinely
// runs before the answer exists: install.sh calls `step_build` (line ~2684)
// BEFORE `step_edition_lock` (line ~2708), so on a first Hermes install
// /etc/clawbox/edition.env does not exist yet at build time and readEdition()
// would fall back to its "openclaw" default. The same ordering holds for the
// in-app updater, which rebuilds and only then re-bakes the lock. A prerendered
// shell would therefore ship a Hermes appliance wearing ClawBox paint, exactly
// the bug class the root-owned edition file exists to prevent.
//
// force-dynamic pins the read to request time on the running box, so the answer
// is always the device's own — and it also means an edition switch takes effect
// on the next page load rather than the next rebuild.
export const dynamic = "force-dynamic";

/**
 * Stamps the agent skin on an ancestor of `.setup-shell`.
 *
 * The Hermes layer in globals.css is written as `[data-agent="hermes"]
 * .setup-shell`, a DESCENDANT selector, so the attribute cannot live on the
 * shell itself — it needs a wrapper. The wrapper is `display: contents`, which
 * removes it from the box tree entirely: `.setup-shell` stays the direct flex
 * item of <body> it was before, so this adds a selector hook and not a single
 * pixel of layout. Selector matching is unaffected by `display: contents` — it
 * is still a real DOM ancestor.
 *
 * This is server-rendered, so the attribute is present in the very first byte
 * of HTML the browser parses. There is no client fetch to wait on and nothing
 * to re-paint: the customer never sees the wrong skin, not even for a frame.
 * A client-side `fetchHarness()` could not offer that — on a captive portal
 * during first boot it is also a request that may hang or fail with no network
 * at all, and the wizard would either flash from coral to teal or block on it.
 */
export default async function SetupLayout({ children }: { children: ReactNode }) {
  // `undefined` makes React omit the attribute, which is the ClawBox default.
  const agent = await resolveAgentSkin();
  return (
    <div data-agent={agent} style={{ display: "contents" }}>
      {children}
    </div>
  );
}
