// How fast the desktop comes up: a page of the bench's own (shown on the
// box's screen while it loads, closed right after) navigated to "/", timed
// from navigation to the load event and to the shelf being on screen, with
// what it downloaded and parsed. Run twice; the second load has a warm cache.
export const id = "desktop";
export const title = "Desktop load";
export const weight = 15;
export const order = 20;
export const needs = ["page"];

const READY_SELECTOR = '[data-testid="shelf-launcher-button"]';

const TIMING = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const res = performance.getEntriesByType('resource');
  const scripts = res.filter((r) => r.initiatorType === 'script' || /\\.js(\\?|$)/.test(r.name));
  const sum = (xs, k) => xs.reduce((a, r) => a + (r[k] || 0), 0);
  return {
    ttfb: nav ? nav.responseStart - nav.startTime : null,
    dcl: nav ? nav.domContentLoadedEventEnd - nav.startTime : null,
    load: nav ? nav.loadEventEnd - nav.startTime : null,
    requests: res.length + 1,
    transferBytes: sum(res, 'transferSize') + (nav ? nav.transferSize : 0),
    decodedBytes: sum(res, 'decodedBodySize') + (nav ? nav.decodedBodySize : 0),
    scriptCount: scripts.length,
    scriptDecodedBytes: sum(scripts, 'decodedBodySize'),
    largest: res.slice().sort((a, b) => (b.decodedBodySize || 0) - (a.decodedBodySize || 0)).slice(0, 5).map((r) => [r.name.replace(location.origin, ''), r.decodedBodySize, Math.round(r.duration)]),
    heapMb: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
  };
})()`;

async function loadOnce(client, log) {
  const page = await client.newPage("about:blank");
  try {
    let loaded; const loadedP = new Promise((r) => { loaded = r; });
    const off = page.on("Page.loadEventFired", () => loaded());
    await page.send("Performance.enable", { timeDomain: "timeTicks" }).catch(() => null);
    const t0 = performance.now();
    await page.send("Page.navigate", { url: client.baseUrl + "/?clawbox-bench=1" });
    await Promise.race([loadedP, new Promise((_, rej) => setTimeout(() => rej(new Error("load event timeout")), 60_000))]);
    off();
    const loadMs = performance.now() - t0;
    // The shelf: the first thing a person waits for.
    let readyMs = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const ok = await page.evaluate(`!!document.querySelector(${JSON.stringify(READY_SELECTOR)})`).catch(() => false);
      if (ok) { readyMs = performance.now() - t0; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    // Let the mount fan-out settle so its requests count.
    await new Promise((r) => setTimeout(r, 1500));
    const timing = await page.evaluate(TIMING);
    const metrics = Object.fromEntries((await page.send("Performance.getMetrics").catch(() => ({ metrics: [] }))).metrics.map((m) => [m.name, m.value]));
    log(`load ${loadMs.toFixed(0)} ms, shelf ${readyMs?.toFixed(0) ?? "—"} ms, ${timing.requests} requests, ${(timing.transferBytes / 1024).toFixed(0)} KB transferred, ${(timing.scriptDecodedBytes / 1048576).toFixed(1)} MB of script`);
    return { loadMs, readyMs, ...timing, nodes: metrics.Nodes ?? null, scriptDurationS: metrics.ScriptDuration ?? null, taskDurationS: metrics.TaskDuration ?? null };
  } finally {
    await page.close();
  }
}

export async function run({ client, log }) {
  const cold = await loadOnce(client, log);
  const warm = await loadOnce(client, log);
  return {
    metrics: {
      shelf_ms: { value: warm.readyMs ?? warm.loadMs, unit: "ms", dir: "lower", good: 600, bad: 5000, weight: 2, label: "navigate → shelf on screen (warm cache)" },
      load_ms: { value: warm.loadMs, unit: "ms", dir: "lower", good: 800, bad: 6000, label: "navigate → load event (warm cache)" },
      cold_shelf_ms: { value: cold.readyMs ?? cold.loadMs, unit: "ms", dir: "lower", good: 900, bad: 8000, label: "navigate → shelf, first load" },
      ttfb_ms: { value: warm.ttfb, unit: "ms", dir: "lower", good: 30, bad: 600, label: "time to first byte of the page" },
      transfer_kb: { value: warm.transferBytes / 1024, unit: "KB", dir: "lower", good: 300, bad: 4000, label: "bytes transferred (warm)" },
      script_mb: { value: warm.scriptDecodedBytes / 1048576, unit: "MB", dir: "lower", good: 1, bad: 8, label: "JavaScript parsed on load" },
      requests: { value: warm.requests, unit: "", dir: "lower", good: 40, bad: 200, label: "requests until the desktop settled" },
      main_thread_s: { value: warm.taskDurationS, unit: "s", dir: "lower", good: 0.5, bad: 5, label: "main-thread task time until settled" },
    },
    details: { cold, warm },
  };
}
