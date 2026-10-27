// Owner API latency: the routes the desktop polls and the ones every app
// opens with, each called a few times in a row from the signed-in page.
import { median } from "../lib/score.mjs";

export const id = "api";
export const title = "Owner API latency";
export const weight = 10;
export const order = 10;

// [path, group] — "fast" routes read local state; "heavy" ones consult git,
// the portal or a run store and are allowed more.
const ROUTES = [
  ["/setup-api/users/me", "fast"],
  ["/setup-api/system/battery", "fast"],
  ["/setup-api/system/power/approval", "fast"],
  ["/setup-api/clawkeep", "fast"],
  ["/setup-api/chat/model", "fast"],
  ["/setup-api/chat/capabilities", "fast"],
  ["/setup-api/ai-models/status", "fast"],
  ["/setup-api/email/pending", "fast"],
  ["/setup-api/harness/active", "fast"],
  ["/setup-api/kv?key=ui:pending-actions", "fast"],
  ["/setup-api/coding-agent/status", "fast"],
  ["/setup-api/telegram/pairing?poll=1", "fast"],
  ["/setup-api/preferences?keys=theme", "fast"],
  ["/setup-api/update/status", "fast"],
  ["/setup-api/coding-agent/runs?limit=5&artifacts=1", "heavy"],
  ["/setup-api/update/versions", "heavy"],
  ["/setup-api/ai-models/usage", "heavy"],
  ["/setup-api/files?dir=", "heavy"],
];

export async function run({ client, opts, log }) {
  const n = opts.quick ? 3 : 5;
  const perRoute = {};
  const errors = [];
  for (const [path, group] of ROUTES) {
    const samples = [];
    let bytes = 0;
    for (let i = 0; i < n; i++) {
      const r = await client.http(path, { timeoutMs: 30_000 });
      samples.push(r.ms);
      bytes = r.bytes;
      if (!r.ok) errors.push(`${path} → ${r.status}${r.error ? " " + r.error : ""}`);
    }
    perRoute[path] = { group, p50: median(samples), max: Math.max(...samples), first: samples[0], bytes };
  }
  const fast = Object.values(perRoute).filter((r) => r.group === "fast");
  const heavy = Object.values(perRoute).filter((r) => r.group === "heavy");
  const fastP50 = median(fast.map((r) => r.p50));
  const fastWorst = Math.max(...fast.map((r) => r.p50));
  const heavyP50 = median(heavy.map((r) => r.p50));
  const heavyCold = Math.max(...heavy.map((r) => r.first));
  const pollBytes = Object.entries(perRoute).filter(([p]) => /battery|power|clawkeep|chat\/model|ai-models\/status|email|kv\?|pairing|coding-agent\/runs/.test(p)).reduce((a, [, r]) => a + r.bytes, 0);
  const slowest = Object.entries(perRoute).sort((a, b) => b[1].p50 - a[1].p50).slice(0, 5).map(([p, r]) => `${p} ${r.p50.toFixed(0)} ms`);
  log(`fast p50 ${fastP50.toFixed(1)} ms, heavy p50 ${heavyP50.toFixed(0)} ms, slowest: ${slowest.join("; ")}`);
  return {
    metrics: {
      fast_p50_ms: { value: fastP50, unit: "ms", dir: "lower", good: 10, bad: 150, label: "median of the fast routes' medians" },
      fast_worst_ms: { value: fastWorst, unit: "ms", dir: "lower", good: 25, bad: 400, label: "slowest fast route (median)" },
      heavy_p50_ms: { value: heavyP50, unit: "ms", dir: "lower", good: 40, bad: 1500, label: "median of the heavy routes' medians" },
      heavy_cold_ms: { value: heavyCold, unit: "ms", dir: "lower", good: 100, bad: 4000, label: "slowest first call of a heavy route" },
      poll_cycle_kb: { value: pollBytes / 1024, unit: "KB", dir: "lower", good: 20, bad: 300, label: "bytes one round of the desktop's polls carries" },
      errors: { value: errors.length, unit: "", dir: "lower", good: 0, bad: 3, weight: 2, label: "non-2xx answers" },
    },
    details: { perRoute, errors, calls: n },
  };
}
