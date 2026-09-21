/**
 * A GitHub remote as a person would open it.
 *
 * `git remote get-url origin` answers the URL git pushes to —
 * `https://github.com/owner/repo.git` on this box (gh is configured for
 * https), `git@github.com:owner/repo.git` on one where the owner set up SSH
 * by hand — and neither is a page. The project page draws the repository's
 * name and links it, so the two forms have to become one address. Anything
 * that is not GitHub answers null: a link to a self-hosted remote the
 * desktop cannot reach is a link to an error page.
 */

const HTTPS = /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
const SSH = /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

/** `owner/repo` for a GitHub remote, or null for anything else. */
export function githubRepoName(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const m = HTTPS.exec(remote.trim()) ?? SSH.exec(remote.trim());
  if (!m) return null;
  const [, owner, repo] = m;
  if (!owner || !repo || owner === "." || owner === "..") return null;
  return `${owner}/${repo}`;
}

/** The repository's page on github.com, or null for a remote that is not GitHub. */
export function githubWebUrl(remote: string | null | undefined): string | null {
  const name = githubRepoName(remote);
  return name ? `https://github.com/${name}` : null;
}
