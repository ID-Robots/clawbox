import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sliceScript } from "@/tests/helpers/gateway-pre-start";

// Starts a real bash process per case — both ceilings, per test-timeout-hygiene.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * On the subscription path the core tells Anthropic it is Claude Code
 * 2.1.75, a number hard-coded in its bundle, and Anthropic refuses the newest
 * models below 2.1.251. The box has a real Claude Code installed; Hermes
 * reports THAT version and works on the same login. This pre-start step makes
 * the core report the same — and only when what is installed is newer.
 */

const BUNDLE_BEFORE = 'var X;init(()=>{X=`a`,ANTHROPIC_CLAUDE_CODE_VERSION=`2.1.75`,ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK=`x-anthropic-billing-header: cc_version=${ANTHROPIC_CLAUDE_CODE_VERSION}; cc_entrypoint=sdk-cli;`});';
// The copy the Anthropic extension imports: the `@openclaw/ai` package's own
// bundle under the core's node_modules, plainly quoted.
const AI_PACKAGE_BEFORE = 'const ANTHROPIC_CLAUDE_CODE_VERSION = "2.1.75";\nconst ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK = `x-anthropic-billing-header: cc_version=${ANTHROPIC_CLAUDE_CODE_VERSION}; cc_entrypoint=sdk-cli;`;\n';

let tmp: string;
function run(claudeVersion: string | null): { out: string; bundle: string; aiBundle: string; stray: string; status: number | null } {
  const home = path.join(tmp, "home");
  const bin = path.join(home, ".npm-global", "bin");
  const dist = path.join(home, ".npm-global", "lib", "node_modules", "openclaw", "dist");
  mkdirSync(bin, { recursive: true });
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(bin, "openclaw"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "openclaw"), 0o755);
  const bundle = path.join(dist, "anthropic-abc123.js");
  if (!readFileSafe(bundle)) writeFileSync(bundle, BUNDLE_BEFORE);
  const aiDist = path.join(home, ".npm-global", "lib", "node_modules", "openclaw", "node_modules", "@openclaw", "ai", "dist");
  mkdirSync(aiDist, { recursive: true });
  const aiBundle = path.join(aiDist, "host-abc123.mjs");
  if (!readFileSafe(aiBundle)) writeFileSync(aiBundle, AI_PACKAGE_BEFORE);
  // A stray copy deeper in node_modules is not the core's and is never touched.
  const stray = path.join(home, ".npm-global", "lib", "node_modules", "openclaw", "node_modules", "left-pad", "index.js");
  mkdirSync(path.dirname(stray), { recursive: true });
  if (!readFileSafe(stray)) writeFileSync(stray, AI_PACKAGE_BEFORE);
  const localBin = path.join(home, ".local", "bin");
  mkdirSync(localBin, { recursive: true });
  if (claudeVersion) {
    writeFileSync(path.join(localBin, "claude"), `#!/bin/sh\necho "${claudeVersion} (Claude Code)"\n`);
    chmodSync(path.join(localBin, "claude"), 0o755);
  } else {
    rmSync(path.join(localBin, "claude"), { force: true });
  }
  const section = sliceScript("# ── Report the installed Claude Code to Anthropic", "# ── End of pre-start");
  const script = `set -u\nHOME=${JSON.stringify(home)}\nOPENCLAW_BIN=${JSON.stringify(path.join(bin, "openclaw"))}\n${section}`;
  const res = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: "/usr/bin:/bin", HOME: home } });
  return { out: res.stdout + res.stderr, bundle: readFileSync(bundle, "utf8"), aiBundle: readFileSync(aiBundle, "utf8"), stray: readFileSync(stray, "utf8"), status: res.status };
}
function readFileSafe(p: string): string | null {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

beforeEach(() => { tmp = mkdtempSync(path.join(os.tmpdir(), "clawbox-ccv-")); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("reporting the installed Claude Code version", () => {
  it("rewrites the bundle's constant to the installed version when that is newer, once", () => {
    const first = run("2.1.273");
    expect(first.status).toBe(0);
    expect(first.out).toMatch(/the core said Claude Code 2\.1\.75; now reporting the installed 2\.1\.273/);
    expect(first.bundle).toContain("ANTHROPIC_CLAUDE_CODE_VERSION=`2.1.273`");
    expect(first.bundle).not.toContain("2.1.75");
    // Everything around the constant is untouched, including the billing
    // header that reads the same constant.
    expect(first.bundle).toContain("cc_version=${ANTHROPIC_CLAUDE_CODE_VERSION}; cc_entrypoint=sdk-cli;");
    // The ai package's own copy — the one the request is actually built from —
    // is rewritten too, keeping its quoting; a stray copy elsewhere is not.
    expect(first.aiBundle).toContain('const ANTHROPIC_CLAUDE_CODE_VERSION = "2.1.273";');
    expect(first.stray).toBe(AI_PACKAGE_BEFORE);
    const second = run("2.1.273");
    expect(second.out).toMatch(/already reporting the installed Claude Code 2\.1\.273/);
    expect(second.bundle).toBe(first.bundle);
  });

  it("leaves the core alone when the installed Claude Code is older — a downgrade would be the lie", () => {
    const r = run("2.1.10");
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/2\.1\.75 is not older than the installed 2\.1\.10; kept/);
    expect(r.bundle).toBe(BUNDLE_BEFORE);
  });

  it("judges every copy of the constant in a file on its own — an older first copy cannot drag a newer one down", () => {
    // One file, two constants: the rewrite is per occurrence, so the older
    // one comes up to the installed version and the newer one is left as it
    // is. Deciding on the first match alone rewrote BOTH, and the second was
    // the downgrade the step exists to refuse.
    const dist = path.join(tmp, "home", ".npm-global", "lib", "node_modules", "openclaw", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      path.join(dist, "anthropic-abc123.js"),
      "ANTHROPIC_CLAUDE_CODE_VERSION=`2.1.75`;ANTHROPIC_CLAUDE_CODE_VERSION=`2.1.300`;",
    );
    const r = run("2.1.200");
    expect(r.status).toBe(0);
    expect(r.bundle).toBe("ANTHROPIC_CLAUDE_CODE_VERSION=`2.1.200`;ANTHROPIC_CLAUDE_CODE_VERSION=`2.1.300`;");
    expect(r.out).toMatch(/the core said Claude Code 2\.1\.75; now reporting the installed 2\.1\.200/);
  });

  it("leaves the core alone, and says so, when no Claude Code is installed", () => {
    const r = run(null);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/no Claude Code on this box; the core's own number is kept/);
    expect(r.bundle).toBe(BUNDLE_BEFORE);
  });
});
