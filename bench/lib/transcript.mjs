// Read a Claude Code session transcript (the JSONL under ~/.claude-ds) and
// sum token usage per model. This is where the orchestrator-vs-sub-agent
// split comes from: the main loop runs on the tier model, the shipped
// sub-agents all run on deepseek-v4-flash, so a per-model sum IS the split.
import fs from "node:fs";

export function parseTranscript(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const byModel = {};
  let lines = 0;
  // One API message arrives as SEVERAL transcript lines — one per content
  // block (thinking, then text or tool_use), each carrying the message's whole
  // usage. Measured 2026-09-03 on the box's CLI (2.1.259): the l-01 baseline
  // transcript had 97 usage lines for 31 messages, and the per-line sum was
  // 3x the real bill. Count each message.id once — with the LARGEST figure
  // its lines carry: a helper's first line (the thinking block) arrives with
  // output_tokens 0 and the real count lands on a later line of the same
  // message, so "first line wins" billed every flash helper's output as
  // nothing (cycle 1, 2026-09-05). The per-message sum matches the CLI's
  // own modelUsage.
  const byMessage = new Map();
  let anonymous = 0;
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    lines++;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = event?.message;
    const usage = message?.usage;
    if (!usage || typeof usage !== "object") continue;
    const model = typeof message.model === "string" ? message.model : "(unknown)";
    // A line without a message id is billed on its own, as before.
    const key = typeof message.id === "string" && message.id ? message.id : `anonymous-${anonymous++}`;
    const seen = byMessage.get(key) ?? { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    seen.input = Math.max(seen.input, usage.input_tokens ?? 0);
    seen.output = Math.max(seen.output, usage.output_tokens ?? 0);
    seen.cacheRead = Math.max(seen.cacheRead, usage.cache_read_input_tokens ?? 0);
    seen.cacheWrite = Math.max(seen.cacheWrite, usage.cache_creation_input_tokens ?? 0);
    byMessage.set(key, seen);
  }
  for (const seen of byMessage.values()) {
    const slot = (byModel[seen.model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });
    slot.input += seen.input;
    slot.output += seen.output;
    slot.cacheRead += seen.cacheRead;
    slot.cacheWrite += seen.cacheWrite;
    slot.messages += 1;
  }
  return { lines, byModel };
}

