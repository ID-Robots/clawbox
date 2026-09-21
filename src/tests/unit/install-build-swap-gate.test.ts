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
  it("propagates failed swap persistence instead of starting a build",()=>{
    expect(run({diskBytes:8*1024*1024*1024,provisionRc:1}).status).toBe(1);
  });
  it("does not provision swap on large hosts or test containers",()=>{
    for(const opts of [{ram:16000000},{skip:true}]) {
      const r=run(opts);expect(r.status).toBe(0);expect(r.stderr).not.toContain("provision");
    }
  });
});
