#!/usr/bin/env bun
// Direct MCP client benchmark for the ClawBox MCP server (TASK-1069).
// Runs ON the box, from ~/clawbox so the SDK resolves. Spawns the server
// exactly as openclaw.json registers it, measures cold starts, tools/list
// size, per-tool latency, and the child's RSS. Prints one JSON document.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "fs";
import { homedir } from "os";

const HOME = homedir();
const cfg = JSON.parse(readFileSync(`${HOME}/.openclaw/openclaw.json`, "utf8"));
const srv = cfg?.mcp?.servers?.clawbox;
if (!srv) { console.log(JSON.stringify({ error: "mcp.servers.clawbox not registered" })); process.exit(2); }
const COLD_STARTS = Number(process.env.COLD_STARTS || 5);
const WARM_REPS = Number(process.env.WARM_REPS || 3);

function rssKb(pid: number | undefined): number | null {
  if (!pid) return null;
  try {
    const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

async function connect() {
  const t0 = performance.now();
  const transport = new StdioClientTransport({ command: srv.command, args: srv.args, env: { ...process.env, ...(srv.env || {}) }, stderr: "pipe" });
  const client = new Client({ name: "mcp-bench", version: "1.0.0" });
  await client.connect(transport);
  const t1 = performance.now();
  const list = await client.listTools();
  const t2 = performance.now();
  return { client, transport, connectMs: t1 - t0, listMs: t2 - t1, tools: list.tools };
}

// Arguments by parameter name; the script reads each tool's schema and fills
// only what it declares, so a renamed parameter shows up as an error row, not
// a crash.
const ARGS: Record<string, unknown> = {
  file_path: `${HOME}/clawbox/README.md`,
  path: `${HOME}/clawbox`,
  pattern: "*.md",
  url: "https://example.com/",
  command: "uname -a",
  max_results: 20,
  limit: 40,
  tail: 20,
};
const SCRIPT: Array<{ tool: string; args?: Record<string, unknown> }> = [
  { tool: "device_status" }, { tool: "system_stats" }, { tool: "clawbox_health" }, { tool: "clawbox_context" },
  { tool: "system_info" }, { tool: "disk_usage" }, { tool: "ui_list_apps" }, { tool: "update_check" },
  { tool: "list_directory", args: { path: `${HOME}/clawbox` } },
  { tool: "read_file", args: { file_path: `${HOME}/clawbox/README.md`, limit: 40 } },
  { tool: "glob", args: { pattern: "*.md", path: `${HOME}/clawbox` } },
  { tool: "grep", args: { pattern: "ClawBox", path: `${HOME}/clawbox/README.md`, max_results: 10 } },
  { tool: "bash", args: { command: "uname -a" } },
  { tool: "bash", args: { command: "ls -1 ~ | head -20" } },
  { tool: "bash", args: { command: "sleep 3 && echo slept" } },
  { tool: "write_file", args: { file_path: `${HOME}/mcp-bench-note.txt`, content: "hello from bench\n" } },
  { tool: "edit_file", args: { file_path: `${HOME}/mcp-bench-note.txt`, old_text: "hello", new_text: "hi" } },
  { tool: "read_file", args: { file_path: `${HOME}/mcp-bench-note.txt` } },
  // The TASK-1072 case: the agent's own workspace under ~/.openclaw.
  { tool: "read_file", args: { file_path: `${HOME}/.openclaw/workspace/USER.md` } },
  { tool: "list_directory", args: { path: `${HOME}/.openclaw/workspace` } },
  { tool: "bash", args: { command: "cat ~/.openclaw/workspace/USER.md | head -3" } },
  { tool: "web_fetch", args: { url: "https://example.com/", max_length: 2000 } },
  { tool: "screen_capture" },
  { tool: "browser_open", args: { url: "https://example.com/" } },
  { tool: "browser_screenshot" },
  { tool: "browser_close" },
];

async function main() {
  const out: any = { box: HOME, server: { command: srv.command, args: srv.args }, coldStarts: [], warm: [], schemaBytes: 0, toolCount: 0, byTool: {} };
  for (let i = 0; i < COLD_STARTS; i++) {
    const c = await connect();
    out.coldStarts.push({ connectMs: +c.connectMs.toFixed(1), listMs: +c.listMs.toFixed(1), tools: c.tools.length });
    if (i === 0) {
      out.toolCount = c.tools.length;
      out.schemaBytes = Buffer.byteLength(JSON.stringify(c.tools));
      out.toolNames = c.tools.map((t) => t.name);
      out.byTool = Object.fromEntries(c.tools.map((t) => [t.name, { bytes: Buffer.byteLength(JSON.stringify(t)), descChars: (t.description || "").length }]));
    }
    await c.client.close();
  }
  const c = await connect();
  const pid = (c.transport as any).pid ?? (c.transport as any)._process?.pid;
  out.rssKbAfterList = rssKb(pid);
  const known = new Set(c.tools.map((t) => t.name));
  for (let rep = 0; rep < WARM_REPS; rep++) {
    for (const step of SCRIPT) {
      if (!known.has(step.tool)) { out.warm.push({ rep, tool: step.tool, skipped: "not registered" }); continue; }
      const t0 = performance.now();
      try {
        const r: any = await c.client.callTool({ name: step.tool, arguments: step.args ?? {} });
        const ms = performance.now() - t0;
        const text = (r.content || []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
        let code: string | null = null;
        try { const j = JSON.parse(text); if (j && j.error) code = j.code || j.error; } catch {}
        out.warm.push({ rep, tool: step.tool, ms: +ms.toFixed(1), isError: !!r.isError, chars: text.length, code, head: text.slice(0, 100) });
      } catch (e: any) {
        out.warm.push({ rep, tool: step.tool, ms: +(performance.now() - t0).toFixed(1), threw: String(e?.message || e).slice(0, 160) });
      }
    }
  }
  out.rssKbAfterScript = rssKb(pid);
  await c.client.close();
  console.log(JSON.stringify(out));
}
main().catch((e) => { console.log(JSON.stringify({ error: String(e?.message || e) })); process.exit(1); });
