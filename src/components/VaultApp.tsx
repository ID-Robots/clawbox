"use client";

import { VAULT_PROXY_PREFIX } from "@/lib/vault-proxy";

/**
 * ClawBox Vault's window: the vault service's own page, shown as it is.
 *
 * The page comes from the loopback-only vault service through the owner-only
 * route under /apps/clawbox-vault/ (src/lib/vault-proxy.ts says why that is
 * not the generic app proxy). It is ClawBox's own code, so the frame is
 * same-origin and carries no sandbox: every request the page makes then
 * carries the session cookie, which is what lets the route refuse anyone but
 * the owner. What unlocks the passwords themselves is the vault PIN, asked by
 * the page in the frame and checked by the service, never by this window.
 */
export const VAULT_FRAME_SRC = `${VAULT_PROXY_PREFIX}/`;

/** A product name, like the app's own (src/lib/desktop-apps.ts): not translated. */
const VAULT_TITLE = "ClawBox Vault";

export default function VaultApp() {
  return (
    <iframe
      src={VAULT_FRAME_SRC}
      title={VAULT_TITLE}
      data-testid="vault-frame"
      className="h-full w-full border-0 bg-[var(--bg-deep)]"
      referrerPolicy="no-referrer"
    />
  );
}
