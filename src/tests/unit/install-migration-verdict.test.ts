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
 // install.sh runs under pipefail, and a doctor run can print a thousand lines: a
 // `printf | grep -q` check that met the phrase early read printf's SIGPIPE as "no blocker".
 it("finds a blocker phrase early in output past the pipe buffer, under pipefail",()=>{
  const output=`Agent identity migration requires stopped-writer maintenance\n${"Doctor: checked one more agent state section\n".repeat(20000)}`;
  const r=spawnSync("bash",["-c",`set -o pipefail\n${fn}\nopenclaw_migration_complete 0 "$(cat)"`],{input:output});
  expect(r.status).toBe(1);
 });
 it("finds a blocker phrase on a line that is not valid UTF-8 in a UTF-8 locale",()=>{
  const output=Buffer.concat([Buffer.from("Agent identity migration requires stopped-writer maintenance "),Buffer.from([0xff]),Buffer.from("\n")]);
  const r=spawnSync("bash",["-c",`${fn}\nopenclaw_migration_complete 0 "$(cat)"`],{input:output,env:{...process.env,LC_ALL:"C.UTF-8"}});
  expect(r.status).toBe(1);
 });
 it("does not confuse optional maintenance notices with migration failures",()=>{
  expect(verdict(0,"Session SQLite: Legacy entries 8; SQLite entries 8.\n5 dead-lettered ingress events.\nNo successful backup is recorded.\nDoctor complete.")).toBe(0);
 });
});
