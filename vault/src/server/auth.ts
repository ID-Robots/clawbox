// Credentials of the three kinds of clients:
//  - the desktop UI: a human-chosen vault PIN (scrypt hash on disk) unlocks a
//    short-lived in-memory session token;
//  - the Chrome extension: receives a random 32-byte token when it pairs; only
//    its SHA-256 hash and the extension origin are stored. The box's own
//    browser pairs by itself with a secret the service leaves in the extension
//    folder it builds (a file only the box user can read), once the owner has
//    chosen a PIN; any other browser pairs with a 6-digit code shown in the
//    unlocked UI;
//  - the agent's tools: a random token in a mode-600 file the service creates.
// Nothing here ever handles a stored password.
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SESSION_IDLE_MS = 15 * 60_000;
const SESSION_MAX_MS = 12 * 60 * 60_000;
const PAIRING_TTL_MS = 5 * 60_000;
const PAIRING_ATTEMPTS = 5;
const PIN_FREE_FAILURES = 5;

interface PinRecord {
  salt: string;
  hash: string;
  N: number;
  r: number;
  p: number;
}

interface ExtensionRecord {
  origin: string;
  tokenHash: string;
  pairedAt: string;
  locked: boolean;
}

interface StateFile {
  version: 1;
  pin?: PinRecord;
  extension?: ExtensionRecord;
  /** false once the owner unpaired the box's browser: it stays unpaired until they turn it on again. */
  autoPair?: boolean;
}

export type PinCheck = { ok: true } | { ok: false; retryAfterMs: number };

export type PairClaim =
  | { ok: true; token: string }
  | { ok: false; reason: "no_pairing" | "expired" | "invalid_code" | "bad_origin" };

export type AutoPairClaim =
  | { ok: true; token: string }
  | { ok: false; reason: "bad_origin" | "not_set_up" | "off" | "invalid_secret" };

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sameHash(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9_\-]{16,200})$/.exec(h.trim());
  return m ? m[1]! : null;
}

export class Auth {
  readonly stateFile: string;
  readonly mcpTokenFile: string;
  /**
   * What the box's own browser proves itself with. New on every start and only
   * ever written into the extension folder the service builds, so a browser
   * that can read it runs as the box user on this machine.
   */
  readonly autoPairSecret = randomToken();
  private state: StateFile = { version: 1 };
  private sessions = new Map<string, { created: number; lastSeen: number }>();
  private pairing: { code: string; expiresAt: number; attemptsLeft: number } | null = null;
  private pinFailures = 0;
  private pinBlockedUntil = 0;

  constructor(
    readonly configDir: string,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    chmodSync(configDir, 0o700);
    this.stateFile = join(configDir, "state.json");
    this.mcpTokenFile = join(configDir, "agent-token");
    if (existsSync(this.stateFile)) {
      this.state = JSON.parse(readFileSync(this.stateFile, "utf8")) as StateFile;
      chmodSync(this.stateFile, 0o600);
    }
    this.ensureMcpToken();
  }

  private persist(): void {
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.stateFile);
  }

  // ---- vault PIN -------------------------------------------------------

  pinSet(): boolean {
    return Boolean(this.state.pin);
  }

  static validatePin(pin: unknown): string {
    if (typeof pin !== "string" || pin.length < 6 || pin.length > 128) {
      throw new Error("PIN must be 6 to 128 characters");
    }
    return pin;
  }

  private hashPin(pin: string, salt: Buffer, rec = SCRYPT): string {
    return scryptSync(pin, salt, SCRYPT.keylen, { N: rec.N, r: rec.r, p: rec.p, maxmem: 64 * 1024 * 1024 }).toString("hex");
  }

  setupPin(pin: string): void {
    if (this.state.pin) throw new Error("PIN is already set");
    this.writePin(Auth.validatePin(pin));
  }

  private writePin(pin: string): void {
    const salt = randomBytes(16);
    this.state.pin = { salt: salt.toString("hex"), hash: this.hashPin(pin, salt), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
    this.persist();
  }

  /** Rate-limited: after 5 failures every further failure doubles a lockout (max 15 min). */
  verifyPin(pin: unknown): PinCheck {
    const now = this.now();
    if (now < this.pinBlockedUntil) return { ok: false, retryAfterMs: this.pinBlockedUntil - now };
    const rec = this.state.pin;
    const ok =
      Boolean(rec) &&
      typeof pin === "string" &&
      pin.length <= 128 &&
      sameHash(this.hashPin(pin, Buffer.from(rec!.salt, "hex"), { ...SCRYPT, N: rec!.N, r: rec!.r, p: rec!.p }), rec!.hash);
    if (ok) {
      this.pinFailures = 0;
      return { ok: true };
    }
    this.pinFailures++;
    if (this.pinFailures >= PIN_FREE_FAILURES) {
      const wait = Math.min(15 * 60_000, 30_000 * 2 ** (this.pinFailures - PIN_FREE_FAILURES));
      this.pinBlockedUntil = now + wait;
      return { ok: false, retryAfterMs: wait };
    }
    return { ok: false, retryAfterMs: 0 };
  }

  changePin(current: unknown, next: unknown): PinCheck {
    const check = this.verifyPin(current);
    if (!check.ok) return check;
    this.writePin(Auth.validatePin(next));
    this.sessions.clear();
    return { ok: true };
  }

  // ---- UI sessions -------------------------------------------------------

  createSession(): { token: string; idleMs: number } {
    const token = randomToken();
    const now = this.now();
    this.sessions.set(sha256(token), { created: now, lastSeen: now });
    return { token, idleMs: SESSION_IDLE_MS };
  }

  checkSession(token: string | null): boolean {
    if (!token) return false;
    const key = sha256(token);
    const s = this.sessions.get(key);
    if (!s) return false;
    const now = this.now();
    if (now - s.lastSeen > SESSION_IDLE_MS || now - s.created > SESSION_MAX_MS) {
      this.sessions.delete(key);
      return false;
    }
    s.lastSeen = now;
    return true;
  }

  endSession(token: string | null): void {
    if (token) this.sessions.delete(sha256(token));
  }

  // ---- extension pairing --------------------------------------------------

  startPairing(): { code: string; expiresAt: string } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.pairing = { code, expiresAt, attemptsLeft: PAIRING_ATTEMPTS };
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  cancelPairing(): void {
    this.pairing = null;
  }

  pendingPairing(): { expiresAt: string } | null {
    if (!this.pairing || this.pairing.expiresAt < this.now()) return null;
    return { expiresAt: new Date(this.pairing.expiresAt).toISOString() };
  }

  /** One code, five attempts, five minutes. Success replaces any earlier pairing. */
  claimPairing(code: unknown, origin: string | null): PairClaim {
    if (!origin || !EXTENSION_ORIGIN_RE.test(origin)) return { ok: false, reason: "bad_origin" };
    const p = this.pairing;
    if (!p) return { ok: false, reason: "no_pairing" };
    if (p.expiresAt < this.now()) {
      this.pairing = null;
      return { ok: false, reason: "expired" };
    }
    const given = typeof code === "string" ? code.replace(/\s+/g, "") : "";
    const ok = /^\d{6}$/.test(given) && timingSafeEqual(Buffer.from(given), Buffer.from(p.code));
    if (!ok) {
      p.attemptsLeft--;
      if (p.attemptsLeft <= 0) this.pairing = null;
      return { ok: false, reason: "invalid_code" };
    }
    this.pairing = null;
    const token = randomToken();
    this.state.extension = { origin, tokenHash: sha256(token), pairedAt: new Date(this.now()).toISOString(), locked: false };
    this.persist();
    return { ok: true, token };
  }

  /** Does the box's own browser pair by itself? Yes until the owner unpairs it. */
  autoPairEnabled(): boolean {
    return this.state.autoPair !== false;
  }

  setAutoPair(enabled: boolean): void {
    if (this.autoPairEnabled() === enabled) return;
    this.state.autoPair = enabled;
    this.persist();
  }

  /**
   * The box's own browser pairing without a code. Refused until the owner has
   * chosen a PIN, so nothing is saved or filled on a box whose owner never
   * opened the vault, and after the owner unpaired it.
   */
  claimAutoPairing(secret: unknown, origin: string | null): AutoPairClaim {
    if (!origin || !EXTENSION_ORIGIN_RE.test(origin)) return { ok: false, reason: "bad_origin" };
    if (!this.state.pin) return { ok: false, reason: "not_set_up" };
    if (!this.autoPairEnabled()) return { ok: false, reason: "off" };
    if (typeof secret !== "string" || !sameHash(sha256(secret), sha256(this.autoPairSecret))) {
      return { ok: false, reason: "invalid_secret" };
    }
    this.pairing = null;
    const token = randomToken();
    this.state.extension = { origin, tokenHash: sha256(token), pairedAt: new Date(this.now()).toISOString(), locked: false };
    this.persist();
    return { ok: true, token };
  }

  extension(): Omit<ExtensionRecord, "tokenHash"> | null {
    const e = this.state.extension;
    return e ? { origin: e.origin, pairedAt: e.pairedAt, locked: e.locked } : null;
  }

  unpair(): void {
    delete this.state.extension;
    this.persist();
  }

  /**
   * Token first. Chrome sends no Origin on an extension's GET to a host in its
   * host_permissions, so an absent Origin is accepted; a present one must be
   * the paired origin (web pages always send Origin cross-origin).
   */
  checkExtension(token: string | null, origin: string | null): "ok" | "unauthorized" | "forbidden_origin" {
    const e = this.state.extension;
    if (!e || !token || !sameHash(sha256(token), e.tokenHash)) return "unauthorized";
    if (origin !== null && origin !== e.origin) return "forbidden_origin";
    return "ok";
  }

  setExtensionLocked(locked: boolean): void {
    if (!this.state.extension) return;
    this.state.extension.locked = locked;
    this.persist();
  }

  extensionLocked(): boolean {
    return Boolean(this.state.extension?.locked);
  }

  pairedOrigin(): string | null {
    return this.state.extension?.origin ?? null;
  }

  // ---- agent token ---------------------------------------------------------

  private ensureMcpToken(): void {
    if (!existsSync(this.mcpTokenFile)) {
      writeFileSync(this.mcpTokenFile, `${randomToken()}\n`, { mode: 0o600, flag: "wx" });
    }
    if ((statSync(this.mcpTokenFile).mode & 0o077) !== 0) chmodSync(this.mcpTokenFile, 0o600);
  }

  /** Re-reads the file each time, so rotating it (delete + restart) takes effect. */
  checkMcp(token: string | null): boolean {
    if (!token) return false;
    let expected: string;
    try {
      expected = readFileSync(this.mcpTokenFile, "utf8").trim();
    } catch {
      return false;
    }
    return expected.length >= 16 && sameHash(sha256(token), sha256(expected));
  }
}
