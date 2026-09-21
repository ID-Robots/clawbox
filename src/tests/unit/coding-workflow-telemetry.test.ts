import { afterEach, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { workflowTelemetry, cachedWorkflowTelemetry } from "@/lib/coding-workflow-telemetry";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-telemetry-"));
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it("counts real children, excludes resumed history, and marks truncated/unfinished evidence", () => {
  for (const [id, at] of [["wf_old", 1000], ["wf_new", 3000]] as const) {
    fs.mkdirSync(path.join(root, "sess", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(root, "sess", "workflows", `${id}.json`), JSON.stringify({ timestamp: new Date(at).toISOString() }));
    const dir = path.join(root, "sess", "subagents", "workflows", id);
    fs.mkdirSync(dir, { recursive: true });
    const events = [1, 2, 3].map((n) => ({ type: "started", agentId: `a${n}`, label: `audit ${n}` }));
    fs.writeFileSync(path.join(dir, "journal.jsonl"), [...events, events[0], { type: "result", agentId: "a1" }, { type: "result", agentId: "a2" }].map((e) => JSON.stringify(e)).join("\n"));
  }
  const live = workflowTelemetry(path.join(root, "sess.jsonl"), 2000, null);
  expect(live.childrenTotal).toBe(3);
  expect(live.childrenActive).toBe(1);
  expect(live.workflows[0].peakActive).toBe(3);
  expect(live.workflows).toHaveLength(1);
  const done = workflowTelemetry(path.join(root, "sess.jsonl"), 2000, 4000);
  expect(done.complete).toBe(false);
  expect(done.childrenActive).toBe(0);
  expect(done.workflows[0].children[2].status).toBe("unknown-at-stop");
  expect(workflowTelemetry(null, 0, null).complete).toBe(false);
});

it("bounds repeated journal scans, marks stale evidence and refreshes journal-only changes", () => {
  fs.mkdirSync(path.join(root, "cache", "workflows"), { recursive: true });
  const transcript = path.join(root, "cache.jsonl");
  fs.writeFileSync(transcript, "start");
  const scan = vi.spyOn(fs, "readdirSync");
  let now = 10000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  expect(cachedWorkflowTelemetry(transcript, 0, null).complete).toBe(true);
  for (let i = 0; i < 25; i++) cachedWorkflowTelemetry(transcript, 0, null);
  expect(scan).toHaveBeenCalledTimes(1);
  fs.appendFileSync(transcript, "changed");
  expect(cachedWorkflowTelemetry(transcript, 0, null).complete).toBe(false);
  expect(scan).toHaveBeenCalledTimes(1);
  now += 5001;
  const fresh = cachedWorkflowTelemetry(transcript, 0, null);
  expect(fresh.complete).toBe(true);
  fresh.workflows.push({ id: "mutated", children: [], peakActive: 0 });
  expect(cachedWorkflowTelemetry(transcript, 0, null).workflows).toHaveLength(0);
  now += 5001;
  cachedWorkflowTelemetry(transcript, 0, null);
  expect(scan).toHaveBeenCalledTimes(3);
  // Settlement is a distinct phase and must not reuse live child statuses.
  cachedWorkflowTelemetry(transcript, 0, now);
  expect(scan).toHaveBeenCalledTimes(4);
});
