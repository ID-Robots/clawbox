// Where the device's outgoing-mail credentials live, and the only module that
// reads them back out.
//
// STORAGE: data/config.json through config-store, which writes 0600 via
// temp+rename — the same place and the same discipline as the Telegram bot
// token. Nothing here ever goes into the repo, and the app password is only
// ever returned to a caller by getEmailCredentials(), which the SMTP paths use
// and no HTTP response body ever includes.
//
// MASKING: publicEmailStatus() is what /setup-api/email/status returns. It
// reports the address masked (k••••i@example.com) and the password as a
// boolean, because "which account is this box sending as" is a legitimate
// question and "what is the password" is not.

import { get, setMany } from "@/lib/config-store";
import { isEmailAddress, isHostname, isPort, type SmtpConfig } from "@/lib/smtp-client";

export const EMAIL_KEYS = {
  address: "email_address",
  password: "email_password",
  smtpHost: "email_smtp_host",
  smtpPort: "email_smtp_port",
  smtpSecure: "email_smtp_secure",
  fromName: "email_from_name",
  imapHost: "email_imap_host",
  allowedSenders: "email_allowed_senders",
} as const;

/** Gmail's submission endpoint — what the form is prefilled with. */
export const DEFAULT_SMTP_HOST = "smtp.gmail.com";
export const DEFAULT_SMTP_PORT = 587;
export const DEFAULT_IMAP_HOST = "imap.gmail.com";

export interface EmailSettings {
  address: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  /** true = implicit TLS (465). false = plain connect + STARTTLS (587). */
  smtpSecure: boolean;
  fromName?: string;
  /** Hermes inbound only. Empty string when the user did not ask for replies. */
  imapHost?: string;
  /** Hermes inbound only. Who the agent is allowed to answer. */
  allowedSenders?: string[];
}

export interface PublicEmailStatus {
  configured: boolean;
  address: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  fromName: string | null;
  hasPassword: boolean;
  inbound: boolean;
  imapHost: string | null;
  allowedSenders: string[];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Show enough of the address to recognise the account, never enough to harvest
 * it. The domain stays readable because that is what tells a user "this is my
 * work account, not my personal one".
 */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "•".repeat(Math.min(address.length, 8));
  const local = address.slice(0, at);
  const domain = address.slice(at);
  if (local.length <= 2) return `${local[0]}•${domain}`;
  return `${local[0]}${"•".repeat(Math.min(local.length - 2, 6))}${local[local.length - 1]}${domain}`;
}

/** Credentials for the SMTP client. null when the device has none. */
export async function getEmailCredentials(): Promise<EmailSettings | null> {
  const address = asString(await get(EMAIL_KEYS.address));
  const password = asString(await get(EMAIL_KEYS.password));
  const smtpHost = asString(await get(EMAIL_KEYS.smtpHost));
  if (!address || !password || !smtpHost) return null;

  const rawPort = await get(EMAIL_KEYS.smtpPort);
  const smtpPort = typeof rawPort === "number" && isPort(rawPort) ? rawPort : DEFAULT_SMTP_PORT;
  const rawSenders = await get(EMAIL_KEYS.allowedSenders);

  return {
    address,
    password,
    smtpHost,
    smtpPort,
    smtpSecure: (await get(EMAIL_KEYS.smtpSecure)) === true,
    fromName: asString(await get(EMAIL_KEYS.fromName)) || undefined,
    imapHost: asString(await get(EMAIL_KEYS.imapHost)) || undefined,
    allowedSenders: Array.isArray(rawSenders) ? rawSenders.filter((s): s is string => typeof s === "string") : undefined,
  };
}

/** The shape /setup-api/email/status returns. Never carries the password. */
export async function publicEmailStatus(): Promise<PublicEmailStatus> {
  const settings = await getEmailCredentials();
  if (!settings) {
    return {
      configured: false,
      address: null,
      smtpHost: null,
      smtpPort: null,
      smtpSecure: false,
      fromName: null,
      hasPassword: false,
      inbound: false,
      imapHost: null,
      allowedSenders: [],
    };
  }
  return {
    configured: true,
    address: maskAddress(settings.address),
    smtpHost: settings.smtpHost,
    smtpPort: settings.smtpPort,
    smtpSecure: settings.smtpSecure,
    fromName: settings.fromName ?? null,
    hasPassword: true,
    inbound: Boolean(settings.imapHost && settings.allowedSenders?.length),
    imapHost: settings.imapHost ?? null,
    allowedSenders: settings.allowedSenders ?? [],
  };
}

export function toSmtpConfig(settings: EmailSettings): SmtpConfig {
  return {
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpSecure,
    user: settings.address,
    password: settings.password,
  };
}

export async function saveEmailSettings(settings: EmailSettings): Promise<void> {
  await setMany({
    [EMAIL_KEYS.address]: settings.address,
    [EMAIL_KEYS.password]: settings.password,
    [EMAIL_KEYS.smtpHost]: settings.smtpHost,
    [EMAIL_KEYS.smtpPort]: settings.smtpPort,
    [EMAIL_KEYS.smtpSecure]: settings.smtpSecure,
    [EMAIL_KEYS.fromName]: settings.fromName || undefined,
    [EMAIL_KEYS.imapHost]: settings.imapHost || undefined,
    [EMAIL_KEYS.allowedSenders]:
      settings.allowedSenders && settings.allowedSenders.length > 0 ? settings.allowedSenders : undefined,
  });
}

export async function clearEmailSettings(): Promise<void> {
  await setMany(Object.fromEntries(Object.values(EMAIL_KEYS).map((k) => [k, undefined])));
}

// ── Request validation ───────────────────────────────────────────────────────

export interface EmailConfigureInput {
  address?: unknown;
  password?: unknown;
  smtpHost?: unknown;
  smtpPort?: unknown;
  smtpSecure?: unknown;
  fromName?: unknown;
  imapHost?: unknown;
  allowedSenders?: unknown;
}

export type ParseResult =
  | { ok: true; settings: EmailSettings }
  | { ok: false; error: string };

const MAX_PASSWORD_LEN = 512;
const MAX_NAME_LEN = 100;
const MAX_ALLOWED_SENDERS = 25;

/**
 * Validate what the form posted, entirely offline. A value that would be read
 * as a command-line flag or spliced into a mail header is rejected here rather
 * than at the SMTP server: the Hermes wiring below passes several of these
 * straight to a CLI.
 */
export function parseEmailConfigure(body: EmailConfigureInput): ParseResult {
  const address = typeof body.address === "string" ? body.address.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const smtpHost = (typeof body.smtpHost === "string" ? body.smtpHost.trim() : "") || DEFAULT_SMTP_HOST;
  const rawPort = body.smtpPort;
  const smtpPort =
    typeof rawPort === "number"
      ? rawPort
      : typeof rawPort === "string" && rawPort.trim() !== ""
        ? Number(rawPort)
        : DEFAULT_SMTP_PORT;

  if (!address) return { ok: false, error: "Email address is required" };
  if (!isEmailAddress(address)) return { ok: false, error: "That does not look like an email address" };
  if (!password) return { ok: false, error: "App password is required" };
  if (password.length > MAX_PASSWORD_LEN) return { ok: false, error: "App password is too long" };
  if (/[\r\n]/.test(password)) return { ok: false, error: "App password cannot contain line breaks" };
  if (!isHostname(smtpHost) || smtpHost.startsWith("-")) {
    return { ok: false, error: "That does not look like a server address" };
  }
  if (!isPort(smtpPort)) return { ok: false, error: "Port must be a number between 1 and 65535" };

  const fromName = typeof body.fromName === "string" ? body.fromName.trim() : "";
  if (fromName.length > MAX_NAME_LEN) return { ok: false, error: "Display name is too long" };
  if (/[\r\n]/.test(fromName)) return { ok: false, error: "Display name cannot contain line breaks" };

  const imapHost = typeof body.imapHost === "string" ? body.imapHost.trim() : "";
  if (imapHost && (!isHostname(imapHost) || imapHost.startsWith("-"))) {
    return { ok: false, error: "That does not look like a server address" };
  }

  const rawSenders = body.allowedSenders;
  let allowedSenders: string[] = [];
  if (typeof rawSenders === "string") {
    allowedSenders = rawSenders.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean);
  } else if (Array.isArray(rawSenders)) {
    allowedSenders = rawSenders.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
  }
  if (allowedSenders.length > MAX_ALLOWED_SENDERS) {
    return { ok: false, error: `At most ${MAX_ALLOWED_SENDERS} allowed senders` };
  }
  for (const sender of allowedSenders) {
    if (!isEmailAddress(sender)) return { ok: false, error: `"${sender}" is not a valid email address` };
  }

  // Inbound is opt-in AND allowlist-only. Hermes' email adapter has no pairing
  // flow — the allowlist is the ONLY access control — so an inbox with no
  // allowlist would be an unauthenticated path to an agent that holds the
  // device's tools. Refuse rather than guess what an empty allowlist means.
  if (imapHost && allowedSenders.length === 0) {
    return {
      ok: false,
      error: "To let people email the agent, list at least one address that is allowed to write to it",
    };
  }
  if (!imapHost) allowedSenders = [];

  return {
    ok: true,
    settings: {
      address,
      password,
      smtpHost,
      smtpPort,
      smtpSecure: body.smtpSecure === true || smtpPort === 465,
      fromName: fromName || undefined,
      imapHost: imapHost || undefined,
      allowedSenders: allowedSenders.length > 0 ? allowedSenders : undefined,
    },
  };
}
