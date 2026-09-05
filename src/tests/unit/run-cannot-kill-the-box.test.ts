/**
 * A coding run cannot take the box's own web server down.
 *
 * On 2026-09-05 a run's `pkill -f next-server` — meant for the dev server it
 * had started — matched ClawBox's own server (Next titles its process
 * `next-server (v…)`), systemd restarted it, and the run was marked lost
 * fourteen minutes in. Two fences now: the by-name killers are denied to a
 * run — the ONE command deny-list actually shipped beside `Bash(*)` — and
 * the box's server takes a title of its own so a stray one cannot match it
 * anyway, checked here at runtime in a child process.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { BASH_ALLOWLIST, BASH_KILL_DENYLIST } from "@/lib/coding-agent";
import { WEBAPP_STORAGE_GUIDE } from "../../../mcp/tools/orientation";

describe("the run's Bash rules", () => {
  it("deny every killer that matches by name, and a kill of every process", () => {
    for (const rule of ["Bash(pkill:*)", "Bash(killall:*)", "Bash(fuser:*)", "Bash(kill -9 -1:*)", "Bash(kill -1:*)"]) {
      expect(BASH_KILL_DENYLIST).toContain(rule);
    }
    // And never allowed by prefix either — the deny rule is belt and braces.
    expect(BASH_ALLOWLIST.some((r) => /Bash\((pkill|killall|fuser)/.test(r))).toBe(false);
  });

  it("tells a run to end its own server by PID", () => {
    expect(WEBAPP_STORAGE_GUIDE).toMatch(/use its PID/);
    expect(WEBAPP_STORAGE_GUIDE).toMatch(/never pkill, killall or fuser/);
  });
});

describe("the box's web server", () => {
  const guardModule = path.join(process.cwd(), "scripts", "process-title.js");

  it("is wired to reclaim its title after Next has started", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "production-server.js"), "utf8");
    const call = src.indexOf('require("./scripts/process-title.js").guardProcessTitle()');
    expect(call).toBeGreaterThan(src.indexOf('require("./.next/standalone/server.js")'));
  });

  it("takes the title back from Next at runtime, and again when Next sets it late", () => {
    // A child process plays Next: it names itself next-server, the guard
    // runs with a short retry, Next names it again a moment later, and the
    // retry takes it back. What is printed is the process's real title.
    const script = [
      `const { guardProcessTitle, CLAWBOX_PROCESS_TITLE } = require(${JSON.stringify(guardModule)});`,
      'process.title = "next-server (v16.3.3)";',
      "guardProcessTitle([15]);",
      "const first = process.title;",
      'setTimeout(() => { process.title = "next-server (v16.3.3)"; }, 5);',
      "setTimeout(() => { console.log(JSON.stringify({ first, later: process.title, expected: CLAWBOX_PROCESS_TITLE })); }, 40);",
    ].join("\n");
    const out = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10_000 }).trim());
    expect(out.first).toBe("clawbox-web");
    expect(out.later).toBe("clawbox-web");
    expect(out.expected).toBe("clawbox-web");
    expect(/next|node/i.test(out.later)).toBe(false);
  });
});
