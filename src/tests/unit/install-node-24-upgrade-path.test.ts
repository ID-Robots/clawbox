import { describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Starts a real bash per case: vitest's 5 s test and 10 s hook defaults are not
// enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * TASK-788 — the ORDER the Node 22 → 24 switch has to happen in.
 *
 * Pinning the core to 2026.9.3 is not a pin bump on its own: that core's
 * `engines.node` is `>=24.16.0 <25 || >=26.1.0` and every shipped ClawBox image
 * runs Node 22.23.2, where every `openclaw` command exits 1. So on the upgrade
 * path — a box that has Node 22 and core 2026.8.1 and is told to update — the
 * new Node must be in place BEFORE `npm install -g openclaw@<target>`, or the
 * new core's first invocation (`doctor --fix`, which owns the config and session
 * migrations) runs on a Node it refuses and the box comes up without a gateway.
 *
 * `step_openclaw_install` is where both happen, and this drives the shipped
 * function under bash with stub binaries, recording the order of what it did:
 *
 *   curl …/setup_24.x  →  apt-get install nodejs  →  npm install -g openclaw@…
 *
 * The stubs model the apt transaction honestly rather than just logging it: the
 * NodeSource setup script records which channel was configured, and `apt-get
 * install nodejs` then installs the major THAT channel offers. A script that
 * piped `setup_22.x` would therefore land on 22.23.2 and the guard would refuse
 * it — which is the real failure mode, not a string mismatch.
 *
 * The second claim is the fresh-install one: a box flashed today must never
 * take the retired channel at all, on any path.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
/** The pin the step will install, read where the step reads it. */
const TARGET = readFileSync(path.join(REPO, "config/openclaw-target.txt"), "utf-8").trim();

const HAS_BASH = spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const HAS_DPKG = spawnSync("dpkg", ["--version"], { stdio: "ignore" }).status === 0;
// python3 is not decoration here: the sliced `step_openclaw_install` pipes
// `plugins list --json` through a python program of its own.
const HAS_PYTHON3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/** A shell function lifted out of install.sh, so the test cannot drift from it. */
function shellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${INSTALL_SH.slice(start, end)}\n}`;
}

/**
 * A top-level assignment lifted out of install.sh by name.
 *
 * An absent one becomes an empty definition rather than an error, so this suite
 * still RUNS against a tree that predates the variable and fails on what the
 * shipped code DID — which is how its own red was demonstrated against beta.
 */
function assignment(name: string): string {
  const m = new RegExp(`^${name}=.*$`, "m").exec(INSTALL_SH);
  return m ? m[0] : `${name}=""`;
}

type Box = {
  dir: string;
  state: string;
  bin: string;
  npmPrefix: string;
  openclawBin: string;
  calls: () => string[];
  nodeVersion: () => string;
  coreVersion: () => string;
};

/**
 * A box on disk: the stub binaries install.sh reaches for, plus the two pieces
 * of state a major upgrade actually moves — which Node is installed, and which
 * NodeSource channel is configured.
 */
function makeBox(opts: { node: string | null; core: string | null }): Box {
  const dir = mkdtempSync(path.join(tmpdir(), "clawbox-node24-"));
  const state = path.join(dir, "state");
  const bin = path.join(dir, "bin");
  const npmPrefix = path.join(dir, "npm-global");
  mkdirSync(state, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(npmPrefix, "bin"), { recursive: true });
  // Where the core's own package.json lives, so the failure path can read the
  // engines it declares — npm's layout, the same one install.sh derives.
  mkdirSync(path.join(npmPrefix, "lib", "node_modules", "openclaw"), { recursive: true });
  if (opts.node) writeFileSync(path.join(state, "node-version"), opts.node);
  if (opts.core) writeFileSync(path.join(state, "core-version"), opts.core);
  writeFileSync(path.join(state, "calls"), "");

  const write = (name: string, body: string) => {
    const p = path.join(bin, name);
    writeFileSync(p, `#!/usr/bin/env bash\nST=${JSON.stringify(state)}\n${body}`);
    chmodSync(p, 0o755);
  };

  // A box with no node at all answers 127, exactly as a missing binary does —
  // so `$(node -p …)` is empty and the guard's own `-n` test is what decides.
  write("node", `
v="$(cat "$ST/node-version" 2>/dev/null || true)"
[ -n "$v" ] || { echo "node: command not found" >&2; exit 127; }
case "\${1:-}" in
  --version) printf 'v%s\\n' "$v" ;;
  *) printf '%s' "$v" ;;
esac
`);

  // The NodeSource setup script, which is a script: curl prints it and the
  // caller pipes it into bash. All it does on a box is configure the apt
  // channel — so that is all it does here, and which channel it configured is
  // what decides what apt installs next.
  write("curl", `
url=""
for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
printf 'curl %s\\n' "$url" >> "$ST/calls"
case "$url" in
  *deb.nodesource.com/setup_*)
    major="\${url##*setup_}"; major="\${major%%.x*}"
    printf 'printf %%s %s > %s\\n' "$major" "$ST/channel"
    ;;
esac
`);

  // apt only ever moves a package UP unless it is told otherwise. NodeSource
  // pins its repo at priority 600, under the 1000 apt wants before it will pick
  // a lower version, so `apt-get install nodejs` on a host whose major is above
  // the configured channel reports "already the newest version" and changes
  // nothing. Modelled, because the new engine table has a ceiling and that is
  // the one transition the installer can ask for and not get.
  write("apt-get", `
printf 'apt-get %s\\n' "$*" >> "$ST/calls"
case " $* " in
  *" nodejs "*|*" nodejs"*)
    channel="$(cat "$ST/channel" 2>/dev/null || true)"
    case "$channel" in
      22) offered='22.23.2' ;;
      24) offered='24.21.0' ;;
      26) offered='26.8.2' ;;
      # No NodeSource channel configured: apt serves the distro package, which
      # is what the comment in step_apt_update warns about.
      *) offered='12.22.9' ;;
    esac
    have="$(cat "$ST/node-version" 2>/dev/null || true)"
    allow=0
    case " $* " in *" --allow-downgrades "*) allow=1 ;; esac
    case " $* " in *"nodejs="*) allow=1 ;; esac
    if [ -n "$have" ] && [ "$allow" -eq 0 ] \
      && [ "\${have%%.*}" -gt "\${offered%%.*}" ] 2>/dev/null; then
      printf 'apt-get: nodejs is already the newest version (%s).\\n' "$have"
      exit 0
    fi
    printf '%s' "$offered" > "$ST/node-version"
    ;;
esac
exit 0
`);

  // Every npm line is logged WITH the Node in place at that moment: that pair
  // is the whole claim — the core was installed onto Node 24, not merely after
  // some apt transaction.
  write("npm", `
printf 'npm %s node=%s\\n' "$*" "$(cat "$ST/node-version" 2>/dev/null || echo none)" >> "$ST/calls"
for a in "$@"; do
  case "$a" in
    openclaw@*) printf '%s' "\${a#openclaw@}" > "$ST/core-version" ;;
  esac
done
exit 0
`);

  // apt's two answers about nodejs, modelled the way apt really answers them on
  // the host the remedy is for — which is the whole point of this stub.
  //
  // `policy` reports the INSTALLED version as the candidate whenever the
  // installed one is higher: apt will not select a lower version at NodeSource's
  // priority. So on a Node 25 host the candidate IS the runtime the core
  // refuses, and a remedy built from it reinstalls the problem. `madison` lists
  // what the configured repositories offer, which is where an acceptable version
  // can actually be found.
  write("apt-cache", `
verb="\${1:-}"
have="$(cat "$ST/node-version" 2>/dev/null || echo none)"
channel="$(cat "$ST/channel" 2>/dev/null || true)"
case "$verb" in
  policy)
    printf 'nodejs:\\n  Installed: %s-1nodesource1\\n  Candidate: %s-1nodesource1\\n' "$have" "$have" ;;
  madison)
    case "$channel" in
      22) printf '   nodejs | 22.23.2-1nodesource1 | https://deb.nodesource.com/node_22.x nodistro/main arm64 Packages\\n' ;;
      24) printf '   nodejs | 24.21.0-1nodesource1 | https://deb.nodesource.com/node_24.x nodistro/main arm64 Packages\\n' ;;
      26) printf '   nodejs | 26.8.2-1nodesource1 | https://deb.nodesource.com/node_26.x nodistro/main arm64 Packages\\n' ;;
    esac
    # The installed one is on offer too, from the channel it came from, and it is
    # the highest — so a pick that is not filtered by the engine table lands on it.
    printf '   nodejs | %s-1nodesource1 | https://deb.nodesource.com/node_%s.x nodistro/main arm64 Packages\\n' "$have" "\${have%%.*}"
    printf '   nodejs | 18.19.1+dfsg-6ubuntu5 | http://ports.ubuntu.com jammy/universe arm64 Packages\\n' ;;
esac
`);

  const openclawBin = path.join(npmPrefix, "bin", "openclaw");
  writeFileSync(openclawBin, `#!/usr/bin/env bash
ST=${JSON.stringify(state)}
printf 'openclaw %s node=%s\\n' "$*" "$(cat "$ST/node-version" 2>/dev/null || echo none)" >> "$ST/calls"
case "$1" in
  --version) printf 'OpenClaw %s (stub)\\n' "$(cat "$ST/core-version" 2>/dev/null || echo none)" ;;
  plugins) printf '{"plugins":[]}\\n' ;;
esac
exit 0
`);
  chmodSync(openclawBin, 0o755);
  // An upgrade starts with the OLD core on disk; a fresh install has none.
  if (!opts.core) rmSync(openclawBin);

  return {
    dir, state, bin, npmPrefix, openclawBin,
    calls: () => readFileSync(path.join(state, "calls"), "utf-8").split("\n").filter(Boolean),
    nodeVersion: () => (existsSync(path.join(state, "node-version"))
      ? readFileSync(path.join(state, "node-version"), "utf-8") : "none"),
    coreVersion: () => (existsSync(path.join(state, "core-version"))
      ? readFileSync(path.join(state, "core-version"), "utf-8") : "none"),
  };
}

/** Everything install.sh's own file provides, and nothing the test invents. */
const SHIPPED = [
  assignment("OPENCLAW_VERSION"),
  assignment("OPENCLAW_NODE_ENGINE"),
  shellFunction("node_version_satisfies_openclaw_engine"),
  shellFunction("node_satisfies_openclaw_engine"),
  shellFunction("node_engine_remedy"),
  shellFunction("ensure_openclaw_node_engine"),
  shellFunction("openclaw_version_is_v2"),
  shellFunction("openclaw_is_v2"),
  // The migration verdict is pure rc-and-text logic (#818), so it is lifted
  // rather than stubbed: whether doctor is judged to have completed decides
  // whether this step goes on, and that judgement must be the shipped one.
  shellFunction("openclaw_migration_complete"),
];

/** The ambient helpers the sliced steps call, stubbed to do nothing of note. */
const AMBIENT = [
  "wait_for_apt() { :; }",
  "ensure_clawbox_bashrc_path() { :; }",
  "is_hermes_edition() { return 1; }",
  "chown() { :; }",
  'systemctl() { printf "systemctl %s\\n" "$*" >> "$ST/calls"; }',
  // `as_clawbox -H cmd …` runs cmd as the service user; here it just runs it.
  'as_clawbox() { while [ "${1:-}" = "-H" ]; do shift; done; "$@"; }',
  // #818 stops both gateway units before the core install and restores them at
  // the end. Stubbed, not lifted: it is systemd and user-manager bookkeeping,
  // nothing to do with which Node the core lands on, and lifting it would drag
  // `systemctl show`, `id` and the user bus into a suite about ordering. Logged,
  // so a case can still see that it happened before the npm install.
  'stop_openclaw_gateways_for_migration() { printf "stop-gateways-for-migration\\n" >> "$ST/calls"; }',
];

function run(box: Box, step: "step_openclaw_install" | "step_apt_update"): SpawnSyncReturns<string> {
  const program = [
    "set -uo pipefail",
    `ST=${JSON.stringify(box.state)}`,
    `SRC_DIR=${JSON.stringify(REPO)}`,
    `CLAWBOX_HOME=${JSON.stringify(box.dir)}`,
    `CLAWBOX_USER=${JSON.stringify(process.env.USER ?? "clawbox")}`,
    `NPM_PREFIX=${JSON.stringify(box.npmPrefix)}`,
    `OPENCLAW_BIN=${JSON.stringify(box.openclawBin)}`,
    ...SHIPPED,
    ...AMBIENT,
    shellFunction(step),
    step,
  ].join("\n");
  return spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    timeout: 20_000,
    env: { ...process.env, PATH: `${box.bin}:${process.env.PATH ?? ""}` },
  });
}

/** Index of the first logged call matching a substring, -1 when absent. */
function at(calls: string[], needle: string): number {
  return calls.findIndex((c) => c.includes(needle));
}

describe("the Node 22 → 24 switch inside the updater", () => {
  // ASSERTED, NOT SKIPPED ON — same reason as the engine-table suite: the order
  // of the switch is what this file exists to hold in place, and a silent skip
  // would let it ship unmeasured.
  it("has the bash, dpkg and python3 the shipped step itself uses", () => {
    expect(HAS_BASH).toBe(true);
    expect(HAS_DPKG).toBe(true);
    expect(HAS_PYTHON3).toBe(true);
  });

  it("installs Node 24 before it installs the pinned core", () => {
    // The customer path: a unit on the shipped image (Node 22.23.2, core
    // 2026.8.1) told to update. `bootstrap_updater` has already refreshed
    // install.sh, so the step running here is this one.
    const box = makeBox({ node: "22.23.2", core: "2026.8.1" });

    const r = run(box, "step_openclaw_install");
    const calls = box.calls();

    expect(r.status, r.stderr).toBe(0);
    const channel = at(calls, "deb.nodesource.com/setup_24.x");
    const apt = at(calls, "apt-get install -y -qq nodejs");
    const core = at(calls, "npm install -g openclaw@");
    expect(channel, `no NodeSource 24 channel was configured:\n${calls.join("\n")}`)
      .toBeGreaterThanOrEqual(0);
    expect(apt).toBeGreaterThan(channel);
    expect(core, `the core was never installed:\n${calls.join("\n")}`).toBeGreaterThan(apt);
    // Where the two changes meet: #818 stops both gateway units before the core
    // install, and the Node switch happens before that — a running gateway keeps
    // its mapped binary until the reboot, so the apt transaction does not need it
    // down, and bringing the stop forward would only lengthen the outage.
    expect(at(calls, "stop-gateways-for-migration")).toBeGreaterThan(apt);
    expect(at(calls, "stop-gateways-for-migration")).toBeLessThan(core);
    // The pair that matters: the core went on under Node 24, not under 22.
    expect(calls[core]).toContain(`openclaw@${TARGET}`);
    expect(calls[core]).toContain("node=24.21.0");
    expect(box.nodeVersion()).toBe("24.21.0");
    expect(box.coreVersion()).toBe(TARGET);
  });

  it("runs the new core's first command on the new Node", () => {
    // `doctor --fix --non-interactive` is the migration owner (config v2 keys,
    // sessions into SQLite). On Node 22 the 2026.9.3 CLI exits 1 before doing
    // any of it, and the step's WARN branch would report a doctor that merely
    // "did not complete" over a box whose runtime is simply too old.
    const box = makeBox({ node: "22.23.2", core: "2026.8.1" });

    run(box, "step_openclaw_install");
    const calls = box.calls();

    const doctor = calls.findIndex((c) => c.startsWith("openclaw doctor --fix"));
    expect(doctor, `doctor never ran:\n${calls.join("\n")}`).toBeGreaterThanOrEqual(0);
    expect(calls[doctor]).toContain("node=24.21.0");
    expect(doctor).toBeGreaterThan(at(calls, "npm install -g openclaw@"));
  });

  it("never configures the retired Node 22 channel, on either path", () => {
    // A fresh flash: no node on the image at all, no core installed. This is
    // the other half of the same switch (`step_apt_update`), and the one an
    // e2e-install run exercises first.
    const fresh = makeBox({ node: null, core: null });
    const upgrade = makeBox({ node: "22.23.2", core: "2026.8.1" });

    const freshRun = run(fresh, "step_apt_update");
    run(upgrade, "step_openclaw_install");

    expect(freshRun.status, freshRun.stderr).toBe(0);
    for (const box of [fresh, upgrade]) {
      const joined = box.calls().join("\n");
      expect(joined).not.toContain("setup_22.x");
      expect(joined).toContain("deb.nodesource.com/setup_24.x");
    }
    expect(fresh.nodeVersion()).toBe("24.21.0");
  });

  it("leaves a box that already has a satisfying Node alone", () => {
    // Idempotence, and the reason this guard is cheap enough to sit in two
    // steps: a unit already on 24.21.0 must not take an apt transaction on
    // every update run.
    const box = makeBox({ node: "24.21.0", core: TARGET });

    const r = run(box, "step_openclaw_install");
    const calls = box.calls();

    expect(r.status, r.stderr).toBe(0);
    expect(calls.join("\n")).not.toContain("deb.nodesource.com");
    expect(calls.join("\n")).not.toContain("apt-get");
    // …and the core is not reinstalled either, because it is already at target.
    expect(at(calls, "npm install -g")).toBe(-1);
  });

  it("fails the step when the installed core refuses the Node it was put on", () => {
    // FALSE SUCCESS, refused. Our engine table is a copy of `engines.node`, and
    // the next pin whose floor moves again (or an OPENCLAW_PIN_VERSION override
    // to a core with a different one) passes a stale table. The core then says so
    // itself on its very first invocation — and that sentence used to go to
    // /dev/null behind `|| echo 'unknown version'`, leaving the step to walk on
    // into a WARN-only doctor and a gateway that never comes up.
    const box = makeBox({ node: "24.21.0", core: "2026.8.1" });
    // A core that rejects this Node the way a real one does: the banner on
    // stderr and a non-zero exit on every subcommand.
    writeFileSync(box.openclawBin, `#!/usr/bin/env bash
ST=${JSON.stringify(box.state)}
printf 'openclaw %s node=%s\n' "$*" "$(cat "$ST/node-version" 2>/dev/null || echo none)" >> "$ST/calls"
echo "Node.js >=26.9.0 is required (current: v$(cat "$ST/node-version"))" >&2
exit 1
`);
    chmodSync(box.openclawBin, 0o755);
    writeFileSync(path.join(box.npmPrefix, "lib", "node_modules", "openclaw", "package.json"),
      JSON.stringify({ name: "openclaw", version: TARGET, engines: { node: ">=26.9.0" } }));

    const r = run(box, "step_openclaw_install");

    expect(r.status).not.toBe(0);
    // The core's own sentence reaches the log, and the disagreement is named.
    expect(r.stderr).toContain("Node.js >=26.9.0 is required");
    expect(r.stderr).toContain("refuses to run on");
    expect(r.stderr).toContain("engines.node >=26.9.0");
    // …and the step stopped there rather than running doctor over it, saying so
    // rather than leaving the operator to discover a parked gateway.
    expect(r.stderr).toContain("The gateway is left stopped");
    expect(box.calls().join("\n")).not.toContain("openclaw doctor");
  });

  it("says what to do on a host apt cannot bring DOWN to the range", () => {
    // The population the new ceiling creates: a dev or demo machine on Node 25.x
    // (or 26.0.x), which the old table accepted and this one does not. apt will
    // not lower the package, so the step cannot fix it by itself — and a bare
    // "did not reach an OpenClaw-compatible version" would be a dead end on the
    // one box where the operator has to choose. No shipped unit is here: the
    // fleet is on 22 and moves up.
    const box = makeBox({ node: "25.9.0", core: "2026.8.1" });

    const r = run(box, "step_openclaw_install");

    expect(r.status).not.toBe(0);
    // The transaction was attempted and honestly got nowhere.
    expect(box.calls().join("\n")).toContain("deb.nodesource.com/setup_24.x");
    expect(box.nodeVersion()).toBe("25.9.0");
    expect(r.stderr).toContain("is ABOVE the range");
    // The version named must be one the box will ACCEPT afterwards. `apt-cache
    // policy`'s candidate here is the installed 25.9.0 — apt cannot select a
    // lower one — so a remedy built from the candidate would hand the operator a
    // command that reinstalls the runtime the core refuses.
    expect(r.stderr).toContain("--allow-downgrades nodejs=24.21.0-1nodesource1");
    expect(r.stderr).not.toContain("nodejs=25.9.0");
    // …and nothing was installed over it.
    expect(box.calls().join("\n")).not.toContain("npm install -g openclaw@");
    expect(box.coreVersion()).toBe("2026.8.1");
  });

  it("points a 26.0.x host up rather than down", () => {
    // 26.1.0 is inside the range, so the cheap way out of 26.0.x is the 26
    // channel — an upgrade apt CAN perform — and the message says so first.
    const box = makeBox({ node: "26.0.0", core: "2026.8.1" });

    const r = run(box, "step_openclaw_install");

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("deb.nodesource.com/setup_26.x");
    expect(r.stderr).toContain("26.1.0 and newer are accepted");
  });

  it("fails loudly when the apt transaction lands on a Node the core refuses", () => {
    // FALSE SUCCESS, refused: apt can serve the distro's own nodejs when the
    // NodeSource channel could not be configured (a lost apt lock, a proxy
    // rewriting the setup script). The step must not go on to install a core
    // that cannot start — it has to stop and say which Node it found.
    const box = makeBox({ node: "22.23.2", core: "2026.8.1" });
    // Make the channel unconfigurable: curl answers nothing, so `bash -` reads
    // an empty script and apt serves the distro package.
    writeFileSync(path.join(box.bin, "curl"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(path.join(box.bin, "curl"), 0o755);

    const r = run(box, "step_openclaw_install");

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("did not reach an OpenClaw-compatible version");
    expect(r.stderr).toContain(">=24.16.0 <25, or >=26.1.0");
    expect(box.calls().join("\n")).not.toContain("npm install -g openclaw@");
    expect(box.coreVersion()).toBe("2026.8.1");
  });
});
