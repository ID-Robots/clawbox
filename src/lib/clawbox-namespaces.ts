/**
 * Which top-level paths belong to ClawBox rather than to the OpenClaw gateway.
 *
 * WHY THIS EXISTS. `src/app/[...gateway]/route.ts` answers every path Next did
 * not match, and for a NAVIGATION it answers with the Control UI shell — into
 * which `serveGatewayHTML` injects the gateway auth token for an owner session.
 * That is the right answer for a gateway deep link like `/chat/main` and the
 * wrong one for a path in ClawBox's own namespace, where the gateway serves
 * nothing at all: the owner asked for a ClawBox page or endpoint that does not
 * exist and was handed somebody else's application, with a credential in it.
 *
 * Measured on an OpenClaw box at beta head `c2b1a44b`, owner-authenticated,
 * with a browser's navigation metadata (TASK-631 / F-29):
 *
 *     GET /setup-api        -> 200 text/html, Control UI, token injected
 *     GET /setup-api/       -> 308 to /setup-api, then the same
 *     GET /portal           -> 200 text/html, Control UI, token injected
 *     GET /portal/nope      -> 200 text/html, Control UI, token injected
 *     GET /login-api/nope   -> 200 text/html, Control UI, token injected
 *     GET /app              -> 200 text/html, Control UI, token injected
 *     GET /app/x/y          -> 200 text/html, Control UI, token injected
 *     GET /Setup-Api/nope   -> 200 text/html, Control UI, token injected
 *     GET /setup-api/nope   -> 404 text/plain
 *
 * The last line is the half that was already fixed, and it is what makes the
 * shape of the defect obvious: the guard tested `startsWith("/setup-api/")`,
 * WITH the trailing slash, so the namespace root itself fell straight through
 * it — and nothing covered the other four namespaces at all.
 *
 * SEGMENT-BOUNDARY MATCHING IS LOAD-BEARING. `/setup-api` also starts with
 * `/setup`; a bare `startsWith` on the roots below would fold one into the
 * other, which is the original auth-bypass `src/middleware.ts` still carries a
 * comment about. `isUnderRoot` matches the root exactly or the root plus a
 * separator, and never `/setupsomething`.
 */

/**
 * ClawBox's API namespaces. An unmatched path here is a missing endpoint, and
 * its caller is code: it gets JSON, like every real route under them and like
 * the middleware's own 401 for the same prefix.
 */
const CLAWBOX_API_ROOTS = ["/setup-api", "/login-api"] as const;

/**
 * ClawBox's page namespaces. `/app` is one of them: `src/app/app/[id]/page.tsx`
 * matches ONE segment and there is no page at the root, so both `/app` and
 * `/app/x/y` reached the catch-all (measured: 200 Control UI, token injected).
 *
 * `/api`, `/assets` and the gateway's static trees are absent for the opposite
 * reason — they are the GATEWAY's, and serving them is what the catch-all is
 * for. Checked against the pinned Control UI's own bundle rather than assumed:
 * `dist/control-ui/assets/*.js` carries route literals for `/chat`,
 * `/sessions` and `/logs`, and none for any root below.
 */
const CLAWBOX_PAGE_ROOTS = ["/setup", "/login", "/portal", "/updating", "/app"] as const;

/**
 * `/a` matches `/a` and `/a/b`, never `/ab`.
 *
 * Case-SENSITIVE, deliberately, because `src/middleware.ts` feeds it an
 * already-lower-cased pathname and three of its allow-gates depend on that
 * exact comparison. The catch-all route lower-cases at its own call site
 * instead — see the note there.
 */
function isUnderRoot(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

/** ClawBox's own API namespace: `/setup-api` itself and everything under it. */
export function isSetupApiPath(pathname: string): boolean {
  return isUnderRoot(pathname, "/setup-api");
}

/**
 * Which ClawBox namespace owns this path, or null when it is the gateway's.
 *
 * `"api"` and `"page"` differ only in what an unmatched path should answer
 * WITH — the ownership question has one answer for both.
 */
export function clawboxNamespaceKind(pathname: string): "api" | "page" | null {
  // Lower-cased HERE and not in `isUnderRoot`: Next's router is case-sensitive,
  // so `/Setup-Api/nope` and `/Portal/nope` matched no ClawBox route and were
  // answered with the shell and the token (measured on a box). This is the same
  // leak class as the `/Login` and `/Manifest.json` fall-throughs
  // `serveGatewayHTML` still carries a comment about. Ownership is not a
  // question of spelling; the middleware's own gates, which get a pathname that
  // is already lower-cased, keep the exact comparison.
  const lower = pathname.toLowerCase();
  if (CLAWBOX_API_ROOTS.some((root) => isUnderRoot(lower, root))) return "api";
  if (CLAWBOX_PAGE_ROOTS.some((root) => isUnderRoot(lower, root))) return "page";
  return null;
}
