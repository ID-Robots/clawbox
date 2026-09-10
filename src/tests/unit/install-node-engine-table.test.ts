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
 * The pinned core's `engines.node` moved with 2026.9.3:
 *
 *   2026.8.1  >=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0
 *   2026.9.3  >=24.16.0 <25 || >=26.1.0
 *
 * (read off the registry, 2026-09-10). Node 22 is not merely deprecated there —
 * every `openclaw` command exits 1 under it with a requirement banner, because
 * `node:sqlite` truncates a TEXT value at an embedded NUL on 22.23.x, 24.15.0,
 * 25.9.0 and 26.0.0, and the first fixed builds are 24.16.0 and 26.1.0.
 *
 * So a guard that still accepts Node 22 does not just mis-report: it installs
 * Node 22 (`ensure_openclaw_node_engine`) and then installs a core that cannot
 * run on it, leaving the box with a gateway that never comes up. The three
 * versions that matter are therefore pinned as REJECTED here — `v22.23.2` (what
 * every shipped image has), `v24.15.0` (the old floor, and what install-x64's
 * verified tarball used to fetch) and `v26.0.0` — and the table is run, not
 * read, so a future edit to either installer's `case` is measured.
 *
 * Both installers are held to the SAME table: arm64 boxes take install.sh and
 * the x64 dev/demo path takes install-x64.sh, and they install the same core.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INSTALLERS = {
  "install.sh": readFileSync(path.join(REPO, "install.sh"), "utf-8"),
  "install-x64.sh": readFileSync(path.join(REPO, "install-x64.sh"), "utf-8"),
} as const;

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
 * Ask the shipped guard about one Node version.
 *
 * The version reaches it the way it reaches it on a box: the function asks the
 * `node` on PATH for `process.versions.node`, so the stub answers that and
 * nothing else is faked — `dpkg --compare-versions` is the real one.
 */
function accepts(installer: keyof typeof INSTALLERS, version: string): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), "clawbox-node-engine-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const stub = path.join(bin, "node");
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s' ${JSON.stringify(version)}\n`);
  chmodSync(stub, 0o755);
  const r = spawnSync(
    "bash",
    ["-c", [shellFunction(INSTALLERS[installer], "node_satisfies_openclaw_engine"),
      "node_satisfies_openclaw_engine"].join("\n")],
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, encoding: "utf-8" },
  );
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`guard crashed (status ${r.status}): ${r.stderr}`);
  }
  return r.status === 0;
}

/** Exactly the published `engines.node` of the pinned core, as a table. */
const REJECTED = [
  "22.22.2", // below even the old 22 floor
  "22.22.3", // the OLD floor: accepted by 2026.8.1, refused by 2026.9.3
  "22.23.2", // what every shipped ClawBox image runs today
  "23.11.0", // 23 was never in any of these ranges
  "24.15.0", // the old 24 floor — one patch below the NUL fix
  "25.9.0", // inside the retired `>=25.9.0` arm; `<25` now excludes all of 25
  "26.0.0", // 26 is allowed only from 26.1.0
] as const;

const ACCEPTED = [
  "24.16.0", // the floor itself
  "24.21.0", // the LTS build the installers provision
  "26.1.0", // the floor of the other allowed line
  "26.8.2", // current 26.x
  "27.0.0", // the next major above the open-ended `>=26.1.0`
  "100.0.0", // three digits: the case a two-digit-only pattern rejected
] as const;

describe("install.sh / install-x64.sh Node engine table", () => {
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
      expect(source).toContain('OPENCLAW_NODE_ENGINE=">=24.16.0 <25, or >=26.1.0"');
      expect(source).not.toMatch(/requires Node >=22/);
    }
  });

  it("fetches the NodeSource channel of the major it accepts, and never the retired one", () => {
    // A guard that rejects 22 while the install line still pipes `setup_22.x`
    // is the worst of both: the box takes the apt transaction, lands on a Node
    // the guard refuses, and the step exits 1 having replaced the runtime.
    for (const [name, source] of Object.entries(INSTALLERS)) {
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
    const m = /^NODE_DIST_VERSION="([^"]+)"/m.exec(INSTALLERS["install-x64.sh"]);
    expect(m, "NODE_DIST_VERSION not found").not.toBeNull();
    expect(accepts("install-x64.sh", m![1])).toBe(true);
  });

  it("pins the same core version in both installers and in the pin file", () => {
    // `OPENCLAW_VERSION` is only the fallback for a missing pin file, but it is
    // the version a corrupted or partial install lands on, so a stale one there
    // is a box quietly installed onto the previous core — with, now, the wrong
    // Node floor behind it.
    const pinned = readFileSync(path.join(REPO, "config/openclaw-target.txt"), "utf-8").trim();
    expect(pinned).toBe("2026.9.3");
    for (const [name, source] of Object.entries(INSTALLERS)) {
      expect(source, name).toContain(`OPENCLAW_VERSION="${pinned}"`);
    }
  });
});
