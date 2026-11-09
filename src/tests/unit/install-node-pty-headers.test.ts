import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Runs real bash for every case: vitest's 5 s test and 10 s hook defaults are
// not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * TASK-2244: the 4.3 update failed at rebuild_reboot with "node-pty is still
 * not loadable after rebuild" twice, rolled back, and left the web terminal
 * dead. Reproduced on a nano-lab board (NodeSource Node 24.22.2, its headers
 * in /usr/include/node): `ensure_node_pty` exported
 * `npm_config_nodedir=/usr/include/node`, but node-gyp's nodedir is a PREFIX —
 * it compiles with `-I<nodedir>/include/node` — so every attempt stopped at
 * `napi.h:13:10: fatal error: node_api.h: No such file or directory`, with
 * headers that matched the running Node exactly. `nodedir=/usr` built, and so
 * did no nodedir at all (node-gyp fetches the headers itself).
 *
 * The fake `npm` below applies that same rule, so a nodedir in the wrong shape
 * fails here as it fails on the box. These run the SHIPPED function bodies out
 * of install.sh: an edit to install.sh is what the assertions see.
 */

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");

/** One shell function, verbatim, anchored at a line start. */
function shellFunction(name: string): string {
  const opener = new RegExp(`^${name}\\(\\) \\{$`, "m").exec(INSTALL_SH);
  if (!opener) throw new Error(name + " not found in install.sh");
  const end = INSTALL_SH.indexOf("\n}", opener.index);
  if (end < 0) throw new Error(name + " has no closing brace");
  return INSTALL_SH.slice(opener.index, end + 2);
}

const FUNCTIONS = [
  "node_header_version",
  "choose_node_headers",
  "node_gyp_devdir",
  "node_gyp_has_headers",
  "run_node_pty_rebuild",
  "node_pty_failure_summary",
  "print_native_build_preflight",
  "ensure_node_pty",
  "ensure_node_pty_after_rollback",
];

/** The Node the box runs. */
const RUNNING = "24.22.2";

interface Scenario {
  /** Version in /usr/include/node/node_version.h; null: no such directory. */
  systemHeaders?: string | null;
  /**
   * /usr/include/nodejs: absent, a symlink to `node` (Debian's compat link),
   * or a real directory holding the headers at its top — a layout node-gyp
   * cannot take as a nodedir.
   */
  nodejsDir?: "absent" | "symlink-to-node" | "flat-dir";
  /** Can node-gyp download the headers it needs? */
  network?: "online" | "offline";
  /** The compile itself: works, or fails whatever the headers. */
  compiler?: "works" | "broken";
  /** npm exits 0 but leaves no module node can load. */
  buildLeavesNothing?: boolean;
  /** Lines of node-gyp chatter each attempt prints before its verdict. */
  noise?: number;
  tmp?: "writable" | "unwritable";
  entry?: "ensure_node_pty" | "ensure_node_pty_after_rollback";
  /** Call the entry bare under errexit, as step_build does, not as a condition. */
  bare?: boolean;
  /** node-pty already loads before the entry runs. */
  ptyLoads?: boolean;
  /** What the clawbox user's login environment sets (XDG_CACHE_HOME, npm_config_devdir, …). */
  loginEnv?: Record<string, string>;
  /** The project's .npmrc; absent when not given. */
  npmrc?: string;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** npm_config_nodedir per `npm rebuild`, "<unset>" when there was none. */
  nodedirs: string[];
  /** The version of the headers the module that loads was built against. */
  builtAgainst: string | null;
  /** NODE_PTY_FAILURE once the entry returned. */
  failure: string;
}

let sandbox: string;
let sys: string;
let home: string;
let project: string;
let fakeBin: string;

function writeHeaders(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  const [ma, mi, pa] = version.split(".");
  writeFileSync(
    path.join(dir, "node_version.h"),
    [
      "#ifndef SRC_NODE_VERSION_H_",
      "#define SRC_NODE_VERSION_H_",
      "",
      `#define NODE_MAJOR_VERSION ${ma}`,
      `#define NODE_MINOR_VERSION ${mi}`,
      `#define NODE_PATCH_VERSION ${pa}`,
      "",
      "#define NODE_VERSION_IS_RELEASE 1",
      "#endif  // SRC_NODE_VERSION_H_",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(path.join(dir, "node_api.h"), "// node_api.h\n", "utf-8");
}

const FAKE_NODE = `#!/usr/bin/env bash
case "$1" in
  -p)
    case "$2" in
      process.versions.node) echo "$FAKE_NODE_VERSION" ;;
      process.version) echo "v$FAKE_NODE_VERSION" ;;
      process.versions.modules) echo 137 ;;
      *) exit 1 ;;
    esac
    exit 0 ;;
  -e)
    [ -f "$PWD/node_modules/node-pty/build/Release/pty.node" ] && exit 0
    echo "$PWD/node_modules/node-pty/lib/utils.js:36" >&2
    echo '    throw new Error("Failed to load native module: " + name + ".node");' >&2
    echo "" >&2
    echo "Error: Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-arm64: Error: Cannot find module './prebuilds/linux-arm64//pty.node'" >&2
    exit 1 ;;
esac
exit 1
`;

// node-gyp as measured: -I<nodedir>/include/node, or the headers it fetches
// into <devdir>/<version>/include/node when no nodedir is given. The devdir
// as node-gyp 11's bin/node-gyp.js takes it: npm_package_config_node_gyp_devdir,
// else npm's devdir config — the environment's npm_config_devdir, else a
// .npmrc's, as \`npm config get devdir\` answers ("undefined" for none) and npm
// hands it to node-gyp — a leading ~ is the home; else env-paths' cache,
// ${XDG_CACHE_HOME:-~/.cache}/node-gyp.
const FAKE_NPM = `#!/usr/bin/env bash
[ "\${1:-}" = "--version" ] && { echo 11.19.1; exit 0; }
npm_devdir_config() {
  # npm's env layer: npm_config_devdir under any case, an empty one skipped.
  local v rc
  v="$(env | awk -F= 'tolower($1) == "npm_config_devdir" && length($0) > length($1) + 1 { sub(/^[^=]*=/, ""); print; exit }')"
  for rc in "$PWD/.npmrc" "$HOME/.npmrc"; do
    [ -n "$v" ] || v="$(sed -n 's/^devdir=//p' "$rc" 2>/dev/null)"
  done
  echo "\${v:-undefined}"
}
if [ "\${1:-} \${2:-} \${3:-}" = "config get devdir" ]; then npm_devdir_config; exit 0; fi
attempt=$(( $(cat "$NPM_ATTEMPTS" 2>/dev/null || echo 0) + 1 ))
echo "$attempt" > "$NPM_ATTEMPTS"
printf '%s\\n' "\${npm_config_nodedir-<unset>}" >> "$NPM_CALLS"
for i in $(seq 1 "$NOISE"); do echo "gyp info attempt $attempt line $i"; done
if [ -n "\${npm_config_nodedir:-}" ]; then
  hdr="$npm_config_nodedir/include/node"
else
  # The package config under any case, and set but empty still wins; relative
  # is node-pty's directory's, where npm runs it.
  if devdir="$(env | awk -F= 'tolower($1) == "npm_package_config_node_gyp_devdir" { sub(/^[^=]*=/, ""); print; f = 1; exit } END { exit !f }')"; then :
  else devdir="$(npm_devdir_config)"
  fi
  [ "$devdir" != undefined ] || devdir=""
  case "$devdir" in "~"*) devdir="$HOME\${devdir#"~"}" ;; esac
  devdir="\${devdir:-\${XDG_CACHE_HOME:-$HOME/.cache}/node-gyp}"
  case "$devdir" in /*) ;; *) devdir="$PWD/node_modules/node-pty/$devdir" ;; esac
  hdr="$devdir/$FAKE_NODE_VERSION/include/node"
  if [ ! -f "$hdr/node_version.h" ]; then
    echo "gyp http GET https://nodejs.org/download/release/v$FAKE_NODE_VERSION/node-v$FAKE_NODE_VERSION-headers.tar.gz" >&2
    if [ "$NETWORK" != online ]; then
      echo "gyp ERR! configure error " >&2
      echo "gyp ERR! stack FetchError: request to https://nodejs.org/download/release/v$FAKE_NODE_VERSION/node-v$FAKE_NODE_VERSION-headers.tar.gz failed, reason: getaddrinfo EAI_AGAIN nodejs.org" >&2
      echo "npm error code 1" >&2
      exit 1
    fi
    mkdir -p "$hdr"
    printf '#define NODE_MAJOR_VERSION %s\\n#define NODE_MINOR_VERSION %s\\n#define NODE_PATCH_VERSION %s\\n' $(echo "$FAKE_NODE_VERSION" | tr . ' ') > "$hdr/node_version.h"
    : > "$hdr/node_api.h"
  fi
fi
if [ ! -f "$hdr/node_api.h" ]; then
  echo "In file included from ../src/unix/pty.cc:21:"
  echo "../../node-addon-api/napi.h:13:10: fatal error: node_api.h: No such file or directory" >&2
  echo "compilation terminated."
  echo "gyp ERR! build error " >&2
  echo "gyp ERR! stack Error: \\\`make\\\` failed with exit code: 2" >&2
  echo "npm error code 1" >&2
  exit 1
fi
if [ "$COMPILER" = broken ]; then
  echo "../src/unix/pty.cc:42:1: error: 'forkpty' was not declared in this scope (attempt $attempt)" >&2
  echo "gyp ERR! stack Error: \\\`make\\\` failed with exit code: 2" >&2
  echo "npm error code 1" >&2
  exit 1
fi
[ "$LEAVES_NOTHING" = 1 ] && exit 0
mkdir -p node_modules/node-pty/build/Release
sed -n 's/^#define NODE_\\(MAJOR\\|MINOR\\|PATCH\\)_VERSION //p' "$hdr/node_version.h" | paste -sd. > node_modules/node-pty/build/Release/pty.node
`;

// A toolchain whose `--version` outruns a pipe buffer: `| head -1` then
// SIGPIPEs it every time instead of half the time, which is what the preflight
// did under errexit and pipefail until it read with awk instead.
const FAKE_TOOL = (first: string) => `#!/usr/bin/env bash
echo "${first}"
for i in $(seq 1 20000); do echo "This is free software; see the source for copying conditions. ($i)"; done
`;

function run(scenario: Scenario = {}): Run {
  const {
    systemHeaders = RUNNING,
    nodejsDir = "absent",
    network = "online",
    compiler = "works",
    buildLeavesNothing = false,
    noise = 5,
    tmp = "writable",
    entry = "ensure_node_pty",
    bare = false,
    ptyLoads = false,
    loginEnv = {},
    npmrc,
  } = scenario;

  // Per RUN: a case that calls this twice must not start from the first one's
  // build, header cache or call log.
  const include = path.join(sys, "usr", "include");
  const ptyBuild = path.join(project, "node_modules", "node-pty", "build");
  const npmCalls = path.join(sandbox, "npm-calls.txt");
  const devdirs = [
    path.join(home, ".cache"), path.join(sandbox, "devdirs"), path.join(home, "gyp-dev"),
    path.join(project, "node_modules", "node-pty", "gyp-rel"),
  ];
  const projectNpmrc = path.join(project, ".npmrc");
  for (const p of [include, ptyBuild, npmCalls, path.join(sandbox, "npm-attempts.txt"), projectNpmrc, ...devdirs]) {
    rmSync(p, { recursive: true, force: true });
  }
  mkdirSync(include, { recursive: true });
  if (npmrc !== undefined) writeFileSync(projectNpmrc, npmrc, "utf-8");
  if (ptyLoads) {
    mkdirSync(path.join(ptyBuild, "Release"), { recursive: true });
    writeFileSync(path.join(ptyBuild, "Release", "pty.node"), "built\n", "utf-8");
  }
  if (systemHeaders !== null) writeHeaders(path.join(include, "node"), systemHeaders);
  if (nodejsDir === "symlink-to-node") symlinkSync("node", path.join(include, "nodejs"));
  if (nodejsDir === "flat-dir") writeHeaders(path.join(include, "nodejs"), RUNNING);

  const unwritable = path.join(sandbox, "no-write");
  writeFileSync(unwritable, "", "utf-8");
  const call = bare
    ? `${entry}; rc=0`
    : `if ${entry}; then rc=0; else rc=$?; fi`;
  const script = [
    "set -euo pipefail",
    `PATH=${JSON.stringify(fakeBin)}:"$PATH"`,
    "PROJECT_DIR=" + JSON.stringify(project),
    "CLAWBOX_HOME=" + JSON.stringify(home),
    "CLAWBOX_USER=clawbox",
    "TMPDIR=" + JSON.stringify(tmp === "writable" ? path.join(sandbox, "tmp") : unwritable),
    // The search list the shipped one names, moved into the sandbox.
    `NODE_SYSTEM_HEADER_DIRS="${path.join(include, "nodejs")} ${path.join(include, "node")}"`,
    'NODE_PTY_FAILURE=""',
    `export FAKE_NODE_VERSION=${RUNNING} NETWORK=${network} COMPILER=${compiler} NOISE=${noise}`,
    `export LEAVES_NOTHING=${buildLeavesNothing ? 1 : 0}`,
    "export NPM_CALLS=" + JSON.stringify(npmCalls),
    "export NPM_ATTEMPTS=" + JSON.stringify(path.join(sandbox, "npm-attempts.txt")),
    // `su - clawbox -c "<command>"`, minus the user switch: a login
    // environment, so none of the runner's own devdir settings leak in.
    "as_clawbox_login() { env -u XDG_CACHE_HOME -u npm_config_devdir -u NPM_CONFIG_DEVDIR "
      + "-u npm_package_config_node_gyp_devdir -u NPM_PACKAGE_CONFIG_NODE_GYP_DEVDIR "
      + `HOME=${JSON.stringify(home)} `
      + Object.entries(loginEnv).map(([k, v]) => `${k}=${JSON.stringify(v)} `).join("")
      + `PATH=${JSON.stringify(fakeBin)}:"$PATH" bash -c "$*"; }`,
    "wait_for_apt() { :; }",
    "apt-get() { :; }",
    "chown() { :; }",
    ...FUNCTIONS.map(shellFunction),
    call,
    'echo "FAILURE=$NODE_PTY_FAILURE"',
    'exit "$rc"',
    "",
  ].join("\n");
  const scriptPath = path.join(sandbox, "run.sh");
  writeFileSync(scriptPath, script, "utf-8");
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", cwd: REPO });
  const stdout = result.stdout ?? "";
  const pty = path.join(project, "node_modules", "node-pty", "build", "Release", "pty.node");
  return {
    status: result.status,
    stdout,
    stderr: result.stderr ?? "",
    nodedirs: existsSync(npmCalls) ? readFileSync(npmCalls, "utf-8").split("\n").filter(Boolean) : [],
    builtAgainst: existsSync(pty) ? readFileSync(pty, "utf-8").trim() : null,
    failure: /^FAILURE=(.*)$/m.exec(stdout)?.[1] ?? "",
  };
}

/** The preflight's line naming the headers. */
const headersLine = (r: Run) => /^ {4}Node headers: (.*)$/m.exec(r.stdout)?.[1] ?? "";

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "clawbox-node-pty-"));
  sys = path.join(sandbox, "sys");
  home = path.join(sandbox, "home");
  project = path.join(sandbox, "clawbox");
  fakeBin = path.join(sandbox, "bin");
  mkdirSync(path.join(project, "node_modules", "node-pty"), { recursive: true });
  mkdirSync(path.join(sandbox, "tmp"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(path.join(fakeBin, "node"), FAKE_NODE, "utf-8");
  writeFileSync(path.join(fakeBin, "npm"), FAKE_NPM, "utf-8");
  writeFileSync(path.join(fakeBin, "make"), FAKE_TOOL("GNU Make 4.3"), "utf-8");
  writeFileSync(path.join(fakeBin, "g++"), FAKE_TOOL("g++ (Ubuntu 11.4.0-1ubuntu1~22.04.2) 11.4.0"), "utf-8");
  for (const tool of ["node", "npm", "make", "g++"]) chmodSync(path.join(fakeBin, tool), 0o755);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("the shipped function bodies these tests run", () => {
  it.each(FUNCTIONS)("%s is extracted whole", (name) => {
    const body = shellFunction(name);
    expect(body.startsWith(name + "() {")).toBe(true);
    expect(body.endsWith("\n}")).toBe(true);
    expect(body).not.toMatch(/\n\s*(if|while|case)[^\n]*\n\}$/);
  });

  it("searches the two directories distributions use", () => {
    expect(INSTALL_SH).toMatch(/^NODE_SYSTEM_HEADER_DIRS="\/usr\/include\/nodejs \/usr\/include\/node"$/m);
  });
});

describe("ensure_node_pty builds against headers that match the running Node", () => {
  it("uses system headers that match, as the prefix node-gyp expects", () => {
    const r = run({ systemHeaders: RUNNING, network: "offline" });
    expect(r.status).toBe(0);
    // The prefix, never the header directory itself: -I<nodedir>/include/node.
    expect(r.nodedirs).toEqual([path.join(sys, "usr")]);
    expect(r.builtAgainst).toBe(RUNNING);
    expect(r.stdout).toContain("node-pty rebuilt and verified");
    expect(headersLine(r)).toBe(
      `${path.join(sys, "usr", "include", "node")} (Node ${RUNNING}, matches the running Node) — node-gyp nodedir=${path.join(sys, "usr")}`,
    );
  });

  it("never hands node-gyp a directory that holds the headers itself (the 4.3 failure)", () => {
    const r = run({ systemHeaders: RUNNING });
    for (const dir of r.nodedirs) {
      expect(existsSync(path.join(dir, "node_api.h")), `${dir} is a header directory, not a prefix`).toBe(false);
    }
    expect(r.stdout + r.stderr).not.toContain("fatal error: node_api.h");
  });

  it("follows Debian's nodejs -> node link to the same prefix", () => {
    const r = run({ systemHeaders: RUNNING, nodejsDir: "symlink-to-node" });
    expect(r.status).toBe(0);
    expect(r.nodedirs).toEqual([path.join(sys, "usr")]);
  });

  it.each([
    ["the Node 22 a move to 24 left behind", "22.21.0"],
    ["Ubuntu's libnode-dev", "12.22.9"],
    ["another patch release of the same Node", "24.21.0"],
  ])("ignores %s and lets node-gyp fetch the matching headers", (_label, version) => {
    const r = run({ systemHeaders: version });
    expect(r.status).toBe(0);
    expect(r.nodedirs).toEqual(["<unset>"]);
    expect(r.builtAgainst).toBe(RUNNING);
    expect(headersLine(r)).toBe(
      `auto — node-gyp fetches v${RUNNING} into ~/.cache/node-gyp/${RUNNING}/ `
        + `(ignored: ${path.join(sys, "usr", "include", "node")} holds Node ${version}, not the running ${RUNNING})`,
    );
  });

  it("ignores a header directory node-gyp cannot use as a nodedir, whatever its version", () => {
    const r = run({ systemHeaders: null, nodejsDir: "flat-dir" });
    expect(r.status).toBe(0);
    expect(r.nodedirs).toEqual(["<unset>"]);
    expect(headersLine(r)).toContain(
      `ignored: ${path.join(sys, "usr", "include", "nodejs")} is not laid out as <prefix>/include/node`,
    );
  });

  it("lets node-gyp fetch when there are no system headers at all", () => {
    const r = run({ systemHeaders: null });
    expect(r.status).toBe(0);
    expect(r.nodedirs).toEqual(["<unset>"]);
    expect(headersLine(r)).toBe(`auto — node-gyp fetches v${RUNNING} into ~/.cache/node-gyp/${RUNNING}/`);
  });

  it("falls back to mismatched system headers, and says so, when the fetch cannot happen", () => {
    const r = run({ systemHeaders: "22.21.0", network: "offline" });
    expect(r.status).toBe(0);
    expect(r.nodedirs).toEqual(["<unset>", path.join(sys, "usr")]);
    expect(r.builtAgainst).toBe("22.21.0");
    expect(r.stdout).toContain(
      `node-gyp could not fetch the headers for Node v${RUNNING} (no network?)`,
    );
    expect(r.stdout).toContain(
      `falling back to the system headers in ${path.join(sys, "usr", "include", "node")} (Node 22.21.0), which do NOT match the running Node`,
    );
  });

  it("retries a build against matching system headers with the ones node-gyp fetches", () => {
    const r = run({ systemHeaders: RUNNING, compiler: "broken" });
    expect(r.nodedirs).toEqual([path.join(sys, "usr"), "<unset>"]);
    expect(r.stdout).toContain(`retrying once with the headers node-gyp fetches for Node v${RUNNING}`);
  });

  it("does nothing when node-pty already loads", () => {
    const r = run({ ptyLoads: true });
    expect(r.status).toBe(0);
    expect(r.nodedirs).toEqual([]);
    expect(r.stdout).toContain("node-pty is already loadable");
  });
});

describe("the headers node-gyp fetched are looked for where node-gyp keeps them", () => {
  // A devdir moved by the clawbox user's login environment (XDG_CACHE_HOME for
  // env-paths, npm_config_devdir, npm_package_config_node_gyp_devdir) or by a
  // .npmrc. ~/.cache/node-gyp stays empty then.
  const dev = (name: string) => path.join(sandbox, "devdirs", name);
  const xdg = () => ({ XDG_CACHE_HOME: dev("xdg") });
  const fetched = (devdir: string) => existsSync(path.join(devdir, RUNNING, "include", "node", "node_version.h"));

  it.each<[string, () => Scenario, () => string]>([
    ["XDG_CACHE_HOME", () => ({ loginEnv: xdg() }), () => path.join(dev("xdg"), "node-gyp")],
    ["npm_config_devdir", () => ({ loginEnv: { npm_config_devdir: dev("gyp") } }), () => dev("gyp")],
    ["NPM_CONFIG_DEVDIR", () => ({ loginEnv: { NPM_CONFIG_DEVDIR: dev("gyp") } }), () => dev("gyp")],
    ["npm_config_devdir under ~", () => ({ loginEnv: { npm_config_devdir: "~/gyp-dev" } }), () => path.join(home, "gyp-dev")],
    ["the project's .npmrc", () => ({ npmrc: `devdir=${dev("rc")}\n` }), () => dev("rc")],
    [
      "npm_package_config_node_gyp_devdir, over npm_config_devdir",
      () => ({ loginEnv: { npm_config_devdir: dev("gyp"), npm_package_config_node_gyp_devdir: dev("pkg") } }),
      () => dev("pkg"),
    ],
    [
      "NPM_PACKAGE_CONFIG_NODE_GYP_DEVDIR, over npm_config_devdir",
      () => ({ loginEnv: { npm_config_devdir: dev("gyp"), NPM_PACKAGE_CONFIG_NODE_GYP_DEVDIR: dev("pkg") } }),
      () => dev("pkg"),
    ],
    [
      "Npm_Package_Config_Node_Gyp_Devdir, over npm_config_devdir",
      () => ({ loginEnv: { npm_config_devdir: dev("gyp"), Npm_Package_Config_Node_Gyp_Devdir: dev("pkg") } }),
      () => dev("pkg"),
    ],
    ["Npm_Config_Devdir", () => ({ loginEnv: { Npm_Config_Devdir: dev("gyp") } }), () => dev("gyp")],
    [
      "an empty npm_package_config_node_gyp_devdir, which clears npm_config_devdir",
      () => ({ loginEnv: { npm_config_devdir: dev("gyp"), npm_package_config_node_gyp_devdir: "" } }),
      () => path.join(home, ".cache", "node-gyp"),
    ],
    [
      "a relative npm_config_devdir, node-pty's directory's",
      () => ({ loginEnv: { npm_config_devdir: "gyp-rel" } }),
      () => path.join(project, "node_modules", "node-pty", "gyp-rel"),
    ],
  ])("a build that failed after the fetch worked (%s) retries, without the mismatched system headers", (_label, scenario, devdir) => {
    const r = run({ systemHeaders: "22.21.0", compiler: "broken", ...scenario() });
    // Only where the headers went: one devdir, never npm_config_devdir's when overridden.
    for (const other of [path.join(home, ".cache", "node-gyp"), dev("gyp")]) {
      if (other !== devdir()) expect(fetched(other)).toBe(false);
    }
    expect(fetched(devdir())).toBe(true);
    expect(r.nodedirs).toEqual(["<unset>", "<unset>"]);
    expect(r.stdout).not.toContain("could not fetch");
    expect(r.stdout).toContain("Initial node-pty rebuild failed (../src/unix/pty.cc:42:1: error: 'forkpty' was not declared in this scope (attempt 1)); clearing stale build output and retrying once...");
  });

  it("still falls back to the system headers when the fetch into that devdir could not happen", () => {
    const r = run({ systemHeaders: "22.21.0", network: "offline", loginEnv: xdg() });
    expect(r.status).toBe(0);
    expect(r.nodedirs).toEqual(["<unset>", path.join(sys, "usr")]);
    expect(r.stdout).toContain(`node-gyp could not fetch the headers for Node v${RUNNING} (no network?)`);
  });

  it("names the retry's own error when its fetch into that devdir worked", () => {
    const r = run({ systemHeaders: RUNNING, compiler: "broken", loginEnv: xdg() });
    expect(r.status).toBe(1);
    expect(r.nodedirs).toEqual([path.join(sys, "usr"), "<unset>"]);
    expect(r.failure).toBe("../src/unix/pty.cc:42:1: error: 'forkpty' was not declared in this scope (attempt 2)");
  });

  it("keeps the first error when the retry's fetch into that devdir could not happen", () => {
    const r = run({ systemHeaders: RUNNING, compiler: "broken", network: "offline", loginEnv: xdg() });
    expect(r.failure).toBe(
      `../src/unix/pty.cc:42:1: error: 'forkpty' was not declared in this scope (attempt 1) (the retry could not fetch the headers for Node v${RUNNING})`,
    );
  });

  it("names that devdir in the preflight", () => {
    const r = run({ systemHeaders: null, loginEnv: xdg() });
    expect(r.status).toBe(0);
    expect(headersLine(r)).toBe(`auto — node-gyp fetches v${RUNNING} into ${path.join(dev("xdg"), "node-gyp")}/${RUNNING}/`);
    expect(headersLine(run({ systemHeaders: null, loginEnv: { npm_config_devdir: "~/gyp-dev" } })))
      .toBe(`auto — node-gyp fetches v${RUNNING} into ~/gyp-dev/${RUNNING}/`);
  });

  it("takes an empty XDG_CACHE_HOME or devdir as unset, as node-gyp does", () => {
    const r = run({ systemHeaders: "22.21.0", compiler: "broken", loginEnv: { XDG_CACHE_HOME: "", npm_config_devdir: "" } });
    expect(fetched(path.join(home, ".cache", "node-gyp"))).toBe(true);
    expect(r.nodedirs).toEqual(["<unset>", "<unset>"]);
    expect(headersLine(r)).toBe(`auto — node-gyp fetches v${RUNNING} into ~/.cache/node-gyp/${RUNNING}/ `
      + `(ignored: ${path.join(sys, "usr", "include", "node")} holds Node 22.21.0, not the running ${RUNNING})`);
  });
});

describe("a failed node-pty rebuild leaves its own output in the update log", () => {
  const tailBlock = (r: Run) => r.stderr.split("\n").filter((l) => l.startsWith("    | "));

  it("prints the last 80 lines of the attempt that failed, right before the error", () => {
    const r = run({ compiler: "broken", noise: 150 });
    expect(r.status).toBe(1);
    const block = tailBlock(r);
    expect(block).toHaveLength(80);
    expect(r.stderr).toContain("node-pty rebuild — the last 80 lines of its last attempt");
    // The LAST attempt's lines, and only its last 80: 150 lines of chatter,
    // node-gyp's header download and three lines of verdict make 154, so the
    // window opens at line 75.
    expect(block).toContain("    | gyp info attempt 2 line 150");
    expect(block[0]).toBe("    | gyp info attempt 2 line 75");
    expect(block).not.toContain("    | gyp info attempt 2 line 74");
    expect(block.some((l) => l.includes("attempt 1"))).toBe(false);
    expect(block.at(-1)).toBe("    | npm error code 1");
    const errorAt = r.stderr.indexOf("Error: node-pty is still not loadable");
    expect(errorAt).toBeGreaterThan(r.stderr.indexOf("    | npm error code 1"));
  });

  it("names the compiler's own error in its error line, and hands it to do_rebuild", () => {
    const r = run({ compiler: "broken" });
    expect(r.stderr).toContain(
      "Error: node-pty is still not loadable after rebuild: ../src/unix/pty.cc:42:1: error: 'forkpty' was not declared in this scope (attempt 2). The last 80 lines of its last attempt are above.",
    );
    expect(r.failure).toBe("../src/unix/pty.cc:42:1: error: 'forkpty' was not declared in this scope (attempt 2)");
    // The first attempt's reason is in the retry line, so neither is lost.
    expect(r.stdout).toContain("Initial node-pty rebuild failed (../src/unix/pty.cc:42:1: error: 'forkpty' was not declared in this scope (attempt 1))");
  });

  it("keeps the compiler's error when the retry could not even fetch its headers", () => {
    // Offline, matching system headers, a real compile error: the retry with
    // fetched headers fails on the download, which says nothing about the build.
    const r = run({ systemHeaders: RUNNING, compiler: "broken", network: "offline" });
    expect(r.status).toBe(1);
    expect(r.nodedirs).toEqual([path.join(sys, "usr"), "<unset>"]);
    expect(r.failure).toBe(
      `../src/unix/pty.cc:42:1: error: 'forkpty' was not declared in this scope (attempt 1) (the retry could not fetch the headers for Node v${RUNNING})`,
    );
  });

  it("names node-gyp's own reason when the headers could not be fetched and nothing else was there", () => {
    const r = run({ systemHeaders: null, network: "offline" });
    expect(r.status).toBe(1);
    expect(r.failure).toBe(
      `gyp ERR! stack FetchError: request to https://nodejs.org/download/release/v${RUNNING}/node-v${RUNNING}-headers.tar.gz failed, reason: getaddrinfo EAI_AGAIN nodejs.org`,
    );
  });

  it("names what node said when a build that reported success does not load", () => {
    const r = run({ buildLeavesNothing: true });
    expect(r.status).toBe(1);
    expect(r.failure).toMatch(/^Error: Failed to load native module: pty\.node, checked: build\/Release/);
  });

  it("keeps every line of the tail from reading as this script's own error", () => {
    // The update screen shows the newest line that STARTS with Error/fatal.
    const r = run({ compiler: "broken", noise: 150 });
    expect(tailBlock(r)).toHaveLength(80);
    for (const l of tailBlock(r)) expect(l.trim()).not.toMatch(/^(?:error|fatal)\b/i);
  });

  it("still rebuilds, and reports, when it cannot open a log", () => {
    const ok = run({ tmp: "unwritable" });
    expect(ok.status).toBe(0);
    expect(ok.builtAgainst).toBe(RUNNING);
    const bad = run({ tmp: "unwritable", compiler: "broken" });
    expect(bad.status).toBe(1);
    // Still in the output, through this script's own tee (the unit's journal).
    expect(bad.stdout).toContain("../src/unix/pty.cc:42:1: error: 'forkpty' was not declared in this scope (attempt 2)");
    expect(bad.stderr).toMatch(/Error: node-pty is still not loadable after rebuild: Error: Failed to load native module.*\. Its build output is above\.$/m);
  });

  it("gets through the preflight under errexit and pipefail, as step_build calls it", () => {
    // `make --version | head -1` was a 141 in 153 of 300 tries, and a bare
    // call ended the whole install with it.
    const r = run({ bare: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("    make: GNU Make 4.3\n");
    expect(r.stdout).toContain("    g++: g++ (Ubuntu 11.4.0-1ubuntu1~22.04.2) 11.4.0\n");
    expect(r.builtAgainst).toBe(RUNNING);
  });

  it("reports before errexit ends a bare call, as step_build makes it", () => {
    const r = run({ compiler: "broken", bare: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Error: node-pty is still not loadable after rebuild: ../src/unix/pty.cc:42:1");
    expect(tailBlock(r).length).toBeGreaterThan(0);
  });
});

describe("ensure_node_pty_after_rollback (the restored box's terminal)", () => {
  it("rebuilds node-pty so it loads, saying two lines and nothing else", () => {
    const r = run({ entry: "ensure_node_pty_after_rollback", systemHeaders: RUNNING, noise: 40 });
    expect(r.status).toBe(0);
    expect(r.builtAgainst).toBe(RUNNING);
    const said = (r.stdout + r.stderr).split("\n").filter((l) => l && !l.startsWith("FAILURE="));
    expect(said).toEqual([
      "  node-pty does not load on the restored box; rebuilding it for the web terminal...",
      "  node-pty rebuilt and verified on the restored box",
    ]);
  });

  it("warns in one line, with the reason, and prints no error line of its own", () => {
    const r = run({ entry: "ensure_node_pty_after_rollback", compiler: "broken", noise: 40 });
    expect(r.status).toBe(1);
    const said = (r.stdout + r.stderr).split("\n").filter((l) => l && !l.startsWith("FAILURE="));
    expect(said).toHaveLength(2);
    expect(r.stderr).toMatch(
      /^ {2}Warning: node-pty still does not load after the rollback, so the web terminal stays unavailable: \.\.\/src\/unix\/pty\.cc:42:1: error: 'forkpty' was not declared in this scope \(attempt 2\) \(full output: .*after-rollback\.log\)$/m,
    );
    for (const l of said) expect(l.trim()).not.toMatch(/^(?:error|fatal)\b/i);
  });

  it("does nothing on a box whose node-pty loads", () => {
    const r = run({ entry: "ensure_node_pty_after_rollback", ptyLoads: true });
    expect(r.status).toBe(0);
    expect(r.nodedirs).toEqual([]);
    expect((r.stdout + r.stderr).split("\n").filter((l) => l && !l.startsWith("FAILURE="))).toEqual([]);
  });
});
