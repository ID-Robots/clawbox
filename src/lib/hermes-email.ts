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

import { resolveImapHost, type EmailSettings } from "@/lib/email-config";
import { clearHermesEnvValues, getHermesEnvValue, setHermesEnvValues } from "@/lib/hermes-env";
import { ensureHermesGateway, readHermesGatewayStatus } from "@/lib/hermes-telegram";

export const HERMES_EMAIL_KEYS = [
  "EMAIL_ADDRESS",
  "EMAIL_PASSWORD",
  "EMAIL_SMTP_HOST",
  "EMAIL_SMTP_PORT",
  "EMAIL_IMAP_HOST",
  "EMAIL_ALLOWED_USERS",
] as const;

/**
 * True only in "answer" mode.
 *
 * NOT the same question as "may the agent read?". "read" mode also opens the
 * mailbox, but on demand and from ClawBox's own IMAP client — Hermes' adapter
 * is never wired up for it, because the adapter POLLS and REPLIES and that is
 * exactly what the middle mode promises not to do. Wiring EMAIL_* into
 * ~/.hermes/.env for a read-mode device would silently turn it into an
 * answering one.
 */
export function wantsInbound(settings: EmailSettings): boolean {
  return settings.mode === "answer"
    && Boolean(settings.allowedSenders && settings.allowedSenders.length > 0);
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
    EMAIL_IMAP_HOST: resolveImapHost(settings),
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

/**
 * Restart Hermes' messaging gateway so the adapter picks up the new .env.
 *
 * No abort signal, deliberately: the only caller reaches this after the EMAIL_*
 * block has been written, and `runHermesCli` refuses a call whose signal is
 * already aborted — so a browser that walked away would leave the credentials
 * saved and the gateway still polling the old mailbox.
 */
export async function restartHermesForEmail(): Promise<boolean> {
  const status = await ensureHermesGateway();
  // Both halves: a restart that was refused leaves the gateway running on the
  // PREVIOUS .env, which is exactly the state this function exists to rule out.
  return status.running && status.applied;
}

/**
 * What happened when email tried to stop Hermes receiving.
 *
 *   "none-running" — no gateway was up, so nothing was polling anyway.
 *   "stopped"      — the service was restarted and has dropped the adapter.
 *   "unmanaged"    — a gateway is running that this device did not install,
 *                    and it is STILL RECEIVING. See below.
 *   "restart-failed" — the restart was attempted and refused (no grant, systemd
 *                    error). Same user-visible consequence as "unmanaged": the
 *                    old process is still polling the old mailbox.
 */
export type EmailPollingStop =
  | "none-running"
  | "stopped"
  | "unmanaged"
  | "restart-failed";

/**
 * Restart the gateway ONLY if one is already up, and report what that did.
 *
 * This is the "email is going away" half, and it is deliberately not
 * ensureHermesGateway(): clearing the EMAIL_* block does nothing on its own, so
 * an adapter that is already polling keeps polling the old mailbox until
 * something restarts the gateway — but a device that never had a gateway must
 * not have one INSTALLED AND STARTED as a side effect of un-ticking a checkbox
 * or pressing Disconnect. ensureHermesGateway would do exactly that.
 *
 * A gateway that is RUNNING WITHOUT A SERVICE UNIT is somebody's foreground
 * `hermes gateway run`. ensureHermesGateway leaves that one alone on purpose —
 * `gateway restart` would fall through to running the next one in the
 * foreground and block this request until the timeout kills it — so nothing
 * here can make it drop the adapter, and it keeps the EMAIL_* values it read
 * at startup. That case answers "unmanaged" rather than reporting a restart
 * that did not happen: the allowlist can still reach the agent until someone
 * restarts that process, and the owner is told so.
 */
export async function stopHermesEmailPolling(): Promise<EmailPollingStop> {
  // The UNCACHED reader, like `ensureHermesGateway`: this branches on `before`,
  // and the shared fifteen-second memo picks the wrong branch. Opening
  // Settings → Channels populates that memo from three status routes at once,
  // so a gateway that died and was brought back by systemd inside the window
  // reads as `running:false` here — "none-running", answered as "receiving
  // stopped" over a live gateway still polling the mailbox the owner just
  // disconnected.
  const { value: before, answered } = await readHermesGatewayStatus();
  // Nor is a probe that could not be run an answer of "nothing was polling".
  // Same user-visible consequence as a refused restart: something may still be
  // receiving and this call did not change it, so say so.
  if (!answered) return "restart-failed";
  if (!before.running) return "none-running";
  if (!before.installed) return "unmanaged";
  const after = await ensureHermesGateway();
  // runHermesCli resolves on non-zero and the status probe is unprivileged, so
  // an unchecked await here reported "stopped" for a restart that was refused.
  return after.applied ? "stopped" : "restart-failed";
}
