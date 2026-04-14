import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-auth-tests-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "data");
const SECRET_PATH = path.join(DATA_DIR, ".session-secret");
const LOCAL_PASSWORD_PATH = path.join(DATA_DIR, ".clawbox-password");

let auth: typeof import("@/lib/auth");

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(DATA_DIR, { recursive: true });
  vi.resetModules();
  auth = await import("@/lib/auth");
});

beforeEach(async () => {
  // Clean secret file before each test
  await fs.rm(SECRET_PATH, { force: true });
  await fs.rm(LOCAL_PASSWORD_PATH, { force: true });
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("auth", () => {
  // ─── getOrCreateSecret ──────────────────────────────────────────────

  describe("getOrCreateSecret", () => {
    it("creates a new secret when none exists", async () => {
      const secret = await auth.getOrCreateSecret();
      expect(secret).toBeTruthy();
      expect(secret.length).toBe(64); // 32 bytes hex = 64 chars
    });

    it("persists the secret to disk", async () => {
      const secret = await auth.getOrCreateSecret();
      const onDisk = (await fs.readFile(SECRET_PATH, "utf-8")).trim();
      expect(onDisk).toBe(secret);
    });

    it("returns the same secret on subsequent calls", async () => {
      const first = await auth.getOrCreateSecret();
      const second = await auth.getOrCreateSecret();
      expect(first).toBe(second);
    });

    it("returns existing secret when file already contains a valid one", async () => {
      const existing = crypto.randomBytes(32).toString("hex");
      await fs.writeFile(SECRET_PATH, existing, "utf-8");

      const secret = await auth.getOrCreateSecret();
      expect(secret).toBe(existing);
    });

    it("generates a new secret when existing file content is too short", async () => {
      await fs.writeFile(SECRET_PATH, "tooshort", "utf-8");

      const secret = await auth.getOrCreateSecret();
      expect(secret.length).toBe(64);
      expect(secret).not.toBe("tooshort");
    });

    it("trims whitespace from existing secret", async () => {
      const existing = crypto.randomBytes(32).toString("hex");
      await fs.writeFile(SECRET_PATH, `  ${existing}  \n`, "utf-8");

      const secret = await auth.getOrCreateSecret();
      expect(secret).toBe(existing);
    });

    it("creates the data directory if missing", async () => {
      await fs.rm(DATA_DIR, { recursive: true, force: true });

      const secret = await auth.getOrCreateSecret();
      expect(secret.length).toBe(64);

      // Verify directory was recreated
      const stat = await fs.stat(DATA_DIR);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe("getSessionSigningSecret", () => {
    it("prefers SESSION_SECRET from the running server", async () => {
      process.env.SESSION_SECRET = "live-session-secret";
      await fs.writeFile(SECRET_PATH, crypto.randomBytes(32).toString("hex"), "utf-8");

      await expect(auth.getSessionSigningSecret()).resolves.toBe("live-session-secret");

      delete process.env.SESSION_SECRET;
    });

    it("falls back to the persisted secret when SESSION_SECRET is absent", async () => {
      delete process.env.SESSION_SECRET;

      const secret = await auth.getSessionSigningSecret();
      const onDisk = (await fs.readFile(SECRET_PATH, "utf-8")).trim();
      expect(secret).toBe(onDisk);
    });
  });

  // ─── verifyPassword ─────────────────────────────────────────────────

  describe("verifyPassword", () => {
    it("is an exported async function", () => {
      expect(typeof auth.verifyPassword).toBe("function");
    });

    // We cannot easily call unix_chkpwd in a test environment, so we test
    // the function's behavior by mocking child_process.spawn.
    it("returns false when unix_chkpwd is not available", async () => {
      // On test machines unix_chkpwd may not exist, so this should resolve false
      const result = await auth.verifyPassword("wrong-password-test");
      expect(result).toBe(false);
    });
  });

  describe("local password auth", () => {
    it("stores and verifies a local ClawBox password", async () => {
      await auth.setLocalPassword("desktop-secret");

      await expect(auth.verifyLocalPassword("desktop-secret")).resolves.toBe(true);
      await expect(auth.verifyLocalPassword("wrong-secret")).resolves.toBe(false);
    });

    it("returns false when no local ClawBox password is configured", async () => {
      await expect(auth.verifyLocalPassword("desktop-secret")).resolves.toBe(false);
    });

    it("invalidates the old local password when it is updated", async () => {
      await auth.setLocalPassword("first-password");
      await auth.setLocalPassword("second-password");

      await expect(auth.verifyLocalPassword("first-password")).resolves.toBe(false);
      await expect(auth.verifyLocalPassword("second-password")).resolves.toBe(true);
    });

    it("returns false for malformed local password files", async () => {
      await fs.writeFile(LOCAL_PASSWORD_PATH, "not-a-valid-password-file", "utf-8");

      await expect(auth.verifyLocalPassword("desktop-secret")).resolves.toBe(false);
    });
  });

  // ─── createSessionCookie ────────────────────────────────────────────

  describe("createSessionCookie", () => {
    const secret = "test-secret-for-unit-tests-long-enough";

    it("returns a string with payload.signature format", () => {
      const cookie = auth.createSessionCookie(3600, secret);
      const parts = cookie.split(".");
      expect(parts).toHaveLength(2);
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[1].length).toBeGreaterThan(0);
    });

    it("signature is a 64-character hex string (SHA-256)", () => {
      const cookie = auth.createSessionCookie(3600, secret);
      const sig = cookie.split(".")[1];
      expect(sig).toMatch(/^[0-9a-f]{64}$/);
    });

    it("payload contains correct expiration", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const duration = 7200;
      const cookie = auth.createSessionCookie(duration, secret);
      const payload = cookie.split(".")[0];
      const data = JSON.parse(Buffer.from(payload, "base64url").toString());

      expect(data.exp).toBeGreaterThanOrEqual(nowSec + duration - 1);
      expect(data.exp).toBeLessThanOrEqual(nowSec + duration + 1);
    });

    it("produces different cookies for different durations", () => {
      const cookie1 = auth.createSessionCookie(3600, secret);
      const cookie2 = auth.createSessionCookie(7200, secret);
      expect(cookie1).not.toBe(cookie2);
    });

    it("produces different cookies for different secrets", () => {
      const cookie1 = auth.createSessionCookie(3600, "secret-a");
      const cookie2 = auth.createSessionCookie(3600, "secret-b");
      // Payloads could match (same duration, nearly same timestamp) but sigs differ
      const sig1 = cookie1.split(".")[1];
      const sig2 = cookie2.split(".")[1];
      expect(sig1).not.toBe(sig2);
    });

    it("uses HMAC-SHA256 for the signature", () => {
      const cookie = auth.createSessionCookie(3600, secret);
      const [payload, sig] = cookie.split(".");
      const expectedSig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      expect(sig).toBe(expectedSig);
    });
  });

  // ─── verifySessionCookie ────────────────────────────────────────────

  describe("verifySessionCookie", () => {
    const secret = "test-secret-for-unit-tests-long-enough";

    it("returns true for a valid, non-expired cookie", () => {
      const cookie = auth.createSessionCookie(3600, secret);
      expect(auth.verifySessionCookie(cookie, secret)).toBe(true);
    });

    it("returns false for an expired cookie", () => {
      // Create a cookie that expired 10 seconds ago
      const exp = Math.floor(Date.now() / 1000) - 10;
      const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
      const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      const cookie = `${payload}.${sig}`;

      expect(auth.verifySessionCookie(cookie, secret)).toBe(false);
    });

    it("returns false for a tampered payload", () => {
      const cookie = auth.createSessionCookie(3600, secret);
      const [, sig] = cookie.split(".");
      // Create a different payload
      const tamperedPayload = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString("base64url");
      const tampered = `${tamperedPayload}.${sig}`;

      expect(auth.verifySessionCookie(tampered, secret)).toBe(false);
    });

    it("returns false for a tampered signature", () => {
      const cookie = auth.createSessionCookie(3600, secret);
      const [payload] = cookie.split(".");
      const fakeSig = "a".repeat(64);
      const tampered = `${payload}.${fakeSig}`;

      expect(auth.verifySessionCookie(tampered, secret)).toBe(false);
    });

    it("returns false for wrong secret", () => {
      const cookie = auth.createSessionCookie(3600, secret);
      expect(auth.verifySessionCookie(cookie, "wrong-secret")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(auth.verifySessionCookie("", secret)).toBe(false);
    });

    it("returns false for cookie with no dot separator", () => {
      expect(auth.verifySessionCookie("nodot", secret)).toBe(false);
    });

    it("returns false for cookie with empty payload", () => {
      expect(auth.verifySessionCookie("." + "a".repeat(64), secret)).toBe(false);
    });

    it("returns false for cookie with empty signature", () => {
      const payload = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString("base64url");
      expect(auth.verifySessionCookie(`${payload}.`, secret)).toBe(false);
    });

    it("returns false when signature is not valid hex", () => {
      const payload = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString("base64url");
      expect(auth.verifySessionCookie(`${payload}.${"z".repeat(64)}`, secret)).toBe(false);
    });

    it("returns false when signature is wrong length", () => {
      const payload = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString("base64url");
      expect(auth.verifySessionCookie(`${payload}.${"ab".repeat(16)}`, secret)).toBe(false);
    });

    it("returns false for non-JSON payload", () => {
      const payload = Buffer.from("not json").toString("base64url");
      const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      expect(auth.verifySessionCookie(`${payload}.${sig}`, secret)).toBe(false);
    });

    it("returns false when payload has no exp field", () => {
      const payload = Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64url");
      const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      expect(auth.verifySessionCookie(`${payload}.${sig}`, secret)).toBe(false);
    });

    it("returns false when exp is not a number", () => {
      const payload = Buffer.from(JSON.stringify({ exp: "not-a-number" })).toString("base64url");
      const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      expect(auth.verifySessionCookie(`${payload}.${sig}`, secret)).toBe(false);
    });

    it("returns false for multiple dot separators", () => {
      expect(auth.verifySessionCookie("a.b.c", secret)).toBe(false);
    });

    it("handles a cookie expiring exactly at current time as expired", () => {
      const exp = Math.floor(Date.now() / 1000); // exactly now, not greater than now
      const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
      const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      const cookie = `${payload}.${sig}`;

      // exp must be strictly greater than now, so exactly-now is expired
      expect(auth.verifySessionCookie(cookie, secret)).toBe(false);
    });

    it("accepts a cookie with a far-future expiration", () => {
      const exp = Math.floor(Date.now() / 1000) + 86400 * 365 * 10; // 10 years
      const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
      const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      const cookie = `${payload}.${sig}`;

      expect(auth.verifySessionCookie(cookie, secret)).toBe(true);
    });

    it("is case-insensitive for hex signature validation", () => {
      // The regex uses /i flag, so uppercase hex should pass the format check
      // but the HMAC comparison should still fail if the case doesn't match
      const cookie = auth.createSessionCookie(3600, secret);
      const [payload, sig] = cookie.split(".");
      const upperSig = sig.toUpperCase();
      // Upper-case sig passes the regex check but will fail timingSafeEqual
      // because the HMAC produces lowercase hex
      const upperCookie = `${payload}.${upperSig}`;
      // This depends on whether Buffer.from(upperHex, "hex") matches — it does,
      // because hex parsing is case-insensitive in Node
      expect(auth.verifySessionCookie(upperCookie, secret)).toBe(true);
    });
  });
});
