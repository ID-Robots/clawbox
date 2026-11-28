import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * `openclaw_is_v2` in the Jetson installer: which generation the installed
 * OpenClaw core is.
 *
 * Root runs nothing from the tree, so the answer comes from the installed
 * package's own package.json, read as data, never by running
 * `bin/openclaw --version`: the same file the gateway's pre-start and the web
 * server already read for the same question. The launcher only decides whether
 * the installed core is consulted at all; without it, or when the manifest says
 * nothing usable, the pin file and then OPENCLAW_VERSION answer, as before.
 *
 * This suite lifts the shipped functions and drives them over a prefix built on
 * disk, with a launcher that logs every run of itself.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const source = readFileSync("install.sh", "utf8");

function shellFunction(name: string): string {
  const start = source.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`Missing ${name}`);
  return source.slice(start + 1, source.indexOf("\n}", start) + 2);
}

const LIFTED = [shellFunction("openclaw_version_is_v2"), shellFunction("openclaw_is_v2")].join("\n");

const which = spawnSync("bash", ["-c", "command -v python3"], { encoding: "utf8" });
const REAL_PYTHON3 = which.status === 0 ? which.stdout.trim() : "";
const hasPython3 = REAL_PYTHON3 !== "";

/** What the launcher prints: the pin's banner, so an executed launcher always reads as v2. */
const BANNER = "OpenClaw 2026.10.9 (0000000)";

interface Box {
  dir: string;
  prefix: string;
  srcDir: string;
  /** Every run of the launcher, one argv per line. */
  launcherRuns(): string;
  /** The installed package's manifest: an object is written as JSON, a string as is, null removes it. */
  manifest(content: Record<string, unknown> | string | null): void;
  /** The pin file's first line, or null for no pin file. */
  pin(version: string | null): void;
  /** Remove the launcher (a first install, a Hermes-edition box). */
  dropLauncher(): void;
  /** Put an executable `python3` first on PATH. */
  python3Shim(body: string): void;
  shimDir: string;
}

const boxes: string[] = [];
afterEach(() => {
  for (const dir of boxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeBox(): Box {
  const dir = mkdtempSync(path.join(tmpdir(), "clawbox-oc-generation-"));
  boxes.push(dir);
  const prefix = path.join(dir, "npm-global");
  const srcDir = path.join(dir, "checkout");
  const shimDir = path.join(dir, "shim");
  const log = path.join(dir, "launcher.log");
  const manifestPath = path.join(prefix, "lib/node_modules/openclaw/package.json");
  const pinPath = path.join(srcDir, "config/openclaw-target.txt");
  const launcher = path.join(prefix, "bin/openclaw");
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  mkdirSync(path.dirname(launcher), { recursive: true });
  mkdirSync(path.dirname(pinPath), { recursive: true });
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(log, "");
  writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\necho '${BANNER}'\n`);
  chmodSync(launcher, 0o755);
  writeFileSync(pinPath, "2026.10.9\n");
  return {
    dir,
    prefix,
    srcDir,
    shimDir,
    launcherRuns: () => readFileSync(log, "utf8"),
    manifest(content) {
      if (content === null) rmSync(manifestPath, { force: true });
      else writeFileSync(manifestPath, typeof content === "string" ? content : JSON.stringify(content));
    },
    pin(version) {
      if (version === null) rmSync(pinPath, { force: true });
      else writeFileSync(pinPath, `${version}\n`);
    },
    dropLauncher: () => rmSync(launcher, { force: true }),
    python3Shim(body) {
      const shim = path.join(shimDir, "python3");
      writeFileSync(shim, `#!/bin/sh\n${body}\n`);
      chmodSync(shim, 0o755);
    },
  };
}

interface Run {
  stdout: string;
  stderr: string;
  status: number | null;
}

/** Run `body` after the lifted functions, under the installer's own shell options. */
function run(box: Box, body: string, opts: { openclawVersion?: string; stdin?: string } = {}): Run {
  const script = [
    "set -euo pipefail",
    `NPM_PREFIX=${JSON.stringify(box.prefix)}`,
    `SRC_DIR=${JSON.stringify(box.srcDir)}`,
    `OPENCLAW_VERSION=${JSON.stringify(opts.openclawVersion ?? "")}`,
    LIFTED,
    body,
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    input: opts.stdin ?? "",
    env: { ...process.env, PATH: `${box.shimDir}:${process.env.PATH ?? ""}` },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function generation(box: Box, opts: { openclawVersion?: string } = {}): string {
  const r = run(box, "if openclaw_is_v2; then echo v2; else echo v1; fi", opts);
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

describe.skipIf(!hasPython3)("openclaw_is_v2 reads the installed core's manifest", () => {
  it("answers from package.json, not from the launcher's banner, and never runs the launcher", () => {
    const box = makeBox();
    box.manifest({ name: "openclaw", version: "2026.6.8" });
    expect(generation(box)).toBe("v1");
    expect(box.launcherRuns()).toBe("");
  });

  it("answers v2 for the pinned core", () => {
    const box = makeBox();
    box.manifest({ name: "openclaw", version: "2026.10.9" });
    expect(generation(box)).toBe("v2");
    expect(box.launcherRuns()).toBe("");
  });

  it.each(["2026.8.1-dev.3", "2026.11.1-beta.2"])("keeps a prerelease core (%s) in its generation", (version) => {
    const box = makeBox();
    box.pin("2026.7.1");
    box.manifest({ name: "openclaw", version });
    expect(generation(box)).toBe("v2");
    expect(box.launcherRuns()).toBe("");
  });

  it("answers v1 for a pre-OpenClaw-2 core", () => {
    const box = makeBox();
    box.manifest({ name: "openclaw", version: "2026.7.20" });
    expect(generation(box)).toBe("v1");
    expect(box.launcherRuns()).toBe("");
  });

  it("without a launcher, ignores the manifest and answers from the pin file", () => {
    const box = makeBox();
    box.dropLauncher();
    box.manifest({ name: "openclaw", version: "2026.6.8" });
    expect(generation(box)).toBe("v2");
    box.pin("2026.7.1");
    box.manifest({ name: "openclaw", version: "2026.10.9" });
    expect(generation(box)).toBe("v1");
  });

  it("without a launcher or a pin file, answers from OPENCLAW_VERSION", () => {
    const box = makeBox();
    box.dropLauncher();
    box.pin(null);
    expect(generation(box, { openclawVersion: "2026.10.9" })).toBe("v2");
    expect(generation(box, { openclawVersion: "2026.7.1" })).toBe("v1");
  });

  // The pin file says v1 here and the launcher's banner says v2, so a case that
  // still ran the launcher would answer v2.
  it.each<[string, Record<string, unknown> | string | null]>([
    ["missing", null],
    ["not JSON", "{ this is not json"],
    ["a JSON list", "[1, 2]"],
    ["a version that is not a string", { name: "openclaw", version: 5 }],
    ["a version that is not a date", { name: "openclaw", version: "nightly" }],
    ["a version that does not start with a date", { name: "openclaw", version: "v2026.10.9" }],
  ])("with the manifest %s, falls back to the pin file", (_label, content) => {
    const box = makeBox();
    box.pin("2026.7.1");
    box.manifest(content);
    expect(generation(box)).toBe("v1");
    expect(box.launcherRuns()).toBe("");
  });

  it("with the manifest unusable and no pin file, falls back to OPENCLAW_VERSION", () => {
    const box = makeBox();
    box.pin(null);
    box.manifest({ name: "openclaw", version: 5 });
    expect(generation(box, { openclawVersion: "2026.7.1" })).toBe("v1");
    expect(box.launcherRuns()).toBe("");
  });

  // The answer is the exit status, so a bare call under `set -euo pipefail`
  // ends its caller exactly when the answer is "before OpenClaw 2": callers
  // use it as a condition. The manifest read itself never ends the caller or
  // prints, whatever state the file is in, so the same unusable manifest gives
  // "after" under a v2 pin and a quiet status 1 under an older one.
  const BARE: [string, string, Run][] = [
    ["a v2 pin", "2026.10.9", { stdout: "after\n", stderr: "", status: 0 }],
    ["a pre-v2 pin", "2026.7.1", { stdout: "", stderr: "", status: 1 }],
  ];
  const UNUSABLE: [string, Record<string, unknown> | string | null][] = [
    ["missing", null],
    ["not JSON", "{ this is not json"],
    ["a version that is not a string", { version: 5 }],
  ];
  const bareCases = UNUSABLE.flatMap(([label, content]) =>
    BARE.map(([pinLabel, pin, want]) => [label, pinLabel, content, pin, want] as const),
  );
  it.each(bareCases)(
    "called bare under set -euo pipefail with the manifest %s and %s, ends the caller only on a pre-v2 answer",
    (_label, _pinLabel, content, pin, want) => {
      const box = makeBox();
      box.pin(pin);
      box.manifest(content);
      expect(run(box, "openclaw_is_v2\necho after")).toEqual(want);
      expect(box.launcherRuns()).toBe("");
    },
  );

  it.each(BARE)(
    "called bare under set -euo pipefail with a python3 that fails and %s, ends the caller only on a pre-v2 answer",
    (_label, pin, want) => {
      const box = makeBox();
      box.pin(pin);
      box.manifest({ name: "openclaw", version: "2026.10.9" });
      box.python3Shim("echo 'python3: broken' >&2\nexit 1");
      expect(run(box, "openclaw_is_v2\necho after")).toEqual(want);
      expect(box.launcherRuns()).toBe("");
    },
  );

  it("called bare under set -euo pipefail on a pre-v2 core, returns 1 and ends the caller", () => {
    const box = makeBox();
    box.manifest({ name: "openclaw", version: "2026.7.1" });
    expect(run(box, "openclaw_is_v2\necho after")).toEqual({ stdout: "", stderr: "", status: 1 });
    expect(box.launcherRuns()).toBe("");
  });

  it("with a python3 that fails, falls back quietly", () => {
    const box = makeBox();
    box.pin("2026.7.1");
    box.manifest({ name: "openclaw", version: "2026.10.9" });
    box.python3Shim("echo 'python3: broken' >&2\nexit 1");
    expect(generation(box)).toBe("v1");
    expect(box.launcherRuns()).toBe("");
  });

  it("runs python3 isolated, with the manifest path as an argument", () => {
    const box = makeBox();
    const argvLog = path.join(box.dir, "python3.argv");
    box.python3Shim(`printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}\nexec ${JSON.stringify(REAL_PYTHON3)} "$@"`);
    box.manifest({ name: "openclaw", version: "2026.10.9" });
    expect(generation(box)).toBe("v2");
    const argv = readFileSync(argvLog, "utf8").split("\n").filter(Boolean);
    expect(argv[0]).toBe("-I");
    expect(argv).toContain(path.join(box.prefix, "lib/node_modules/openclaw/package.json"));
  });

  // The plugin refresh in step_openclaw_install asks this once per plugin from
  // inside `while read … done <<< "$INSTALLED_PLUGINS"`: the read must not eat
  // the loop's input.
  it("leaves the stdin of a surrounding while-read loop alone", () => {
    const box = makeBox();
    box.manifest({ name: "openclaw", version: "2026.10.9" });
    const r = run(
      box,
      [
        "while IFS= read -r line; do",
        "  if openclaw_is_v2; then echo \"$line:v2\"; else echo \"$line:v1\"; fi",
        "done <<< $'first\\nsecond'",
      ].join("\n"),
    );
    expect(r).toEqual({ stdout: "first:v2\nsecond:v2\n", stderr: "", status: 0 });
    expect(box.launcherRuns()).toBe("");
  });
});
