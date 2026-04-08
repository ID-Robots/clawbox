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
