import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Starts a real bash per case: vitest's 5 s test and 10 s hook defaults are not
// enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * TASK-788 — the Node engine floor both installers hold the box to.
 *
 * The pinned core's `engines.node` moved with 2026.9.3, and again with 2026.10.6:
 *
 *   2026.8.1   >=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0
 *   2026.9.3   >=24.16.0 <25 || >=26.1.0
 *   2026.10.6  >=24.22.1 <25 || >=26.12.1
 *
 * (read off the registry, 2026-09-10 and 2026-10-22). Node 22 is not merely
 * deprecated there — every `openclaw` command exits 1 under it with a
 * requirement banner, because `node:sqlite` truncates a TEXT value at an
 * embedded NUL on 22.23.x, 24.15.0, 25.9.0 and 26.0.0, and the first fixed
 * builds are 24.16.0 and 26.1.0. 2026.10.6 then moved both floors to the
 * October 2026 Node.js security releases, which reject TLS chains signed with
 * compromised certificate keys, so 24.16.0–24.22.0 and 26.1.0–26.12.0 are
 * refused too.
 *
 * So a guard that still accepts Node 22 does not just mis-report: it installs
 * Node 22 (`ensure_openclaw_node_engine`) and then installs a core that cannot
 * run on it, leaving the box with a gateway that never comes up. The three
 * versions that matter are therefore pinned as REJECTED here — `v22.23.2` (what
 * every shipped image has), `v24.15.0` (an old floor, and what install-x64's
 * verified tarball used to fetch), `v24.22.0` (one patch below today's floor)
 * and `v26.0.0` — and the table is run, not read, so a future edit to either
 * installer's `case` is measured.
 *
 * Both installers are held to the SAME table: arm64 boxes take install.sh and
 * the x64 dev/demo path takes install-x64.sh, and they install the same core.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INSTALLERS = {
  "install.sh": readFileSync(path.join(REPO, "install.sh"), "utf-8"),
  "install-x64.sh": readFileSync(path.join(REPO, "install-x64.sh"), "utf-8"),
  // The x64 integration package's root step carries the third copy: it asks
  // the Node the PACKAGE names (`$NODE_DIR/node`, as the owner) before npm
  // stages a core on it — a package rebuilt without --node-dir once pointed it
  // at the distro's Node 22, and the refusal was npm's, naming no repair.
  "scripts/x64-migration/clawbox-x64-step.sh": readFileSync(
    path.join(REPO, "scripts/x64-migration/clawbox-x64-step.sh"),
    "utf-8",
  ),
} as const;

/** build-package.py's Python copy of the same table; test_integration.py runs it, this suite holds its text. */
const BUILDER = readFileSync(path.join(REPO, "scripts/x64-migration/build-package.py"), "utf-8");

const HAS_BASH = spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const HAS_DPKG = spawnSync("dpkg", ["--version"], { stdio: "ignore" }).status === 0;

/** A shell function lifted out of an installer, so the test cannot drift from it. */
function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${source.slice(start, end)}\n}`;
}

/**
 * The same, for a function a tree may not have yet.
 *
 * An absent one becomes nothing rather than an error, so this suite still RUNS
 * against a tree that predates the split between the table and its caller and
 * fails on what the shipped guard ANSWERED — which is how its own red was
 * demonstrated against beta.
 */
function optionalShellFunction(source: string, name: string): string {
  return source.includes(`${name}() {`) ? shellFunction(source, name) : "";
}

/**
 * Ask the shipped guard about one Node version.
 *
 * Every version in the matrix is asked in ONE bash per installer, not one per
 * case: the shipped functions are sourced once and the loop drives them over the
 * whole list. The answers are then read per `it`, so a failure still names the
 * version it is about. Two spawns rather than twenty-six — this suite shares the
 * `test` job with a thousand component files, and a five-second default timeout
 * somewhere else is not a budget to spend on process startup.
 *
 * The version reaches the guard the way it reaches it on a box: the function
 * asks the `node` on PATH for `process.versions.node`, so the stub answers that
 * from a file the loop rewrites, and nothing else is faked —
 * `dpkg --compare-versions` is the real one.
 */
const VERDICTS = new Map<keyof typeof INSTALLERS, Map<string, boolean>>();

/**
 * install-x64's verified-tarball version, asked in the same batch.
 *
 * In the list rather than asked separately, so a future edit to that constant is
 * measured by the same run instead of falling outside the matrix.
 */
const DIST_VERSION = (() => {
  const m = /^NODE_DIST_VERSION="([^"]+)"/m.exec(INSTALLERS["install-x64.sh"]);
  if (!m) throw new Error("NODE_DIST_VERSION not found in install-x64.sh");
  return m[1];
})();

function verdicts(installer: keyof typeof INSTALLERS): Map<string, boolean> {
  const cached = VERDICTS.get(installer);
  if (cached) return cached;

  const dir = mkdtempSync(path.join(tmpdir(), "clawbox-node-engine-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const asked = path.join(dir, "version");
  const stub = path.join(bin, "node");
  writeFileSync(stub, `#!/usr/bin/env bash\ncat ${JSON.stringify(asked)}\n`);
  chmodSync(stub, 0o755);

  const source = INSTALLERS[installer];
  const program = [
    // The step asks through `as_owner` (runuser as the desktop owner): here it
    // is the stub itself, asked directly.
    'as_owner() { "$@"; }',
    optionalShellFunction(source, "node_version_satisfies_openclaw_engine"),
    shellFunction(source, "node_satisfies_openclaw_engine"),
    `for v in ${[...REJECTED, ...ACCEPTED, DIST_VERSION].join(" ")}; do`,
    `  printf '%s' "$v" > ${JSON.stringify(asked)}`,
    '  if node_satisfies_openclaw_engine; then printf "%s=yes\\n" "$v"; else printf "%s=no\\n" "$v"; fi',
    "done",
  ].join("\n");
  const r = spawnSync("bash", ["-c", program], {
    // NODE_DIR is what the x64 step asks; the installers ask the node on PATH.
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, NODE_DIR: bin },
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`the guard could not be run (status ${r.status}): ${r.stderr}`);

  const map = new Map<string, boolean>();
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const [version, verdict] = line.split("=");
    map.set(version, verdict === "yes");
  }
  VERDICTS.set(installer, map);
  return map;
}

/** What the shipped guard answered about one version. */
function accepts(installer: keyof typeof INSTALLERS, version: string): boolean {
  const map = verdicts(installer);
  const answer = map.get(version);
  if (answer === undefined) {
    // A version asked about outside the matrix above would silently read as
    // "rejected" from a missing map entry, which is how a green suite stops
    // testing anything.
    throw new Error(`${version} is not in the matrix the batch run covers`);
  }
  return answer;
}

/** Exactly the published `engines.node` of the pinned core, as a table. */
const REJECTED = [
  "22.22.2", // below even the old 22 floor
  "22.22.3", // the OLD floor: accepted by 2026.8.1, refused by 2026.9.3
  "22.23.2", // what every shipped ClawBox image runs today
  "23.11.0", // 23 was never in any of these ranges
  "24.15.0", // an old 24 floor — one patch below the NUL fix
  "24.16.0", // the 2026.9.3 floor: has the NUL fix, not the TLS one
  "24.21.0", // what the installers provisioned before 2026.10.6
  "24.22.0", // one patch below the October 2026 security release
  "25.9.0", // inside the retired `>=25.9.0` arm; `<25` now excludes all of 25
  "26.0.0", // 26 is allowed only from 26.12.1
  "26.1.0", // the 2026.9.3 floor of the 26 line
  "26.12.0", // one patch below the 26 line's security release
] as const;

const ACCEPTED = [
  "24.22.1", // the floor itself, and the LTS build the installers provision
  "24.23.0", // a later 24 minor
  "26.12.1", // the floor of the other allowed line
  "26.13.0", // a later 26 minor
  "27.0.0", // the next major above the open-ended `>=26.12.1`
  "100.0.0", // three digits: the case a two-digit-only pattern rejected
] as const;

describe("install.sh / install-x64.sh / clawbox-x64-step.sh Node engine table", () => {
  // ASSERTED, NOT SKIPPED ON, the way email-directive-parity.test.ts puts it:
  // `describe.skip` on a missing tool turns the only proof of the engine floor
  // into a green no-op, and the next edit to either `case` table would ship
  // unmeasured with nothing saying so. Both are present on any Debian-family
  // runner, which is every runner this repo uses, so this costs nothing where it
  // runs and is loud where it would otherwise be silent.
  it("has the bash and dpkg the shipped guard itself uses", () => {
    expect(HAS_BASH).toBe(true);
    expect(HAS_DPKG).toBe(true);
  });

  for (const installer of Object.keys(INSTALLERS) as (keyof typeof INSTALLERS)[]) {
    describe(installer, () => {
      for (const version of REJECTED) {
        it(`rejects Node ${version}`, () => {
          expect(accepts(installer, version)).toBe(false);
        });
      }
      for (const version of ACCEPTED) {
        it(`accepts Node ${version}`, () => {
          expect(accepts(installer, version)).toBe(true);
        });
      }
    });
  }

  it("states the requirement once per installer, and states the same one", () => {
    // The failure messages used to spell the range out by hand, which is how a
    // guard and its own error message come to disagree after a bump. One
    // variable, and the same text in both installers.
    for (const source of Object.values(INSTALLERS)) {
      expect(source).toContain('OPENCLAW_NODE_ENGINE=">=24.22.1 <25, or >=26.12.1"');
      expect(source).not.toMatch(/requires Node >=22/);
    }
    expect(BUILDER).toContain('OPENCLAW_NODE_ENGINE = ">=24.22.1 <25, or >=26.12.1"');
  });

  it("fetches the NodeSource channel of the major it accepts, and never the retired one", () => {
    // A guard that rejects 22 while the install line still pipes `setup_22.x`
    // is the worst of both: the box takes the apt transaction, lands on a Node
    // the guard refuses, and the step exits 1 having replaced the runtime.
    // The two INSTALLERS only: the x64 step installs no Node at all (the
    // package names one, and the step refuses a core on the wrong one).
    for (const name of ["install.sh", "install-x64.sh"] as const) {
      const source = INSTALLERS[name];
      expect(source, name).toContain("deb.nodesource.com/setup_24.x");
      expect(source, name).not.toContain("setup_22.x");
    }
  });

  it("leaves the e2e image on the Node every field unit starts from", () => {
    // The opposite of the rule above, on purpose: the e2e-install image models a
    // box BEFORE the update, so it stays on 22 and CI performs the real switch.
    // An image baked with 24 satisfies the guard on its first call and the apt
    // transaction never runs in CI at all.
    const dockerfile = readFileSync(path.join(REPO, "e2e-install/Dockerfile"), "utf-8");
    expect(dockerfile).toContain("deb.nodesource.com/setup_22.x");
    expect(dockerfile).toContain("performs a Node MAJOR upgrade");
  });

  it("keeps install-x64's verified tarball above the floor", () => {
    // `NODE_DIST_VERSION` is the fallback for a machine whose apt cannot
    // deliver NodeSource's package. It is fetched, checksummed, and then put
    // through the very guard above — so a value below the floor turns the
    // fallback into a guaranteed `exit 1` on exactly the machines that need it.
    expect(accepts("install-x64.sh", DIST_VERSION), DIST_VERSION).toBe(true);
  });

  // The pin itself — one source, every fallback equal to it, its state-schema
  // row — is guarded in harness-pins.test.ts; the pinned package's own
  // `engines.node` is checked against OPENCLAW_NODE_ENGINE by the
  // harness-contract CI job.
});
