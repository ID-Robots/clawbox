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
export const CLAWBOX_API_ROOTS = ["/setup-api", "/login-api"] as const;

/**
 * ClawBox's page namespaces. `/app` is one of them: `src/app/app/[id]/page.tsx`
 * matches ONE segment and there is no page at the root, so both `/app` and
 * `/app/x/y` reached the catch-all (measured: 200 Control UI, token injected).
 *
 * `/apps` is deliberately NOT here — see `UNCLAIMED_ROOTS`, which is where the
 * evidence for that lives. `clawbox-namespace-coverage.test.ts` reads `src/app/`
 * and fails when a top-level route directory is in neither list, so a namespace
 * added later cannot be missed the way `/app` was.
 */
export const CLAWBOX_PAGE_ROOTS = [
  "/setup",
  "/login",
  "/portal",
  "/updating",
  "/app",
] as const;

/**
 * Top-level route directories this module deliberately does NOT claim, so the
 * coverage guard can tell "decided against" from "never noticed". An unmatched
 * path under one of these keeps reaching the catch-all, which is the point.
 *
 * `/api` is the GATEWAY's own API surface — ClawBox's routes live under
 * `/setup-api` precisely so this prefix stays the gateway's
 * (src/app/api/[...path]/route.ts says so in as many words). `/assets` is the
 * Control UI's static tree (src/lib/gateway-static.ts). The two favicons are
 * the gateway's too: `public/` has no copy, their handlers proxy, and
 * `src/middleware.ts` lists them in `GATEWAY_ONLY_EXACT`.
 *
 * `/apps` IS ClawBox's below the root and the GATEWAY'S at it, which is why
 * claiming it would be wrong in both directions:
 *
 *   - Below it, `src/app/apps/[id]/[[...path]]/route.ts` is an OPTIONAL
 *     catch-all, so `/apps/<id>` AND `/apps/<id>/…` are matched by a real
 *     route. Nothing under `/apps/` ever reaches the catch-all, so an entry
 *     here could never fire on a real path.
 *   - At the root, `/apps` is a Control UI PAGE. Claiming it would 404 a
 *     gateway page that works today.
 *
 * That second half is measured, not assumed, and the check is written down
 * because the previous one was not reproducible: the bundle spells its route
 * paths as backtick template literals, so a grep for double-quoted `"/apps"`
 * finds nothing — and finds nothing for `/chat` either, which is how a grep
 * that could not see its own positives got read as proof of a negative. Run in
 * the pinned OPENCLAW_VERSION's bundle (2026.8.1, install.sh) — on a box that
 * is `/home/clawbox/.npm-global/lib/node_modules/openclaw/dist/control-ui/assets`,
 * NOT the `npm root -g` of `/usr/lib/node_modules`, which is where this said to
 * look and where openclaw is not installed (and `openclaw` is not on the
 * `clawbox` user's PATH either, so `dirname $(which openclaw)` does not find it):
 *
 *     grep -ohE '\bpath:`/[^`]{0,50}`' *.js | sed 's/path://; s/`//g' | sort -u
 *
 * That is 55 routes. `/apps` is among them (and `apps-page-*.js/.css` ship with
 * it); `/setup`, `/login`, `/portal`, `/updating`, `/app`, `/setup-api` and
 * `/login-api` are all absent, so every root claimed above is genuinely free.
 *
 * SIBLINGS: adding a gateway-owned root here is not the whole job —
 * `GATEWAY_ONLY_EXACT` / `GATEWAY_ONLY_PREFIXES` in src/middleware.ts decide
 * the Hermes 404 gate for the same paths, and src/lib/gateway-static.ts decides
 * which are served as bytes. Nothing cross-checks the three lists yet.
 */
export const UNCLAIMED_ROOTS = [
  "/api",
  "/assets",
  "/favicon.svg",
  "/favicon-32.png",
  "/apps",
] as const;

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
 * Percent-decoding, repeated until it stops changing, for the OWNERSHIP question
 * only.
 *
 * Deny-only, which is what makes it safe. This module's decoded answer is read
 * by exactly one caller — `src/app/[...gateway]/route.ts` — and the only thing
 * it can produce is a 404. Claiming one path too many costs a 404 on a path
 * that would otherwise have been answered with the Control UI shell and an
 * injected gateway credential; that is the strictly safer error. `isUnderRoot`
 * and `isSetupApiPath` stay literal on purpose: those feed the middleware's
 * ALLOW gates, and decoding there would widen an auth decision.
 *
 * To a fixpoint because one pass is not enough: `/setup%252Fnope` decodes to
 * `/setup%2Fnope`, which is still an encoded separator. Each pass that changes
 * anything strictly SHORTENS the string — an escape sequence is at least three
 * characters in and at most two UTF-16 code units out (`%F0%9F%98%80` is 12
 * characters and one emoji) — so the loop reaches a fixpoint on its own.
 *
 * PER ESCAPE RUN, not all-or-nothing, and that is the difference between
 * denying a spelling and denying a family. `decodeURIComponent` over the whole
 * path throws on the first malformed escape and yields nothing, so
 * `/portal%2Fnope` was denied while `/portal%2Fnope%zz` — the same path with a
 * junk suffix — decoded to nothing, matched nothing and was handed to the
 * gateway. Appending `%zz` was a cheaper walk-around than the nested-encoding
 * one this module was written to close. Decoding each maximal run of
 * well-formed escapes and leaving the rest alone closes both.
 *
 * Nothing is lost by it: over the 55 Control UI routes and the gateway's
 * static paths, in every encoding either decoder was measured on, both claim
 * NOTHING — `/assets/a%zz.js` and `/assets/100%25.png` stay the gateway's
 * under this one exactly as they did under the old one.
 *
 * The cap bounds the work AND, when it fires, chooses the answer — so it is
 * not only a runaway guard, and the two must not be read apart. It fails
 * CLOSED: a path the passes ran out on is one this box cannot read to the end,
 * so it is claimed rather than handed to the gateway. A cap that gave up and
 * ALLOWED made the function non-idempotent under its own decode — it denied
 * `/portal%2Fnope` and permitted `/portal%252525252Fnope`, four passes away
 * from it. Note what the number therefore decides: at more than
 * MAX_DECODE_PASSES nestings EVERY path is 404'd, the gateway's included, so
 * lowering it is a behaviour change and `gateway.test.ts` pins both sides.
 * 33 nestings is a 73-character URL — short, but unreachable by accident,
 * because only a NESTED escape consumes a pass: `"%25".repeat(50)` is 50
 * sequential escapes and costs two.
 */
const MAX_DECODE_PASSES = 32;

type DecodedPath = {
  /** The path as far as it could be decoded. */
  spelling: string;
  /**
   * The passes ran out before the fixpoint — this box does not know what the
   * path says. Never set for a path that simply CONTAINS a `%` it cannot
   * decode: that is a settled answer, not a budget running out.
   */
  undecodable: boolean;
};

/**
 * One pass: every maximal run of well-formed `%XX` escapes decoded, everything
 * else left exactly as it was.
 *
 * A RUN rather than one escape at a time, because a non-ASCII character is
 * several escapes together (`%E2%82%AC` is one euro sign) and decoding them
 * singly would produce mojibake instead of the character the client sent. A run
 * that is well-formed percent-encoding but not valid UTF-8 makes
 * `decodeURIComponent` throw, and that run is then left alone too.
 */
function decodeEscapeRuns(pathname: string): string {
  return pathname.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

function decodePercentEncoding(pathname: string): DecodedPath {
  let current = pathname;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    const next = decodeEscapeRuns(current);
    if (next === current) return { spelling: current, undecodable: false };
    current = next;
  }
  // "Would one more pass still change it?" — the honest test for a budget that
  // ran out, and not "does it still contain `%`", which is also true of the
  // settled `/assets/a%zz.js`.
  return { spelling: current, undecodable: decodeEscapeRuns(current) !== current };
}

/**
 * Which ClawBox namespace owns this path, or null when it is the gateway's.
 *
 * `"api"` and `"page"` differ only in what an unmatched path should answer
 * WITH — the ownership question has one answer for both.
 *
 * `"unreadable"` is not a namespace and deliberately not spelled as one: it is
 * "this box could not decode the path to the end, so it is refused rather than
 * handed on". The caller answers it like a page, but that is the CALLER's
 * decision to make with the fact in front of it — folding it into `"page"`
 * would tell a second reader that a path nobody could read is a ClawBox page.
 */
export function clawboxNamespaceKind(
  pathname: string,
): "api" | "page" | "unreadable" | null {
  // Lower-cased HERE and not in `isUnderRoot`: Next's router is case-sensitive,
  // so `/Setup-Api/nope` and `/Portal/nope` matched no ClawBox route and were
  // answered with the shell and the token (measured on a box). This is the same
  // leak class as the `/Login` and `/Manifest.json` fall-throughs
  // `serveGatewayHTML` still carries a comment about. Ownership is not a
  // question of spelling; the middleware's own gates, which get a pathname that
  // is already lower-cased, keep the exact comparison.
  //
  // The DECODED spelling too. Measured anonymously on an OpenClaw box at beta
  // `dd058938`: `GET /setup-api/nope` answers 401 application/json from the
  // middleware's own `/setup-api` gate, and `GET /setup-api%2Fnope` answers 307
  // to /login — the gate missed it, so the platform does not decode `%2F` and
  // the encoded spelling stays one segment, matches no route and lands here.
  // For an owner session that was the shell with the gateway token in it.
  const decoded = decodePercentEncoding(pathname);
  const spellings = new Set([
    pathname.toLowerCase(),
    decoded.spelling.toLowerCase(),
  ]);
  for (const candidate of spellings) {
    if (CLAWBOX_API_ROOTS.some((root) => isUnderRoot(candidate, root))) return "api";
    if (CLAWBOX_PAGE_ROOTS.some((root) => isUnderRoot(candidate, root))) return "page";
  }
  // Neither spelling is the path's LAST word — the passes ran out before the
  // fixpoint — so "this is the gateway's" is not something this box knows.
  // Refused rather than guessed: the deny-only argument above is what makes
  // that the safe answer, and no client can spell a path this deep by accident.
  if (decoded.undecodable) return "unreadable";
  return null;
}
