/**
 * A server app's window: how a project's own server under `/apps/<id>/`
 * (src/lib/app-proxy.ts) stays signed in while the owner clicks around in it.
 *
 * WHY
 *
 * The app's document is served under a CSP sandbox with no allow-same-origin,
 * so it has an opaque origin and nothing of the desktop's is in its reach.
 * The price: every request that document makes ITSELF is cross-site to the
 * box. Measured with Chromium over plain-HTTP LAN: a link it follows, a form
 * it posts and a fetch it makes carry no cookie, no Sec-Fetch-* and no
 * Referer (a POST and a fetch carry `Origin: null`); through the tunnel they
 * say `Sec-Fetch-Site: cross-site` and still carry no cookie. Assets and
 * fetches pass the middleware without one (step 2b), but a page the frame
 * navigated to met the session gate empty-handed and the window showed the
 * box's login screen. Only the frame's FIRST page had the cookie, because
 * the desktop started that navigation.
 *
 * A cookie of the app's own cannot fix it on the LAN: a cookie a cross-site
 * request carries must be `SameSite=None`, which browsers accept only with
 * `Secure`, which plain HTTP cannot set. So the frame is not given anything.
 * Instead the desktop, which holds the session, starts the navigation again:
 *
 *   1. The frame navigates to `/apps/<id>/page` without a cookie. The
 *      middleware answers a navigation there that has no session, and is
 *      not a top-level one, with APP_REOPEN_PAGE: a tiny page that posts
 *      `{ clawboxAppReopen: { href } }` to its parent.
 *   2. The window around it (src/components/WebappFrame.tsx) checks that the
 *      message came from ITS frame and that `href` is that app's own
 *      `/apps/<id>/…` on this origin (appReopenHref), acknowledges, and
 *      navigates the frame there itself. A navigation the desktop starts is
 *      same-site, so the owner's cookie goes with it — LAN and tunnel alike.
 *   3. Nobody answers (a visitor's tab, a page that is not the desktop): the
 *      page goes to /login after a few seconds, at once when it is not framed.
 *
 * WHAT THE APP GAINS
 *
 * Nothing it can hold: no token, no cookie, no header. It can ask the
 * desktop to load ITS OWN pages with the owner's session — which is what
 * opening the window already did — and the answer still reaches it under the
 * sandbox. A href outside `/apps/<id>/` (the box's API, another app, the
 * desktop) is refused, and so is anything a server could read as a way out
 * of that prefix (an encoded dot or slash). The proxy strips the owner's
 * cookie before the app's server sees a request (src/app/apps/[id]/…).
 *
 * This module stays dependency-free: the middleware, the proxy and a client
 * component all import it.
 */

/**
 * The App Router's `Next-Url` header, carried past the box's own Next.js.
 *
 * A client-side navigation in a Next app sends `Next-Url` and hashes it into
 * the `_rsc` search param; the app's server recomputes that hash and answers
 * a mismatch with a 307 to the "right" URL. The box's own Next.js deletes
 * `Next-Url` from a request before a route handler sees it (it has no
 * interception routes, so it has no use for it), so the proxy forwarded
 * every navigation without it: the app redirected, the router gave up on the
 * fetch and loaded the page in full instead. The middleware, which runs
 * before that deletion, copies it into this header; the proxy turns it back
 * into `Next-Url` for the app and forwards nothing else of it.
 */
export const APP_PROXY_NEXT_URL_HEADER = "x-clawbox-next-url";

/** The message the reopen page posts to its parent. */
export const APP_REOPEN_MESSAGE = "clawboxAppReopen";
/** The parent's answer: "I am opening it", so the page stops waiting. */
export const APP_REOPEN_ACK = "clawboxAppReopenAck";
/** How long the reopen page waits for an answer before it goes to /login. */
export const APP_REOPEN_WAIT_MS = 5_000;
/**
 * The same address asked for again this soon after the desktop opened it is
 * a loop, not a click: the desktop's own cookie did not get it in either (the
 * session ended), so the page is left to go to /login.
 */
export const APP_REOPEN_REPEAT_MS = 4_000;

const APP_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** `%2e` `%2f` `%5c` — a dot, a slash or a backslash some server might decode into a way out of the prefix. */
const ENCODED_PATH_ESCAPE_RE = /%(?:2e|2f|5c)/i;
const MAX_HREF_LENGTH = 4096;

/**
 * Which app a window frame belongs to: the id in its `/apps/<id>/` address,
 * else the `app` of a `/setup-api/webapps?app=<id>` address (which sends a
 * server app on to `/apps/<id>/`), else the id the window was opened with.
 * Same origin only. Null when none of them is an app id.
 */
export function appWindowIdOf(src: string, origin: string, appId?: string): string | null {
  try {
    const u = new URL(src, origin);
    if (u.origin === origin) {
      const proxied = /^\/apps\/([^/]+)(?:\/|$)/.exec(u.pathname);
      if (proxied) return APP_ID_RE.test(proxied[1]) ? proxied[1] : null;
      if (u.pathname === "/setup-api/webapps" || u.pathname === "/setup-api/webapps/") {
        const app = u.searchParams.get("app");
        if (app && APP_ID_RE.test(app)) return app;
      }
    }
  } catch {
    // An address that does not parse names no app; fall back to the id.
  }
  return appId && APP_ID_RE.test(appId) ? appId : null;
}

/**
 * The address the desktop may open in app `appId`'s window for a reopen
 * request, or null to refuse it: a string naming `/apps/<appId>` or a path
 * below it on `origin`, with no credentials and no encoded dot, slash or
 * backslash in the path. Dot segments are resolved by the URL parser first,
 * so `/apps/<appId>/../../setup-api` is judged as `/setup-api` and refused.
 */
export function appReopenHref(href: unknown, appId: string, origin: string): string | null {
  if (typeof href !== "string" || !href || href.length > MAX_HREF_LENGTH) return null;
  if (!APP_ID_RE.test(appId)) return null;
  let u: URL;
  try {
    u = new URL(href, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin || (u.protocol !== "http:" && u.protocol !== "https:")) return null;
  if (u.username || u.password) return null;
  const prefix = `/apps/${appId}`;
  if (u.pathname !== prefix && !u.pathname.startsWith(`${prefix}/`)) return null;
  if (ENCODED_PATH_ESCAPE_RE.test(u.pathname) || u.pathname.includes("\\")) return null;
  return u.href;
}

/** `JSON.stringify` safe inside an inline `<script>`. */
function scriptString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function htmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The policy the reopen page is served under: the same opaque origin as the
 * app it stands in for, its one inline script, and nothing else — no fetch,
 * no form, no frame of its own.
 */
export const APP_REOPEN_PAGE_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/**
 * The page the middleware answers a server app's window with when the frame
 * navigated itself (no cookie — see the top of this file). `loginUrl` is
 * where it goes when nobody reopens it. `relay: false` is for a request that
 * DID carry a session cookie that no longer verifies: that is the desktop's
 * own navigation coming back signed out, and asking again would loop.
 */
export function appReopenPage(loginUrl: string, relay = true): string {
  const login = scriptString(loginUrl);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>ClawBox</title>
<style>html,body{margin:0;height:100%;background:#fff;color:#555;font:14px system-ui,sans-serif}body{display:flex;align-items:center;justify-content:center}a{color:#f97316}</style></head>
<body><p data-clawbox-app-reopen="1">Opening&hellip; <noscript><a href="${htmlText(loginUrl)}">Sign in to ClawBox</a></noscript></p>
<script>
(function () {
  var login = ${login};
  var framed = false;
  try { framed = window.parent !== window; } catch (e) { framed = true; }
  if (!${relay ? "true" : "false"} || !framed) { location.replace(login); return; }
  var timer = setTimeout(function () { location.replace(login); }, ${APP_REOPEN_WAIT_MS});
  window.addEventListener("message", function (event) {
    if (event.source === window.parent && event.data && event.data.${APP_REOPEN_ACK}) clearTimeout(timer);
  });
  var ask = {};
  ask.${APP_REOPEN_MESSAGE} = { href: location.href };
  window.parent.postMessage(ask, "*");
})();
</script></body></html>
`;
}

/** Navigate a window's frame to `href` — the desktop's own navigation, which carries its cookie. A seam for the tests. */
export function navigateAppFrame(frame: { contentWindow: { location: { replace(url: string): void } } | null }, href: string): void {
  frame.contentWindow?.location.replace(href);
}
