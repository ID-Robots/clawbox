import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
const source=readFileSync("install.sh","utf8");
const start=source.indexOf("\nopenclaw_migration_complete() {");
const fn=source.slice(start+1,source.indexOf("\n}",start)+2);
function verdict(code:number,output:string) {
 return spawnSync("bash",["-c",`${fn}\nopenclaw_migration_complete "$1" "$2"`,"test",String(code),output]).status;
}
describe("required OpenClaw migration verdict",()=>{
 it("rejects nonzero doctor even if the output looks finished",()=>expect(verdict(1,"Doctor complete.")).toBe(1));
 it("rejects the customer's incomplete-migration warnings even on zero exit",()=>{
  for(const output of ["Agent identity migration requires stopped-writer maintenance", "Legacy session store requires migration", "OpenClaw startup migrations did not complete cleanly", "Skipped historical transcript directive migration"]) expect(verdict(0,output)).toBe(1);
 });
 it("does not confuse optional maintenance notices with migration failures",()=>{
  expect(verdict(0,"Session SQLite: Legacy entries 8; SQLite entries 8.\n5 dead-lettered ingress events.\nNo successful backup is recorded.\nDoctor complete.")).toBe(0);
 });
});
