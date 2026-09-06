/**
 * The two halves of the webapp sandbox contract.
 *
 * A webapp is HTML the agent wrote. The desktop (src/app/page.tsx) and the
 * standalone page (src/app/app/[id]/page.tsx) frame it from the ClawBox origin,
 * and with `allow-same-origin` that frame ran with the OWNER's session: it
 * could call every session-authenticated /setup-api route — including the ones
 * that refuse the agent's own bearer (email/pending, coding-agent/enable) — and
 * script the desktop around it. Both pages now use the one sandbox below, so
 * the frame has an opaque origin and none of that reaches it.
 *
 * What an opaque origin loses is storage: fetch('/setup-api/kv') from inside
 * the frame is cross-origin now, the session cookie is not sent and CSP
 * refuses the call. The replacement is a postMessage bridge — the guest posts
 * `{ clawboxKv: { id, op, key, value } }` to window.parent, the host performs
 * the KV call with the owner's session under the app's own key namespace and
 * answers `{ clawboxKvResult: { id, ok, value, error } }` to that frame only.
 * The guest half is the snippet below; code-projects.ts inlines it into every
 * new project and the field guide (mcp/tools/orientation.ts) hands it to the
 * agent for one-file apps.
 */

/** The iframe `sandbox` attribute for a framed webapp. Never `allow-same-origin`. */
export const WEBAPP_IFRAME_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads";

/**
 * The same sandbox as a RESPONSE HEADER — `Content-Security-Policy: sandbox …`
 * on everything GET /setup-api/webapps serves — for the document nobody
 * framed.
 *
 * The attribute above boxes the webapp only while a page of ours is the one
 * framing it. The raw URL is also a first-class document on the authenticated
 * origin: the desktop `window.open`s it for an `installed_meta` entry with
 * `launch: "window"`, a chat reply can link to it, a share link can be pasted
 * into a tab. Opened top-level, the agent's script ran with the owner's
 * session cookie and could call every session-authenticated route — including
 * the ones that deliberately refuse the agent's own bearer. A `sandbox`
 * directive in the response's CSP gives that document the same opaque origin
 * the frame has, wherever it was opened, and a framed document is unchanged
 * (the attribute and the header intersect, and both already lack
 * allow-same-origin). What a top-level open loses is localStorage and
 * IndexedDB (a SecurityError under an opaque origin) and the KV bridge, which
 * never worked without a parent; nothing on the box writes `launch` or
 * `public`, so no shipped app is affected.
 *
 * Derived from the attribute so the two cannot drift, plus allow-pointer-lock:
 * a game that wants the pointer is the reason `launch: "window"` exists at all
 * (src/app/page.tsx). Never allow-same-origin, and never
 * allow-popups-to-escape-sandbox — a popup this document opens must not come
 * out of the box either, because top-level there is nothing outside it.
 *
 * DELIVERY: next.config.ts `headers()` is what actually ships this — a
 * Content-Security-Policy set by a route handler is dropped in production
 * because the config already sets one for the path (a config header is
 * written before the handler runs and a handler's copy of an existing key is
 * not appended). The route sets it too, for the record and for its tests, but
 * the config entry is the one on the wire.
 *
 * This module stays dependency-free on purpose: next.config.ts imports it, and
 * the config is loaded before any alias or bundler exists.
 */
export const WEBAPP_DOCUMENT_CSP = `sandbox ${WEBAPP_IFRAME_SANDBOX} allow-pointer-lock`;

/**
 * The guest half of the KV bridge: a dependency-free `<script>` defining
 * `window.clawboxKv = { get, set, delete, list }`, each returning a Promise
 * that resolves on the host's matching `clawboxKvResult` and rejects after
 * 30 s of silence (the app was opened somewhere that is not the ClawBox
 * desktop). `"*"` as the target origin is deliberate: the host is whichever
 * page framed the app, and the frame's own origin is "null", so no narrower
 * target can be named — the host's `event.source` check is what scopes the
 * conversation to this frame.
 */
export const WEBAPP_KV_CLIENT_SNIPPET = `<script>
(function () {
  if (window.clawboxKv) return;
  var pending = {};
  var seq = 0;
  window.addEventListener("message", function (event) {
    var result = event.data && event.data.clawboxKvResult;
    if (!result || !pending[result.id]) return;
    var call = pending[result.id];
    delete pending[result.id];
    clearTimeout(call.timer);
    if (result.ok) call.resolve(result.value === undefined ? null : result.value);
    else call.reject(new Error(result.error || "clawboxKv: request failed"));
  });
  function request(op, key, value) {
    return new Promise(function (resolve, reject) {
      if (window.parent === window) {
        reject(new Error("clawboxKv: this app is not running inside the ClawBox desktop"));
        return;
      }
      var id = "kv" + (++seq) + "-" + Date.now();
      pending[id] = {
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function () {
          delete pending[id];
          reject(new Error("clawboxKv: no answer from the ClawBox desktop after 30 s"));
        }, 30000)
      };
      window.parent.postMessage({ clawboxKv: { id: id, op: op, key: key, value: value } }, "*");
    });
  }
  window.clawboxKv = {
    get: function (key) { return request("get", key); },
    set: function (key, value) { return request("set", key, value); },
    "delete": function (key) { return request("delete", key); },
    list: function () { return request("list"); }
  };
})();
</script>`;

/**
 * Is this frame source a project's own server proxied under /apps/<id>/ on
 * THIS origin? Such a document is boxed by the response's own CSP sandbox
 * (src/lib/app-proxy.ts) and must not ALSO carry the attribute: a sandboxed
 * frame's navigation sends no cookie, and that document needs the owner's.
 * Same origin only — a foreign /apps/ path is somebody else's page.
 */
export function isProxiedAppUrl(src: string, origin?: string): boolean {
  // `globalThis`, not `window`: the MCP server imports this module for the
  // KV snippet and is typechecked without the DOM.
  const base = origin ?? (globalThis as { location?: { origin?: string } }).location?.origin ?? "http://localhost";
  try {
    const u = new URL(src, base);
    return u.origin === base && /^\/apps\/[a-zA-Z0-9_-]{1,64}(?:\/|$)/.test(u.pathname);
  } catch {
    return false;
  }
}
