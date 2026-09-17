import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A real bash per case: vitest's 5 s default is not enough on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * 2026-09-16 — three field boxes went dark in the middle of the 4.0.0 update.
 *
 * The update runs `step_performance_mode` as step 2 of 13 (ahead of apt since 2026-09-17), and since 2660282a
 * (performance the default, `--apply` on every update) that step pinned every
 * core, the GPU and EMC to their ceilings BEFORE the OpenClaw npm install, the
 * rebuild and post_update. On each box the log stops within a minute of the
 * pin, seconds after `npm install -g openclaw@…` had finished — no shutdown,
 * NUL-padded syslog and npm log — and the box stayed dark until it was
 * power-cycled, with a core whose files had never reached the disk.
 *
 * The pin buys nothing under an update: every full update ends in a reboot and
 * clawbox-performance.service applies the profile at that boot. So a DISPATCHED
 * step, while the updater holds `update_in_progress`, UNPINS for the length of
 * the update (`--restore`, which persists nothing — since performance became
 * the default every box boots pinned, so the next update would otherwise run
 * its heaviest work pinned from the first second) and only installs and
 * enables the unit; a full install and a hand-run `--step` with no update in
 * flight apply as before. This drives the shipped function under bash to hold
 * that.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");

function shellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start + 1);
  return `${INSTALL_SH.slice(start + 1, end)}\n}`;
}

type Box = { dir: string; calls: () => string[] };

function makeBox(opts: { lock: unknown }): Box {
  const dir = mkdtempSync(path.join(tmpdir(), "clawbox-perf-step-"));
  const libexec = path.join(dir, "libexec");
  mkdirSync(libexec, { recursive: true });
  mkdirSync(path.join(dir, "data"), { recursive: true });
  writeFileSync(path.join(dir, "calls"), "");
  if (opts.lock !== undefined) {
    writeFileSync(path.join(dir, "data", "config.json"), typeof opts.lock === "string" ? opts.lock : JSON.stringify(opts.lock));
  }
  // The power script the step runs, logging what it was asked for.
  const power = path.join(libexec, "clawbox-power-mode.sh");
  writeFileSync(power, `#!/usr/bin/env bash\nprintf 'power-mode %s\\n' "$*" >> ${JSON.stringify(path.join(dir, "calls"))}\n`);
  chmodSync(power, 0o755);
  const ollama = path.join(libexec, "optimize-ollama.sh");
  writeFileSync(ollama, `#!/usr/bin/env bash\nprintf 'optimize-ollama\\n' >> ${JSON.stringify(path.join(dir, "calls"))}\n`);
  chmodSync(ollama, 0o755);
  return { dir, calls: () => readFileSync(path.join(dir, "calls"), "utf-8").split("\n").filter(Boolean) };
}

function runStep(box: Box, env: Record<string, string>) {
  const calls = JSON.stringify(path.join(box.dir, "calls"));
  const program = [
    "set -euo pipefail",
    `PROJECT_DIR=${JSON.stringify(box.dir)}`,
    `SRC_DIR=${JSON.stringify(box.dir)}`,
    `ROOT_LIBEXEC_DIR=${JSON.stringify(path.join(box.dir, "libexec"))}`,
    "install_root_libexec() { :; }",
    "is_test_mode() { return 1; }",
    `install_performance_unit() { printf 'install-unit\\n' >> ${calls}; }`,
    `step_resource_limits() { printf 'resource-limits\\n' >> ${calls}; }`,
    shellFunction("update_owns_the_box"),
    shellFunction("step_performance_mode"),
    "step_performance_mode",
  ].join("\n");
  return spawnSync("bash", ["-c", program], { encoding: "utf-8", timeout: 20_000, env: { ...process.env, ...env } });
}

describe("step_performance_mode under an in-app update", () => {
  it("unpins the clocks while the updater holds the lock, persists nothing, and only installs the unit", () => {
    const box = makeBox({ lock: { update_in_progress: true, update_lock_holder: { pid: 1 } } });
    try {
      const r = runStep(box, { CLAWBOX_DISPATCHED_STEP: "performance_mode" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/unpinning the clocks for the length of the update/);
      // `--restore` is the unit's own ExecStop verb: it unpins and writes no
      // state file, so the owner's choice is what the closing reboot applies.
      // Never `--apply`, never `--balanced` (which would persist).
      expect(box.calls()).toEqual(["power-mode --restore", "install-unit"]);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("applies the profile on a hand-run step when no update is in flight", () => {
    const box = makeBox({ lock: { update_in_progress: false } });
    try {
      const r = runStep(box, { CLAWBOX_DISPATCHED_STEP: "performance_mode" });
      expect(r.status, r.stderr).toBe(0);
      expect(box.calls()).toEqual(["power-mode --apply", "install-unit", "optimize-ollama", "resource-limits"]);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("applies the profile on a full install, whatever the store says", () => {
    // The full-install path never sets the dispatched marker, so the lock is
    // not even consulted — an installer running over a stale flag still pins.
    const box = makeBox({ lock: { update_in_progress: true } });
    try {
      const r = runStep(box, {});
      expect(r.status, r.stderr).toBe(0);
      expect(box.calls()[0]).toBe("power-mode --apply");
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("treats a store it cannot read as no update, so the safe answer is still an unpinned box only when asked", () => {
    // An absent, unparseable or lock-less store all read as "no update owns
    // the box"; the step then does what it always did.
    for (const lock of [undefined, "not json", { other: true }]) {
      const box = makeBox({ lock });
      try {
        const r = runStep(box, { CLAWBOX_DISPATCHED_STEP: "performance_mode" });
        expect(r.status, r.stderr).toBe(0);
        expect(box.calls()[0]).toBe("power-mode --apply");
      } finally {
        rmSync(box.dir, { recursive: true, force: true });
      }
    }
  });

  it("is wired the way the dispatch block and the step agree on", () => {
    // The `--step` block sets the marker before it invokes the step, and the
    // step asks the marker AND the lock before `--apply`, never after.
    const dispatch = INSTALL_SH.slice(INSTALL_SH.indexOf('if [ "${1:-}" = "--step" ]; then'));
    expect(dispatch.indexOf('CLAWBOX_DISPATCHED_STEP="$local_step"')).toBeGreaterThan(-1);
    expect(dispatch.indexOf('CLAWBOX_DISPATCHED_STEP="$local_step"')).toBeLessThan(dispatch.indexOf('"step_${local_step}"'));
    const step = shellFunction("step_performance_mode");
    const guard = step.indexOf('[ -n "${CLAWBOX_DISPATCHED_STEP:-}" ] && update_owns_the_box');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(step.indexOf("clawbox-power-mode.sh\" --apply"));
  });
});
