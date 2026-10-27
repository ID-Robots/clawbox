// What the desktop does when nobody touches it: the requests it sends on its
// own, the bytes they carry and the main-thread time it burns, watched for a
// window from inside the live desktop page.
export const id = "idle";
export const title = "Idle desktop";
export const weight = 10;
export const order = 25;
export const needs = ["page"];

export async function run({ client, opts, log }) {
  const page = client.page;
  const windowMs = opts.quick ? 30_000 : 60_000;
  await page.send("Performance.enable", { timeDomain: "timeTicks" }).catch(() => null);
  const metricsAt = async () => Object.fromEntries((await page.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const before = await metricsAt();
  const t0 = Date.now();
  await page.evaluate(`(() => { window.__clawboxBenchIdle = { entries: [] }; const o = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__clawboxBenchIdle.entries.push([e.name, e.initiatorType, e.transferSize || 0, e.decodedBodySize || 0, Math.round(e.duration)]); }); o.observe({ type: 'resource', buffered: false }); window.__clawboxBenchIdle.observer = o; return 'armed'; })()`);
  await new Promise((r) => setTimeout(r, windowMs));
  const entries = await page.evaluate(`(() => { const s = window.__clawboxBenchIdle; s.observer.disconnect(); delete window.__clawboxBenchIdle; return s.entries; })()`);
  const after = await metricsAt();
  const sec = (Date.now() - t0) / 1000;
  const api = entries.filter(([n]) => n.includes("/setup-api/"));
  const perMin = (entries.length / sec) * 60;
  const kbPerMin = (entries.reduce((a, e) => a + (e[2] || e[3] || 0), 0) / sec) * 60 / 1024;
  const byPath = {};
  for (const [n] of entries) { const p = n.replace(/^https?:\/\/[^/]+/, "").replace(/([?&])(t|_)=\d+/g, "$1"); byPath[p] = (byPath[p] || 0) + 1; }
  const top = Object.entries(byPath).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const busyPct = ((after.TaskDuration - before.TaskDuration) / sec) * 100;
  const layoutsPerS = (after.LayoutCount - before.LayoutCount) / sec;
  const recalcsPerS = (after.RecalcStyleCount - before.RecalcStyleCount) / sec;
  const heapMb = after.JSHeapUsedSize / 1048576;
  const openWindows = await page.evaluate(`document.querySelectorAll('[data-testid="mobile-app-window"], [class*="window"]').length`).catch(() => null);
  log(`${perMin.toFixed(0)} requests/min (${api.length} to setup-api), ${kbPerMin.toFixed(0)} KB/min, main thread ${busyPct.toFixed(2)}% busy, ${layoutsPerS.toFixed(2)} layouts/s; top: ${top.map(([p, c]) => `${p} ×${c}`).join(", ")}`);
  return {
    metrics: {
      requests_per_min: { value: perMin, unit: "/min", dir: "lower", good: 15, bad: 150, weight: 2, label: "requests the idle desktop sends" },
      kb_per_min: { value: kbPerMin, unit: "KB/min", dir: "lower", good: 50, bad: 3000, label: "bytes those requests carry" },
      main_thread_busy_pct: { value: busyPct, unit: "%", dir: "lower", good: 0.5, bad: 15, weight: 2, label: "renderer main thread busy while idle" },
      layouts_per_s: { value: layoutsPerS, unit: "/s", dir: "lower", good: 0.2, bad: 20, label: "layouts per second while idle" },
      style_recalcs_per_s: { value: recalcsPerS, unit: "/s", dir: "lower", good: 1, bad: 60, label: "style recalculations per second" },
      js_heap_mb: { value: heapMb, unit: "MB", dir: "lower", good: 40, bad: 300, label: "JS heap of the desktop page" },
    },
    details: { windowSec: sec, entries: entries.length, top, openWindows, metricsBefore: before, metricsAfter: after },
  };
}
