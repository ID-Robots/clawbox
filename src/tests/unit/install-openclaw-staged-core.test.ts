import { describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A real bash per case: vitest's 5 s default is not enough on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * 2026-09-16 — three field boxes stopped dead seconds after `npm install -g
 * openclaw@2026.9.3` had exited 0 inside the update's "Updating OpenClaw" step.
 * They came back with a core that was complete in SHAPE and useless: 5,346 of
 * the 35,025 files npm had just written were zero-length — openclaw.mjs and
 * package.json among them — because ext4 had not yet written what npm had
 * extracted, and the gateway then failed 203/EXEC on every boot. And for the
 * 33 s of the install itself the box had NO core at all, because a global npm
 * install retires the old tree first and removes it last.
 *
 * So `step_openclaw_install` now installs into a STAGING prefix, gates the
 * launcher there, and `promote_staged_openclaw_core` flushes the stage to disk
 * before two renames put it in front of the gateway. This drives the shipped
 * functions under bash against a real prefix, with the flush observed rather
 * than performed.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");

function shellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start + 1);
  return `${INSTALL_SH.slice(start + 1, end)}\n}`;
}

function assignment(name: string): string {
  const m = new RegExp(`^${name}=.*$`, "m").exec(INSTALL_SH);
  return m ? m[0] : `${name}=""`;
}

type Prefix = { dir: string; prefix: string; calls: () => string[] };

/** A live prefix holding an OLD core, laid out the way npm lays a global install out. */
function makePrefix(opts: { oldCore?: boolean }): Prefix {
  const dir = mkdtempSync(path.join(tmpdir(), "clawbox-staged-core-"));
  const prefix = path.join(dir, "npm-global");
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  mkdirSync(path.join(prefix, "lib", "node_modules"), { recursive: true });
  writeFileSync(path.join(dir, "calls"), "");
  if (opts.oldCore !== false) {
    const old = path.join(prefix, "lib", "node_modules", "openclaw");
    mkdirSync(old, { recursive: true });
    writeFileSync(path.join(old, "openclaw.mjs"), "#!/usr/bin/env bash\necho 'OpenClaw 2026.7.1 (old)'\n");
    chmodSync(path.join(old, "openclaw.mjs"), 0o755);
    writeFileSync(path.join(old, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.7.1" }));
    symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", path.join(prefix, "bin", "openclaw"));
  }
  return { dir, prefix, calls: () => readFileSync(path.join(dir, "calls"), "utf-8").split("\n").filter(Boolean) };
}

/** What npm leaves in a staging prefix: the new tree and a relative launcher link. */
function stageCore(prefix: string, version: string, opts: { emptyLauncher?: boolean } = {}): string {
  const stage = path.join(prefix, ".openclaw-stage");
  const pkg = path.join(stage, "lib", "node_modules", "openclaw");
  mkdirSync(pkg, { recursive: true });
  mkdirSync(path.join(stage, "bin"), { recursive: true });
  writeFileSync(path.join(pkg, "openclaw.mjs"), opts.emptyLauncher ? "" : `#!/usr/bin/env bash\necho 'OpenClaw ${version} (new)'\n`);
  chmodSync(path.join(pkg, "openclaw.mjs"), 0o755);
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "openclaw", version, engines: { node: ">=24" } }));
  symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", path.join(stage, "bin", "openclaw"));
  return stage;
}

function bash(p: Prefix, program: string) {
  const calls = JSON.stringify(path.join(p.dir, "calls"));
  return spawnSync("bash", ["-c", [
    "set -uo pipefail",
    `NPM_PREFIX=${JSON.stringify(p.prefix)}`,
    `CLAWBOX_USER=${JSON.stringify(process.env.USER ?? "clawbox")}`,
    "chown() { :; }",
    `flush_core_to_disk() { printf 'flush %s\\n' "$1" >> ${calls}; }`,
    shellFunction("promote_staged_openclaw_core"),
    program,
  ].join("\n")], { encoding: "utf-8", timeout: 20_000 });
}

describe("promote_staged_openclaw_core", () => {
  it("flushes the stage BEFORE the swap, renames it into place, and drops the old tree after", () => {
    const p = makePrefix({});
    try {
      const stage = stageCore(p.prefix, "2026.9.3");
      const r = bash(p, `promote_staged_openclaw_core ${JSON.stringify(stage)}`);
      expect(r.status, r.stderr).toBe(0);
      const live = path.join(p.prefix, "lib", "node_modules", "openclaw");
      expect(JSON.parse(readFileSync(path.join(live, "package.json"), "utf-8")).version).toBe("2026.9.3");
      // The launcher is npm's relative link, and it resolves from the live bin.
      const launcher = path.join(p.prefix, "bin", "openclaw");
      expect(lstatSync(launcher).isSymbolicLink()).toBe(true);
      expect(readlinkSync(launcher)).toBe("../lib/node_modules/openclaw/openclaw.mjs");
      expect(spawnSync("bash", [launcher], { encoding: "utf-8" }).stdout).toContain("OpenClaw 2026.9.3 (new)");
      // Nothing of the old core or the stage is left behind.
      expect(existsSync(path.join(p.prefix, "lib", "node_modules", ".openclaw-previous"))).toBe(false);
      expect(existsSync(stage)).toBe(false);
      // The flush is the point: the stage before anything moved, the prefix after.
      expect(p.calls()).toEqual([`flush ${stage}`, `flush ${p.prefix}`]);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("works on a box with no core yet", () => {
    const p = makePrefix({ oldCore: false });
    try {
      const stage = stageCore(p.prefix, "2026.9.3");
      const r = bash(p, `promote_staged_openclaw_core ${JSON.stringify(stage)}`);
      expect(r.status, r.stderr).toBe(0);
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.9.3");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("puts the old core back when the staged tree cannot be moved in", () => {
    const p = makePrefix({});
    try {
      const stage = stageCore(p.prefix, "2026.9.3");
      // A stage whose package tree has vanished under it: the second rename fails.
      const r = bash(p, `rm -rf ${JSON.stringify(path.join(stage, "lib", "node_modules", "openclaw"))}; promote_staged_openclaw_core ${JSON.stringify(stage)}`);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/putting the previous one back/);
      const live = path.join(p.prefix, "lib", "node_modules", "openclaw");
      expect(JSON.parse(readFileSync(path.join(live, "package.json"), "utf-8")).version).toBe("2026.7.1");
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.7.1");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("refuses to go on when the stage cannot be flushed, leaving the live core untouched", () => {
    const p = makePrefix({});
    try {
      const stage = stageCore(p.prefix, "2026.9.3");
      const r = bash(p, `flush_core_to_disk() { return 1; }; promote_staged_openclaw_core ${JSON.stringify(stage)}`);
      expect(r.status).not.toBe(0);
      const live = path.join(p.prefix, "lib", "node_modules", "openclaw");
      expect(JSON.parse(readFileSync(path.join(live, "package.json"), "utf-8")).version).toBe("2026.7.1");
      expect(existsSync(stage)).toBe(true);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });
});

describe("step_openclaw_install stages the core", () => {
  /** The step, driven with a stub npm that lays npm's layout down at the prefix it is handed. */
  function runStep(p: Prefix, opts: { npm: "ok" | "empty-launcher" | "wrong-version" | "nothing" }) {
    const calls = JSON.stringify(path.join(p.dir, "calls"));
    const bin = path.join(p.dir, "bin");
    mkdirSync(bin, { recursive: true });
    const npm = path.join(bin, "npm");
    writeFileSync(npm, `#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> ${calls}
prefix=""; prev=""; want=""
for a in "$@"; do
  case "$prev" in --prefix) prefix="$a" ;; esac
  case "$a" in openclaw@*) want="\${a#openclaw@}" ;; esac
  prev="$a"
done
case ${JSON.stringify(opts.npm)} in
  nothing) exit 0 ;;
  wrong-version) want="2026.1.1" ;;
esac
mkdir -p "$prefix/bin" "$prefix/lib/node_modules/openclaw"
if [ ${JSON.stringify(opts.npm)} = empty-launcher ]; then
  : > "$prefix/lib/node_modules/openclaw/openclaw.mjs"
else
  printf '#!/usr/bin/env bash\\necho "OpenClaw %s (new)"\\n' "$want" > "$prefix/lib/node_modules/openclaw/openclaw.mjs"
fi
chmod 755 "$prefix/lib/node_modules/openclaw/openclaw.mjs"
printf '{"name":"openclaw","version":"%s"}' "$want" > "$prefix/lib/node_modules/openclaw/package.json"
ln -s ../lib/node_modules/openclaw/openclaw.mjs "$prefix/bin/openclaw"
exit 0
`);
    chmodSync(npm, 0o755);
    // A pin file the step reads its target from.
    const src = path.join(p.dir, "src");
    mkdirSync(path.join(src, "config"), { recursive: true });
    writeFileSync(path.join(src, "config", "openclaw-target.txt"), "2026.9.3\n");
    const program = [
      "set -uo pipefail",
      `NPM_PREFIX=${JSON.stringify(p.prefix)}`,
      `OPENCLAW_BIN=${JSON.stringify(path.join(p.prefix, "bin", "openclaw"))}`,
      `SRC_DIR=${JSON.stringify(src)}`,
      `CLAWBOX_HOME=${JSON.stringify(p.dir)}`,
      `CLAWBOX_USER=${JSON.stringify(process.env.USER ?? "clawbox")}`,
      assignment("OPENCLAW_VERSION"),
      assignment("OPENCLAW_NODE_ENGINE"),
      assignment("OPENCLAW_SERVICE_REPAIR_POLICY"),
      "is_hermes_edition() { return 1; }",
      "ensure_clawbox_bashrc_path() { :; }",
      "ensure_openclaw_node_engine() { :; }",
      "node_engine_remedy() { :; }",
      "chown() { :; }",
      `flush_core_to_disk() { printf 'flush %s\\n' "$1" >> ${calls}; }`,
      `stop_openclaw_gateways_for_migration() { printf 'stop-gateways\\n' >> ${calls}; }`,
      // Everything after the install is the migration and the plugin refresh,
      // which this suite is not about: the step is cut off after the install.
      "openclaw_version_is_v2() { return 1; }",
      'as_clawbox() { while [ "${1:-}" = "-H" ]; do shift; done; "$@"; }',
      shellFunction("promote_staged_openclaw_core"),
      shellFunction("step_openclaw_install").replace(/\n  # Force-reinstall every externally-installed plugin[\s\S]*$/, "\n}"),
      "step_openclaw_install",
    ].join("\n");
    return spawnSync("bash", ["-c", program], {
      encoding: "utf-8",
      timeout: 20_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
  }

  it("installs into the stage, never the live prefix, and promotes only a launcher that answers", () => {
    const p = makePrefix({});
    try {
      const r = runStep(p, { npm: "ok" });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      const npmCall = p.calls().find((c) => c.startsWith("npm "));
      expect(npmCall).toContain(`--prefix ${path.join(p.prefix, ".openclaw-stage")}`);
      expect(npmCall).not.toContain(`--prefix ${p.prefix}\n`);
      expect(r.stdout).toContain("OpenClaw installed: OpenClaw 2026.9.3 (new)");
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.9.3");
      expect(existsSync(path.join(p.prefix, ".openclaw-stage"))).toBe(false);
      expect(p.calls().filter((c) => c.startsWith("flush ")).length).toBe(2);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("keeps the live core when the staged launcher answers nothing — the zero-length file the field boxes were left with", () => {
    const p = makePrefix({});
    try {
      const r = runStep(p, { npm: "empty-launcher" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/answers '<nothing>' to --version, not 2026\.9\.3/);
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.7.1");
      expect(p.calls().some((c) => c.startsWith("flush "))).toBe(false);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("keeps the live core when npm delivered a different version than the pin", () => {
    const p = makePrefix({});
    try {
      const r = runStep(p, { npm: "wrong-version" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/not 2026\.9\.3 — leaving the core on the box as it is/);
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.7.1");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("keeps the live core when npm left no launcher at all", () => {
    const p = makePrefix({});
    try {
      const r = runStep(p, { npm: "nothing" });
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/npm left no openclaw launcher/);
      expect(spawnSync("bash", [path.join(p.prefix, "bin", "openclaw")], { encoding: "utf-8" }).stdout).toContain("2026.7.1");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });
});
