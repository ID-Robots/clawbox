/**
 * @vitest-environment node
 *
 * Disk-backed swap, added to every install and every update on 2026-09-06.
 *
 * The board ships with zram alone (nvzramconfig: one compressed device per
 * core, half of RAM). zram is a compression ratio and never capacity — its
 * pages live in RAM — so a box that genuinely needs more memory than it has
 * still dies: on 2026-09-05 an owner's in-app update was OOM-killed at
 * `next build`, 4.6 GB resident, with the desktop session also up, and the
 * update ended on a restored previous build.
 *
 * `step_swapfile` adds a file on the disk at a priority BELOW zram's, so the
 * compressed devices stay the kernel's first choice and the file is reserve.
 * What is pinned here: it runs on both flows, it is idempotent, it never
 * fails the install, it refuses a disk that cannot spare the room, and it
 * survives a reboot through /etc/fstab. The behaviour is exercised against a
 * REAL bash with swapon/mkswap/df stubbed — a container cannot swap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Starts a real bash: vitest's 5 s test and 10 s hook defaults are not enough
// on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const NL = String.fromCharCode(10);

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf(`${NL}}`, start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return INSTALL_SH.slice(start, end + 2);
}

/** Comments quote the failure being prevented; assertions must not read them. */
function shellCode(fn: string): string {
  return fn.split(NL).filter((line) => !line.trim().startsWith("#")).join(NL);
}

const STEP = extractShellFunction("step_swapfile");
const FSTAB_FN = extractShellFunction("ensure_swapfile_fstab");
const IN_CONTAINER = extractShellFunction("in_container");

/**
 * The real binaries the step shells out to, resolved ONCE against this
 * machine's PATH. The sandbox's PATH is built from these rather than
 * inherited, so the only `systemd-detect-virt` a case can reach is the stub it
 * asked for — and `spawnSync` resolves the shell itself through the CHILD's
 * PATH, which is why bash is on the list too.
 */
const REAL_TOOLS: Record<string, string> = (() => {
  const found: Record<string, string> = {};
  for (const tool of ["bash", "sh", "grep", "awk", "tail", "tr", "dd", "chmod", "chown", "rm", "wc", "cat"]) {
    const probe = spawnSync("/usr/bin/env", ["sh", "-c", `command -v ${tool}`], { encoding: "utf-8" });
    const real = probe.stdout.trim();
    if (real) found[tool] = real;
  }
  return found;
})();
const BASH = REAL_TOOLS.bash ?? "/bin/bash";

let tmp: string;

/**
 * Run step_swapfile against a sandbox: its own fstab and root, with swapon,
 * mkswap, df and free stubbed on PATH. `swapState` seeds what swapon reports.
 */
function runStep(opts: {
  availGb: number;
  existingFile?: "active" | "present" | "none";
  swaponFails?: boolean;
  testMode?: boolean;
  container?: boolean;
  /**
   * Which of the configured marker paths actually exists. Default: both.
   * A case that writes every marker cannot tell a probe that reads the whole
   * list from one that stops at the first path, so the fallback cases name
   * one marker each.
   */
  containerMarkers?: number[];
  detectVirtMissing?: boolean;
  readOnlyFstab?: boolean;
  fstab?: string;
}) {
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin, { recursive: true });
  // One test runs the step twice; each run's calls are its own.
  fs.rmSync(path.join(tmp, "calls"), { force: true });
  const fstab = path.join(tmp, "fstab");
  fs.writeFileSync(fstab, opts.fstab ?? "/dev/nvme0n1p1 / ext4 defaults 0 1\n");
  const swapfile = path.join(tmp, "swapfile");
  if (opts.existingFile && opts.existingFile !== "none") fs.writeFileSync(swapfile, "x");

  const stub = (name: string, body: string) => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  };
  stub("swapon", opts.existingFile === "active"
    ? `if [ "$1" = "--show=NAME" ]; then echo "${swapfile}"; exit 0; fi\nif [ "$1" = "--show=NAME,SIZE" ]; then echo "${swapfile} 8G"; exit 0; fi\nif [ "$1" = "--show=NAME,SIZE,USED,PRIO" ]; then echo "${swapfile} 8G 0B 1"; exit 0; fi\necho "swapon $*" >> "${tmp}/calls"; exit 0`
    : `if [[ "$1" == --show* ]]; then exit 0; fi\necho "swapon $*" >> "${tmp}/calls"; exit ${opts.swaponFails ? 1 : 0}`);
  stub("mkswap", `echo "mkswap $*" >> "${tmp}/calls"; exit 0`);
  stub("df", `echo "Avail"; echo "${opts.availGb}G"`);
  stub("free", `echo "Swap: 11Gi 1Gi 10Gi"`);
  stub("fallocate", `echo "fallocate $*" >> "${tmp}/calls"; : > "\${!#}"; exit 0`);
  // The container probe answers through systemd-detect-virt on a real box.
  if (!opts.detectVirtMissing) stub("systemd-detect-virt", `exit ${opts.container ? 0 : 1}`);
  // …and falls back to marker files. Point those at the sandbox: read from the
  // real filesystem, every case here would answer "container" whenever the
  // suite itself runs in one, and skip the provisioning it is meant to prove.
  const markerDir = path.join(tmp, "markers");
  fs.mkdirSync(markerDir, { recursive: true });
  const markers = [path.join(markerDir, "dockerenv"), path.join(markerDir, "containerenv")];
  if (opts.container) {
    const present = opts.containerMarkers ?? markers.map((_, i) => i);
    for (const i of present) fs.writeFileSync(markers[i], "");
  }
  if (opts.readOnlyFstab) fs.chmodSync(fstab, 0o444);

  // A PATH of exactly two directories: the stubs, and symlinks to the real
  // tools the step shells out to. The inherited PATH is deliberately NOT on it
  // — with it, `detectVirtMissing` only removed our stub while the box's own
  // systemd-detect-virt stayed reachable, so the marker fallback the case is
  // named for was never the branch that answered.
  const sysbin = path.join(tmp, "sysbin");
  fs.mkdirSync(sysbin, { recursive: true });
  // One test calls runStep twice against the same sandbox.
  for (const [tool, real] of Object.entries(REAL_TOOLS)) {
    const link = path.join(sysbin, tool);
    if (!fs.existsSync(link)) fs.symlinkSync(real, link);
  }

  const script = [
    "set -uo pipefail",
    `CLAWBOX_TEST_MODE=${opts.testMode ? 1 : 0}`,
    `CLAWBOX_CONTAINER_MARKERS=${JSON.stringify(markers.join(" "))}`,
    "is_test_mode() { [ \"$CLAWBOX_TEST_MODE\" = \"1\" ]; }",
    'SWAPFILE_SIZE_GB=8',
    'SWAPFILE_DISK_RESERVE_GB=20',
    'SWAPFILE_PRIORITY=1',
    // The helper reads /etc/fstab too; the sandbox owns both paths.
    shellCode(FSTAB_FN).replace(/\/etc\/fstab/g, fstab),
    // The probe is the real one; only its helper binary is stubbed.
    shellCode(IN_CONTAINER),
    // The step's own path constants are the box's; the sandbox rewrites them.
    shellCode(STEP).replace(/\/swapfile/g, swapfile).replace(/\/etc\/fstab/g, fstab),
    "step_swapfile",
  ].join(NL);

  const res = spawnSync(BASH, ["-c", script], {
    encoding: "utf-8",
    env: { ...process.env, PATH: `${bin}:${sysbin}` },
  });
  return {
    status: res.status,
    out: `${res.stdout}${res.stderr}`,
    calls: fs.existsSync(path.join(tmp, "calls")) ? fs.readFileSync(path.join(tmp, "calls"), "utf-8") : "",
    fstab: fs.readFileSync(fstab, "utf-8"),
    fileExists: fs.existsSync(swapfile),
  };
}

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-swapfile-")); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("step_swapfile runs on both flows and never fails them", () => {
  it("is called by a fresh install and by an in-app update, both non-fatally", () => {
    // Fresh-install-only would leave every box already in the field facing a
    // rebuild with zram alone, which is the box the OOM happened on.
    for (const caller of ["step_system_config", "step_post_update"]) {
      const body = shellCode(extractShellFunction(caller));
      expect(body, `${caller} must call step_swapfile`).toContain("step_swapfile");
      expect(body).toMatch(/step_swapfile \|\| echo/);
    }
  });

  it("puts the file BELOW zram in priority, so the compressed devices stay first", () => {
    // nvzramconfig gives its devices priority 5. A file at a higher priority
    // would take the pages zram compresses for free.
    expect(INSTALL_SH).toMatch(/SWAPFILE_PRIORITY=1\b/);
    expect(shellCode(STEP)).toContain('swapon --priority "$SWAPFILE_PRIORITY"');
  });
});

describe("step_swapfile on a box that can take it", () => {
  it("creates the file, makes it swap, enables it and records it in fstab", () => {
    const r = runStep({ availGb: 400 });
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/fallocate -l 8G/);
    expect(r.calls).toMatch(/mkswap/);
    expect(r.calls).toMatch(/swapon --priority 1/);
    expect(r.fstab).toMatch(/swapfile none swap sw,pri=1 0 0/);
  });

  it("writes exactly one fstab line however often it runs", () => {
    // The update calls it on every run; a duplicate line is a boot warning at
    // best and a double swapon at worst.
    const first = runStep({ availGb: 400 });
    expect(first.fstab.match(/swapfile none swap/g) ?? []).toHaveLength(1);
    const again = runStep({ availGb: 400, existingFile: "active", fstab: first.fstab });
    expect(again.status).toBe(0);
    expect(again.fstab.match(/swapfile none swap/g) ?? []).toHaveLength(1);
    expect(again.calls).not.toMatch(/mkswap/);
  });

  it("re-enables a file that exists but is not swapped on, and never re-makes it", () => {
    // After a reboot on a box whose fstab predates this step.
    const r = runStep({ availGb: 400, existingFile: "present" });
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/swapon --priority 1/);
    expect(r.calls).not.toMatch(/mkswap/);
    expect(r.fstab).toMatch(/swapfile none swap/);
  });
});

describe("step_swapfile stands down rather than harming the box", () => {
  it("refuses a disk that cannot spare the room, and leaves no file behind", () => {
    // 8 GB plus a 20 GB reserve; 4 GB plus the reserve is the fallback.
    const r = runStep({ availGb: 10 });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Skipping swapfile: only 10G free/);
    expect(r.fileExists).toBe(false);
    expect(r.fstab).not.toMatch(/swapfile/);
  });

  it("falls back to a smaller file when the disk is tight but usable", () => {
    const r = runStep({ availGb: 25 });
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/fallocate -l 4G/);
  });

  it.each([[0, "the docker marker"], [1, "the podman marker"]])(
    "answers marker %i (%s) on its own, with no systemd-detect-virt to ask",
    (index) => {
      // The fallback path is what a box without systemd-detect-virt uses; the
      // probe must not depend on the one binary, and it must read the whole
      // marker list rather than stopping at the first path.
      const r = runStep({ availGb: 400, container: true, containerMarkers: [index], detectVirtMissing: true });
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/Skipping swapfile: running in a container/);
      expect(r.calls).toBe("");
    },
  );

  it("provisions normally when neither marker is there and the probe is missing", () => {
    // The other half of the fallback: no binary and no marker is a real box,
    // and the step must go on to make the file rather than skip on a doubt.
    const r = runStep({ availGb: 400, detectVirtMissing: true });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Creating a 8G swapfile/);
    expect(r.calls).toMatch(/swapon --priority 1/);
  });

  it("skips a container BEFORE writing anything, test flag or not", () => {
    // The CI harness is only one kind of container. An 8 GB file written and
    // then refused by swapon is 8 GB of the host's disk wasted.
    const r = runStep({ availGb: 400, container: true });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Skipping swapfile: running in a container/);
    expect(r.calls).toBe("");
    expect(r.fileExists).toBe(false);
    expect(r.fstab).not.toMatch(/swapfile/);
  });

  it("reports an fstab that cannot be written, so the caller warns", () => {
    // The swap is live at that point; without the status the step would claim
    // success and the file would quietly vanish at the next boot.
    const r = runStep({ availGb: 400, readOnlyFstab: true });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/will not survive a reboot/);
    expect(r.calls).toMatch(/swapon --priority 1/);
  });

  it("skips in test mode: a container cannot swapon", () => {
    const r = runStep({ availGb: 400, testMode: true });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Skipping swapfile: test mode/);
    expect(r.calls).toBe("");
  });

  it("removes the file and carries on when swapon refuses it", () => {
    // A half-made swapfile left on disk is worse than none: it wastes the
    // space and the next run would adopt it.
    const r = runStep({ availGb: 400, swaponFails: true });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Warning: swapon failed/);
    expect(r.fileExists).toBe(false);
    expect(r.fstab).not.toMatch(/swapfile/);
  });
});
