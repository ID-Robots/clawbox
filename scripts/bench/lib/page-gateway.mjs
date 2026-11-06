// The gateway socket, opened INSIDE the desktop page exactly the way the chat
// popup opens it: the page fetches its own ws-config and signs the connect
// challenge with the device identity it already holds. The token and the key
// never leave the page; the bench only receives timings and reply text.
//
// `GATEWAY_PAGE_SOURCE` is JavaScript evaluated in the page. It installs
// `window.__clawboxBenchGateway` = { open(), req(method, params, timeoutMs),
// on(fn), off(fn), close(), hello } once.
export const GATEWAY_PAGE_SOURCE = String.raw`
(() => {
  if (window.__clawboxBenchGateway) return 'present';
  const uuid = () => crypto.randomUUID();
  const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64u = (v) => Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const hex = (bytes) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  const scopes = ['operator.admin', 'operator.approvals', 'operator.questions', 'operator.pairing'];
  const norm = (v) => typeof v === 'string' ? v.trim().toLowerCase() : '';
  const g = { ws: null, hello: null, pending: new Map(), listeners: new Set() };
  g.on = (fn) => g.listeners.add(fn);
  g.off = (fn) => g.listeners.delete(fn);
  g.close = () => { try { g.ws && g.ws.close(); } catch {} g.ws = null; g.hello = null; };
  g.req = (method, params, timeoutMs) => new Promise((res, rej) => {
    if (!g.ws || g.ws.readyState !== 1) return rej(new Error('gateway socket not open'));
    const id = uuid();
    const t = setTimeout(() => { g.pending.delete(id); rej(new Error('timeout ' + method)); }, timeoutMs || 60000);
    g.pending.set(id, { res, rej, t });
    g.ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
  g.open = async () => {
    if (g.ws && g.ws.readyState === 1) return g.hello;
    const r = await fetch('/setup-api/gateway/ws-config', { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) throw new Error('ws-config ' + r.status);
    const cfg = await r.json();
    const token = cfg.token; const wsUrl = cfg.wsUrl;
    const stored = JSON.parse(localStorage.getItem('clawbox-gateway-device-identity-v1') || 'null');
    const clientPlatform = navigator.platform || 'web';
    const buildDevice = async (challenge) => {
      if (!stored || !stored.priv || !stored.pub) return null;
      const nonce = challenge && challenge.nonce; const signedAt = challenge && challenge.ts;
      if (typeof nonce !== 'string' || typeof signedAt !== 'number') return null;
      const pub = fromB64u(stored.pub);
      const deviceId = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', pub)));
      const payload = ['v3', deviceId, 'openclaw-control-ui', 'webchat', 'operator', scopes.join(','), String(signedAt), token || '', nonce, norm(clientPlatform), norm(undefined)].join('|');
      const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', d: stored.priv, x: stored.pub }, { name: 'Ed25519' }, false, ['sign']);
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(payload)));
      return { id: deviceId, publicKey: stored.pub, signature: b64u(sig), signedAt, nonce };
    };
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl); g.ws = ws;
      let done = false; const connectId = uuid();
      const sendConnect = async (challenge) => {
        const device = await buildDevice(challenge);
        ws.send(JSON.stringify({ type: 'req', id: connectId, method: 'connect', params: { minProtocol: 4, maxProtocol: 4, client: { id: 'openclaw-control-ui', version: 'clawbox-bench', platform: clientPlatform, mode: 'webchat', instanceId: uuid() }, role: 'operator', scopes, caps: ['tool-events'], auth: { token }, userAgent: navigator.userAgent, locale: navigator.language, ...(device ? { device } : {}) } }));
      };
      ws.onerror = () => { if (!done) { done = true; reject(new Error('gateway ws error')); } };
      ws.onclose = (e) => { if (!done) { done = true; reject(new Error('gateway closed ' + e.code + ' ' + e.reason)); } for (const [, p] of g.pending) { clearTimeout(p.t); p.rej(new Error('gateway closed')); } g.pending.clear(); };
      ws.onmessage = (ev) => {
        let f; try { f = JSON.parse(ev.data); } catch { return; }
        if (f.type === 'event' && f.event === 'connect.challenge') { void sendConnect(f.payload); return; }
        if (f.type === 'res' && f.id === connectId) { done = true; if (f.ok) { g.hello = f.payload; resolve(f.payload); } else reject(new Error('connect refused: ' + (f.error && f.error.message || ''))); return; }
        if (f.type === 'res' && g.pending.has(f.id)) { const p = g.pending.get(f.id); g.pending.delete(f.id); clearTimeout(p.t); f.ok ? p.res(f.payload) : p.rej(new Error(f.error && f.error.message || 'rpc error')); return; }
        if (f.type === 'event') for (const l of [...g.listeners]) { try { l(f); } catch {} }
      };
      setTimeout(() => { if (!done) { done = true; reject(new Error('gateway handshake timeout')); } }, 15000);
    });
  };
  window.__clawboxBenchGateway = g;
  return 'installed';
})()`;

/**
 * Page-side: send one message in `sessionKey` and wait for the final, with
 * timings relative to the send. Returns a plain object.
 */
export function sendTurnSource(sessionKey, message, timeoutMs) {
  return String.raw`
(async () => {
  const g = window.__clawboxBenchGateway;
  const key = ${JSON.stringify(sessionKey)};
  const run = { sendAt: Date.now(), ackMs: null, firstDeltaMs: null, finalMs: null, deltas: 0, tools: [], state: null, text: '', error: null, runId: null };
  const t0 = performance.now(); const ms = () => Math.round(performance.now() - t0);
  let resolveFinal; const finalP = new Promise((r) => { resolveFinal = r; });
  let runId = null;
  const l = (f) => {
    const p = f.payload || {};
    if (f.event === 'chat') {
      if (p.sessionKey !== key) return;
      if (runId && p.runId && p.runId !== runId) return;
      if (p.state === 'delta') { run.deltas++; if (run.firstDeltaMs === null) run.firstDeltaMs = ms(); }
      else if (p.state === 'final' || p.state === 'error' || p.state === 'aborted') {
        run.finalMs = ms(); run.state = p.state;
        const c = p.message && p.message.content;
        run.text = Array.isArray(c) ? c.map(x => x.text || '').join('') : String((p.message && (p.message.text || p.message.content)) || '');
        run.text = run.text.slice(0, 400);
        if (p.state === 'error') run.error = String(p.errorMessage || p.error || 'error');
        resolveFinal();
      }
    } else if (f.event === 'agent') {
      if (p.sessionKey && p.sessionKey !== key) return;
      if (runId && p.runId && p.runId !== runId) return;
      const d = p.data || {};
      if (p.stream === 'tool' && d.name) run.tools.push([ms(), d.phase || '', d.name]);
    }
  };
  g.on(l);
  try {
    const ack = await g.req('chat.send', { sessionKey: key, message: ${JSON.stringify(message)}, deliver: false, idempotencyKey: crypto.randomUUID() }, 60000);
    run.ackMs = ms(); runId = ack && ack.runId || null; run.runId = runId;
    await Promise.race([finalP, new Promise((_, rej) => setTimeout(() => rej(new Error('final timeout')), ${Number(timeoutMs) || 120000}))]);
  } catch (e) { run.error = (run.error ? run.error + ' ' : '') + e.message; }
  g.off(l);
  return run;
})()`;
}
