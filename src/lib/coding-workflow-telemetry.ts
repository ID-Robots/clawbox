/** CLI-owned Workflow journals: actual children, not the orchestration container.
 * Read only this session and phase. Missing/capped evidence is explicit, never zero proof.
 * Journal ordering proves per-workflow overlap, not simultaneous inference.
 */
import fs from "fs";
import path from "path";

export interface WorkflowTelemetry {
  workflows: Array<{ id: string; children: Array<{ id: string; label: string; status: string }>; peakActive: number }>;
  childrenTotal: number;
  childrenActive: number;
  complete: boolean;
}

function readBounded(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) throw new Error("journal unavailable or too large");
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size === buffer.length) throw new Error("journal grew beyond limit");
    return buffer.subarray(0, size).toString("utf8");
  } finally { fs.closeSync(fd); }
}

export function workflowTelemetry(transcript: string | null, startedAt: number, completedAt: number | null): WorkflowTelemetry {
  const out: WorkflowTelemetry = { workflows: [], childrenTotal: 0, childrenActive: 0, complete: true };
  if (!transcript) return { ...out, complete: false };
  const sessionRoot = transcript.replace(/\.jsonl$/, "");
  let files: fs.Dirent[];
  try { files = fs.readdirSync(path.join(sessionRoot, "workflows"), { withFileTypes: true }); }
  catch { return { ...out, complete: false }; }
  const names = files.filter((f) => f.isFile() && /^wf_[a-zA-Z0-9-]+\.json$/.test(f.name));
  if (names.length > 100) out.complete = false;
  for (const entry of names.slice(0, 100)) {
    try {
      const meta = JSON.parse(readBounded(path.join(sessionRoot, "workflows", entry.name)));
      const at = Date.parse(meta.timestamp);
      if (!Number.isFinite(at)) { out.complete = false; continue; }
      if (at < startedAt || (completedAt !== null && at > completedAt)) continue;
      const id = entry.name.slice(0, -5);
      const text = readBounded(path.join(sessionRoot, "subagents", "workflows", id, "journal.jsonl"));
      const children = new Map<string, { id: string; label: string; status: string }>();
      let peakActive = 0;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { out.complete = false; continue; }
        if (typeof event.agentId !== "string" || event.agentId.length > 128) continue;
        if (event.type === "started") {
          if (!children.has(event.agentId)) children.set(event.agentId, { id: event.agentId, label: typeof event.label === "string" ? event.label.slice(0, 120) : "helper", status: "running" });
          peakActive = Math.max(peakActive, [...children.values()].filter((c) => c.status === "running").length);
        } else if (["result", "failed", "error"].includes(event.type)) {
          const child = children.get(event.agentId);
          if (child) child.status = event.type === "result" ? "completed" : "failed";
          else out.complete = false;
        }
      }
      const active = [...children.values()].filter((c) => c.status === "running");
      if (completedAt !== null && active.length) {
        out.complete = false;
        for (const child of active) child.status = "unknown-at-stop";
      }
      out.workflows.push({ id, children: [...children.values()], peakActive });
      out.childrenTotal += children.size;
      if (completedAt === null) out.childrenActive += active.length;
    } catch { out.complete = false; }
  }
  return out;
}
