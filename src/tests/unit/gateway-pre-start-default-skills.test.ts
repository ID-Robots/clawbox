import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Starts real processes (bash / python3).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Default skills and the cron failure-alert seed (TASK-1639). Pinned:
//   seeds once      — every shipped skill lands in <workspace>/skills once.
//   owner's own     — a same-named skill already there is never overwritten;
//                     a removed one is never re-added; an edited one is kept.
//   updates         — an untouched seeded skill follows the shipped copy.
//   unusable record — nothing is written.
//   alert           — cron.failureAlert is set once when absent, never over the
//                     owner's own value, and not retried after it landed.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const SHIPPED = path.resolve(process.cwd(), "config/default-skills");
const hasTools = ["python3", "bash"].every((b) => spawnSync(b, ["--version"], { stdio: "ignore" }).status === 0);
const d = hasTools ? describe : describe.skip;

function block(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf("# ── Default skills (TASK-1639)");
  const endMarker = "ALERTREC\n  fi\nfi\n";
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("default-skills block not found");
  return src.slice(start, end + endMarker.length);
}

let dir: string, root: string, ws: string, cfg: string, state: string, calls: string, bin: string;

function run(extraEnv: Record<string, string> = {}) {
  const script = `set -euo pipefail\n${block()}`;
  return spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH ?? "",
      CLAWBOX_ROOT: root,
      CLAWBOX_WORKSPACE: ws,
      OPENCLAW_CONFIG: cfg,
      OPENCLAW_BIN: bin,
      CLAWBOX_OPENCLAW_V2: "1",
      OC_CALLS: calls,
      ...extraEnv,
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cb-default-skills-"));
  root = path.join(dir, "clawbox");
  ws = path.join(dir, "ws");
  mkdirSync(path.join(root, "config"), { recursive: true });
  mkdirSync(path.join(ws, "skills"), { recursive: true });
  spawnSync("cp", ["-r", SHIPPED, path.join(root, "config/default-skills")]);
  cfg = path.join(dir, "openclaw.json");
  writeFileSync(cfg, "{}");
  state = path.join(root, "data/default-skills.json");
  calls = path.join(dir, "calls");
  bin = path.join(dir, "openclaw");
  writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$OC_CALLS"\nexit "\${OC_EXIT:-0}"\n`);
  chmodSync(bin, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const shippedIds = () => readdirSync(SHIPPED).filter((n) => existsSync(path.join(SHIPPED, n, "SKILL.md"))).sort();
const skillMd = (id: string) => path.join(ws, "skills", id, "SKILL.md");

d("default skills seeding", () => {
  it("ships the handbook and stays small", () => {
    expect(shippedIds()).toContain("clawbox-handbook");
    for (const id of shippedIds()) {
      const text = readFileSync(path.join(SHIPPED, id, "SKILL.md"), "utf-8");
      expect(text.startsWith(`---\nname: ${id}\n`)).toBe(true);
      expect(text.length).toBeLessThan(10_000);
    }
  });

  it("seeds every shipped skill once", () => {
    expect(run().status).toBe(0);
    for (const id of shippedIds()) expect(existsSync(skillMd(id))).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(state, "utf-8")).skills).sort()).toEqual(shippedIds());
    const second = run();
    expect(second.stdout).not.toContain("Seeded default skills");
  });

  it("never overwrites, re-adds or reverts the owner's skills", () => {
    mkdirSync(path.join(ws, "skills", "reminders"));
    writeFileSync(skillMd("reminders"), "mine");
    run();
    expect(readFileSync(skillMd("reminders"), "utf-8")).toBe("mine");
    rmSync(path.join(ws, "skills", "lead-finder"), { recursive: true });
    writeFileSync(skillMd("docs-maker"), "edited");
    writeFileSync(path.join(root, "config/default-skills/docs-maker/SKILL.md"), "---\nname: docs-maker\n---\nv2");
    run();
    expect(existsSync(skillMd("lead-finder"))).toBe(false);
    expect(readFileSync(skillMd("docs-maker"), "utf-8")).toBe("edited");
  });

  it("refreshes an untouched seeded skill to the shipped copy", () => {
    run();
    const next = "---\nname: research-brief\n---\nv2";
    writeFileSync(path.join(root, "config/default-skills/research-brief/SKILL.md"), next);
    const out = run();
    expect(out.stdout).toContain("Refreshed default skills: research-brief");
    expect(readFileSync(skillMd("research-brief"), "utf-8")).toBe(next);
  });

  it("writes nothing when the record cannot be read", () => {
    mkdirSync(path.dirname(state), { recursive: true });
    writeFileSync(state, "not json");
    const out = run();
    expect(out.status).toBe(0);
    expect(out.stderr).toContain("cannot be read");
    expect(readdirSync(path.join(ws, "skills"))).toEqual([]);
  });
});

d("cron failure alert seed", () => {
  it("sets cron.failureAlert once when absent, then never again", () => {
    run();
    const first = readFileSync(calls, "utf-8");
    expect(first).toContain('config set --batch-json [{"path":"cron.failureAlert"');
    expect(JSON.parse(readFileSync(state, "utf-8")).config).toEqual(["cron.failureAlert"]);
    run();
    expect(readFileSync(calls, "utf-8")).toBe(first);
  });

  it("leaves the owner's own value and records it", () => {
    writeFileSync(cfg, JSON.stringify({ cron: { failureAlert: { enabled: false } } }));
    run();
    expect(existsSync(calls)).toBe(false);
    expect(JSON.parse(readFileSync(state, "utf-8")).config).toEqual(["cron.failureAlert"]);
  });

  it("retries next boot when the CLI write failed", () => {
    const out = run({ OC_EXIT: "1" });
    expect(out.status).toBe(0);
    expect(out.stderr).toContain("could not enable cron failure alerts");
    expect(JSON.parse(readFileSync(state, "utf-8")).config).toBeUndefined();
  });

  it("does nothing on a non-OpenClaw-2 box", () => {
    run({ CLAWBOX_OPENCLAW_V2: "0" });
    expect(existsSync(calls)).toBe(false);
  });
});
