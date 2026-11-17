// The Hermes half of the ClawBox stress run (TASK-2500): one chat turn through
// the box's own desktop route (POST /setup-api/hermes/chat, streamed), its
// event frames, and the owner's Stop. Kept in a hermes-named file of its own
// because the frame names below belong to ClawBox's own chat route, not to a
// harness contract — scripts/harness-contract/scan.mjs reads a file whose name
// says hermes as Hermes usage (dotted JSON-RPC names only), never as OpenClaw
// gateway events.
import crypto from "node:crypto";

/**
 * Server-sent events out of a buffer: every complete `event:`/`data:` block,
 * and what is left for the next read. `data` is parsed JSON, or null.
 */
export function takeSseFrames(buf) {
  const frames = [];
  let rest = buf.replace(/\r\n/g, "\n");
  let cut;
  while ((cut = rest.indexOf("\n\n")) >= 0) {
    const block = rest.slice(0, cut);
    rest = rest.slice(cut + 2);
    let event = "message", data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    let payload = null;
    try { payload = data ? JSON.parse(data) : null; } catch { /* keep null */ }
    frames.push({ event, data: payload });
  }
  return { frames, rest };
}

/**
 * The Hermes driver for one run. `deps` are the host's own pieces: the
 * dashboard's base URL, the owner-signed headers, and the run's log line.
 */
export function createHermesDriver({ dash, headers, log = () => {} }) {
  async function stop(key, turnId) {
    const q = new URLSearchParams({ sessionKey: key, ...(turnId ? { turnId } : {}) });
    try {
      const res = await fetch(`${dash}/setup-api/hermes/chat?${q}`, { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(30_000) });
      const json = await res.json().catch(() => null);
      if (!res.ok) log(`stop ${key}: HTTP ${res.status}`);
      return json?.stopped ?? null;
    } catch (e) {
      log(`stop ${key}: ${e.message}`);
      return null;
    }
  }

  /**
   * One turn. `signal` (optional) is the run's stop: aborted, the turn ends
   * at once as `stopped`. Whatever way it ends without the route saying so —
   * the timeout, the stop, a read error, a stream that ends early — the turn
   * is Stopped on the box (once) before this returns: a request going away
   * does not end a Hermes turn, and the session's next turn must not overlap it.
   */
  async function turn(sess, message, timeoutMs, signal) {
    const r = { ackMs: null, firstTokenMs: null, latencyMs: null, toolCalls: 0, text: "", error: null, model: null };
    if (signal?.aborted) {
      r.error = { kind: "stopped", message: "the run was stopped" };
      return r;
    }
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    const turnId = crypto.randomBytes(8).toString("hex");
    const ac = new AbortController();
    let why = null;
    const timer = setTimeout(() => { why = why || "timeout"; ac.abort(); }, timeoutMs);
    const onStop = () => { why = why || "stopped"; ac.abort(); };
    signal?.addEventListener("abort", onStop, { once: true });
    let toolEvents = 0;
    // The route told us how the turn ended: a done/error/stopped frame, or a
    // plain JSON answer (an answer or a refusal; nothing left running).
    let ended = false;
    try {
      const res = await fetch(`${dash}/setup-api/hermes/chat`, {
        method: "POST",
        headers: headers({ "Content-Type": "application/json", Accept: "text/event-stream" }),
        body: JSON.stringify({ message, sessionKey: sess.key, turnId, ...(sess.sessionId ? { sessionId: sess.sessionId } : {}) }),
        signal: ac.signal,
      });
      r.ackMs = ms();
      const type = res.headers.get("content-type") || "";
      let done = null, error = null;
      if (!type.includes("text/event-stream")) {
        ended = true;
        const json = await res.json().catch(() => null);
        if (res.ok && json && typeof json.text === "string") done = json;
        else error = { kind: "http", message: `HTTP ${res.status}: ${String(json?.error || "").slice(0, 160)}` };
      } else {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        outer: for (;;) {
          const { value, done: eof } = await reader.read();
          if (eof) break;
          const taken = takeSseFrames(buf + dec.decode(value, { stream: true }));
          buf = taken.rest;
          for (const { event, data: payload } of taken.frames) {
            if (event === "delta" && r.firstTokenMs === null) r.firstTokenMs = ms();
            if (event === "tool") toolEvents++;
            if (event === "done") { ended = true; done = payload || {}; break outer; }
            if (event === "error" || event === "stopped") {
              ended = true;
              error = { kind: event === "error" ? "agent-error" : "aborted", message: String(payload?.error || payload?.message || event).slice(0, 200) };
              break outer;
            }
          }
        }
        try { await reader.cancel(); } catch { /* ended */ }
        if (!done && !error) error = { kind: "connection", message: "stream ended without an answer" };
      }
      r.latencyMs = ms();
      if (done) {
        r.text = String(done.text || "");
        r.model = typeof done.model === "string" ? done.model : null;
        if (typeof done.sessionId === "string" && done.sessionId) {
          sess.sessionId = done.sessionId;
          sess.hermesIds.add(done.sessionId);
        }
        const calls = Array.isArray(done.toolCalls) ? done.toolCalls.length : 0;
        r.toolCalls = Math.max(calls, toolEvents);
        if (/^Error:/.test(r.text.trim())) r.error = { kind: "agent-error", message: r.text.trim().slice(0, 200) };
      }
      if (error) r.error = error;
    } catch (e) {
      r.latencyMs = ms();
      if (why === "timeout") r.error = { kind: "timeout", message: `no answer within ${Math.round(timeoutMs / 1000)} s` };
      else if (why === "stopped") r.error = { kind: "stopped", message: "the run was stopped" };
      else r.error = { kind: "connection", message: String(e.message || e).slice(0, 200) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onStop);
    }
    // Not ended by the route: no latency to count, and the owner's Stop ends
    // the turn on the box (the only Stop this turn sends).
    if (!ended) {
      r.latencyMs = null;
      await stop(sess.key, turnId);
    }
    return r;
  }

  return { turn, stop };
}
