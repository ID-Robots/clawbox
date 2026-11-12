import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs bash: vitest's 5 s default is not enough on a loaded CI runner
// (src/tests/unit/test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * install.sh writes the checkout's .env and data/network.env as the service
 * account, which owns them, and never as root: a root write in a directory the
 * account controls follows whatever link the account put there. Each writer is
 * sliced out of install.sh and run as the installer runs it (`set -euo
 * pipefail`), with these stand-ins:
 *  - the checkout, data/, .env and data/network.env are made read-only to
 *    their owner outside `as_clawbox`, so a write root's shell makes itself
 *    (`printf >>`, which no command shim can see) fails with EACCES;
 *  - `as_clawbox` makes them writable for the command it wraps, logs that
 *    command's argv and takes the write permission away again;
 *  - recording shims for the commands that write files log each run as root
 *    or as the account. Their `chown` only records, so the test needs neither
 *    root nor a group named after the user.
 * The bytes, modes and messages are pinned to what root's writes produced.
 */

const INSTALL = fs.readFileSync(path.join(process.cwd(), "install.sh"), "utf-8");

/** A top-level function of install.sh; "" for an `optional` one it lacks. */
function installFunction(name: string, optional = false): string {
  const at = INSTALL.indexOf(`\n${name}() {\n`);
  if (at < 0) {
    if (optional) return "";
    throw new Error(`${name}() not found in install.sh`);
  }
  return INSTALL.slice(at + 1, INSTALL.indexOf("\n}\n", at + 1) + 3);
}

/** The writers under test, and what they read with. */
const WRITERS = [
  "get_env_setting_or_default",
  "ensure_env_setting",
  "migrate_env_setting",
  "step_directories_permissions",
  "step_network_setup",
];
/**
 * The writers' own helpers. Optional so the test runs against an install.sh
 * from before they existed; a writer calling one this list misses fails with
 * "command not found" under errexit.
 */
const HELPERS = ["append_as_clawbox", "hand_over_checkout"];

/** Commands that can write a file, each logged with who ran it. */
const RECORDED = ["mkdir", "cp", "mv", "mktemp", "chmod", "cat", "touch", "find", "rm", "ln", "install", "tee", "sed", "chown"];

const AI_KEY_MARKER = "clawbox-ai-argv-marker-not-a-key";
const ROOT_USER = process.getuid?.() === 0;

let dir: string;
let project: string;
let bin: string;
let etc: string;

const envFile = () => path.join(project, ".env");
const networkEnv = () => path.join(project, "data", "network.env");

function put(rel: string, text: string, mode = 0o644): void {
  // A run leaves the checkout read-only, as the writers saw it.
  spawnSync("chmod", ["-R", "u+w", project]);
  const file = path.join(project, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, mode);
}

function realPath(cmd: string): string {
  const r = spawnSync("bash", ["-c", `command -v ${cmd}`], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`${cmd} is not on PATH`);
  return r.stdout.trim();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-env-files-owner-"));
  project = path.join(dir, "project");
  bin = path.join(dir, "bin");
  etc = path.join(dir, "etc-clawbox");
  fs.mkdirSync(project);
  fs.mkdirSync(bin);
  for (const cmd of RECORDED) {
    const body = [
      "#!/bin/bash",
      "who=root",
      '[ -z "${AS_SERVICE_USER:-}" ] || who=service',
      `{ printf '%s\\0' "$who" ${cmd} "$@"; printf '\\036'; } >> "$EVENTS"`,
      cmd === "chown" ? "exit 0" : `exec ${realPath(cmd)} "$@"`,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(bin, cmd), body, { mode: 0o755 });
  }
});

afterEach(() => {
  spawnSync("chmod", ["-R", "u+rwx", dir]);
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Event {
  /** root, service (a shim run inside as_clawbox) or wrapper (as_clawbox itself). */
  who: string;
  argv: string[];
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  events: Event[];
  /** The last mode as_clawbox saw for each of .env and data/network.env. */
  modes: Map<string, string>;
}

/**
 * `lockedCwd` starts the writer from a directory the account cannot enter, as
 * a step run by hand from /root does: the suite's user plays the account, so
 * the directory is its own with every bit off.
 */
function run(call: string, opts: { user?: string; env?: Record<string, string>; lockedCwd?: boolean } = {}): Run {
  const eventsLog = path.join(dir, "events");
  const modesLog = path.join(dir, "modes");
  fs.rmSync(eventsLog, { force: true });
  fs.rmSync(modesLog, { force: true });
  const user = opts.user ?? os.userInfo().username;
  const script = [
    "set -euo pipefail",
    "umask 022",
    'IFACE_ENV="$PROJECT_DIR/data/network.env"',
    // u+w or u-w on what the account writes; a link is left as it is.
    "writable() {",
    "  local p",
    '  for p in "$PROJECT_DIR" "$PROJECT_DIR/data" "$PROJECT_DIR/.env" "$IFACE_ENV"; do',
    '    if [ -e "$p" ] && [ ! -L "$p" ]; then "$REAL_CHMOD" "$1" "$p"; fi',
    "  done",
    "}",
    "as_clawbox() {",
    `  { printf '%s\\0' wrapper "$@"; printf '\\036'; } >> "$EVENTS"`,
    "  writable u+w",
    "  local rc=0 p",
    '  AS_SERVICE_USER=1 "$@" || rc=$?',
    '  for p in "$PROJECT_DIR/.env" "$IFACE_ENV"; do',
    `    if [ -f "$p" ]; then printf '%s %s\\n' "$p" "$(stat -c %a "$p")" >> "$MODES"; fi`,
    "  done",
    "  writable u-w",
    '  return "$rc"',
    "}",
    'is_test_mode() { [ "${CLAWBOX_TEST_MODE:-}" = "1" ]; }',
    "read_configured_hostname() { echo clawbox; }",
    "apply_hostname() { :; }",
    ...HELPERS.map((name) => installFunction(name, true)),
    ...WRITERS.map((name) => installFunction(name).replaceAll("/etc/clawbox", etc)),
    "writable u-w",
    ...(opts.lockedCwd ? ['mkdir "$HOME/locked-cwd"', 'cd "$HOME/locked-cwd"', '"$REAL_CHMOD" 000 .'] : []),
    call,
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      LC_ALL: "C",
      PROJECT_DIR: project,
      CLAWBOX_USER: user,
      EVENTS: eventsLog,
      MODES: modesLog,
      REAL_CHMOD: realPath("chmod"),
      ...opts.env,
    },
  });
  const events = fs.existsSync(eventsLog)
    ? fs
        .readFileSync(eventsLog, "utf-8")
        .split("\x1e")
        .filter(Boolean)
        .map((record) => {
          const parts = record.split("\0");
          parts.pop();
          return { who: parts[0], argv: parts.slice(1) };
        })
    : [];
  const modes = new Map<string, string>();
  if (fs.existsSync(modesLog)) {
    for (const line of fs.readFileSync(modesLog, "utf-8").split("\n").filter(Boolean)) {
      const at = line.lastIndexOf(" ");
      modes.set(line.slice(0, at), line.slice(at + 1));
    }
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, events, modes };
}

/** Root runs that write in the checkout. A `find` that only lists is a read. */
function rootWrites(r: Run): string[] {
  const writes = /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;
  return r.events
    .filter((e) => e.who === "root")
    .filter((e) => !(e.argv[0] === "find" && !e.argv.some((a) => writes.test(a))))
    .filter((e) => e.argv.some((a) => a.startsWith(project)))
    .map((e) => e.argv.join(" "));
}

/** What as_clawbox was handed, one string per call. */
const wrapped = (r: Run): string[] => r.events.filter((e) => e.who === "wrapper").map((e) => e.argv.join("\0"));
const everyArgv = (r: Run): string => r.events.map((e) => e.argv.join("\0")).join("\n");
const read = (file: string): string => fs.readFileSync(file, "utf-8");

/** The public Gemini CLI OAuth pair step_directories_permissions seeds, as it assembles it. */
function oauthPair(): { cid: string; sec: string } {
  const lines = installFunction("step_directories_permissions")
    .split("\n")
    .filter((l) => /\bG_(?:CID|SEC)=/.test(l));
  const r = spawnSync("bash", ["-c", `f() {\n${lines.join("\n")}\nprintf '%s\\n%s\\n' "$G_CID" "$G_SEC"\n}\nf`], {
    encoding: "utf-8",
  });
  const [cid, sec] = r.stdout.split("\n");
  expect(cid).toMatch(/\.apps\.googleusercontent\.com$/);
  expect(sec.length).toBeGreaterThan(8);
  return { cid, sec };
}

/**
 * What root's writers left in .env for the same input: the three appends as
 * written, then each two-space-indented ensure/migrate line of the step in
 * order, modelled on the helpers below, which the helper tests pin byte for
 * byte. Test mode is off, so the indented CLAWBOX_TEST_MODE line is not run.
 */
function seeded(start: string, created: boolean, aiKey?: string): { text: string; stdout: string } {
  const env = envFile();
  const { cid, sec } = oauthPair();
  const has = (t: string, k: string) => t.split("\n").some((l) => l.startsWith(`${k}=`));
  const messages: string[] = created ? [`  Created ${env} from .env.example`] : [];
  let t = start;
  if (!has(t, "GOOGLE_OAUTH_CLIENT_ID")) {
    t += `\nGOOGLE_OAUTH_CLIENT_ID=${cid}\n`;
    messages.push(`  Added GOOGLE_OAUTH_CLIENT_ID to ${env}`);
  }
  if (!has(t, "GOOGLE_OAUTH_CLIENT_SECRET")) {
    t += `GOOGLE_OAUTH_CLIENT_SECRET=${sec}\n`;
    messages.push(`  Added GOOGLE_OAUTH_CLIENT_SECRET to ${env}`);
  }
  if (aiKey && !has(t, "CLAWBOX_AI_API_KEY")) {
    t += `CLAWBOX_AI_API_KEY=${aiKey}\n`;
    messages.push(`  Added CLAWBOX_AI_API_KEY to ${env}`);
  }
  const calls = installFunction("step_directories_permissions")
    .split("\n")
    .filter((l) => /^ {2}(?:ensure|migrate)_env_setting "\$ENV_FILE" /.test(l));
  expect(calls.length).toBeGreaterThan(10);
  for (const line of calls) {
    const [k, a, b] = [...line.slice(line.indexOf('"$ENV_FILE"') + 11).matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (line.startsWith("  ensure_env_setting")) {
      if (has(t, k)) continue;
      if (t.length > 0 && !t.endsWith("\n")) t += "\n";
      t += `${k}=${a}\n`;
      messages.push(`  Added ${k} to ${env}`);
    } else {
      const current = t.split("\n").filter((l) => l.startsWith(`${k}=`)).pop()?.slice(k.length + 1) ?? "";
      if (current !== a) continue;
      const rows = t.split("\n");
      if (t.endsWith("\n")) rows.pop();
      t = `${rows.map((l) => (l.startsWith(`${k}=`) ? `${k}=${b}` : l)).join("\n")}\n`;
      messages.push(`  Migrated ${k} from ${a} to ${b}`);
    }
  }
  messages.push("  Done");
  return { text: t, stdout: `${messages.join("\n")}\n` };
}

const EXAMPLE = "# ClawBox\nPORT=80\nLLAMACPP_CONTEXT_WINDOW=131072\n";

// Root ignores the read-only bits the RED rests on; CI runs vitest unprivileged.
describe.skipIf(ROOT_USER)("install.sh writes .env and data/network.env as the service account", () => {
  it("ensure_env_setting appends a missing key as the account, the line on stdin, byte for byte as before", () => {
    put(".env", "PORT=80\n", 0o600);
    const r = run(`ensure_env_setting "${envFile()}" LLAMACPP_LOAD_MODE mmap`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(read(envFile())).toBe("PORT=80\nLLAMACPP_LOAD_MODE=mmap\n");
    expect(r.stdout).toBe(`  Added LLAMACPP_LOAD_MODE to ${envFile()}\n`);
    expect(r.modes.get(envFile())).toBe("600");
    expect(rootWrites(r)).toEqual([]);
    expect(wrapped(r).some((call) => call.split("\0").includes(envFile()))).toBe(true);
    expect(everyArgv(r)).not.toContain("LLAMACPP_LOAD_MODE=mmap");

    // A key already there is left alone: nothing is written, nothing said.
    const again = run(`ensure_env_setting "${envFile()}" LLAMACPP_LOAD_MODE other`);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toBe("");
    expect(wrapped(again)).toEqual([]);
    expect(read(envFile())).toBe("PORT=80\nLLAMACPP_LOAD_MODE=mmap\n");
  });

  it("ensure_env_setting repairs a missing final newline before it appends, as the account", () => {
    put(".env", "PORT=80", 0o600);
    const r = run(`ensure_env_setting "${envFile()}" LLAMACPP_LOAD_MODE mmap`);
    expect(r.status, r.stderr).toBe(0);
    expect(read(envFile())).toBe("PORT=80\nLLAMACPP_LOAD_MODE=mmap\n");
    expect(r.stdout).toBe(`  Added LLAMACPP_LOAD_MODE to ${envFile()}\n`);
    expect(rootWrites(r)).toEqual([]);

    put(".env", "", 0o600);
    const empty = run(`ensure_env_setting "${envFile()}" LLAMACPP_LOAD_MODE mmap`);
    expect(empty.status, empty.stderr).toBe(0);
    expect(read(envFile())).toBe("LLAMACPP_LOAD_MODE=mmap\n");
    expect(empty.modes.get(envFile())).toBe("600");
  });

  it("migrate_env_setting rewrites .env as the account: a temp beside it, its mode carried, the values on stdin", () => {
    put(".env", "A=1\nLLAMACPP_HF_REPO=old/repo\nB=two words\\n", 0o640);
    const r = run(`migrate_env_setting "${envFile()}" LLAMACPP_HF_REPO old/repo new/repo-marker`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(read(envFile())).toBe("A=1\nLLAMACPP_HF_REPO=new/repo-marker\nB=two words\\n\n");
    expect(r.stdout).toBe("  Migrated LLAMACPP_HF_REPO from old/repo to new/repo-marker\n");
    expect(r.modes.get(envFile())).toBe("640");
    expect(fs.readdirSync(project)).toEqual([".env"]);
    expect(rootWrites(r)).toEqual([]);
    expect(wrapped(r).some((call) => call.split("\0").includes(envFile()))).toBe(true);
    expect(everyArgv(r)).not.toContain("new/repo-marker");

    // A value the operator chose is not the old default: nothing moves.
    const kept = run(`migrate_env_setting "${envFile()}" LLAMACPP_HF_REPO old/repo other/repo`);
    expect(kept.status, kept.stderr).toBe(0);
    expect(kept.stdout).toBe("");
    expect(wrapped(kept)).toEqual([]);
  });

  it("step_directories_permissions makes data/ and .env and seeds it as the account, the two secrets on stdin", () => {
    put(".env.example", EXAMPLE);
    put("scripts/a.sh", "true\n");
    put("scripts/sub/b.sh", "true\n");
    const r = run("step_directories_permissions", { env: { CLAWBOX_AI_API_KEY: AI_KEY_MARKER } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    const want = seeded(EXAMPLE, true, AI_KEY_MARKER);
    expect(read(envFile())).toBe(want.text);
    expect(r.stdout).toBe(want.stdout);
    expect(r.modes.get(envFile())).toBe("600");
    expect(fs.statSync(path.join(project, "data")).isDirectory()).toBe(true);
    for (const script of ["scripts/a.sh", "scripts/sub/b.sh"]) {
      expect(fs.statSync(path.join(project, script)).mode & 0o111, script).toBe(0o111);
    }
    expect(rootWrites(r)).toEqual([]);
    for (const target of [path.join(project, "data"), path.join(project, "scripts"), envFile()]) {
      expect(wrapped(r).some((call) => call.split("\0").includes(target)), target).toBe(true);
    }
    const { sec } = oauthPair();
    expect(everyArgv(r)).not.toContain(sec);
    expect(everyArgv(r)).not.toContain(AI_KEY_MARKER);
  });

  it("step_directories_permissions seeds an existing .env that lacks a final newline exactly as before", () => {
    const start = "PORT=80\nLLAMACPP_MAX_TOKENS=131072\nLLAMACPP_REASONING=on";
    put(".env.example", EXAMPLE);
    put("scripts/a.sh", "true\n", 0o755);
    put(".env", start, 0o600);
    fs.mkdirSync(path.join(project, "data"));
    const r = run("step_directories_permissions");
    expect(r.status, r.stderr).toBe(0);
    const want = seeded(start, false);
    expect(read(envFile())).toBe(want.text);
    expect(r.stdout).toBe(want.stdout);
    expect(r.modes.get(envFile())).toBe("600");
    expect(rootWrites(r)).toEqual([]);
    expect(everyArgv(r)).not.toContain(oauthPair().sec);
  });

  // GNU find returns to its starting directory before it exits, and fails
  // when the account cannot enter that directory.
  it("step_directories_permissions finishes when started from a directory the account cannot enter", () => {
    put(".env.example", EXAMPLE);
    put("scripts/a.sh", "true\n");
    const r = run("step_directories_permissions", { lockedCwd: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(fs.statSync(path.join(project, "scripts", "a.sh")).mode & 0o111).toBe(0o111);
    expect(read(envFile())).toBe(seeded(EXAMPLE, true).text);
  });

  it("step_network_setup writes data/network.env as the account, 0644 when fresh, and root's own copy as root", () => {
    const env = { CLAWBOX_TEST_MODE: "1", NETWORK_INTERFACE: "wlan0" };
    const r = run("step_network_setup", { env });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(read(networkEnv())).toBe("NETWORK_INTERFACE=wlan0\n");
    expect(r.modes.get(networkEnv())).toBe("644");
    expect(r.stdout).toBe(
      `  WiFi interface: wlan0\n  WiFi interface saved to ${networkEnv()} and ${etc}/network.env\n`,
    );
    expect(read(path.join(etc, "network.env"))).toBe("NETWORK_INTERFACE=wlan0\nCLAWBOX_TEST_MODE=1\n");
    expect((fs.statSync(path.join(etc, "network.env")).mode & 0o777).toString(8)).toBe("644");
    expect(rootWrites(r)).toEqual([]);
    for (const target of [path.join(project, "data"), networkEnv()]) {
      expect(wrapped(r).some((call) => call.split("\0").includes(target)), target).toBe(true);
    }
    expect(everyArgv(r)).not.toContain("NETWORK_INTERFACE=wlan0");

    // An existing file keeps its mode; only its line changes.
    fs.chmodSync(networkEnv(), 0o640);
    const again = run("step_network_setup", { env: { ...env, NETWORK_INTERFACE: "wlan1" } });
    expect(again.status, again.stderr).toBe(0);
    expect(read(networkEnv())).toBe("NETWORK_INTERFACE=wlan1\n");
    expect(again.modes.get(networkEnv())).toBe("640");
    expect(rootWrites(again)).toEqual([]);
  });

  // `root` as the account name: the fixtures belong to the user running the
  // suite, so to install.sh every entry is a leftover of someone else's. The
  // recording chown changes nothing, so each later write hands over again.
  it.each([
    ["ensure_env_setting", () => `ensure_env_setting "${envFile()}" LLAMACPP_LOAD_MODE mmap`],
    ["migrate_env_setting", () => `migrate_env_setting "${envFile()}" LLAMACPP_HF_REPO old/repo new/repo`],
    ["step_directories_permissions", () => "step_directories_permissions"],
    ["step_network_setup", () => "step_network_setup"],
  ])("%s hands a checkout with leftovers back to the account first, whole, with the sync's own chown", (_name, call) => {
    put(".env.example", EXAMPLE);
    put("scripts/a.sh", "true\n", 0o755);
    put(".env", "LLAMACPP_HF_REPO=old/repo\n", 0o600);
    // data/ is a link to a directory outside the checkout that holds a
    // network.env of its own: a chown by name below the checkout follows it.
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "network.env"), "NETWORK_INTERFACE=eth9\n");
    fs.symlinkSync(outside, path.join(project, "data"));
    const r = run(call(), { user: "root", env: { CLAWBOX_TEST_MODE: "1", NETWORK_INTERFACE: "wlan0" } });
    expect(r.status, r.stderr).toBe(0);
    const chowns = r.events.filter((e) => e.who === "root" && e.argv[0] === "chown").map((e) => e.argv.join(" "));
    expect(chowns.length).toBeGreaterThan(0);
    expect([...new Set(chowns)]).toEqual([`chown -R root:root ${project}`]);
    const handOver = r.events.findIndex((e) => e.who === "root" && e.argv[0] === "chown");
    const firstWrap = r.events.findIndex((e) => e.who === "wrapper");
    expect(handOver).toBeGreaterThanOrEqual(0);
    expect(firstWrap).toBeGreaterThan(handOver);
    expect([...new Set(rootWrites(r))]).toEqual([`chown -R root:root ${project}`]);
    expect(read(path.join(outside, "network.env"))).toBe(
      _name === "step_network_setup" ? "NETWORK_INTERFACE=wlan0\n" : "NETWORK_INTERFACE=eth9\n",
    );
  });
});

describe("ensure_llamacpp_model_cached hands data/llamacpp over only through the whole checkout", () => {
  // The model cache sits below data/, an entry the account controls: a
  // recursive chown named below the checkout changes whatever a link at data/
  // points at. A leftover anywhere under data/llamacpp hands back the checkout
  // whole, with the sync's own command; a checkout that is all the account's
  // is left alone.
  const MODEL = "gemma-4-E2B_q4_0-it.gguf";
  const models = () => path.join(project, "data", "llamacpp", "models");
  const cacheCall = (extra = "") => [
    extra,
    installFunction("require_safe_hf_ref"),
    installFunction("prune_superseded_llamacpp_model"),
    installFunction("ensure_llamacpp_model_cached"),
    // The download, as the account: hf writes the file into --local-dir.
    "hf() { : > \"$5/$3\"; }",
    'as_clawbox_login() { ( export AS_SERVICE_USER=1; eval "$*" ); }',
    "ensure_llamacpp_model_cached",
  ].join("\n");
  const rootChowns = (r: Run) => [...new Set(
    r.events.filter((e) => e.who === "root" && e.argv[0] === "chown").map((e) => e.argv.join(" ")),
  )];

  beforeEach(() => {
    put(".env", "LLAMACPP_LOAD_MODE=mmap\n", 0o600);
    fs.mkdirSync(models(), { recursive: true });
  });

  it.each([
    ["the model is cached", true],
    ["the model is downloaded", false],
  ])("hands back a checkout with leftovers whole, never a path below it, when %s", (_name, cached) => {
    if (cached) fs.writeFileSync(path.join(models(), MODEL), "gguf");

    const r = run(cacheCall(), { user: "root" });

    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(models(), MODEL))).toBe(true);
    expect(rootChowns(r)).toEqual([`chown -R root:root ${project}`]);
  });

  it("hands back the checkout for a leftover deep under data/llamacpp when everything above it is the account's", () => {
    // The test cannot make a file it does not own, so root's find and stat
    // report one: a file below data/llamacpp owned by another account.
    fs.writeFileSync(path.join(models(), MODEL), "gguf");
    const stray = path.join(models(), "partial");
    fs.writeFileSync(stray, "");
    const shims = [
      `find() { case " $* " in *" $PROJECT_DIR/data/llamacpp "*) echo ${JSON.stringify(stray)}; return 0 ;; esac; `
        + 'command find "$@"; }',
      `stat() { if [ "\${@: -1}" = ${JSON.stringify(stray)} ]; then echo nobody; else command stat "$@"; fi; }`,
    ].join("\n");

    const r = run(cacheCall(shims));

    expect(r.status, r.stderr).toBe(0);
    expect(rootChowns(r)).toEqual([`chown -R ${os.userInfo().username}:${os.userInfo().username} ${project}`]);
  });

  it("changes no owner in a checkout that is all the account's", () => {
    fs.writeFileSync(path.join(models(), MODEL), "gguf");

    const r = run(cacheCall());

    expect(r.status, r.stderr).toBe(0);
    expect(rootChowns(r)).toEqual([]);
  });
});
