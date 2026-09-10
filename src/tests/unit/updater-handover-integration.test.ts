import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const mocks=vi.hoisted(()=>({state:"inactive",lock:vi.fn(),setMany:vi.fn(),get:vi.fn()}));
vi.mock("child_process",()=>({exec:vi.fn(),execFile:vi.fn((...args:unknown[])=>{
 const cb=args.at(-1) as (err:unknown,value:unknown)=>void;
 cb(null,{stdout:mocks.state,stderr:""});
})}));
vi.mock("@/lib/config-store",()=>({get:mocks.get,set:vi.fn(),setMany:mocks.setMany,getKnown:vi.fn(),resolveConfigRoot:()=>process.env.CLAWBOX_ROOT,CONFIG_ROOT:"/nonexistent"}));
vi.mock("@/lib/update-lock",()=>({setUpdateLock:mocks.lock,clearUpdateLock:vi.fn(),isUpdateLocked:vi.fn(),updateLockHeldByLiveProcess:vi.fn()}));
let dir:string;
let updater:typeof import("@/lib/updater");
beforeEach(async()=>{
 dir=mkdtempSync(path.join(tmpdir(),"handover-integration-"));
 vi.stubEnv("CLAWBOX_ROOT",dir);
 mkdirSync(`${dir}/data`);mkdirSync(`${dir}/.next/standalone/.next`,{recursive:true});
 writeFileSync(`${dir}/.next/standalone/server.js`,"// fixture");
 writeFileSync(`${dir}/.next/standalone/.next/BUILD_ID`,"new-build");
 writeFileSync(`${dir}/.next/BUILD_ID`,"new-build");
 writeFileSync(`${dir}/data/updater-handover.json`,JSON.stringify({version:1,previousBuildId:"gold-build"}));
 mocks.state="inactive";mocks.setMany.mockReset();mocks.setMany.mockResolvedValue(undefined);
 mocks.get.mockReset();mocks.lock.mockReset();mocks.lock.mockImplementation(()=>new Promise(()=>{}));
 vi.resetModules();updater=await import("@/lib/updater");updater.resetUpdateState();
});
afterEach(()=>{updater.resetUpdateState();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
describe("bootstrap handover resumes the actual updater",()=>{
 it("starts the FULL flow without marking core/migration completed and consumes the marker",async()=>{
  expect(await updater.checkContinuation()).toBe(true);
  expect(existsSync(`${dir}/data/updater-handover.json`)).toBe(false);
  expect(updater.getUpdateState().phase).toBe("running");
  expect(updater.getUpdateState().steps.find(s=>s.id==="openclaw_install")?.status).toBe("pending");
  expect(updater.getUpdateState().steps[0].status).toBe("pending");
  expect(mocks.lock).toHaveBeenCalledTimes(1);
  expect(updater.startUpdate().started).toBe(false);
  expect(await updater.checkContinuation()).toBe(false);
 });
 it("leaves the marker and avoids another launch while root bootstrap is still active",async()=>{
  mocks.state="activating";
  expect(await updater.checkContinuation()).toBe(false);
  expect(existsSync(`${dir}/data/updater-handover.json`)).toBe(true);
  expect(mocks.lock).not.toHaveBeenCalled();
  expect(mocks.get).not.toHaveBeenCalled();
 });
 it("reports a failed bridge instead of pretending the upgrade finished",async()=>{
  mocks.state="failed";
  expect(await updater.checkContinuation()).toBe(false);
  expect(updater.getUpdateState().phase).toBe("failed");
  expect(mocks.lock).not.toHaveBeenCalled();
 });
 it("reports malformed handover JSON as a failed upgrade and clears the marker",async()=>{
  writeFileSync(`${dir}/data/updater-handover.json`, '{"version":');
  expect(await updater.checkContinuation()).toBe(false);
  expect(updater.getUpdateState().phase).toBe("failed");
  expect(existsSync(`${dir}/data/updater-handover.json`)).toBe(false);
  expect(mocks.lock).not.toHaveBeenCalled();
 });
});
