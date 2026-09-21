/**
 * Which /setup-api/* routes the first-boot wizard may reach before a session
 * exists — an ALLOW-list, deliberately.
 *
 * The previous model was a deny-list (`PRE_AUTH_SENSITIVE_PREFIXES`): while
 * `setup_complete !== true`, every /setup-api/* path that wasn't explicitly
 * named passed through unauthenticated. Over a ~100-route surface that is a
 * gate that grows a hole every time someone adds a route and doesn't think
 * about the wizard. It grew several: setup/reset, update/run, system/power,
 * install/run-step, wifi/connect and ollama/pull were all reachable with no
 * credential by anyone in radio range of the OPEN `ClawBox-Setup` AP — which
 * is broadcasting during exactly this window. TASK-443/446.
 *
 * Inverted, the default is 401 and the list below is the whole attack surface.
 * Adding a route no longer changes the security posture; opening one is an
 * explicit, reviewable edit to this file.
 *
 * NOTE the second half of the fix, in `middleware.ts`: this window is open only
 * while the device has NO owner credential at all. The moment
 * `password_configured` flips true — even if `setup_complete` is still false,
 * i.e. a half-finished or resumed wizard — the window closes and the entire
 * surface requires a session. There is then someone to authenticate as, so
 * there is no excuse to stay open.
 */

/**
 * Routes the wizard calls BEFORE CredentialsStep sets the password (steps 1-3:
 * WifiStep, UpdateStep, CredentialsStep). Everything the wizard does after that
 * — AIModelsStep, TelegramStep, setup/complete — runs with the session cookie
 * that `system/credentials` mints on the initial password set, so those routes
 * are deliberately NOT here.
 *
 * The whole `/setup-api/hermes/oauth` subtree (start / submit / poll / cancel)
 * is part of that "after": AIModelsStep drives it on step 4, holding the cookie
 * step 3 handed it. Under the old deny-list none of those four was ever named,
 * which is how the provider sign-in flow ended up answering an anonymous caller
 * in radio range of the open AP; the inversion is what closed it, and their
 * absence from this list is load-bearing rather than an oversight. The three
 * that change something check for themselves as well — see `ownerGate` in
 * src/app/setup-api/hermes/oauth/shared.ts. TASK-527.
 *
 * Prefix match on a path-segment boundary (`/a` matches `/a` and `/a/b`, never
 * `/ab`).
 */
export const BOOTSTRAP_ALLOWED_PREFIXES = [
  // Wizard state machine. `setup/status` is also public post-setup (it drives
  // the /login and desktop bootstraps), but it answers a trimmed payload to an
  // unauthenticated caller — see the route.
  "/setup-api/setup/status",
  "/setup-api/setup/progress",

  // Step 1 — WifiStep. The device is on its own AP with no route to anywhere,
  // so these have to work before any credential can exist.
  "/setup-api/wifi/scan",
  "/setup-api/wifi/connect",
  "/setup-api/wifi/connect-status",
  "/setup-api/wifi/ethernet",

  // Step 2 — UpdateStep. update/run kicks off the root updater, which is why
  // it ALSO checks `requireSession({ allowBootstrap: true })` in-handler: the
  // moment a password exists this stops being reachable, middleware or not.
  "/setup-api/update/run",
  "/setup-api/update/status",
  // The wizard's readiness poll while the updater restarts services.
  "/setup-api/gateway/health",

  // Step 3 — CredentialsStep. `system/credentials` is the route that ENDS this
  // window: it sets the password and hands back a session cookie, so the
  // hostname/hotspot writes it makes afterwards are already authenticated.
  // `/credentials/verify` is deliberately absent — it is a password oracle
  // with no onboarding role (TASK-444b).
  "/setup-api/system/hostname",
  "/setup-api/system/hotspot",

  // Which agent this SKU runs; AIModelsStep reads it to pick its own shape.
  // Read-only, and the wizard needs it on the step boundary.
  "/setup-api/harness/active",
] as const;

/** Exact matches — no subtree. Keeps `/credentials/verify` out while
 *  `/credentials` itself is allowed. */
export const BOOTSTRAP_ALLOWED_EXACT: ReadonlySet<string> = new Set([
  "/setup-api/system/credentials",
  // The mascot's phrase bag. GET-only, returns nothing but display strings,
  // and it is read before a session can exist. The `/regenerate` leaf next to
  // it is deliberately NOT here and never will be: each call cold-loads a
  // ~3.8 GB model for up to three minutes, so on the open `ClawBox-Setup` AP
  // it was a free way to pin the box's memory and CPU. The exact match is what
  // keeps the two apart.
  "/setup-api/mascot-lines",
]);

/** Normalize a single trailing slash so `/setup-api/x/` can't dodge a match. */
export function normalizeApiPath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/**
 * True when this path may be served without a session during the genuine
 * no-password-yet bootstrap window. Callers must check the window is actually
 * open first — this function says nothing about device state.
 */
export function isBootstrapAllowedPath(pathname: string): boolean {
  const p = normalizeApiPath(pathname);
  if (BOOTSTRAP_ALLOWED_EXACT.has(p)) return true;
  for (const prefix of BOOTSTRAP_ALLOWED_PREFIXES) {
    if (p === prefix || p.startsWith(prefix + "/")) return true;
  }
  return false;
}
