import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  cpSync,
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

// Starts a real process (bash / python3 / node): vitest's 5 s test and 10 s
// hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The gateway boot's FIELD CLEANUP of `clawbox-web-taint` — the approval gate
// TASK-735 shipped, which made every shell call in a turn that had read a web
// page raise a card in the chat, and which the owner retired on 2026-09-15
// ("we want the coding agent to just work, no warnings and pop-ups"). The
// plugin is gone from the checkout; what this suite pins is that nothing
// installs it any more, and that a box which already carries it — copied into
// ~/.openclaw/extensions and enabled in openclaw.json by an earlier boot —
// loses it on the next boot.
//
// It runs the BLOCKS OUT OF THE SHIPPED SCRIPT rather than a copy, like every
// other gateway-pre-start suite, so a drift between the two fails here.
//
// The shapes it pins:
//
//   nothing installs it — the installer slice, run whole, leaves exactly the
//                         path guard behind, and the script's text no longer
//                         names the plugin's sources.
//   the cleanup         — the directory and the config entry gone, every other
//                         plugin's entry byte for byte as it was, ONE line said.
//   no-op               — on a box that never had it the config is not
//                         rewritten and nothing at all is printed.
//   false failure       — a corrupt, unreadable or missing config, a directory
//                         that will not go: one WARN at most, and exit 0 every
//                         time. This is an ExecStartPre under
//                         `set -euo pipefail`; a cleanup of a plugin nobody
//                         wants must never cost the box its agent.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const REPO = path.resolve(process.cwd());
const PLUGIN_ID = "clawbox-web-taint";
const PATH_GUARD_ID = "clawbox-path-guard";
const TABLE_REL = path.join("config", "protected-paths.json");

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasBash && hasPython3 ? describe : describe.skip;

/** 0000 is a no-op for root, which reads anything. CI is non-root. */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** One section of the shipped script, by its heading and the next heading. */
function section(from: string, to: string): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`${from} is not in gateway-pre-start.sh`);
  return src.slice(start, end);
}

const CLEANUP_HEADING = "# ── Field cleanup: the retired clawbox-web-taint plugin ";
const EMAIL_HEADING = "# ── The outbound EMAIL:-directive hook plugin ";

/** The cleanup alone: it uses nothing the shared installer defines. */
function cleanupBlock(): string {
  return section(CLEANUP_HEADING, EMAIL_HEADING);
}

/**
 * The installer, every hook plugin it copies in, and the cleanup — the whole
 * slice before the EMAIL: plugin, which needs an `openclaw` stub of its own
 * and is gateway-pre-start-email-hook.test.ts's subject.
 */
function installerSlice(): string {
  return section("# ── Installing a ClawBox hook plugin into ~/.openclaw/extensions ", EMAIL_HEADING);
}

let dir: string;
let root: string;
let openclawHome: string;
let configPath: string;

function run(block: string): { status: number; stdout: string; stderr: string } {
  const program = [
    "set -euo pipefail",
    `CLAWBOX_ROOT=${JSON.stringify(root)}`,
    `OPENCLAW_CONFIG=${JSON.stringify(configPath)}`,
    `OPENCLAW_HOME_DIR=${JSON.stringify(openclawHome)}`,
    block,
  ].join("\n");
  const r = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
    timeout: 60_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const extensionDir = () => path.join(openclawHome, "extensions", PLUGIN_ID);

/** What an earlier boot's install left behind: the four files, enabled. */
function seedInstalledCopy() {
  mkdirSync(extensionDir(), { recursive: true });
  for (const name of ["index.mjs", "openclaw.plugin.json", "package.json", "web-taint.mjs"]) {
    writeFileSync(path.join(extensionDir(), name), `// ${name}\n`);
  }
}

/** The entries every box here carries, and which the cleanup must not touch. */
const OTHER_ENTRIES = {
  [PATH_GUARD_ID]: { enabled: true },
  "clawbox-email-directives": { hooks: { timeoutMs: 5000 }, enabled: true },
  deepseek: { enabled: true },
};

type Config = {
  plugins?: { entries?: Record<string, unknown>; allow?: string[]; deny?: string[] } | unknown;
  [key: string]: unknown;
};

function writeConfig(cfg: Config) {
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

function readConfig(): Config {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

function entries(): Record<string, unknown> {
  const plugins = readConfig().plugins as { entries?: Record<string, unknown> } | undefined;
  return plugins?.entries ?? {};
}

/** The stdout lines, so "said once" is a count and not a substring. */
const lines = (out: string) => out.split("\n").filter((line) => line.trim() !== "");

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-taint-cleanup-"));
  root = path.join(dir, "clawbox");
  openclawHome = path.join(dir, ".openclaw");
  configPath = path.join(openclawHome, "openclaw.json");

  // A checkout with just the pieces the installer slice reads: the path guard
  // and its table. There is deliberately NO clawbox-web-taint source folder,
  // which is the state of the real checkout now.
  mkdirSync(path.join(root, "config"), { recursive: true });
  cpSync(
    path.join(REPO, "scripts", "openclaw-plugins", PATH_GUARD_ID),
    path.join(root, "scripts", "openclaw-plugins", PATH_GUARD_ID),
    { recursive: true },
  );
  cpSync(path.join(REPO, TABLE_REL), path.join(root, TABLE_REL));

  mkdirSync(openclawHome, { recursive: true });
  writeConfig({ plugins: { entries: { ...OTHER_ENTRIES } } });
});

afterEach(() => {
  // A case may have taken write permission off the extensions dir or the
  // config; give it back so the tree can go.
  try { chmodSync(path.join(openclawHome, "extensions"), 0o755); } catch { /* absent */ }
  try { chmodSync(configPath, 0o644); } catch { /* absent */ }
  rmSync(dir, { recursive: true, force: true });
});

d("gateway-pre-start.sh — the retired web-taint gate's field cleanup", () => {
  it("installs no clawbox-web-taint: the checkout has none and the script names none", () => {
    expect(existsSync(path.join(REPO, "scripts", "openclaw-plugins", PLUGIN_ID))).toBe(false);
    const src = readFileSync(SCRIPT, "utf-8");
    expect(src).not.toContain("web-taint.mjs");
    expect(src).not.toContain(`openclaw-plugins/${PLUGIN_ID}`);
    // The installer is called for the path guard and the EMAIL: plugin and
    // never with the retired id — on any variable spelling.
    for (const call of src.match(/install_clawbox_hook_plugin\s+"[^"]*"[^\n]*/g) ?? []) {
      expect(call.toLowerCase()).not.toContain("taint");
    }
  });

  it("leaves exactly the path guard behind when the whole installer slice runs", () => {
    const r = run(installerSlice());
    expect(r.status).toBe(0);
    expect(readdirSync(path.join(openclawHome, "extensions")).sort()).toEqual([PATH_GUARD_ID]);
    expect(Object.keys(entries()).sort()).toEqual(Object.keys(OTHER_ENTRIES).sort());
    expect(r.stdout).not.toContain(PLUGIN_ID);
  });

  it("removes an installed copy and its config entry, leaves the other plugins alone, and says so once", () => {
    seedInstalledCopy();
    writeConfig({ plugins: { entries: { ...OTHER_ENTRIES, [PLUGIN_ID]: { enabled: true } } } });

    const r = run(cleanupBlock());
    expect(r.status).toBe(0);
    expect(existsSync(extensionDir())).toBe(false);
    expect(entries()[PLUGIN_ID]).toBeUndefined();
    expect(entries()).toEqual(OTHER_ENTRIES);
    expect(r.stderr).toBe("");
    const said = lines(r.stdout);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(`Removed the retired ${PLUGIN_ID} plugin`);
    expect(said[0]).toContain(extensionDir());
    expect(said[0]).toContain(`plugins.entries.${PLUGIN_ID}`);
    // No temp file left beside the config from the atomic write.
    expect(readdirSync(openclawHome).sort()).toEqual(["extensions", "openclaw.json"]);
  });

  it("drops the entry alone when only the config still names it", () => {
    // The directory went with a factory reset; the config was restored from a
    // backup that still names the plugin. An entry with no folder is what the
    // core's doctor reports as a repair.
    writeConfig({ plugins: { entries: { ...OTHER_ENTRIES, [PLUGIN_ID]: { enabled: true, hooks: { timeoutMs: 100 } } } } });
    const r = run(cleanupBlock());
    expect(r.status).toBe(0);
    expect(entries()).toEqual(OTHER_ENTRIES);
    expect(lines(r.stdout)).toHaveLength(1);
    expect(r.stdout).toContain(`plugins.entries.${PLUGIN_ID}`);
    expect(r.stdout).not.toContain(extensionDir());
  });

  it("takes the id out of the core's own allow and deny lists too", () => {
    writeConfig({
      plugins: {
        allow: ["deepseek", PLUGIN_ID, "discord"],
        deny: [PLUGIN_ID],
        entries: { ...OTHER_ENTRIES, [PLUGIN_ID]: { enabled: true } },
      },
    });
    const r = run(cleanupBlock());
    expect(r.status).toBe(0);
    const plugins = readConfig().plugins as { allow?: string[]; deny?: string[] };
    expect(plugins.allow).toEqual(["deepseek", "discord"]);
    expect(plugins.deny).toEqual([]);
    expect(entries()).toEqual(OTHER_ENTRIES);
    expect(lines(r.stdout)).toHaveLength(1);
  });

  it("is a no-op on a box that never had it: nothing printed, the config not rewritten", () => {
    const before = readFileSync(configPath, "utf-8");
    const r = run(cleanupBlock());
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
    expect(readdirSync(openclawHome)).toEqual(["openclaw.json"]);
  });

  it("is a no-op on the boot after the one that removed it", () => {
    seedInstalledCopy();
    writeConfig({ plugins: { entries: { ...OTHER_ENTRIES, [PLUGIN_ID]: { enabled: true } } } });
    expect(lines(run(cleanupBlock()).stdout)).toHaveLength(1);

    const before = readFileSync(configPath, "utf-8");
    const r = run(cleanupBlock());
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("leaves a config whose plugins key is not an object alone", () => {
    writeConfig({ plugins: "not an object", gateway: { port: 18789 } });
    const before = readFileSync(configPath, "utf-8");
    const r = run(cleanupBlock());
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("still removes the directory when the config is corrupt, and leaves the file's bytes alone", () => {
    seedInstalledCopy();
    const torn = '{"plugins":{"entries":{"clawbox-web-taint":{"enabled":tr';
    writeFileSync(configPath, torn);

    const r = run(cleanupBlock());
    expect(r.status).toBe(0);
    expect(existsSync(extensionDir())).toBe(false);
    // Never written back: a config this block could not parse is one the
    // blocks above already reported on, and `{}` over it would cost every
    // provider and channel.
    expect(readFileSync(configPath, "utf-8")).toBe(torn);
    expect(r.stderr).toBe("");
    const said = lines(r.stdout);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(extensionDir());
    expect(said[0]).not.toContain("plugins.entries");
  });

  it.skipIf(isRoot)("does not fail the boot over a config it cannot read", () => {
    seedInstalledCopy();
    chmodSync(configPath, 0o000);
    const r = run(cleanupBlock());
    expect(r.status).toBe(0);
    expect(existsSync(extensionDir())).toBe(false);
    expect(r.stderr).toBe("");
    expect(lines(r.stdout)).toHaveLength(1);
  });

  it("does not fail the boot over a config that is missing", () => {
    rmSync(configPath);
    seedInstalledCopy();
    const r = run(cleanupBlock());
    expect(r.status).toBe(0);
    expect(existsSync(extensionDir())).toBe(false);
    expect(existsSync(configPath)).toBe(false);
    expect(r.stderr).toBe("");
    expect(lines(r.stdout)).toHaveLength(1);
  });

  it.skipIf(isRoot)("reports a directory it cannot remove and still drops the entry, without failing the boot", () => {
    seedInstalledCopy();
    writeConfig({ plugins: { entries: { ...OTHER_ENTRIES, [PLUGIN_ID]: { enabled: true } } } });
    chmodSync(path.join(openclawHome, "extensions"), 0o555);
    try {
      const r = run(cleanupBlock());
      expect(r.status).toBe(0);
      expect(existsSync(extensionDir())).toBe(true);
      expect(r.stderr).toContain(`could not remove the retired ${PLUGIN_ID} plugin`);
      // The entry is what makes the gateway import the folder; with it gone
      // the leftover copy is inert.
      expect(entries()).toEqual(OTHER_ENTRIES);
      const said = lines(r.stdout);
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(`plugins.entries.${PLUGIN_ID}`);
      expect(said[0]).not.toContain(extensionDir());
    } finally {
      chmodSync(path.join(openclawHome, "extensions"), 0o755);
    }
  });

  it.skipIf(isRoot)("reports a config it cannot write and still removes the directory, without failing the boot", () => {
    seedInstalledCopy();
    writeConfig({ plugins: { entries: { ...OTHER_ENTRIES, [PLUGIN_ID]: { enabled: true } } } });
    // The atomic write needs to create a temp file BESIDE the config; a home
    // that refuses that is the write failing, and the file must be left as it
    // was rather than half-replaced.
    const before = readFileSync(configPath, "utf-8");
    chmodSync(openclawHome, 0o555);
    try {
      const r = run(cleanupBlock());
      expect(r.status).toBe(0);
      expect(r.stderr).toContain(`could not drop the retired ${PLUGIN_ID} plugin from`);
      expect(readFileSync(configPath, "utf-8")).toBe(before);
    } finally {
      chmodSync(openclawHome, 0o755);
    }
    // The directory lives under a writable extensions/ and went regardless.
    expect(existsSync(extensionDir())).toBe(false);
  });
});
