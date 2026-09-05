/**
 * A coding run cannot take the box's own web server down.
 *
 * On 2026-09-05 a run's `pkill -f next-server` — meant for the dev server it
 * had started — matched ClawBox's own server (Next titles its process
 * `next-server (v…)`), systemd restarted it, and the run was marked lost
 * fourteen minutes in. Two fences now: the by-name killers are denied to a
 * run, and the box's server takes a title of its own so a stray one cannot
 * match it anyway.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { BASH_ALLOWLIST, BASH_DENYLIST } from "@/lib/coding-agent";
import { WEBAPP_STORAGE_GUIDE } from "../../../mcp/tools/orientation";

describe("the run's Bash rules", () => {
  it("deny every killer that matches by name, and a kill of every process", () => {
    for (const rule of ["Bash(pkill:*)", "Bash(killall:*)", "Bash(fuser:*)", "Bash(kill -9 -1:*)", "Bash(kill -1:*)"]) {
      expect(BASH_DENYLIST).toContain(rule);
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
  it("reclaims its process title from Next, so nothing looking for a next-server by name finds it", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "production-server.js"), "utf8");
    expect(src).toContain('const CLAWBOX_PROCESS_TITLE = "clawbox-web"');
    expect(src).toMatch(/process\.title = CLAWBOX_PROCESS_TITLE/);
    // After Next's own start, and retried: the assignment inside Next is async.
    expect(src.indexOf("reclaimProcessTitle()")).toBeGreaterThan(src.indexOf('require("./.next/standalone/server.js")'));
    expect(src).toMatch(/setTimeout\(reclaimProcessTitle, delay\)\.unref\(\)/);
    expect(CLAWBOX_TITLE_MATCHES_NEXT).toBe(false);
  });
});

const CLAWBOX_TITLE_MATCHES_NEXT = /next/i.test("clawbox-web");
