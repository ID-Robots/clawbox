import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
vi.setConfig({testTimeout: 30000, hookTimeout: 30000});
const source = readFileSync("install.sh", "utf8");
function fn(name: string) {
  const start = source.indexOf(`\n${name}() {`);
  if(start < 0) throw Error(`Missing ${name}`);
  return source.slice(start + 1, source.indexOf("\n}", start) + 2);
}
let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "task789-")); });
afterEach(() => { rmSync(dir, {recursive:true, force:true}); });
function bridge({buildRc=0, swapRc=0, enterRc=0, version="3.9.0", hermes=false, preMasked=false} = {}) {
  mkdirSync(`${dir}/.next/standalone`,{recursive:true}); mkdirSync(`${dir}/data`);
  mkdirSync(`${dir}/config`);
  writeFileSync(`${dir}/config/clawbox-gateway-maintenance.sh`, `echo "maintenance $1" >> "$PROJECT_DIR/events"\nif [ "$1" = enter ]; then exit ${enterRc}; fi`);
  writeFileSync(`${dir}/.next/standalone/package.json`,JSON.stringify({version}));
  writeFileSync(`${dir}/package.json`,JSON.stringify({version:"4.0.0"}));
  writeFileSync(`${dir}/.next/BUILD_ID`,"old-build");
  const script = `set -euo pipefail
export PROJECT_DIR='${dir}'
SRC_DIR='${dir}'
systemctl() {
  echo "systemctl $*" >> "$PROJECT_DIR/events"
  if [ "$1" = is-enabled ]; then echo ${preMasked ? "masked-runtime" : "enabled"}; fi
  return 0
}
is_hermes_edition() { return ${hermes ? 0 : 1}; }
as_clawbox() { "$@"; }
ensure_build_swap() { echo swap >> "$PROJECT_DIR/events"; return ${swapRc}; }
do_rebuild() { echo build >> "$PROJECT_DIR/events"; return ${buildRc}; }
step_systemd_services() { echo services >> "$PROJECT_DIR/events"; }
step_polkit_rules() { echo policy >> "$PROJECT_DIR/events"; }
${fn("legacy_updater_needs_handover")}
${fn("handover_legacy_updater")}
handover_legacy_updater
`;
  const result = spawnSync("bash",["-c",script],{encoding:"utf8"});
  const events = existsSync(`${dir}/events`) ? readFileSync(`${dir}/events`,"utf8") : "";
  return {...result,events, marker: existsSync(`${dir}/data/updater-handover.json`)};
}
describe("legacy bootstrap handover executes shipped shell functions",()=>{
  it("rebuilds before changing authorisation and leaves a full-upgrade continuation",()=>{
    const r=bridge(); expect(r.status,r.stderr).toBe(0);
    expect(r.events.indexOf("build\n")).toBeLessThan(r.events.indexOf("policy\n"));
    expect(r.events).toContain("maintenance enter");
    expect(r.events).toContain("maintenance leave");
    expect(JSON.parse(readFileSync(`${dir}/data/updater-handover.json`,"utf8"))).toEqual({version:1,previousBuildId:"old-build"});
  });
  it("does not revoke the old app's permissions after build failure",()=>{
    const r=bridge({buildRc:137}); expect(r.status,r.stderr).toBe(137);
    expect(r.events).not.toContain("policy\n"); expect(r.events).not.toContain("services\n");
    expect(r.events).toContain("systemctl restart clawbox-setup.service");
    expect(r.events).toContain("maintenance leave");
    expect(r.marker).toBe(false);
  });
  it("refuses before stopping any service when swap cannot be provisioned",()=>{
    const r=bridge({swapRc:1}); expect(r.status).toBe(1); expect(r.events).toBe("swap\n");
  });
  it("cleans a partially installed guard when enter fails without rebuilding or revoking permissions",()=>{
    const r=bridge({enterRc:1});expect(r.status,r.stderr).toBe(1);
    expect(r.events).toContain("maintenance enter\nmaintenance leave");
    expect(r.events).not.toContain("build\n");
    expect(r.events).not.toContain("policy\n");
    expect(r.events).not.toContain("systemctl stop");
    expect(r.marker).toBe(false);
  });
  it("does not touch an absent Hermes gateway",()=>{
    const r=bridge({hermes:true}); expect(r.status,r.stderr).toBe(0);
    expect(r.events).not.toContain("clawbox-gateway.service"); expect(r.marker).toBe(true);
  });
  it("does not remove an existing gateway maintenance mask",()=>{
    const r=bridge({preMasked:true});expect(r.status,r.stderr).toBe(0);
    expect(r.events).not.toContain("systemctl unmask");
    expect(r.events).toContain("maintenance leave");
  });
  it("leaves the current 4.x updater alone",()=>{
    const r=bridge({version:"4.0.0"});expect(r.status).toBe(0);expect(r.events).toBe("");
  });
});
