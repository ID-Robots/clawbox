#!/usr/bin/env node
// The desktop's performance suite: drives the LIVE ClawBox desktop through the
// Chrome that shows it (its loopback DevTools port) and measures what each
// scenario costs.
//
//   node scripts/perf/desktop-perf.mjs                       every scenario, a table
//   node scripts/perf/desktop-perf.mjs idle drag --out a.json chosen scenarios, saved
//   node scripts/perf/desktop-perf.mjs --compare a.json b.json  before → after
//
// Scenarios:
//   idle   10 s with no input: what the desktop costs just being on screen
//   sweep  the pointer swept over the shelf and the desktop for 4 s
//   drag   a Files window of its own dragged back and forth for ~4 s
//   apps   every built-in app opened in a new window and closed again
//
// Per scenario: main-thread time by kind (script, style, layout) and the
// number of style recalcs, layouts and paints (Performance.getMetrics and a
// devtools.timeline trace), animation frames (requestAnimationFrame
// intervals: p50/p95/max and frames over 25 ms), long tasks, frames the
// compositor drew, CPU of the Chrome processes and the web server
// (/proc), and — with --gpu, on an Intel GPU whose `intel_gpu_top` may read
// the GPU's counters (give it that once:
// `setcap cap_perfmon=ep "$(command -v intel_gpu_top)"`) — the GPU's
// render-engine busy time.
//
// Options: --port <cdp port> (default 18801, CLAWBOX_KIOSK_CDP_PORT),
//          --url-match <text> for the desktop page — plain text its address
//          contains, never a pattern (default: a localhost page at "/"),
//          --gpu, --out <file>, --runs <n> (median of n runs).
//
// It only reads, clicks and drags; it never changes a setting. Leave the
// desktop alone while it runs — a moving pointer or typing skews the numbers.
import fs from "node:fs";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};

// ── Compare mode ──
const compareIdx = argv.indexOf("--compare");
if (compareIdx >= 0) {
  const [a, b] = argv.slice(compareIdx + 1, compareIdx + 3).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
  compare(a, b);
  process.exit(0);
}

const PORT = Number(opt("--port", process.env.CLAWBOX_KIOSK_CDP_PORT || 18801));
// Plain text, never a RegExp built from the command line: the page is found by
// what its address contains, or — by default — by being a localhost page at "/".
const URL_MATCH = opt("--url-match", null);
function isDesktopUrl(raw) {
  if (URL_MATCH !== null) return typeof raw === "string" && raw.includes(URL_MATCH);
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:")
      && (u.hostname === "localhost" || u.hostname === "127.0.0.1")
      && u.pathname === "/";
  } catch {
    return false;
  }
}
const OUT = opt("--out", null);
const RUNS = Math.max(1, Number(opt("--runs", 1)));
const GPU = flag("--gpu");
const SCENARIOS = argv.length ? argv : ["idle", "sweep", "drag", "apps"];

// ── CDP ──
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const desk = targets.find((t) => t.type === "page" && isDesktopUrl(t.url));
if (!desk) {
  console.error(`No desktop page on port ${PORT} ${URL_MATCH === null ? "at a localhost \"/\"" : `whose address contains "${URL_MATCH}"`}`);
  process.exit(2);
}
const ws = new WebSocket(desk.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1;
const pending = new Map();
let traceEvents = null;
let traceDone = null;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Tracing.dataCollected" && traceEvents) traceEvents.push(...m.params.value);
  if (m.method === "Tracing.tracingComplete" && traceDone) traceDone();
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const mouse = (type, x, y, buttons = 0) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
await send("Performance.enable", { timeDomain: "timeTicks" });
const metrics = async () => Object.fromEntries((await send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));

// ── Process CPU (/proc) ──
const HZ = 100;
function processes() {
  const out = [];
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, "utf8");
      let kind = null;
      if (/production-server\.js|clawbox-web|next-server/.test(cmd)) kind = "web-server";
      else if (/chrome/.test(cmd) && /clawbox-kiosk/.test(cmd)) {
        kind = /--type=gpu-process/.test(cmd) ? "chrome-gpu" : /--type=renderer/.test(cmd) ? "chrome-renderers" : /--type=/.test(cmd) ? "chrome-other" : "chrome-browser";
      }
      if (kind) out.push({ pid: Number(d), kind });
    } catch {}
  }
  return out;
}
function ticks(procs) {
  const by = {};
  for (const { pid, kind } of procs) {
    try {
      const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
      by[kind] = (by[kind] ?? 0) + Number(f[11]) + Number(f[12]);
    } catch {}
  }
  return by;
}

// ── GPU (intel_gpu_top, optional) ──
function gpuSampler() {
  if (!GPU) return null;
  // Never through sudo: the tool reads the counters itself where it carries
  // cap_perfmon, and the column is null where it cannot.
  const child = spawn("intel_gpu_top", ["-J", "-s", "500"], { stdio: ["ignore", "pipe", "ignore"] });
  child.on("error", () => undefined);
  let buf = "";
  const samples = [];
  child.stdout.on("data", (d) => {
    buf += d;
    for (const m of buf.matchAll(/"Render\/3D(?:\/0)?"\s*:\s*\{\s*"busy"\s*:\s*([\d.]+)/g)) samples.push(Number(m[1]));
    buf = buf.slice(-400);
  });
  return {
    stop: () => {
      child.kill();
      const s = samples.slice(1);
      return s.length ? +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) : null;
    },
  };
}

// ── Probes inside the page ──
const FRAME_PROBE = `(() => {
  if (window.__deskPerf) window.__deskPerf.stop();
  const frames = []; const longTasks = []; let last = 0, on = true;
  const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push(e.duration); });
  try { po.observe({ type: "longtask" }); } catch {}
  const loop = (t) => { if (!on) return; if (last) frames.push(t - last); last = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  window.__deskPerf = { frames, longTasks, stop: () => { on = false; po.disconnect(); } };
  return true;
})()`;
const FRAME_READ = `(() => {
  const p = window.__deskPerf; p.stop();
  const f = p.frames.slice().sort((a, b) => a - b);
  const q = (x) => f.length ? +f[Math.min(f.length - 1, Math.floor(f.length * x))].toFixed(1) : null;
  return { frames: f.length, p50: q(0.5), p95: q(0.95), max: f.length ? +f[f.length - 1].toFixed(1) : null, over25: f.filter((x) => x > 25).length,
    longTasks: p.longTasks.length, longTaskMs: Math.round(p.longTasks.reduce((a, b) => a + b, 0)) };
})()`;

async function measure(name, body) {
  const procs = processes();
  const c0 = ticks(procs);
  const m0 = await metrics();
  traceEvents = [];
  await send("Tracing.start", { categories: "devtools.timeline,viz", transferMode: "ReportEvents" });
  await evaluate(FRAME_PROBE);
  const gpu = gpuSampler();
  const t0 = Date.now();
  const extra = (await body()) ?? {};
  const wallMs = Date.now() - t0;
  const gpuBusy = gpu?.stop() ?? null;
  const frames = await evaluate(FRAME_READ);
  const done = new Promise((r) => (traceDone = r));
  await send("Tracing.end");
  await done;
  const m1 = await metrics();
  const c1 = ticks(procs);
  const n = (ev) => traceEvents.filter((e) => e.name === ev && e.ph !== "e").length;
  const ms = (k) => Math.round((m1[k] - m0[k]) * 1000);
  const perSec = (x) => +(x / (wallMs / 1000)).toFixed(1);
  const cpu = Object.fromEntries(Object.keys(c1).map((k) => [k, +((((c1[k] - (c0[k] ?? 0)) / HZ) / (wallMs / 1000)) * 100).toFixed(1)]));
  const fullPagePaints = traceEvents.filter((e) => e.name === "Paint" && e.args?.data?.clip && e.args.data.clip[2] - e.args.data.clip[0] >= (m1.LayoutViewportWidth ?? 0) * 0.9).length;
  const result = {
    scenario: name,
    wallMs,
    mainThread: { scriptMs: ms("ScriptDuration"), styleMs: ms("RecalcStyleDuration"), layoutMs: ms("LayoutDuration"), taskMs: ms("TaskDuration") },
    perSecond: {
      styleRecalcs: perSec(m1.RecalcStyleCount - m0.RecalcStyleCount),
      layouts: perSec(m1.LayoutCount - m0.LayoutCount),
      paints: perSec(n("Paint")),
      compositorDraws: perSec(traceEvents.filter((e) => e.name === "Display::DrawAndSwap" && e.ph === "X").length),
    },
    fullPagePaints,
    frames,
    cpuPercent: cpu,
    gpuRenderBusy: gpuBusy,
    nodes: m1.Nodes,
    jsHeapMB: +(m1.JSHeapUsedSize / 1048576).toFixed(1),
    ...extra,
  };
  traceEvents = null;
  return result;
}

/** Open an app in a NEW window and answer its window id (null if none appeared). */
async function openApp(app) {
  return evaluate(`new Promise((resolve) => {
    const before = new Set([...document.querySelectorAll("[data-window-id]")].map((w) => w.getAttribute("data-window-id")));
    const t0 = performance.now();
    const look = () => {
      const win = [...document.querySelectorAll("[data-window-id]")].find((w) => !before.has(w.getAttribute("data-window-id")));
      if (win) return setTimeout(() => resolve(win.getAttribute("data-window-id")), 800);
      if (performance.now() - t0 > 5000) return resolve(null);
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
    window.dispatchEvent(new CustomEvent("clawbox:open-app", { detail: { appId: ${JSON.stringify(app)}, forceNew: true } }));
  })`);
}

/** Close a window through its own close button. */
async function closeWindow(id) {
  if (!id) return;
  await evaluate(`(() => { const w=document.querySelector('[data-window-id="${id}"]'); [...(w?.querySelectorAll("button")??[])].find(b=>/close/i.test(b.getAttribute("aria-label")||b.title||""))?.click(); })()`);
  await sleep(400);
}

const SCENARIO_FNS = {
  idle: () => measure("idle", () => sleep(10_000)),
  sweep: () =>
    measure("sweep", async () => {
      const vw = await evaluate("innerWidth");
      const vh = await evaluate("innerHeight");
      for (let i = 0; i < 240; i++) {
        await mouse("mouseMoved", (i * 37) % vw, vh - 30 - (i % 5) * 120);
        await sleep(16);
      }
    }),
  drag: async () => {
    // Its OWN window, so every run drags the same thing whatever else is open
    // (a window full of content-visibility cards costs far more to move than
    // an empty one, and the topmost window changes from run to run).
    const id = await openApp("files");
    try {
      return await measure("drag", async () => {
        const w = await evaluate(`(() => { const r=document.querySelector('[data-window-id="${id}"]')?.getBoundingClientRect(); return r ? {x:r.x+r.width/2, y:r.y+12} : null })()`);
        if (!w) return { skipped: "the drag window did not open" };
        await mouse("mouseMoved", w.x, w.y);
        await mouse("mousePressed", w.x, w.y, 1);
        for (let i = 1; i <= 120; i++) { await mouse("mouseMoved", w.x - 8 * i, w.y + (i % 3), 1); await sleep(16); }
        for (let i = 119; i >= 0; i--) { await mouse("mouseMoved", w.x - 8 * i, w.y, 1); await sleep(16); }
        await mouse("mouseReleased", w.x, w.y);
      });
    } finally {
      await closeWindow(id);
    }
  },
  apps: () =>
    measure("apps", async () => {
      const apps = ["settings", "files", "terminal", "coding", "store", "memory-shard", "clawkeep", "projects", "system_update"];
      const opened = {};
      for (const app of apps) {
        const r = await evaluate(`new Promise((resolve) => {
          const before = new Set([...document.querySelectorAll("[data-window-id]")].map((w) => w.getAttribute("data-window-id")));
          const t0 = performance.now();
          const look = () => {
            const win = [...document.querySelectorAll("[data-window-id]")].find((w) => !before.has(w.getAttribute("data-window-id")));
            if (win) return requestAnimationFrame(() => resolve({ ms: Math.round(performance.now() - t0), id: win.getAttribute("data-window-id") }));
            if (performance.now() - t0 > 5000) return resolve({ ms: null, id: null });
            requestAnimationFrame(look);
          };
          requestAnimationFrame(look);
          window.dispatchEvent(new CustomEvent("clawbox:open-app", { detail: { appId: ${JSON.stringify("APP")}, forceNew: true } }));
        })`.replace('"APP"', JSON.stringify(app)));
        opened[app] = r.ms;
        await sleep(600);
        if (r.id) await evaluate(`(() => { const w=document.querySelector('[data-window-id="${r.id}"]'); [...(w?.querySelectorAll("button")??[])].find(b=>/close/i.test(b.getAttribute("aria-label")||b.title||""))?.click(); })()`);
        await sleep(400);
      }
      return { openToFirstFrameMs: opened };
    }),
};

const median = (xs) => { const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
function mergeRuns(runs) {
  if (runs.length === 1) return runs[0];
  const walk = (vals) => {
    if (typeof vals[0] === "number" || vals[0] === null) return median(vals);
    if (vals[0] && typeof vals[0] === "object") return Object.fromEntries(Object.keys(vals[0]).map((k) => [k, walk(vals.map((v) => v?.[k]))]));
    return vals[0];
  };
  return walk(runs);
}

const results = [];
for (const s of SCENARIOS) {
  const fn = SCENARIO_FNS[s];
  if (!fn) { console.error(`unknown scenario ${s}`); continue; }
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await fn());
  const r = mergeRuns(runs);
  results.push(r);
  console.log(JSON.stringify(r));
}
// The saved report holds the measurements and the CDP port they came from —
// not the page address DevTools listed, which nothing reads back and which
// would put text from the network into the file.
const report = { at: new Date().toISOString(), port: PORT, viewport: await evaluate("[innerWidth, innerHeight]"), results };
if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
ws.close();

function compare(a, b) {
  const rows = [];
  const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));
  for (const rb of b.results) {
    const ra = a.results.find((r) => r.scenario === rb.scenario);
    if (!ra) continue;
    const fa = Object.fromEntries(flat(ra));
    for (const [k, vb] of flat(rb)) {
      const va = fa[k];
      if (typeof va !== "number" || typeof vb !== "number" || k === "wallMs") continue;
      const pct = va === 0 ? (vb === 0 ? 0 : Infinity) : ((vb - va) / Math.abs(va)) * 100;
      rows.push([rb.scenario, k, va, vb, Number.isFinite(pct) ? `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%` : "new"]);
    }
  }
  const w = [8, 34, 10, 10, 8];
  console.log(["scenario", "metric", "before", "after", "change"].map((h, i) => h.padEnd(w[i])).join(" "));
  for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(w[i])).join(" "));
}
