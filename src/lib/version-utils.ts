/**
 * Strip cosmetic noise from version strings emitted by openclaw / git-describe.
 *
 * Handles:
 *   "OpenClaw 2026.4.5 (3e72c03)"  → "2026.4.5"
 *   "v2.2.3-56-gb7948f0"           → "v2.2.3"
 *   "2026.3.13 (61d171a)"          → "2026.3.13"
 *
 * Returns null if the input is empty/null/undefined so callers can choose
 * their own fallback (e.g. `cleanVersion(v) ?? "?"`).
 */
export function cleanVersion(v: string | null | undefined): string | null {
  if (!v) return null;
  const cleaned = v
    .replace(/^OpenClaw\s+/i, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/-\d+-g[0-9a-f]+$/, "")
    .trim();
  return cleaned || null;
}

/**
 * Reduce the Hermes agent's `--version` banner to a bare version tag.
 *
 * `hermes --version` is a multi-line report, not a version string:
 *
 *   Hermes Agent v0.21.1 (2026.9.7) · upstream d0df3248 · local 2237be35 (+32678 carried commits)
 *   Install directory: /home/clawbox/.hermes/hermes-agent
 *   Install method: git
 *
 * The separator between the fields is upstream's to change — it has already
 * been both an em dash and a middle dot — so nothing here may depend on it.
 *
 * Only the tag belongs in an About row, and `cleanVersion` cannot get it:
 * its rules are shaped for OpenClaw/git-describe output, and none of them
 * match here — the parenthesised build date is mid-line, not at the end.
 *
 * Returns null for empty input so callers keep their own fallback.
 */
export function parseHermesVersion(raw: string | null | undefined): string | null {
  const line = (raw || "").split(/\r?\n/, 1)[0]?.trim();
  if (!line) return null;
  // First semver-ish token, keeping the leading "v" when Hermes printed one.
  const match = line.match(/\bv?\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.]+)?\b/);
  if (match) return match[0];
  // Unrecognised banner: show it rather than "not installed" — the agent did
  // answer — but cap it so a runaway line can't blow out the row.
  return line.length > 64 ? `${line.slice(0, 64)}…` : line;
}
