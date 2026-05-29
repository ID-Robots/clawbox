import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

// gateway-pre-start.sh decides whether to PRESERVE the on-disk gateway auth
// token or rotate it to a fresh per-device random. That predicate + rotation
// gate LAN access to the agent's privileged tools, so a regression (reverting
// to the unconditional `set_if(auth,"token","clawbox")` clobber, or a botched
// strength check that drops a strong token) is a security risk. We extract the
// real predicate from the shipped script and exercise it — and the actual
// rotation line — via python3 so this tracks the real code. See #149 / #150.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");

const hasPython3 =
  spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

// Pull the token-policy block (constants + predicate) out of the .sh verbatim.
// Anchored between the first constant and the next top-level statement
// (`cfg_path = sys.argv[1]`), so it survives reformatting of the function body.
function extractTokenPolicy(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf('LEGACY_GATEWAY_TOKEN = "clawbox"');
  const end = src.indexOf("\ncfg_path = sys.argv[1]", start);
  if (start < 0 || end < 0) {
    throw new Error("token-policy block not found in gateway-pre-start.sh");
  }
  return src.slice(start, end);
}

const POLICY = hasPython3 ? extractTokenPolicy() : "";
const HEX_64 = /^[0-9a-f]{64}$/;

function runPython(body: string, valueJson: string): string {
  return execFileSync("python3", ["-c", `${POLICY}\n${body}`, valueJson], {
    encoding: "utf-8",
  }).trim();
}

/** "strong" (preserve) or "weak" (rotate) for a JSON-encoded token value. */
function classify(value: unknown): string {
  return runPython(
    `import json, sys\nprint("strong" if is_strong_gateway_token(json.loads(sys.argv[1])) else "weak")`,
    JSON.stringify(value),
  );
}

/** The token pre-start would end up persisting, given an existing value. */
function rotateOutcome(value: unknown): string {
  // Mirrors the rotation at the call site:
  //   if not is_strong_gateway_token(auth.get("token")): auth["token"] = secrets.token_hex(32)
  return runPython(
    `import json, sys, secrets\nt = json.loads(sys.argv[1])\nprint(t if is_strong_gateway_token(t) else secrets.token_hex(32))`,
    JSON.stringify(value),
  );
}

describe.skipIf(!hasPython3)("gateway-pre-start.sh token policy", () => {
  describe("is_strong_gateway_token predicate", () => {
    it("legacy literal 'clawbox' is weak (must rotate)", () => {
      expect(classify("clawbox")).toBe("weak");
    });
    it("null / missing is weak (must generate)", () => {
      expect(classify(null)).toBe("weak");
    });
    it("64-hex per-device token is strong (must preserve)", () => {
      expect(classify("a".repeat(64))).toBe("strong");
    });
    it("32-char token is strong (length boundary)", () => {
      expect(classify("b".repeat(32))).toBe("strong");
    });
    it("31-char token is weak (just under the boundary)", () => {
      expect(classify("c".repeat(31))).toBe("weak");
    });
    it("non-empty ${ENV} interpolation is strong (runtime-resolved)", () => {
      expect(classify("${OPENCLAW_GATEWAY_TOKEN}")).toBe("strong");
    });
    it("empty ${} interpolation is weak", () => {
      expect(classify("${}")).toBe("weak");
    });
    it("SecretRef object with a known key is strong (externally managed)", () => {
      expect(classify({ env: "OPENCLAW_GATEWAY_TOKEN" })).toBe("strong");
      // file/exec are equally valid SecretRef shapes — assert each so a
      // regression that drops one from the accepted-key set is caught.
      expect(classify({ file: "/run/secrets/gateway-token" })).toBe("strong");
      expect(classify({ exec: "cat /run/secrets/token" })).toBe("strong");
    });
    it("empty/keyless object is weak (not a resolvable secret)", () => {
      expect(classify({})).toBe("weak");
    });
    it("array is weak (matches install-x64.sh Array.isArray guard)", () => {
      expect(classify(["a".repeat(64)])).toBe("weak");
    });
  });

  describe("rotation wiring (preserve strong / rotate weak)", () => {
    it("rotates the legacy literal to a fresh 64-hex token", () => {
      const out = rotateOutcome("clawbox");
      expect(out).not.toBe("clawbox");
      expect(out).toMatch(HEX_64);
    });
    it("rotates a missing token to a 64-hex token", () => {
      expect(rotateOutcome(null)).toMatch(HEX_64);
    });
    it("preserves an existing strong 64-hex token unchanged", () => {
      const strong = "d".repeat(64);
      expect(rotateOutcome(strong)).toBe(strong);
    });
    it("preserves a ${ENV} interpolation unchanged", () => {
      expect(rotateOutcome("${OPENCLAW_GATEWAY_TOKEN}")).toBe(
        "${OPENCLAW_GATEWAY_TOKEN}",
      );
    });
  });
});
