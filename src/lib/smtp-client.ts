// A minimal, dependency-free SMTP client (submission profile).
//
// WHY NOT nodemailer: this device ships an offline-first standalone Next.js
// bundle onto a Jetson, and the whole feature needs exactly one thing —
// "connect, authenticate, hand over one small text message". That is ~250 lines
// of RFC 5321 against node's own `net`/`tls`, so a new runtime dependency (and
// its update/CVE surface on an appliance that customers update rarely) buys
// nothing here. Anything richer — attachments, OAuth2, pooling — is a reason to
// revisit that call, not to pre-pay for it.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   - no plaintext AUTH on an unencrypted channel (see requireTls below);
//   - no attachments, no HTML alternative parts, no connection pooling;
//   - no retries. A caller that wants one can call twice.
//
// SECURITY NOTES:
//   - the password is never written to a log line and never appears in an
//     Error message: every server-supplied string that leaves this module goes
//     through Session.scrub(), which is the single chokepoint for that rule.
//     It matters because /email/configure hands SmtpError.detail back to the
//     browser verbatim.
//   - addresses/subjects are rejected outright if they contain CR or LF, so a
//     value from the UI can never inject extra SMTP commands or mail headers.

import net from "net";
import tls from "tls";
import { randomBytes } from "crypto";

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS from the first byte (port 465). Otherwise plain + STARTTLS. */
  secure: boolean;
  /**
   * When not `secure`, refuse to authenticate unless STARTTLS succeeded.
   * Default true and there is no UI to turn it off — an app password must
   * never cross the wire in the clear. Tests use it for a plaintext sink.
   */
  requireTls?: boolean;
  user: string;
  password: string;
}

export interface SmtpMessage {
  /** Envelope + header sender. Usually the same as SmtpConfig.user. */
  from: string;
  fromName?: string;
  to: string[];
  subject: string;
  /** UTF-8 plain text. */
  text: string;
}

/**
 * The four things that actually go wrong, kept apart because the fix is
 * different for each and the user is a non-engineer reading one sentence in a
 * Settings panel.
 */
export type SmtpFailureKind =
  | "auth"      // credentials rejected
  | "network"   // never got a usable connection
  | "tls"       // connected, but the encrypted channel could not be established
  | "recipient" // server refused the recipient
  | "blocked"   // authenticated, then the server refused to accept the message
  | "protocol"; // anything else the server said

export class SmtpError extends Error {
  constructor(
    readonly kind: SmtpFailureKind,
    message: string,
    /** Server's own reply line, scrubbed. Safe to show; never contains the password. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

const CONNECT_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_REPLY_BYTES = 64 * 1024;

/** Remove anything that looks like the configured secret from a string. */
function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
    if (secret && secret.length >= 4) {
      out = out.split(Buffer.from(secret, "utf8").toString("base64")).join("***");
    }
  }
  return out;
}

/** CR/LF anywhere in a header value is a header-injection attempt. */
export function isHeaderSafe(value: string): boolean {
  return !/[\r\n\0]/.test(value);
}

/**
 * The RFC 5322 dot-atom repertoire on the left of the "@", a hostname on the
 * right, and nothing else.
 *
 * The local part used to be `[^\s@,<>]+`, which reads as "permissive" but
 * actually means "anything that is not one of five characters" — NUL, CR, LF
 * and every other control character included. An address is written straight
 * into `RCPT TO:<...>`, so a control character in one is an SMTP command
 * injection attempt rather than an unusual mailbox. Naming the characters that
 * ARE allowed makes the list itself the answer to "what can reach the wire".
 *
 * The one legal shape this turns away is a quoted local part
 * (`"a b"@example.com`). No mailbox anyone puts into a ClawBox needs one.
 */
export const EMAIL_ADDRESS_RE =
  /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && EMAIL_ADDRESS_RE.test(value);
}

export function isHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  return /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(value);
}

export function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

// ── Header encoding ──────────────────────────────────────────────────────────

function needsEncoding(value: string): boolean {
  return /[^\x20-\x7e]/.test(value);
}

/** RFC 2047 encoded-word, split so no single word exceeds the 75-char limit. */
export function encodeHeaderValue(value: string): string {
  if (!needsEncoding(value)) return value;
  const bytes = Buffer.from(value, "utf8");
  // 45 raw bytes -> 60 base64 chars, comfortably under 75 with the wrapper.
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 45) {
    chunks.push(`=?UTF-8?B?${bytes.subarray(i, i + 45).toString("base64")}?=`);
  }
  return chunks.join("\r\n ");
}

function formatAddress(address: string, name?: string): string {
  if (!name) return `<${address}>`;
  return `${encodeHeaderValue(name)} <${address}>`;
}

/** base64 body in 76-char lines, so no line can exceed the 998-octet limit. */
function encodeBody(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

export function buildMessage(msg: SmtpMessage, domain: string): { id: string; data: string } {
  const id = `${Date.now().toString(36)}.${randomBytes(8).toString("hex")}@${domain}`;
  const headers = [
    `From: ${formatAddress(msg.from, msg.fromName)}`,
    `To: ${msg.to.map((a) => `<${a}>`).join(", ")}`,
    `Subject: ${encodeHeaderValue(msg.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${id}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
  ];
  return { id, data: `${headers.join("\r\n")}\r\n\r\n${encodeBody(msg.text)}` };
}

// ── Connection ───────────────────────────────────────────────────────────────

interface Reply {
  code: number;
  lines: string[];
  text: string;
}

class Session {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = "";
  private pending: { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private failure: Error | null = null;
  private closed = false;
  /** EHLO keywords, upper-cased. */
  capabilities = new Set<string>();

  constructor(socket: net.Socket | tls.TLSSocket, private readonly secrets: string[]) {
    this.socket = socket;
    this.attach();
  }

  private attach(): void {
    // No setEncoding: the socket handed to tls.connect() during STARTTLS must
    // still be in binary mode, so decoding happens here instead.
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    this.socket.on("error", (err: Error) => this.fail(err));
    this.socket.on("close", () => {
      this.closed = true;
      if (this.pending) {
        this.fail(
          this.failure ??
            new SmtpError("network", "The mail server closed the connection unexpectedly."),
        );
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_REPLY_BYTES) {
      this.fail(new SmtpError("protocol", "The mail server sent an unexpectedly large response."));
      return;
    }
    // A reply is complete once a line reads "NNN " (space, not hyphen).
    const lines = this.buffer.split("\r\n");
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      if (/^\d{3} /.test(line)) {
        const replyLines = lines.slice(0, i + 1);
        this.buffer = lines.slice(i + 1).join("\r\n");
        const code = parseInt(replyLines[replyLines.length - 1].slice(0, 3), 10);
        const reply: Reply = {
          code,
          lines: replyLines.map((l) => l.slice(4)),
          text: replyLines.join(" | "),
        };
        const waiter = this.pending;
        this.pending = null;
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(reply);
        }
        return;
      }
    }
  }

  private fail(err: Error): void {
    this.failure = err;
    const waiter = this.pending;
    this.pending = null;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  private read(): Promise<Reply> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) {
      return Promise.reject(new SmtpError("network", "The mail server closed the connection."));
    }
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new SmtpError("network", "The mail server stopped responding."));
      }, COMMAND_TIMEOUT_MS);
      this.pending = { resolve, reject, timer };
    });
  }

  greeting(): Promise<Reply> {
    return this.read();
  }

  /** Send one command line and read its reply. `label` is what a log may show. */
  async command(line: string): Promise<Reply> {
    if (this.failure) throw this.failure;
    this.socket.write(`${line}\r\n`);
    return this.read();
  }

  /** Replace the socket with a TLS one wrapping it (STARTTLS). */
  async upgrade(servername: string, rejectUnauthorized: boolean): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    this.buffer = "";
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SmtpError("tls", "The encrypted connection timed out.")),
        CONNECT_TIMEOUT_MS,
      );
      // The annotation is load-bearing: `sock` is referenced inside its own
      // initializer, so without it TypeScript falls back to `any` and every
      // listener callback below becomes an implicit-any parameter — which under
      // `strict` fails `next build`'s type-check step (and only that step, since
      // the test files tsc also complains about are outside the build graph).
      const sock: tls.TLSSocket = tls.connect(
        { socket: plain, servername, rejectUnauthorized },
        () => {
          clearTimeout(timer);
          resolve(sock);
        },
      );
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    this.socket = secure;
    this.failure = null;
    this.closed = false;
    this.attach();
  }

  /**
   * The one way a server-supplied string is allowed out of this module. Every
   * caller that puts `reply.text` into an SmtpError must go through here —
   * `/email/configure` hands `detail` straight back to the browser.
   */
  scrub(text: string): string {
    return scrubSecrets(text, this.secrets).slice(0, 300);
  }

  expect(reply: Reply, ok: number[], kind: SmtpFailureKind, message: string): void {
    if (ok.includes(reply.code)) return;
    throw new SmtpError(kind, message, this.scrub(reply.text));
  }

  close(): void {
    try {
      this.socket.destroy();
    } catch {
      // already gone
    }
  }
}

/** The error every abort path raises, so callers can recognise one shape. */
function cancelled(): SmtpError {
  return new SmtpError("network", "The connection was cancelled.");
}

function connectSocket(
  cfg: SmtpConfig,
  rejectUnauthorized: boolean,
  signal?: AbortSignal,
): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new SmtpError(
          "network",
          `Could not reach ${cfg.host} on port ${cfg.port} — the connection timed out.`,
        ),
      );
    }, CONNECT_TIMEOUT_MS);
    const onAbort = () => {
      clearTimeout(timer);
      socket.destroy();
      reject(cancelled());
    };
    const onReady = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeListener("error", onError);
      resolve(socket);
    };
    const onError = (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      reject(classifyConnectError(err, cfg));
    };
    const socket = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized }, onReady)
      : net.connect({ host: cfg.host, port: cfg.port }, onReady);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function classifyConnectError(err: NodeJS.ErrnoException, cfg: SmtpConfig): SmtpError {
  const where = `${cfg.host} on port ${cfg.port}`;
  switch (err.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return new SmtpError("network", `Could not look up the server name "${cfg.host}". Check the spelling and that the device is online.`);
    case "ECONNREFUSED":
      return new SmtpError("network", `${where} refused the connection. Check the port.`);
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return new SmtpError("network", `Could not reach ${where}. Check the device's internet connection, and whether the network blocks outgoing mail.`);
    default:
      break;
  }
  if (/certificate|self.signed|ssl|tls|alert/i.test(err.message || "")) {
    return new SmtpError("tls", `The encrypted connection to ${cfg.host} could not be established.`, err.message.slice(0, 200));
  }
  return new SmtpError("network", `Could not connect to ${where}.`);
}

/** Authentication failures the RFCs and the big providers actually emit. */
function isAuthFailure(code: number, text: string): boolean {
  if (code === 535 || code === 534 || code === 538) return true;
  if (code === 530) return true;
  if (code === 454 && /4\.7\.0/.test(text)) return true;
  return false;
}

async function openSession(
  cfg: SmtpConfig,
  rejectUnauthorized: boolean,
  signal?: AbortSignal,
): Promise<Session> {
  const socket = await connectSocket(cfg, rejectUnauthorized, signal);
  const session = new Session(socket, [cfg.password]);
  const greeting = await session.greeting();
  session.expect(greeting, [220], "protocol", `${cfg.host} did not greet us as a mail server.`);

  const clientName = "clawbox.local";
  let ehlo = await session.command(`EHLO ${clientName}`);
  session.expect(ehlo, [250], "protocol", `${cfg.host} rejected the SMTP handshake.`);
  let caps = readCapabilities(ehlo.lines);

  const wantsStartTls = !cfg.secure;
  if (wantsStartTls) {
    if (!caps.has("STARTTLS")) {
      if (cfg.requireTls !== false) {
        session.close();
        throw new SmtpError(
          "tls",
          `${cfg.host}:${cfg.port} does not offer encryption (STARTTLS). ClawBox will not send a password over an unencrypted connection — check the port (587 for STARTTLS, 465 for SSL).`,
        );
      }
    } else {
      const start = await session.command("STARTTLS");
      session.expect(start, [220], "tls", `${cfg.host} refused to start an encrypted connection.`);
      try {
        await session.upgrade(cfg.host, rejectUnauthorized);
      } catch (err) {
        session.close();
        throw err instanceof SmtpError
          ? err
          : new SmtpError(
              "tls",
              `The encrypted connection to ${cfg.host} could not be established. If this is a company mail server with its own certificate, it may not be trusted by the device.`,
              err instanceof Error ? err.message.slice(0, 200) : undefined,
            );
      }
      // RFC 3207: everything learned before STARTTLS is discarded.
      ehlo = await session.command(`EHLO ${clientName}`);
      session.expect(ehlo, [250], "protocol", `${cfg.host} rejected the SMTP handshake after encryption.`);
      caps = readCapabilities(ehlo.lines);
    }
  }

  session.capabilities = caps;
  return session;
}

function readCapabilities(lines: string[]): Set<string> {
  const caps = new Set<string>();
  for (const line of lines.slice(1)) {
    const [keyword, ...rest] = line.trim().split(/\s+/);
    if (!keyword) continue;
    caps.add(keyword.toUpperCase());
    if (keyword.toUpperCase() === "AUTH") {
      for (const mech of rest) caps.add(`AUTH=${mech.toUpperCase()}`);
    }
  }
  return caps;
}

async function authenticate(session: Session, cfg: SmtpConfig): Promise<void> {
  const wantsPlain = session.capabilities.has("AUTH=PLAIN") || !session.capabilities.has("AUTH=LOGIN");
  const reply = wantsPlain
    ? await session.command(
        `AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.password}`, "utf8").toString("base64")}`,
      )
    : await (async () => {
        const start = await session.command("AUTH LOGIN");
        if (start.code !== 334) return start;
        const userReply = await session.command(Buffer.from(cfg.user, "utf8").toString("base64"));
        if (userReply.code !== 334) return userReply;
        return session.command(Buffer.from(cfg.password, "utf8").toString("base64"));
      })();

  if (reply.code === 235) return;
  if (isAuthFailure(reply.code, reply.text)) {
    throw new SmtpError(
      "auth",
      "The mail server rejected that address and password. For Gmail this must be a 16-character App Password (not your normal Google password), and 2-Step Verification has to be on.",
      session.scrub(reply.text),
    );
  }
  throw new SmtpError("protocol", `The mail server refused to sign in (${reply.code}).`, session.scrub(reply.text));
}

export interface SmtpOptions {
  /**
   * Verify the server's certificate. Always true in the product; the on-device
   * end-to-end test points NODE_EXTRA_CA_CERTS at its sink's certificate
   * instead of turning this off.
   */
  rejectUnauthorized?: boolean;
  /**
   * Hang up as soon as the caller stops caring — routes pass `request.signal`.
   * Without it a user who navigates away mid-"Connect" leaves a socket (and a
   * half-finished login) open until the 15 s/20 s timeouts fire.
   */
  signal?: AbortSignal;
}

/**
 * Open a session, run `body`, and always close — closing EARLY if the caller
 * aborts, which is what makes the socket go away with the request rather than
 * on its own timeout.
 */
async function withSession<T>(
  cfg: SmtpConfig,
  opts: SmtpOptions,
  body: (session: Session) => Promise<T>,
): Promise<T> {
  const { signal } = opts;
  if (signal?.aborted) throw cancelled();
  const session = await openSession(cfg, opts.rejectUnauthorized !== false, signal);
  const onAbort = () => session.close();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await body(session);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    session.close();
  }
}

/**
 * Connect + authenticate, then hang up. This is what "Connect" in Settings runs
 * before anything is written to disk: credentials are only saved once the real
 * server has accepted them.
 */
export async function verifySmtp(cfg: SmtpConfig, opts: SmtpOptions = {}): Promise<void> {
  await withSession(cfg, opts, async (session) => {
    await authenticate(session, cfg);
    await session.command("QUIT").catch(() => undefined);
  });
}

/** Connect, authenticate, send one message. Returns the Message-ID we set. */
export async function sendMail(
  cfg: SmtpConfig,
  msg: SmtpMessage,
  opts: SmtpOptions = {},
): Promise<{ messageId: string }> {
  for (const value of [msg.from, msg.subject, msg.fromName ?? "", ...msg.to]) {
    if (!isHeaderSafe(value)) {
      throw new SmtpError("protocol", "Email addresses and the subject cannot contain line breaks.");
    }
  }
  if (msg.to.length === 0) {
    throw new SmtpError("recipient", "No recipient was given.");
  }

  return withSession(cfg, opts, async (session) => {
    await authenticate(session, cfg);

    const mailFrom = await session.command(`MAIL FROM:<${msg.from}>`);
    session.expect(mailFrom, [250], "blocked", `The mail server refused to send as ${msg.from}. Some providers only allow sending from the exact address you signed in with.`);

    for (const recipient of msg.to) {
      const rcpt = await session.command(`RCPT TO:<${recipient}>`);
      session.expect(rcpt, [250, 251], "recipient", `The mail server refused the recipient ${recipient}.`);
    }

    const data = await session.command("DATA");
    session.expect(data, [354], "blocked", "The mail server refused to accept the message.");

    const domain = msg.from.split("@")[1] || "clawbox.local";
    const { id, data: body } = buildMessage(msg, domain);
    // Dot-stuffing (RFC 5321 §4.5.2): a body line of "." would end the message.
    const stuffed = body
      .split("\r\n")
      .map((line) => (line.startsWith(".") ? `.${line}` : line))
      .join("\r\n");
    const accepted = await session.command(`${stuffed}\r\n.`);
    session.expect(accepted, [250], "blocked", "The mail server accepted the sign-in but refused the message. It may consider the sender or the content suspicious.");

    await session.command("QUIT").catch(() => undefined);
    return { messageId: id };
  });
}
