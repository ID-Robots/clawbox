import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real process (bash / python3): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The gateway boot's FIELD CLEANUP of the retired Prime Radiant core block: the
// OpenClaw hook plugin that put the wiki's most-linked pages in the owner's
// main agent's every session, and the file ClawBox wrote for it. The feature
// is gone from the checkout; what this suite pins is that nothing installs the
// plugin any more, and that a box which already carries it — copied into
// ~/.openclaw/extensions and enabled (with its conversation-access grant) in
// openclaw.json by an earlier boot, the block file beside the vault — loses all
// of it on the next boot, and that a box which never had it is not touched.
//
// It runs the BLOCK OUT OF THE SHIPPED SCRIPT, like every other
// gateway-pre-start suite, so a drift between the two fails here. The shared
// machinery (one function per retired plugin) is pinned in depth by
// gateway-pre-start-web-taint-cleanup.test.ts; this suite holds the second
// plugin and the file to it.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const REPO = path.resolve(process.cwd());
const PLUGIN_ID = "clawbox-prime-radiant-core";
const BLOCK_FILE = "core-context.json";

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasBash && hasPython3 ? describe : describe.skip;

/** 0000 is a no-op for root, which reads anything. CI is non-root. */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

const CLEANUP_HEADING = "# ── Field cleanup: retired ClawBox plugins ";
const EMAIL_HEADING = "# ── The outbound EMAIL:-directive hook plugin ";

function cleanupBlock(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf(CLEANUP_HEADING);
  const end = src.indexOf(EMAIL_HEADING, start);
  if (start < 0 || end < 0) throw new Error("the retired-plugin cleanup is not in gateway-pre-start.sh");
  return src.slice(start, end);
}

let dir: string;
let root: string;
let openclawHome: string;
let configPath: string;
let primeRadiant: string;

function run(env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const program = [
    "set -euo pipefail",
    `CLAWBOX_ROOT=${JSON.stringify(root)}`,
    `OPENCLAW_CONFIG=${JSON.stringify(configPath)}`,
    `OPENCLAW_HOME_DIR=${JSON.stringify(openclawHome)}`,
    cleanupBlock(),
  ].join("\n");
  const r = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }),
    timeout: 60_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const extensionDir = () => path.join(openclawHome, "extensions", PLUGIN_ID);
const blockFile = (folder = primeRadiant) => path.join(folder, BLOCK_FILE);

/** What an earlier boot's install left behind: the four files, enabled with the prompt-hook grant. */
function seedInstalledCopy() {
  mkdirSync(extensionDir(), { recursive: true });
  for (const name of ["index.mjs", "openclaw.plugin.json", "package.json", "prime-radiant-core.mjs"]) {
    writeFileSync(path.join(extensionDir(), name), `// ${name}\n`);
  }
}

/** What the app wrote while the owner had the setting on. */
function seedBlockFile(folder = primeRadiant) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(blockFile(folder), JSON.stringify({ format: 1, text: "- Acme overview: what Acme makes", pages: 1 }));
}

/** The entries every box here carries, and which the cleanup must not touch. */
const OTHER_ENTRIES = {
  "clawbox-path-guard": { enabled: true },
  "clawbox-user-language": { enabled: true, hooks: { allowConversationAccess: true } },
  "memory-wiki": { enabled: true, config: { vaultMode: "isolated" } },
};

const INSTALLED_ENTRY = { enabled: true, hooks: { allowConversationAccess: true } };

type Config = { plugins?: { entries?: Record<string, unknown>; allow?: string[]; deny?: string[] } | unknown; [key: string]: unknown };

function writeConfig(cfg: Config) {
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

function entries(): Record<string, unknown> {
  const plugins = JSON.parse(readFileSync(configPath, "utf-8")).plugins as { entries?: Record<string, unknown> } | undefined;
  return plugins?.entries ?? {};
}

const lines = (out: string) => out.split("\n").filter((line) => line.trim() !== "");

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-core-block-cleanup-"));
  root = path.join(dir, "clawbox");
  openclawHome = path.join(dir, ".openclaw");
  configPath = path.join(openclawHome, "openclaw.json");
  primeRadiant = path.join(root, "data", "prime-radiant");
  mkdirSync(openclawHome, { recursive: true });
  // The Prime Radiant folder as a box keeps it: the cleanup must leave everything but the block alone.
  mkdirSync(path.join(primeRadiant, "vault"), { recursive: true });
  writeFileSync(path.join(primeRadiant, "settings.json"), JSON.stringify({ context: { enabled: true } }));
  writeConfig({ plugins: { entries: { ...OTHER_ENTRIES } } });
});

afterEach(() => {
  try { chmodSync(primeRadiant, 0o755); } catch { /* absent */ }
  rmSync(dir, { recursive: true, force: true });
});

d("gateway-pre-start.sh — the retired Prime Radiant core block's field cleanup", () => {
  it("installs no core block plugin: the checkout has none and only the cleanup names it", () => {
    expect(existsSync(path.join(REPO, "scripts", "openclaw-plugins", PLUGIN_ID))).toBe(false);
    const src = readFileSync(SCRIPT, "utf-8");
    for (const call of src.match(/install_clawbox_hook_plugin\s+"[^"]*"[^\n]*/g) ?? []) {
      expect(call.toLowerCase()).not.toContain("prime-radiant");
    }
    const block = cleanupBlock();
    const outside = src.replace(block, "");
    expect(outside).not.toContain(PLUGIN_ID);
    expect(outside).not.toContain(BLOCK_FILE);
    expect(block).toMatch(new RegExp(`^retire_clawbox_plugin ${PLUGIN_ID}$`, "m"));
  });

  it("removes the installed copy, its config entry and the block file, leaves the rest alone, and says so", () => {
    seedInstalledCopy();
    seedBlockFile();
    writeConfig({ plugins: { entries: { ...OTHER_ENTRIES, [PLUGIN_ID]: INSTALLED_ENTRY } } });

    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(existsSync(extensionDir())).toBe(false);
    expect(entries()).toEqual(OTHER_ENTRIES);
    expect(existsSync(blockFile())).toBe(false);
    // The vault and the owner's settings stay exactly where they were.
    expect(readdirSync(primeRadiant).sort()).toEqual(["settings.json", "vault"]);
    expect(JSON.parse(readFileSync(path.join(primeRadiant, "settings.json"), "utf-8"))).toEqual({ context: { enabled: true } });
    const said = lines(r.stdout);
    expect(said).toHaveLength(2);
    expect(said[0]).toContain(`Removed the retired ${PLUGIN_ID} plugin`);
    expect(said[0]).toContain(extensionDir());
    expect(said[0]).toContain(`plugins.entries.${PLUGIN_ID}`);
    expect(said[1]).toContain(blockFile());
    expect(readdirSync(openclawHome).sort()).toEqual(["extensions", "openclaw.json"]);
  });

  it("takes the id out of the core's own allow and deny lists too", () => {
    writeConfig({ plugins: { allow: ["memory-wiki", PLUGIN_ID], deny: [PLUGIN_ID], entries: { ...OTHER_ENTRIES, [PLUGIN_ID]: INSTALLED_ENTRY } } });
    const r = run();
    expect(r.status).toBe(0);
    const plugins = JSON.parse(readFileSync(configPath, "utf-8")).plugins as { allow?: string[]; deny?: string[] };
    expect(plugins.allow).toEqual(["memory-wiki"]);
    expect(plugins.deny).toEqual([]);
    expect(entries()).toEqual(OTHER_ENTRIES);
    expect(lines(r.stdout)).toHaveLength(1);
  });

  it("finds the block file under PRIME_RADIANT_DIR when that is an absolute path, as the plugin did", () => {
    const elsewhere = path.join(dir, "pr-elsewhere");
    seedBlockFile(elsewhere);
    seedBlockFile();
    const r = run({ PRIME_RADIANT_DIR: elsewhere });
    expect(r.status).toBe(0);
    expect(existsSync(blockFile(elsewhere))).toBe(false);
    // The default folder is not the one in force, so it is not this boot's to touch.
    expect(existsSync(blockFile())).toBe(true);
    expect(lines(r.stdout)).toEqual([expect.stringContaining(blockFile(elsewhere))]);
  });

  it("is a no-op on a box that never had it: nothing printed, nothing rewritten", () => {
    const before = readFileSync(configPath, "utf-8");
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
    expect(readdirSync(openclawHome)).toEqual(["openclaw.json"]);
    expect(readdirSync(primeRadiant).sort()).toEqual(["settings.json", "vault"]);
  });

  it("is a no-op on the boot after the one that removed it", () => {
    seedInstalledCopy();
    seedBlockFile();
    writeConfig({ plugins: { entries: { ...OTHER_ENTRIES, [PLUGIN_ID]: INSTALLED_ENTRY } } });
    expect(lines(run().stdout)).toHaveLength(2);

    const before = readFileSync(configPath, "utf-8");
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("still removes the copy and the file when the config is missing, without failing the boot", () => {
    rmSync(configPath);
    seedInstalledCopy();
    seedBlockFile();
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(existsSync(extensionDir())).toBe(false);
    expect(existsSync(blockFile())).toBe(false);
    expect(existsSync(configPath)).toBe(false);
    expect(lines(r.stdout)).toHaveLength(2);
  });

  it("leaves a corrupt config's bytes alone and still removes the copy", () => {
    seedInstalledCopy();
    const torn = `{"plugins":{"entries":{"${PLUGIN_ID}":{"enabled":tr`;
    writeFileSync(configPath, torn);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(existsSync(extensionDir())).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe(torn);
  });

  it.skipIf(isRoot)("reports a block file it cannot remove, without failing the boot", () => {
    seedBlockFile();
    chmodSync(primeRadiant, 0o555);
    try {
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("could not remove the retired Prime Radiant core block");
      expect(existsSync(blockFile())).toBe(true);
    } finally {
      chmodSync(primeRadiant, 0o755);
    }
  });

  it("leaves a directory that happens to have the block file's name alone", () => {
    mkdirSync(blockFile(), { recursive: true });
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(existsSync(blockFile())).toBe(true);
  });
});
