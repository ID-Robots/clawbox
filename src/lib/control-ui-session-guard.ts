/**
 * A lapsed session on the gateway's own Control UI chat.
 *
 * The desktop and the standalone app pages take themselves to /login when the
 * box stops accepting their session (src/lib/session-expiry.ts). The Control
 * UI — the OpenClaw chat the desktop opens at /chat, and frames on its
 * standalone app page — is the gateway's bundle, not a page of ours: when the
 * session ran out the box cut its socket and refused every reconnect, and the
 * chat stayed on screen, dead, with nothing to say why or to send the person
 * to sign in again.
 *
 * Both routes that serve its HTML (`serveGatewayHTML` and
 * /setup-api/gateway) inject this program, which applies the same rule the
 * desktop does: on the session gate's marked 401 to any request the page
 * makes, on a socket the box closed, or when the tab is shown again, ask the
 * box about the CURRENT session, and leave for /login only when that is
 * refused too. A box that cannot be reached is not a lapsed session.
 *
 * Over plain HTTP the box cuts a lapsed socket with no close code, and the UI's
 * reconnects are then refused at the upgrade, which a browser also reports as
 * a bare close — so every close but an orderly one asks, at most once per
 * `closeProbeGapMs` (the session-expired code always asks).
 */
import {
  SESSION_EXPIRED_CLOSE_CODE,
  SESSION_EXPIRED_HEADER,
  SESSION_EXPIRED_HEADER_VALUE,
  SESSION_PROBE_TIMEOUT_MS,
  SESSION_PROBE_URL,
} from "@/lib/session-expiry";

/** How often a burst of closes may ask about the session. */
export const CONTROL_UI_CLOSE_PROBE_GAP_MS = 3_000;

export interface ControlUiSessionGuardOptions {
  /** Tests shorten it. */
  readonly closeProbeGapMs?: number;
}

/** A value for an inline script: JSON, with nothing that can end the element. */
function forScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

/** The program itself, for a test to run exactly as it ships. */
export function controlUiSessionGuardScriptBody(options: ControlUiSessionGuardOptions = {}): string {
  const gapMs = Math.max(0, Math.trunc(options.closeProbeGapMs ?? CONTROL_UI_CLOSE_PROBE_GAP_MS));
  return `(function(){
// ONE per document: two routes serve this page, and two copies would each wrap
// fetch and WebSocket and ask twice.
if (window.__clawboxSessionGuard) return;
window.__clawboxSessionGuard = true;
var HEADER = ${forScript(SESSION_EXPIRED_HEADER)};
var EXPIRED = ${forScript(SESSION_EXPIRED_HEADER_VALUE)};
var CLOSE_CODE = ${forScript(SESSION_EXPIRED_CLOSE_CODE)};
var PROBE = ${forScript(SESSION_PROBE_URL)};
var GAP_MS = ${forScript(gapMs)};
var PROBE_TIMEOUT_MS = ${forScript(SESSION_PROBE_TIMEOUT_MS)};
var nativeFetch = typeof window.fetch === "function" ? window.fetch : null;
var leaving = false;
var inFlight = null;
var lastCloseProbe = -Infinity;

// The page to send to /login: the one that frames this chat when it is ours
// (the standalone app page), else this one.
function signedInPage() {
  try {
    if (window.top && window.top !== window && window.top.location.origin === window.location.origin) return window.top;
  } catch (e) {}
  return window;
}

function leave() {
  if (leaving) return;
  leaving = true;
  var w = signedInPage();
  try {
    w.location.replace("/login?" + new URLSearchParams({ redirect: w.location.pathname || "/" }).toString());
  } catch (e) {
    window.location.replace("/login");
  }
}

function refused(res) {
  try {
    return !!res && res.status === 401 && !!res.headers && res.headers.get(HEADER) === EXPIRED;
  } catch (e) {
    return false;
  }
}

// One probe at a time, shared only with a signal no newer than it: a probe
// sent before the refused request left may have been answered before the
// session ran out (the rule src/lib/session-expiry.ts keeps).
function probe(evidenceSentAt) {
  if (leaving || !nativeFetch) return;
  if (inFlight && inFlight.sentAt >= evidenceSentAt) return;
  // Bounded, like the desktop's probe: an answer the network swallows is a box
  // that cannot be reached, not a probe left open for ever.
  var controller = typeof AbortController === "function" ? new AbortController() : null;
  var timer = controller ? setTimeout(function () { controller.abort(); }, PROBE_TIMEOUT_MS) : null;
  var pending = nativeFetch.call(window, PROBE, controller ? { cache: "no-store", signal: controller.signal } : { cache: "no-store" });
  var entry = { sentAt: Date.now() };
  inFlight = entry;
  pending.then(function (res) { if (refused(res)) leave(); }, function () {}).then(function () {
    if (timer) clearTimeout(timer);
    if (inFlight === entry) inFlight = null;
  });
}

if (nativeFetch) {
  window.fetch = function (input, init) {
    var sentAt = Date.now();
    return nativeFetch.call(window, input, init).then(function (res) {
      if (refused(res)) probe(sentAt);
      return res;
    });
  };
}

function onClose(event) {
  var code = event && event.code;
  // Closed on purpose, or the page itself going away.
  if (code === 1000 || code === 1001) return;
  var now = Date.now();
  if (code !== CLOSE_CODE && now - lastCloseProbe < GAP_MS) return;
  lastCloseProbe = now;
  probe(now);
}

var NativeWebSocket = window.WebSocket;
if (typeof NativeWebSocket === "function") {
  // Constructed for \`new.target\`, so a page's \`class X extends WebSocket\`
  // still gets an X, with X's methods, out of \`super()\`.
  var GuardedWebSocket = function () {
    var ws = Reflect.construct(NativeWebSocket, Array.prototype.slice.call(arguments), new.target || GuardedWebSocket);
    try { ws.addEventListener("close", onClose); } catch (e) {}
    return ws;
  };
  GuardedWebSocket.prototype = NativeWebSocket.prototype;
  // Statics, for the subclass too (\`AppSocket.OPEN\`).
  try { Object.setPrototypeOf(GuardedWebSocket, NativeWebSocket); } catch (e) {}
  GuardedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  GuardedWebSocket.OPEN = NativeWebSocket.OPEN;
  GuardedWebSocket.CLOSING = NativeWebSocket.CLOSING;
  GuardedWebSocket.CLOSED = NativeWebSocket.CLOSED;
  window.WebSocket = GuardedWebSocket;
}

// A tab that sat in the background makes no request to be refused.
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible") probe(Date.now());
});
})();`;
}

/** The element both Control UI routes put in the page, ahead of the UI's own scripts. */
export function controlUiSessionGuardScript(): string {
  return `<script>${controlUiSessionGuardScriptBody()}</script>`;
}

/**
 * `snippet` as the first thing in the document's <head> — before any script
 * the page loads — or, for a document with no <head>, right after its <html>
 * or doctype (never ahead of the doctype, which would put the page in quirks
 * mode). A replacer FUNCTION: `$&` and friends are substitutions in a
 * replacement string.
 */
export function injectAtHeadStart(html: string, snippet: string): string {
  for (const tag of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype\b[^>]*>/i]) {
    if (tag.test(html)) return html.replace(tag, (match) => `${match}${snippet}`);
  }
  return `${snippet}${html}`;
}
