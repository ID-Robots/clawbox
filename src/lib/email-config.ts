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
import type { ImapConfig } from "@/lib/imap-client";
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
  mode: "email_mode",
  askBeforeSend: "email_ask_before_send",
} as const;

/** Gmail's submission endpoint — what the form is prefilled with. */
export const DEFAULT_SMTP_HOST = "smtp.gmail.com";
export const DEFAULT_SMTP_PORT = 587;
export const DEFAULT_IMAP_HOST = "imap.gmail.com";
/** IMAP over implicit TLS. Not exposed in the panel — see imap-client.ts. */
export const DEFAULT_IMAP_PORT = 993;

/**
 * What the agent is allowed to do with the mailbox. One choice, three values,
 * because the owner's question was "may it read?" and "may it answer?" — two
 * independent booleans would also spell "answers senders but may not read",
 * which is not a thing.
 *
 *   send   — outbound only. The mailbox is never opened. (Was: inbound unticked.)
 *   read   — outbound, plus email_list/email_read WHEN THE AGENT IS ASKED.
 *            Nothing polls; the mailbox is touched only inside a tool call.
 *   answer — Hermes' native inbound adapter: it polls, and it replies to the
 *            allowlist on its own. (Was: inbound ticked.)
 */
export type EmailMode = "send" | "read" | "answer";

export const EMAIL_MODES: readonly EmailMode[] = ["send", "read", "answer"] as const;

export function isEmailMode(value: unknown): value is EmailMode {
  return typeof value === "string" && (EMAIL_MODES as readonly string[]).includes(value);
}

/** Modes in which the read-on-demand tools have a mailbox to open. */
export function modeAllowsReading(mode: EmailMode): boolean {
  return mode === "read" || mode === "answer";
}

/**
 * The IMAP host implied by an SMTP host, so the common case needs no second
 * field. "smtp.gmail.com" -> "imap.gmail.com", and the same for every provider
 * that names its two servers that way (fastmail, zoho, yandex, most cPanel
 * hosts).
 *
 * Anything else is returned UNCHANGED rather than guessed at. That is right for
 * the "mail.example.com does both" shape and merely useless for
 * "smtp-mail.outlook.com", whose IMAP host is outlook.office365.com and is not
 * derivable from the string at all — which is exactly why the panel keeps an
 * explicit incoming-server field. A wrong guess here would be a confusing
 * connection error against a hostname the user never typed.
 */
export function deriveImapHost(smtpHost: string): string {
  const host = smtpHost.trim();
  if (!host) return "";
  if (/^smtps?\./i.test(host)) return host.replace(/^smtps?\./i, "imap.");
  return host;
}

/** The host the IMAP client should dial: the explicit one, else the derived one. */
export function resolveImapHost(settings: Pick<EmailSettings, "smtpHost" | "imapHost">): string {
  return settings.imapHost?.trim() || deriveImapHost(settings.smtpHost);
}

/**
 * New setups get the approval gate ON. An account that was already configured
 * before this setting existed gets it OFF — see getEmailCredentials.
 */
export const DEFAULT_ASK_BEFORE_SEND = true;

export interface EmailSettings {
  address: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  /** true = implicit TLS (465). false = plain connect + STARTTLS (587). */
  smtpSecure: boolean;
  fromName?: string;
  /**
   * EXPLICIT incoming-server override. Undefined means "derive it from the SMTP
   * host" — read it through resolveImapHost(), never directly.
   */
  imapHost?: string;
  /** "answer" mode only. Who the agent is allowed to reply to. */
  allowedSenders?: string[];
  /** What the agent may do with the mailbox. */
  mode: EmailMode;
  /** When true, email_send queues a draft for the owner instead of sending. */
  askBeforeSend: boolean;
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
  mode: EmailMode;
  /** The explicit override only — null when the host is being derived. */
  imapHostExplicit: string | null;
  askBeforeSend: boolean;
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
  const imapHost = asString(await get(EMAIL_KEYS.imapHost)) || undefined;
  const allowedSenders = Array.isArray(rawSenders)
    ? rawSenders.filter((s): s is string => typeof s === "string")
    : undefined;

  return {
    address,
    password,
    smtpHost,
    smtpPort,
    smtpSecure: (await get(EMAIL_KEYS.smtpSecure)) === true,
    fromName: asString(await get(EMAIL_KEYS.fromName)) || undefined,
    imapHost,
    allowedSenders,
    mode: resolveStoredMode(await get(EMAIL_KEYS.mode), imapHost, allowedSenders),
    askBeforeSend: resolveStoredAskBeforeSend(await get(EMAIL_KEYS.askBeforeSend)),
  };
}

/**
 * MIGRATION, read side. An account configured before the three-mode choice
 * existed has no email_mode key, and the honest reading of it is what it is
 * doing right now: an IMAP host plus an allowlist is Hermes' inbound adapter
 * running, i.e. "answer"; anything else only ever sent, i.e. "send". Nobody's
 * device changes behaviour on upgrade.
 */
function resolveStoredMode(raw: unknown, imapHost?: string, allowedSenders?: string[]): EmailMode {
  if (isEmailMode(raw)) return raw;
  return imapHost && allowedSenders && allowedSenders.length > 0 ? "answer" : "send";
}

/**
 * MIGRATION, read side. Reached only from getEmailCredentials, i.e. only for an
 * account that IS configured — so a missing key means an account that predates
 * the approval gate, and turning the gate on under it would silently stop mail
 * the owner already relies on. It defaults OFF here and ON in the form
 * (DEFAULT_ASK_BEFORE_SEND), which is the asymmetry the two cases actually want.
 */
function resolveStoredAskBeforeSend(raw: unknown): boolean {
  return typeof raw === "boolean" ? raw : false;
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
      mode: "send",
      imapHostExplicit: null,
      // No account yet, so this is the value the form should start on.
      askBeforeSend: DEFAULT_ASK_BEFORE_SEND,
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
    inbound: settings.mode === "answer",
    // The EFFECTIVE host, so the panel can show what would actually be dialled.
    imapHost: modeAllowsReading(settings.mode) ? resolveImapHost(settings) : null,
    allowedSenders: settings.allowedSenders ?? [],
    mode: settings.mode,
    imapHostExplicit: settings.imapHost ?? null,
    askBeforeSend: settings.askBeforeSend,
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

/**
 * Credentials for the IMAP client. Implicit TLS on 993 always: the panel offers
 * no incoming port, because every provider worth supporting serves 993 and the
 * alternative (143 + STARTTLS) is a downgrade surface with no user demand. The
 * client can still speak it — see imap-client.ts — which is what the tests use.
 */
export function toImapConfig(settings: EmailSettings): ImapConfig {
  return {
    host: resolveImapHost(settings),
    port: DEFAULT_IMAP_PORT,
    secure: true,
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
    // Always written explicitly, so neither migration above can fire a second
    // time and re-derive a value the owner has since chosen for themselves.
    [EMAIL_KEYS.mode]: settings.mode,
    [EMAIL_KEYS.askBeforeSend]: settings.askBeforeSend,
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
  mode?: unknown;
  askBeforeSend?: unknown;
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

  let imapHost = typeof body.imapHost === "string" ? body.imapHost.trim() : "";
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

  // The mode. A body that carries no `mode` is the pre-three-mode form shape,
  // and it said what it wanted the old way: an IMAP host meant "let people write
  // to the assistant". Deriving it from the IMAP host ALONE — not from the host
  // plus a non-empty allowlist — is what keeps such a body meaning exactly what
  // it used to, including the refusal below when the allowlist is empty. Reading
  // it as "send" instead would silently accept a request the device has always
  // rejected, and drop the explanation with it.
  let mode: EmailMode;
  if (body.mode === undefined || body.mode === null || body.mode === "") {
    mode = imapHost ? "answer" : "send";
  } else if (isEmailMode(body.mode)) {
    mode = body.mode;
  } else {
    return { ok: false, error: "Unknown email mode" };
  }

  // "answer" is opt-in AND allowlist-only. Hermes' email adapter has no pairing
  // flow — the allowlist is the ONLY access control — so an inbox with no
  // allowlist would be an unauthenticated path to an agent that holds the
  // device's tools. Refuse rather than guess what an empty allowlist means.
  //
  // "read" needs no allowlist: nobody is being answered, and the only thing that
  // ever opens the mailbox is a tool call the owner asked for.
  if (mode === "answer" && allowedSenders.length === 0) {
    return {
      ok: false,
      error: "To let people email the agent, list at least one address that is allowed to write to it",
    };
  }
  if (mode !== "answer") allowedSenders = [];
  // Send-only keeps no incoming server: there is nothing that may open a
  // mailbox, so storing where one lives would only be misleading.
  if (mode === "send") imapHost = "";

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
      mode,
      // Absent means a caller that predates the gate — default it ON. The safe
      // direction for a missing field is "ask", never "send silently".
      askBeforeSend: body.askBeforeSend === undefined ? DEFAULT_ASK_BEFORE_SEND : body.askBeforeSend === true,
    },
  };
}
