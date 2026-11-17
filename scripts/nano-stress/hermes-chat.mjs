// The Hermes half of the ClawBox stress run (TASK-2500): one chat turn through
// the box's own desktop route (POST /setup-api/hermes/chat, streamed), its
// event frames, and the owner's Stop. Kept in a hermes-named file of its own
// because the frame names below belong to ClawBox's own chat route, not to a
// harness contract — scripts/harness-contract/scan.mjs reads a file whose name
// says hermes as Hermes usage (dotted JSON-RPC names only), never as OpenClaw
// gateway events.
import crypto from "node:crypto";

/** The frames that end a turn on the chat route. */
const TERMINAL_EVENTS = new Set(["done", "error", "stopped"]);

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
 * dashboard's base URL, the owner-signed headers, and the run's log line;
 * `settleMs` bounds the wait for a Stopped turn to settle (see `settled`).
 */
export function createHermesDriver({ dash, headers, log = () => {}, settleMs = 20_000 }) {
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
   * Whether no turn runs under `key` any more, as the route itself tells it:
   * GET re-attaches to the key's newest live turn — a running one if there is
   * one — and replays its frames (204: no turn on record). Settled means a
   * replayed end of that turn (a done, error or stopped frame), or a 204 when
   * `emptyCounts` (the Stop did stop a registered turn). After a Stop that
   * found no turn, a 204 can mean the POST is still in its setup, before it
   * registers; the Stop held for it expires (60 s, 64 held), so only a replayed
   * end confirms then. A stream that just closes proves nothing (a dropped
   * connection, a session that expired, a turn that keeps running): it is
   * asked again. Not settled by `settleMs`, or no answer by then, is not.
   */
  async function settled(key, emptyCounts = true) {
    const deadline = Date.now() + settleMs;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), settleMs);
    try {
      while (!ac.signal.aborted) {
        try {
          const res = await fetch(`${dash}/setup-api/hermes/chat?${new URLSearchParams({ sessionKey: key })}`, {
            headers: headers({ Accept: "text/event-stream" }),
            signal: ac.signal,
          });
          if (res.status === 204) {
            if (emptyCounts) return true;
          } else if (!res.ok || !res.body) {
            log(`settle ${key}: HTTP ${res.status}`);
          } else {
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = "";
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              const taken = takeSseFrames(buf + dec.decode(value, { stream: true }));
              buf = taken.rest;
              if (taken.frames.some((f) => TERMINAL_EVENTS.has(f.event))) {
                try { await reader.cancel(); } catch { /* ended */ }
                return true;
              }
            }
          }
        } catch (e) {
          if (ac.signal.aborted) break;
          log(`settle ${key}: ${e.message}`);
        }
        if (Date.now() + 500 >= deadline) break;
        await new Promise((res) => setTimeout(res, 500));
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One turn. `signal` (optional) is the run's stop: aborted, the turn ends
   * at once as `stopped`. Whatever way it ends without the route saying so —
   * the timeout, the stop, a read error, a stream that ends early — the turn
   * is Stopped on the box (once) and must then settle before this returns: a
   * request going away does not end a Hermes turn, and the session's next
   * turn must not overlap it. A turn whose end cannot be confirmed blocks its
   * session (`sess.blocked`): no further turn is sent on it, and the run's
   * cleanup leaves it alone.
   *
   * `sess.untracked` counts turns sent with no Hermes session yet that ended
   * without naming one (the route names it only in its answer): a session
   * such a turn may have opened cannot be deleted by id.
   */
  async function turn(sess, message, timeoutMs, signal) {
    const r = { ackMs: null, firstTokenMs: null, latencyMs: null, toolCalls: 0, text: "", error: null, model: null };
    if (signal?.aborted) {
      r.error = { kind: "stopped", message: "the run was stopped" };
      return r;
    }
    if (sess.blocked) {
      r.error = { kind: "blocked", message: "an earlier turn on this session was never confirmed stopped" };
      return r;
    }
    const threadedBefore = Boolean(sess.sessionId);
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
        else {
          // No status proves that no turn ran: the CLI fallback answers 502
          // after it may have opened a session, 401 when the owner's session
          // ran out after the turn, 499 after a Stop — none with an id. Every
          // such answer counts as a turn that may have left a session behind.
          error = { kind: "http", message: `HTTP ${res.status}: ${String(json?.error || "").slice(0, 160)}` };
        }
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
    // the turn on the box (the only Stop this turn sends). The route waits a
    // bounded 5 s for it; whether it really ended is asked of the route.
    if (!ended) {
      r.latencyMs = null;
      // A Stop the route took is held for this turnId even if the POST has not
      // registered its turn yet, so a late start is stopped on arrival. A Stop
      // that failed holds nothing: the route showing no turn proves nothing.
      const stopped = await stop(sess.key, turnId);
      const why = stopped === null ? "its Stop failed" : (await settled(sess.key, stopped > 0)) ? null : `its Stop was not confirmed within ${Math.round(settleMs / 1000)} s`;
      if (why) {
        sess.blocked = true;
        r.error.message = `${r.error.message}; ${why}, so no more turns go to this session`.slice(0, 300);
        log(`${sess.key}: ${why}: no more turns on this session`);
      }
    }
    if (!threadedBefore && !sess.sessionId) sess.untracked = (sess.untracked || 0) + 1;
    return r;
  }

  return { turn, stop, settled };
}
