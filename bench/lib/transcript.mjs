// Read a Claude Code session transcript (the JSONL under ~/.claude-ds) and
// sum token usage per model. This is where the orchestrator-vs-sub-agent
// split comes from: the main loop runs on the tier model, the shipped
// sub-agents all run on deepseek-v4-flash, so a per-model sum IS the split.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseTranscript(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const byModel = {};
  let lines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    lines++;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = event?.message;
    const usage = message?.usage;
    if (!usage || typeof usage !== "object") continue;
    const model = typeof message.model === "string" ? message.model : "(unknown)";
    const slot = (byModel[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });
    slot.input += usage.input_tokens ?? 0;
    slot.output += usage.output_tokens ?? 0;
    slot.cacheRead += usage.cache_read_input_tokens ?? 0;
    slot.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    slot.messages += 1;
  }
  return { lines, byModel };
}

