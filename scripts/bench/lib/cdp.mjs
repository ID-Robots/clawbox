// A minimal Chrome DevTools Protocol client over Node's global WebSocket.
//
// The bench drives the box through the Chrome that already shows the desktop
// (the kiosk's loopback DevTools port): the page is signed in as the owner, so
// a `fetch` evaluated inside it reaches owner-only routes without the bench
// ever touching a cookie, a token or the session secret.

export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`DevTools port ${port} answered ${res.status}`);
  return res.json();
}

export async function connectTarget(wsUrl, { timeoutMs = 10_000 } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`CDP connect timeout ${wsUrl}`)), timeoutMs);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = () => { clearTimeout(t); reject(new Error(`CDP connect failed ${wsUrl}`)); };
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.method) {
      const ls = listeners.get(m.method);
      if (ls) for (const l of [...ls]) l(m.params);
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`));
    else p.res(m.result);
  };
  ws.onclose = () => {
    for (const [, p] of pending) p.rej(new Error(`CDP socket closed during ${p.method}`));
    pending.clear();
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(fn);
    return () => listeners.get(method)?.delete(fn);
  };
  const evaluate = async (expression, { timeoutMs: evalTimeout = 120_000 } = {}) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: evalTimeout });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluate failed");
    }
    return r.result.value;
  };
  return { send, on, evaluate, close: () => { try { ws.close(); } catch { /* closed */ } } };
}

/** The desktop page: a localhost page at "/" (or one whose address contains `urlMatch`). */
export function isDesktopUrl(raw, urlMatch = null) {
  if (urlMatch !== null) return typeof raw === "string" && raw.includes(urlMatch);
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:")
      && (u.hostname === "localhost" || u.hostname === "127.0.0.1")
      && u.pathname === "/";
  } catch {
    return false;
  }
}

export async function findDesktopTarget(port, urlMatch = null) {
  const targets = await listTargets(port);
  return targets.find((t) => t.type === "page" && isDesktopUrl(t.url, urlMatch)) ?? null;
}

/**
 * Open a NEW page in that Chrome (it shows on the box's screen while it is
 * open), attach to it and hand back a handle with `close()`.
 */
export async function openPage(port, url, { timeoutMs = 10_000 } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!res.ok) throw new Error(`DevTools /json/new answered ${res.status}`);
  const target = await res.json();
  const cdp = await connectTarget(target.webSocketDebuggerUrl, { timeoutMs });
  return {
    ...cdp,
    id: target.id,
    close: async () => {
      cdp.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => null);
    },
  };
}
