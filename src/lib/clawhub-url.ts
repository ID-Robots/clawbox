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
 * Returns undefined when the publisher is unknown; callers fall back to
 * whatever link the API gave them rather than shipping a URL that 404s in
 * the browser.
 */
export function clawhubSkillUrl(
  appId: string | undefined,
  developer: string | undefined,
): string | undefined {
  if (!appId || !developer) return undefined;
  // Installed ids can arrive namespaced (`skills/foo`, `clawhub/foo`); the
  // slug ClawHub knows is the last segment.
  const slug = appId.split("/").filter(Boolean).pop();
  if (!slug) return undefined;
  return `https://clawhub.ai/${encodeURIComponent(developer)}/skills/${encodeURIComponent(slug)}`;
}
