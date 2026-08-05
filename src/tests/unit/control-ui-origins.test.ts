import { describe, expect, it, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadConfiguredOrigins,
  loadConfiguredOriginsFromEnv,
  mergeOrigins,
  normalizeOrigin,
  resolveOriginsPath,
} from "@/lib/control-ui-origins";

// TS counterpart to scripts/gateway_origins.py, used by gateway-proxy.ts to
// validate operator-supplied trusted control UI origins. Kept behaviorally
// aligned with the Python module (see gateway-origins.test.ts) since both
// read the same JSON contract file.

describe("control-ui-origins", () => {
  describe("normalizeOrigin", () => {
    it("accepts a bare http origin unchanged", () => {
      expect(normalizeOrigin("http://example.com")).toEqual({ origin: "http://example.com", warning: null });
    });

    it("lowercases scheme and host", () => {
      expect(normalizeOrigin("HTTP://EXAMPLE.com")).toEqual({ origin: "http://example.com", warning: null });
    });

    it("strips the default port for http", () => {
      expect(normalizeOrigin("http://example.com:80")).toEqual({ origin: "http://example.com", warning: null });
    });

    it("strips the default port for https", () => {
      expect(normalizeOrigin("https://example.com:443")).toEqual({ origin: "https://example.com", warning: null });
    });

    it("keeps a non-default port", () => {
      expect(normalizeOrigin("http://example.com:8080")).toEqual({
        origin: "http://example.com:8080",
        warning: null,
      });
    });

    it("normalizes a trailing slash away", () => {
      expect(normalizeOrigin("https://example.com/")).toEqual({ origin: "https://example.com", warning: null });
    });

    it("keeps bracketed IPv6 hosts, dropping the default port", () => {
      expect(normalizeOrigin("https://[::1]:443")).toEqual({ origin: "https://[::1]", warning: null });
      expect(normalizeOrigin("http://[::1]:9000")).toEqual({ origin: "http://[::1]:9000", warning: null });
      expect(normalizeOrigin("http://[0:0:0:0:0:0:0:1]")).toEqual({
        origin: "http://[::1]",
        warning: null,
      });
    });

    it("rejects a wildcard origin", () => {
      const result = normalizeOrigin("*");
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/wildcard/);
    });

    it("rejects credentials in the origin", () => {
      const result = normalizeOrigin("http://user:pass@" + "example.com");
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/credentials/);
    });

    it("rejects a non-root path", () => {
      const result = normalizeOrigin("http://example.com/setup");
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/path/);
    });

    it("rejects a query string", () => {
      const result = normalizeOrigin("http://example.com?x=1");
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/query/);
    });

    it("rejects a fragment", () => {
      const result = normalizeOrigin("http://example.com#frag");
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/fragment/);
    });

    it("rejects a non-http(s) scheme", () => {
      const result = normalizeOrigin("ftp://example.com");
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/scheme/);
    });

    it("rejects an out-of-range port", () => {
      const result = normalizeOrigin("http://example.com:99999");
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/not a valid URL/);
    });

    it("rejects an out-of-range dotted-decimal host", () => {
      const result = normalizeOrigin("http://999.999.999.999");
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/not a valid URL/);
    });

    it("rejects raw characters whose URL-parser behavior is not portable", () => {
      const inputs = [
        "http://evil.com\\`@good.com`",
        "http://exa\nmple.com",
        "http://example.com/%65",
        "http://éxample.com",
      ];
      for (const input of inputs) {
        const result = normalizeOrigin(input);
        expect(result.origin).toBeNull();
        expect(result.warning).toMatch(/forbidden raw character/);
      }
    });

    it("rejects a non-string entry without throwing", () => {
      expect(() => normalizeOrigin(42)).not.toThrow();
      expect(() => normalizeOrigin(null)).not.toThrow();
      expect(() => normalizeOrigin(undefined)).not.toThrow();
      expect(() => normalizeOrigin({})).not.toThrow();
      expect(normalizeOrigin(42).warning).toMatch(/string/);
    });

    it("rejects an invalid IPv6 host without throwing", () => {
      expect(() => normalizeOrigin("http://[gg::1]")).not.toThrow();
      expect(normalizeOrigin("http://[gg::1]").origin).toBeNull();
    });

    it("never throws on garbage input", () => {
      const garbage = [
        "http://[", "http://]", "http://[::", "://", "http:///",
        "http://a b", "\x00", "  ", "\n", "http://a..b", "http://.",
        "javascript:alert(1)", "http://a:b:c@" + "evil.com",
      ];
      for (const g of garbage) {
        expect(() => normalizeOrigin(g)).not.toThrow();
      }
    });
  });

  describe("mergeOrigins", () => {
    it("appends extras after defaults, de-duplicated, order preserved", () => {
      expect(mergeOrigins(["http://a.com", "http://b.com"], ["http://b.com", "http://c.com"])).toEqual([
        "http://a.com",
        "http://b.com",
        "http://c.com",
      ]);
    });

    it("returns defaults unchanged when extras is empty", () => {
      expect(mergeOrigins(["http://a.com"], [])).toEqual(["http://a.com"]);
    });
  });

  describe("loadConfiguredOrigins", () => {
    let dir: string;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("returns no origins and no warning when the file is missing", () => {
      dir = mkdtempSync(path.join(tmpdir(), "control-ui-origins-"));
      const missing = path.join(dir, "nope.json");
      expect(loadConfiguredOrigins(missing)).toEqual({ origins: [], warnings: [] });
    });

    it("loads, normalizes, and de-duplicates a valid array", () => {
      dir = mkdtempSync(path.join(tmpdir(), "control-ui-origins-"));
      const file = path.join(dir, "origins.json");
      writeFileSync(
        file,
        JSON.stringify(["http://a.example.com", "HTTP://A.example.com:80", "https://b.example.com:8443"]),
      );
      const result = loadConfiguredOrigins(file);
      expect(result.origins).toEqual(["http://a.example.com", "https://b.example.com:8443"]);
      expect(result.warnings).toEqual([]);
    });

    it("drops invalid entries with a warning, keeps valid ones", () => {
      dir = mkdtempSync(path.join(tmpdir(), "control-ui-origins-"));
      const file = path.join(dir, "origins.json");
      writeFileSync(file, JSON.stringify(["http://good.example.com", "not-a-url-but-string", "*"]));
      const result = loadConfiguredOrigins(file);
      expect(result.origins).toEqual(["http://good.example.com"]);
      expect(result.warnings).toHaveLength(2);
    });

    it("returns a warning and no origins for invalid JSON", () => {
      dir = mkdtempSync(path.join(tmpdir(), "control-ui-origins-"));
      const file = path.join(dir, "origins.json");
      writeFileSync(file, "{not json");
      const result = loadConfiguredOrigins(file);
      expect(result.origins).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    });

    it("returns a warning and no origins for a non-array top level", () => {
      dir = mkdtempSync(path.join(tmpdir(), "control-ui-origins-"));
      const file = path.join(dir, "origins.json");
      writeFileSync(file, JSON.stringify({ a: 1 }));
      const result = loadConfiguredOrigins(file);
      expect(result.origins).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    });

    it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
      "returns a warning for an existing but unreadable file",
      () => {
        dir = mkdtempSync(path.join(tmpdir(), "control-ui-origins-"));
        const file = path.join(dir, "origins.json");
        writeFileSync(file, JSON.stringify(["http://a.example.com"]));
        chmodSync(file, 0o000);
        try {
          const result = loadConfiguredOrigins(file);
          expect(result.origins).toEqual([]);
          expect(result.warnings).toHaveLength(1);
        } finally {
          chmodSync(file, 0o600);
        }
      },
    );
  });

  describe("resolveOriginsPath / loadConfiguredOriginsFromEnv", () => {
    const ENV_VAR = "CLAWBOX_CONTROL_UI_ORIGINS_FILE";
    const original = process.env[ENV_VAR];

    afterEach(() => {
      if (original === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = original;
    });

    it("defaults to the well-known data path", () => {
      delete process.env[ENV_VAR];
      expect(resolveOriginsPath()).toBe("/home/clawbox/clawbox/data/control-ui-origins.json");
    });

    it("honors the env override", () => {
      process.env[ENV_VAR] = "/tmp/custom-origins.json";
      expect(resolveOriginsPath()).toBe("/tmp/custom-origins.json");
    });

    it("loadConfiguredOriginsFromEnv reads from the env-overridden path", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "control-ui-origins-"));
      const file = path.join(dir, "origins.json");
      writeFileSync(file, JSON.stringify(["http://env-origin.example.com"]));
      process.env[ENV_VAR] = file;
      expect(loadConfiguredOriginsFromEnv()).toEqual({
        origins: ["http://env-origin.example.com"],
        warnings: [],
      });
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
