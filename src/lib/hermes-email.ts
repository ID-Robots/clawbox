// Email on a Hermes device — the INBOUND half.
//
// Two very different things are called "email" in this feature:
//
//   OUTBOUND (both editions): ClawBox's own SMTP client, driven by the
//     email_send MCP tool and the "Send test email" button. Nothing here is
//     involved; the credentials live in ClawBox's config store.
//
//   INBOUND (Hermes only): Hermes' native email gateway adapter polls an IMAP
//     mailbox and replies in-thread. That is what this module turns on. It is
//     opt-in, because it hands anyone on the allowlist a conversation with an
//     agent that holds the device's tools.
//
// Hermes' adapter reports "configured" only when ADDRESS + PASSWORD +
// SMTP_HOST + IMAP_HOST are all set (hermes_cli/gateway.py), so ClawBox writes
// all four or none — a partially-written set is a platform that never comes up
// and a status flag that never goes green.
//
// ACCESS CONTROL: the email adapter has NO pairing flow. EMAIL_ALLOWED_USERS is
// the only gate, and what an EMPTY allowlist means upstream was not established
// from the code. So ClawBox refuses to enable inbound without at least one
// allowed address (enforced in parseEmailConfigure) rather than betting the
// device's shell on the safer reading being the true one.
//
// EMAIL_IMAP_PORT / EMAIL_POLL_INTERVAL / EMAIL_ALLOW_ALL_USERS are documented
// upstream but deliberately not exposed: their defaults (993 / 15 s / false)
// are the ones we want, and the last of the three is the setting that would
// undo the paragraph above.

import type { EmailSettings } from "@/lib/email-config";
import { clearHermesEnvValues, getHermesEnvValue, setHermesEnvValues } from "@/lib/hermes-env";
import { ensureHermesGateway } from "@/lib/hermes-telegram";

export const HERMES_EMAIL_KEYS = [
  "EMAIL_ADDRESS",
  "EMAIL_PASSWORD",
  "EMAIL_SMTP_HOST",
  "EMAIL_SMTP_PORT",
  "EMAIL_IMAP_HOST",
  "EMAIL_ALLOWED_USERS",
] as const;

/** True when the settings ask for inbound: an IMAP host AND an allowlist. */
export function wantsInbound(settings: EmailSettings): boolean {
  return Boolean(settings.imapHost && settings.allowedSenders && settings.allowedSenders.length > 0);
}

/**
 * Write (or remove) the EMAIL_* block in ~/.hermes/.env. Does NOT restart the
 * gateway — the caller decides, because a restart failure must not read as a
 * failed save.
 */
export async function applyHermesEmail(settings: EmailSettings): Promise<{ inbound: boolean }> {
  if (!wantsInbound(settings)) {
    await clearHermesEnvValues([...HERMES_EMAIL_KEYS]);
    return { inbound: false };
  }
  await setHermesEnvValues({
    EMAIL_ADDRESS: settings.address,
    EMAIL_PASSWORD: settings.password,
    EMAIL_SMTP_HOST: settings.smtpHost,
    EMAIL_SMTP_PORT: String(settings.smtpPort),
    EMAIL_IMAP_HOST: settings.imapHost as string,
    EMAIL_ALLOWED_USERS: (settings.allowedSenders as string[]).join(","),
  });
  return { inbound: true };
}

/** Remove the whole EMAIL_* block — used when email is disconnected. */
export async function clearHermesEmail(): Promise<void> {
  await clearHermesEnvValues([...HERMES_EMAIL_KEYS]);
}

/**
 * What Hermes itself has on file. Reads .env directly rather than shelling out:
 * the status panel polls this, and a ~2 s CLI call per poll is not worth it for
 * a question a file read answers exactly.
 *
 * Returns key PRESENCE only. The password is never read back out of here.
 */
export async function hermesEmailState(): Promise<{
  address: string | null;
  imapHost: string | null;
  allowedSenders: string[];
  hasPassword: boolean;
}> {
  const [address, imapHost, allowed, password] = await Promise.all([
    getHermesEnvValue("EMAIL_ADDRESS"),
    getHermesEnvValue("EMAIL_IMAP_HOST"),
    getHermesEnvValue("EMAIL_ALLOWED_USERS"),
    getHermesEnvValue("EMAIL_PASSWORD"),
  ]);
  return {
    address: address || null,
    imapHost: imapHost || null,
    allowedSenders: (allowed || "").split(",").map((s) => s.trim()).filter(Boolean),
    hasPassword: Boolean(password),
  };
}

/** Restart Hermes' messaging gateway so the adapter picks up the new .env. */
export async function restartHermesForEmail(signal?: AbortSignal): Promise<boolean> {
  const status = await ensureHermesGateway(signal);
  return status.running;
}
