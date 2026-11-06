// A real chat turn through the gateway, from the desktop page, in sessions of
// the bench's own: how long until the agent acknowledges, says its first word
// and finishes — once for a plain reply, once for a reply that needs a tool —
// plus the cost of reading a fresh session's history and deleting it.
import { GATEWAY_PAGE_SOURCE, sendTurnSource } from "../lib/page-gateway.mjs";

export const id = "chat";
export const title = "Chat turn";
export const weight = 25;
export const order = 30;
export const needs = ["page"];

export async function run({ client, host, opts, log }) {
  const page = client.page;
  await page.evaluate(GATEWAY_PAGE_SOURCE);
  const t0 = performance.now();
  const hello = await page.evaluate(`window.__clawboxBenchGateway.open().then(h => ({ ok: true, main: (h && h.snapshot && h.snapshot.sessionDefaults && h.snapshot.sessionDefaults.mainSessionKey) || null })).catch(e => ({ ok: false, error: e.message }))`);
  const connectMs = performance.now() - t0;
  if (!hello.ok) return { skipped: `gateway socket: ${hello.error}`, metrics: {} };
  const mainKey = hello.main || "agent:main:main";
  const agentId = mainKey.split(":")[0] === "agent" && mainKey.split(":")[1] ? mainKey.split(":")[1] : "main";
  const stamp = Date.now().toString(36);
  const sessionKey = `agent:${agentId}:clawbox-bench-${stamp}`;
  const sinceIso = new Date(Date.now() - 5000).toISOString();
  const marker = `bench-${stamp}`;
  const details = { sessionKey, connectMs, turns: [] };
  let plain = null, tool = null, historyMs = null, historyBytes = null, deleteMs = null;
  try {
    plain = await page.evaluate(sendTurnSource(sessionKey, `Reply with exactly the word pong and nothing else.`, opts.quick ? 90_000 : 150_000), { timeoutMs: 200_000 });
    details.turns.push({ kind: "plain", ...plain });
    log(`plain: ack ${plain.ackMs} ms, first word ${plain.firstDeltaMs} ms, final ${plain.finalMs} ms, "${(plain.text || "").slice(0, 40)}"${plain.error ? " ERROR " + plain.error : ""}`);
    tool = await page.evaluate(sendTurnSource(sessionKey, `Run the shell command \`echo ${marker}\` and reply with only its output.`, opts.quick ? 120_000 : 180_000), { timeoutMs: 240_000 });
    details.turns.push({ kind: "tool", ...tool });
    log(`tool: ack ${tool.ackMs} ms, first word ${tool.firstDeltaMs} ms, final ${tool.finalMs} ms, tools ${tool.tools.map((t) => t[2]).join(",") || "none"}, "${(tool.text || "").slice(0, 40)}"${tool.error ? " ERROR " + tool.error : ""}`);
    const h = await page.evaluate(`(async () => { const t = performance.now(); const r = await window.__clawboxBenchGateway.req('chat.history', { sessionKey: ${JSON.stringify(sessionKey)}, limit: 50 }); return { ms: performance.now() - t, bytes: JSON.stringify(r).length, count: (r.messages || []).length }; })()`);
    historyMs = h.ms; historyBytes = h.bytes; details.history = h;
  } finally {
    const d = await page.evaluate(`(async () => { const t = performance.now(); try { await window.__clawboxBenchGateway.req('sessions.delete', { key: ${JSON.stringify(sessionKey)}, deleteTranscript: true }); return { ms: performance.now() - t, ok: true }; } catch (e) { return { ms: performance.now() - t, ok: false, error: e.message }; } })()`).catch((e) => ({ ok: false, error: e.message }));
    deleteMs = d.ms ?? null; details.delete = d;
    await page.evaluate(`window.__clawboxBenchGateway.close(), 'closed'`).catch(() => null);
  }
  // The gateway's own account of the turn, when the journal is readable.
  const journal = host.gatewayJournal(sinceIso, /slow chat send|model-fetch\] response|tool-search: cataloged/);
  const prep = journal.map((l) => /preparation=(\d+)ms/.exec(l)?.[1]).filter(Boolean).map(Number);
  const modelMs = journal.map((l) => /elapsedMs=(\d+)/.exec(l)?.[1]).filter(Boolean).map(Number);
  details.journal = { lines: journal.length, preparationMs: prep, modelFetchMs: modelMs };
  const plainOk = plain && plain.state === "final" && /\bpong\b/i.test(plain.text || "") ? 1 : 0;
  const toolOk = tool && tool.state === "final" && (tool.text || "").includes(marker) ? 1 : 0;
  const toolCalls = tool ? tool.tools.filter((t) => t[1] === "start" || t[1] === "").length : 0;
  return {
    metrics: {
      connect_ms: { value: connectMs, unit: "ms", dir: "lower", good: 150, bad: 2000, label: "gateway socket open + hello" },
      ack_ms: { value: plain?.ackMs ?? null, unit: "ms", dir: "lower", good: 100, bad: 1500, label: "chat.send acknowledged (plain turn)" },
      first_word_ms: { value: plain?.firstDeltaMs ?? null, unit: "ms", dir: "lower", good: 1200, bad: 10000, weight: 2, label: "first streamed token (plain turn)" },
      plain_total_ms: { value: plain?.finalMs ?? null, unit: "ms", dir: "lower", good: 2500, bad: 20000, weight: 2, label: "plain turn send → final" },
      tool_total_ms: { value: tool?.finalMs ?? null, unit: "ms", dir: "lower", good: 5000, bad: 45000, weight: 2, label: "tool turn send → final" },
      plain_correct: { value: plainOk, unit: "", dir: "higher", good: 1, bad: 0, weight: 2, label: "plain reply was exactly pong" },
      tool_correct: { value: toolOk, unit: "", dir: "higher", good: 1, bad: 0, weight: 2, label: "tool reply carried the command output" },
      history_ms: { value: historyMs, unit: "ms", dir: "lower", good: 30, bad: 500, label: "chat.history of the fresh session" },
      history_kb: { value: historyBytes != null ? historyBytes / 1024 : null, unit: "KB", dir: "lower", good: 10, bad: 200, label: "bytes of that history (two turns)" },
      delete_ms: { value: deleteMs, unit: "ms", dir: "lower", good: 100, bad: 3000, label: "sessions.delete" },
      gateway_prep_ms: { value: prep.length ? Math.max(...prep) : null, unit: "ms", dir: "lower", good: 500, bad: 5000, label: "gateway 'preparation' stage (journal, when logged)" },
    },
    details: { ...details, toolCalls },
  };
}
