// Where a run's tokens went, read from its Claude Code transcripts (the main
// session JSONL plus everything under <session>/ — sub-agent and workflow
// sidechains). Pure apart from reading the files it is given.
//
// One API message is written as several transcript lines (one per content
// block), each carrying the whole message's usage, and a helper's first line
// can carry output_tokens 0 — so each message id is counted ONCE with the
// LARGEST figure its lines carry (the rule ../../lib/transcript.mjs learned).
import fs from "node:fs";
import path from "node:path";

const zero = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, messages: 0 });

function* events(files) {
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    const side = /[/\\](subagents|workflows)[/\\]/.test(f);
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      yield { e, side: side || e.isSidechain === true, file: f };
    }
  }
}

/**
 * @param {string[]} files transcript files
 * @param {{reviewStart?: number|null, attemptStarts?: number[]}} marks epoch ms
 */
export function splitPhases(files, marks = {}) {
  const reviewStart = marks.reviewStart ?? Infinity;
  const attemptStart = (marks.attemptStarts ?? []).length ? Math.min(...marks.attemptStarts) : Infinity;
  const msgs = new Map();
  for (const { e, side } of events(files)) {
    const u = e?.message?.usage;
    if (!u || typeof u !== "object") continue;
    const key = e.message.id ?? `${e.uuid}`;
    const t = Date.parse(e.timestamp ?? "") || 0;
    const m = msgs.get(key) ?? { side, t, model: e.message.model ?? "(unknown)", input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    m.input = Math.max(m.input, u.input_tokens ?? 0);
    m.output = Math.max(m.output, u.output_tokens ?? 0);
    m.cacheWrite = Math.max(m.cacheWrite, u.cache_creation_input_tokens ?? 0);
    m.cacheRead = Math.max(m.cacheRead, u.cache_read_input_tokens ?? 0);
    m.t = Math.min(m.t || t, t || m.t);
    m.side = m.side || side;
    msgs.set(key, m);
  }
  const phases = { main: zero(), subagents: zero(), review: zero(), attempts: zero() };
  const subagentsBy = { main: 0, review: 0, attempts: 0 };
  const byModel = {};
  let maxContext = 0;
  for (const m of msgs.values()) {
    const when = m.t >= reviewStart ? "review" : m.t >= attemptStart ? "attempts" : "main";
    const bucket = m.side ? phases.subagents : phases[when];
    const tot = m.input + m.output + m.cacheWrite + m.cacheRead;
    for (const k of ["input", "output", "cacheWrite", "cacheRead"]) bucket[k] += m[k];
    bucket.total += tot;
    bucket.messages += 1;
    if (m.side) subagentsBy[when] += tot;
    const bm = (byModel[m.model] ??= zero());
    for (const k of ["input", "output", "cacheWrite", "cacheRead"]) bm[k] += m[k];
    bm.total += tot;
    bm.messages += 1;
    if (!m.side) maxContext = Math.max(maxContext, m.input + m.cacheWrite + m.cacheRead);
  }
  const total = Object.values(phases).reduce((a, p) => a + p.total, 0);
  return { ...phases, subagentsBy, byModel, total, maxContext, files: files.length };
}

/** Tool calls, and the waste signals the diet looks for: the same file read
 * more than once, by the main loop and by helpers. */
export function toolStats(files) {
  const seen = new Set();
  const calls = { main: {}, sub: {} };
  const reads = new Map();
  for (const { e, side } of events(files)) {
    const content = e?.message?.content;
    if (e.type !== "assistant" || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use" || seen.has(block.id)) continue;
      seen.add(block.id);
      const who = side ? "sub" : "main";
      calls[who][block.name] = (calls[who][block.name] ?? 0) + 1;
      if (block.name === "Read" && typeof block.input?.file_path === "string") {
        const k = path.basename(block.input.file_path) === block.input.file_path ? block.input.file_path : block.input.file_path;
        reads.set(k, (reads.get(k) ?? 0) + 1);
      }
    }
  }
  const repeatedReads = [...reads.values()].reduce((a, n) => a + Math.max(0, n - 1), 0);
  const count = (o) => Object.values(o).reduce((a, n) => a + n, 0);
  return { calls, mainCalls: count(calls.main), subCalls: count(calls.sub), reads: [...reads.values()].reduce((a, n) => a + n, 0), repeatedReads };
}
