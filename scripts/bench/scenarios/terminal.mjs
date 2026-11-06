// Terminal: a shell over the PTY socket, opened from inside the desktop page
// exactly as the Terminal app opens one — the same-origin `/terminal-ws`
// upgrade, which production-server.js checks against the session cookie and
// stamps with the per-boot token on its way to scripts/terminal-server.mjs.
// The token never leaves the box's processes; the bench never sees it.
//
// No `?session=` is asked for, so the shell is an ephemeral one that ends
// with its socket — nothing is left in the session registry. Measured: the
// time from `new WebSocket` to the first output (the prompt), and one echo
// round trip typed into the shell. `exit` is sent and the socket closed in
// `finally`, whatever happened.

export const id = "terminal";
export const title = "Terminal shell";
export const weight = 5;
export const order = 55;
export const needs = ["page"];

const TIMEOUT_MS = 20_000;

const PAGE_EXPR = `(async () => {
  const TIMEOUT = ${TIMEOUT_MS};
  const marker = 'BENCH-' + 'ok';
  const url = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/terminal-ws';
  const out = { promptMs: null, echoMs: null, success: 0, error: null, started: null, closeCode: null, firstOutputChars: 0, exitSeen: false };
  const t0 = performance.now();
  let ws = null;
  let buffer = '';
  const waiters = [];
  const feed = () => { for (const w of [...waiters]) if (w.test()) { w.done(); } };
  const waitFor = (test, ms) => new Promise((resolve, reject) => {
    const w = { test, done: () => { clearTimeout(t); waiters.splice(waiters.indexOf(w), 1); resolve(); } };
    const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timeout')); }, ms);
    waiters.push(w);
    if (test()) w.done();
  });
  try {
    ws = new WebSocket(url);
    let opened = false;
    let gotOutput = false;
    let closed = false;
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'started') out.started = { shell: m.shell || null, cwd: m.cwd ? '(set)' : null };
      if (m.type === 'output' && typeof m.data === 'string') {
        if (!gotOutput && m.data.length) { gotOutput = true; out.promptMs = performance.now() - t0; out.firstOutputChars = m.data.length; }
        buffer += m.data;
        feed();
      }
      if (m.type === 'exit') { out.exitSeen = true; feed(); }
      if (m.type === 'gone') { out.error = 'gone'; feed(); }
    };
    ws.onclose = (e) => { closed = true; out.closeCode = e.code; feed(); };
    ws.onerror = () => { out.error = out.error || 'socket error'; feed(); };
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('connect timeout')), TIMEOUT);
      ws.onopen = () => { clearTimeout(t); opened = true; resolve(); };
      const prevClose = ws.onclose;
      ws.onclose = (e) => { prevClose(e); if (!opened) { clearTimeout(t); reject(new Error('closed before open (' + e.code + ')')); } };
    });
    // The app's first message: its size.
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    // Time to the first byte of output — the prompt (or the login banner).
    await waitFor(() => gotOutput || closed || !!out.error, TIMEOUT);
    if (!gotOutput) throw new Error(out.error || 'no output before close');
    // Let the prompt settle, so the echo is timed on its own.
    await new Promise((r) => setTimeout(r, 150));
    const mark = buffer.length;
    const t1 = performance.now();
    ws.send(JSON.stringify({ type: 'input', data: "printf 'BENCH-%s\\\\n' ok\\n" }));
    // The typed line is echoed with the marker split across the format
    // string, so the only whole "BENCH-ok" is the one printf writes.
    await waitFor(() => buffer.slice(mark).includes(marker) || closed || !!out.error, TIMEOUT);
    if (!buffer.slice(mark).includes(marker)) throw new Error(out.error || 'no echo before close');
    out.echoMs = performance.now() - t1;
    out.success = 1;
  } catch (e) {
    out.error = out.error || String(e && e.message || e);
  } finally {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: 'exit\\n' }));
        await waitFor(() => out.exitSeen || out.closeCode !== null, 3000).catch(() => {});
      }
    } catch {}
    try { if (ws) ws.close(1000); } catch {}
  }
  out.totalMs = performance.now() - t0;
  return out;
})()`;

export async function run({ client, log }) {
  const r = await client.page.evaluate(PAGE_EXPR, { timeoutMs: TIMEOUT_MS * 2 + 5000 });
  log(`prompt ${r.promptMs?.toFixed(0) ?? "—"} ms, echo ${r.echoMs?.toFixed(0) ?? "—"} ms, success ${r.success}${r.error ? `, error: ${r.error}` : ""}${r.started?.shell ? `, shell ${r.started.shell}` : ""}`);
  return {
    metrics: {
      connect_to_prompt_ms: { value: r.promptMs, unit: "ms", dir: "lower", good: 300, bad: 3000, label: "WebSocket open to the shell's first output" },
      echo_roundtrip_ms: { value: r.echoMs, unit: "ms", dir: "lower", good: 50, bad: 800, label: "typed command to its output" },
      success: { value: r.success, unit: "", dir: "higher", good: 1, bad: 0, weight: 2, label: "shell answered and was closed (1/0)" },
    },
    details: { error: r.error, shell: r.started?.shell ?? null, firstOutputChars: r.firstOutputChars, exitSeen: r.exitSeen, closeCode: r.closeCode, totalMs: Math.round(r.totalMs) },
  };
}
