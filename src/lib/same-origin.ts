/**
 * Is this state-changing request coming from OUR page?
 *
 * WHY. src/middleware.ts authenticates a request; it does not ask where the
 * request was made FROM. A browser that holds the owner's session cookie will
 * attach it to a POST any other site's page fires at the box, and a route that
 * only checks "is the owner signed in" then does that site's bidding. The
 * GitHub login is the route that made this worth writing: a cross-site page
 * could start a device flow, so the answer here is a small, reusable guard a
 * state-changing route calls after its owner gate.
 *
 * What it reads, in order:
 *  - `Origin`, which browsers attach to every cross-origin request and every
 *    POST. Its HOST is compared with the host the request was addressed to —
 *    host, not scheme, because the box is reached over plain http on the LAN
 *    and over https through the remote-access tunnel, and in both cases the
 *    request's own Host header names the same place the page was served from.
 *    The literal `null` (a sandboxed frame, a redirect across schemes) is
 *    refused: it says "somewhere you cannot trust", not "nowhere".
 *  - `Sec-Fetch-Site`, when there is no Origin: a browser saying `cross-site`
 *    or `same-site` (a sibling host) is refused; `same-origin` and `none` (the
 *    owner typing the address) are allowed.
 *  - Neither header: allowed. curl, the MCP server and every non-browser
 *    caller send nothing here, and they are not the party this guards against
 *    — their credential is what the route's own gate decides on.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    if (origin.trim().toLowerCase() === "null") return false;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    return originHost.toLowerCase() === requestHost(request);
  }
  const site = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site === "cross-site" || site === "same-site") return false;
  return true;
}

/** The host the request was addressed to: the Host header first, the URL's as a fallback. */
function requestHost(request: Request): string {
  const header = request.headers.get("host")?.trim();
  if (header) return header.toLowerCase();
  try {
    return new URL(request.url).host.toLowerCase();
  } catch {
    return "";
  }
}
