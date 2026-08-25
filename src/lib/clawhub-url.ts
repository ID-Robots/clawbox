/**
 * Canonical ClawHub page for a store listing.
 *
 * ClawHub namespaces every skill under its publisher: the real page for
 * `security-audit-toolkit` by `gitgoodordietrying` is
 *
 *   https://clawhub.ai/gitgoodordietrying/skills/security-audit-toolkit
 *
 * We build that ourselves rather than trusting the store API, because the
 * `clawhubUrl` the detail endpoint returns drops the publisher segment
 * (`https://clawhub.ai/skills/<slug>`) and the desktop was also pasting the
 * raw app id into a `https://clawhub.ai/skills/${appId}` template — which
 * doubles the segment to `/skills/skills/<slug>` for any id that already
 * carries a namespace. clawhub.ai is a client-routed SPA, so every one of
 * those wrong shapes answers 200 and then renders nothing useful.
 *
 * Returns undefined when the publisher is unknown or unusable; callers fall
 * back to whatever link the API gave them rather than shipping a URL that
 * 404s in the browser.
 */

/**
 * A ClawHub publisher handle, as it appears in a URL path.
 *
 * The store's `developer` field is NOT reliably a handle. It carries a real
 * one for a minority of listings (`anotb`, `gitgoodordietrying`, `maxsumrall`)
 * and the DISPLAY NAME "ClawHub Community" for the rest — 162 of the first 200
 * apps, so this is the common case, not an edge one. Percent-encoding a display
 * name produces `/ClawHub%20Community/skills/<slug>`, which ClawHub answers with
 * "We couldn't find that page."
 *
 * So the field is only usable when it is shaped like a path segment. Anything
 * with a space — or any other character a handle cannot contain — is a display
 * name, and the caller falls back to the store's own link instead.
 */
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function clawhubSkillUrl(
  appId: string,
  developer: string | undefined,
): string | undefined {
  if (!developer || !HANDLE.test(developer)) return undefined;
  // Installed ids can arrive namespaced (`skills/foo`, `clawhub/foo`); the
  // slug ClawHub knows is the last segment.
  const slug = appId.split("/").filter(Boolean).pop();
  if (!slug) return undefined;
  return `https://clawhub.ai/${developer}/skills/${encodeURIComponent(slug)}`;
}
