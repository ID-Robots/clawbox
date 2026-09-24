/**
 * The guest half of the webapp legacy-storage layer: the first script of a
 * pre-v4.0 webapp's page (see webapp-legacy-storage-rules.ts for the history).
 *
 * The app keeps its own code. Two things it did on the ClawBox origin are
 * given back to it in the opaque origin it now runs in, without the origin:
 *
 *  - `fetch('/setup-api/kv…')` on this host is answered through the desktop's
 *    KV bridge (op `legacyKv`) instead of the network, where it would carry no
 *    session and be refused. Every other request is the browser's own fetch.
 *  - `localStorage` — which THROWS in an opaque origin, usually taking the
 *    app's first screen with it — is a working one: seeded with what the app
 *    saved, every change sent through the bridge (op `legacyLocalStorage`) in
 *    order, one batch in flight at a time. `sessionStorage` is a working one
 *    in memory, which is what a session's storage is.
 *
 * The desktop decides whose namespace a request reaches by the frame it came
 * from, so nothing here can widen what the app reaches; this script only
 * shapes the requests. It is dependency-free ES5 plus Promise, Proxy and
 * TextEncoder, and it never runs twice in one page.
 */

export interface LegacyStorageShimConfig {
  /** Answer `fetch('/setup-api/kv')` through the bridge. */
  kv: boolean;
  /**
   * Replace a localStorage the page cannot use. `seed` is what the app saved;
   * `persist: false` keeps changes in memory (a public view — see
   * legacyWebappDocument).
   */
  storage: { seed: Record<string, string>; persist: boolean } | null;
}

/** Inline-safe JSON: nothing in it can close the script or start markup. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const GUEST_JS = String.raw`
(function () {
  if (window.__clawboxLegacyStorage) return;
  window.__clawboxLegacyStorage = true;
  var CONFIG = __CLAWBOX_LEGACY_STORAGE_CONFIG__;
  var MAX_VALUE_BYTES = 262144;
  var framed = false;
  try { framed = window.parent !== window; } catch (e) { framed = false; }
  var pending = Object.create(null);
  var seq = 0;
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var result = event.data && event.data.clawboxKvResult;
    if (!result || typeof result.id !== "string" || !pending[result.id]) return;
    var call = pending[result.id];
    delete pending[result.id];
    clearTimeout(call.timer);
    if (result.ok) call.resolve(result.value);
    else call.reject(new Error(result.error || "request failed"));
  });
  function ask(op, value) {
    return new Promise(function (resolve, reject) {
      if (!framed) { reject(new Error("not inside the ClawBox desktop")); return; }
      var id = "legacy" + (++seq) + "-" + Date.now();
      pending[id] = {
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function () {
          delete pending[id];
          reject(new Error("no answer from the ClawBox desktop"));
        }, 30000)
      };
      window.parent.postMessage({ clawboxKv: { id: id, op: op, value: value } }, "*");
    });
  }
  var warned = false;
  function warn(message) {
    if (warned) return;
    warned = true;
    try { console.warn("[ClawBox] " + message); } catch (e) {}
  }
  function byteLength(text) {
    try { return new TextEncoder().encode(text).length; } catch (e) { return text.length * 3; }
  }

  if (CONFIG.kv && typeof window.fetch === "function") {
    var nativeFetch = window.fetch;
    var KV_PATH = "/setup-api/kv";
    var kvTarget = function (input, init) {
      var isRequest = typeof Request === "function" && input instanceof Request;
      var url;
      try { url = new URL(isRequest ? input.url : String(input), location.href); } catch (e) { return null; }
      if (url.host !== location.host) return null;
      if (url.pathname !== KV_PATH && url.pathname !== KV_PATH + "/") return null;
      var hasInitBody = !!init && init.body !== undefined && init.body !== null;
      var method = (init && init.method) || (isRequest ? input.method : "GET") || "GET";
      return {
        method: String(method).toUpperCase(),
        search: url.search,
        body: hasInitBody ? init.body : isRequest ? input : null,
        fromRequest: isRequest && !hasInitBody
      };
    };
    var bodyText = function (target) {
      var body = target.body;
      if (body === null || body === undefined) return Promise.resolve("");
      if (target.fromRequest) return body.clone().text();
      if (typeof body === "string") return Promise.resolve(body);
      if (typeof body.text === "function") return body.text();
      return Promise.resolve(String(body));
    };
    window.fetch = function (input, init) {
      var target = kvTarget(input, init);
      if (!target || !framed) return nativeFetch.apply(window, arguments);
      return bodyText(target).then(function (text) {
        return ask("legacyKv", { method: target.method, search: target.search, body: text });
      }).then(function (answer) {
        var status = answer && typeof answer.status === "number" ? answer.status : 500;
        var hasBody = answer && answer.body !== undefined && answer.body !== null;
        return new Response(hasBody ? JSON.stringify(answer.body) : null, {
          status: status,
          headers: hasBody ? { "Content-Type": "application/json" } : {}
        });
      }, function () {
        throw new TypeError("Failed to fetch");
      });
    };
  }

  function makeStorage(seed, onChange) {
    var data = Object.create(null);
    var own = function (key) { return Object.prototype.hasOwnProperty.call(data, key); };
    Object.keys(seed || {}).forEach(function (key) { data[key] = String(seed[key]); });
    var api = {};
    var method = function (name, fn) {
      Object.defineProperty(api, name, { value: fn, writable: true, configurable: true, enumerable: false });
    };
    method("getItem", function (key) { key = String(key); return own(key) ? data[key] : null; });
    method("setItem", function (key, value) {
      key = String(key);
      value = String(value);
      if (onChange && byteLength(value) > MAX_VALUE_BYTES) {
        throw new DOMException("The value of '" + key + "' is larger than ClawBox can store for an app.", "QuotaExceededError");
      }
      data[key] = value;
      if (onChange) onChange("set", key, value);
    });
    method("removeItem", function (key) {
      key = String(key);
      if (!own(key)) return;
      delete data[key];
      if (onChange) onChange("remove", key);
    });
    method("clear", function () {
      data = Object.create(null);
      if (onChange) onChange("clear");
    });
    method("key", function (index) {
      var keys = Object.keys(data);
      index = Math.floor(Number(index));
      return index >= 0 && index < keys.length ? keys[index] : null;
    });
    Object.defineProperty(api, "length", {
      get: function () { return Object.keys(data).length; },
      configurable: true,
      enumerable: false
    });
    if (typeof Proxy !== "function") return api;
    return new Proxy(api, {
      get: function (target, prop) {
        if (typeof prop === "symbol" || prop in target) return target[prop];
        return own(prop) ? data[prop] : undefined;
      },
      set: function (target, prop, value) {
        if (typeof prop !== "symbol" && !(prop in target)) api.setItem(prop, value);
        return true;
      },
      deleteProperty: function (target, prop) {
        if (typeof prop !== "symbol" && !(prop in target)) api.removeItem(prop);
        return true;
      },
      has: function (target, prop) {
        return prop in target || (typeof prop === "string" && own(prop));
      },
      ownKeys: function () { return Object.keys(data); },
      getOwnPropertyDescriptor: function (target, prop) {
        if (typeof prop === "string" && own(prop) && !(prop in target)) {
          return { value: data[prop], writable: true, enumerable: true, configurable: true };
        }
        return undefined;
      }
    });
  }
  function usable(name) {
    try {
      var storage = window[name];
      if (!storage || typeof storage.getItem !== "function") return false;
      storage.getItem("__clawbox_probe__");
      return true;
    } catch (e) {
      return false;
    }
  }
  function install(name, storage) {
    try {
      Object.defineProperty(window, name, { configurable: true, enumerable: true, get: function () { return storage; } });
    } catch (e) {}
  }

  if (CONFIG.storage && !usable("localStorage")) {
    var persist = CONFIG.storage.persist && framed;
    var batch = null;
    var sending = false;
    var send = function () {
      var ops = batch;
      batch = null;
      if (!ops) { sending = false; return; }
      var done = function () { if (batch) send(); else sending = false; };
      ask("legacyLocalStorage", { clear: ops.clear, set: ops.set, remove: Object.keys(ops.remove) }).then(function (answer) {
        if (answer && answer.dropped && answer.dropped.length) warn("some of this app's storage could not be saved: " + answer.dropped.join(", "));
        done();
      }, function (err) {
        warn("this app's storage could not be saved: " + (err && err.message ? err.message : err));
        done();
      });
    };
    var note = function (op, key, value) {
      if (!batch || op === "clear") batch = { clear: op === "clear" || (batch ? batch.clear : false), set: Object.create(null), remove: Object.create(null) };
      if (op === "set") { batch.set[key] = value; delete batch.remove[key]; }
      else if (op === "remove") { delete batch.set[key]; batch.remove[key] = true; }
      if (!sending) { sending = true; Promise.resolve().then(send); }
    };
    install("localStorage", makeStorage(CONFIG.storage.seed, persist ? note : null));
  }
  if (CONFIG.storage && !usable("sessionStorage")) install("sessionStorage", makeStorage({}, null));
})();
`;

/** The script element to put first in a legacy app's page. */
export function legacyStorageShimScript(config: LegacyStorageShimConfig): string {
  return `<script>${GUEST_JS.replace("__CLAWBOX_LEGACY_STORAGE_CONFIG__", () => scriptJson(config))}</script>`;
}

/**
 * The page with the script inserted before anything of the app's can run:
 * straight after `<head>`, else after `<html>`, else after the doctype (never
 * before it — that would put the page in quirks mode), else at the very start.
 */
export function injectLegacyStorageShim(html: string, script: string): string {
  const at = (index: number) => html.slice(0, index) + script + html.slice(index);
  const head = /<head(?=[\s>/])[^>]*>/i.exec(html);
  if (head) return at(head.index + head[0].length);
  const root = /<html(?=[\s>/])[^>]*>/i.exec(html);
  if (root) return at(root.index + root[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return at(doctype[0].length);
  return script + html;
}
