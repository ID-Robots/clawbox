import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
const source=readFileSync("install.sh","utf8");
const start=source.indexOf("\nensure_build_swap() {");
const fn=source.slice(start+1,source.indexOf("\n}",start)+2);
function run({ram=7800000, diskBytes=0, provisionRc=0, skip=false}={}) {
  return spawnSync("bash",["-c",`set -euo pipefail
is_test_mode() { ${skip ? "return 0" : "return 1"}; }
in_container() { return 1; }
step_swapfile() { echo provision >&2; return ${provisionRc}; }
awk() { if [ "\${2:-}" = /proc/meminfo ]; then echo ${ram}; else command awk "$@"; fi; }
swapon() { printf '/dev/zram0 4294967296\\n'; ${diskBytes ? `printf '/swapfile ${diskBytes}\\n';` : ""} }
${fn}
ensure_build_swap
`],{encoding:"utf8"});
}
describe("build disk-swap prerequisite",()=>{
  it("rejects zram-only even when optional provisioning exits zero",()=>{
    const r=run();expect(r.status).toBe(1);expect(r.stderr).toContain("build requires at least 4 GiB");
  });
  it("requires usable capacity, not merely an active tiny swapfile",()=>{
    expect(run({diskBytes:1024*1024*1024}).status).toBe(1);
    expect(run({diskBytes:4*1024*1024*1024}).status).toBe(0);
  });
  it("accepts a REAL 4 GiB swapfile, whose usable area is a page short",()=>{
    // `swapon --show=SIZE --bytes` reports the file minus its one-page swap
    // header, rounded down to whole pages. Measured 2026-09-21: an
    // 8589934592-byte /swapfile (8388608 KiB) reads 8388604 KiB in /proc/swaps.
    // So a box with exactly `/swapfile 4G` measured 4194300 KiB and a literal
    // `-lt 4194304` refused it — on every Retry, for ever. That box could not
    // be updated at all, over a swapfile the exact size being demanded.
    expect(run({diskBytes:4*1024*1024*1024 - 4096}).status).toBe(0);
    // And the requirement itself is NOT relaxed: 3.5 GiB is still too little.
    expect(run({diskBytes:Math.floor(3.5*1024*1024*1024)}).status).toBe(1);
    expect(run({diskBytes:Math.floor(3.5*1024*1024*1024)}).stderr).toContain("at least 4 GiB");
  });
  it("stops the build when provisioning itself failed, and SAYS so",()=>{
    // The gate used to `return 1` silently here. The updater's banner picker
    // (getStepFailureLine in src/lib/updater.ts) shows the newest line starting
    // with "Error:" and only falls back to the LAST log line when nothing
    // printed one — and the step's stdout and stderr reach the journal as two
    // independent streams whose relative order is not guaranteed, so the
    // fallback picked up whichever landed last. An owner was shown "Rebuild
    // failed: Swapfile already active: 4G" for a failed update. Note this is the
    // step FAILING; a swapfile that is merely unrecorded in /etc/fstab no
    // longer reaches here at all (see install-swapfile.test.ts).
    const r=run({diskBytes:8*1024*1024*1024,provisionRc:1});
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^Error: could not provision disk-backed swap/m);
  });
  it("does not provision swap on large hosts or test containers",()=>{
    for(const opts of [{ram:16000000},{skip:true}]) {
      const r=run(opts);expect(r.status).toBe(0);expect(r.stderr).not.toContain("provision");
    }
  });
});
