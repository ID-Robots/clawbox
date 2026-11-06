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
 *   Hermes Agent v0.21.1 (2026.9.7) · upstream ead7e91d · local 2237be35 (+32678 carried commits)
 *   Install directory: /home/clawbox/.hermes/hermes-agent
 *   Install method: git
 *
 * The separator between the fields is upstream's to change — banners carrying
 * an em dash and a middle dot have both been seen — so nothing here may depend
 * on it: the version is the first semver-ish token on line one.
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

/** One component of the `/setup-api/update/versions` payload, as a browser reads it. */
export interface UpdateComponentVersion {
  current?: string | null;
  target?: string | null;
  updateAvailable?: boolean | null;
}

/**
 * Whether an OpenClaw row is about software this device has and the update
 * keeps current. The `hermes` SKU has none — not even when a swap from
 * OpenClaw left the old core on its disk, which nothing there runs or updates;
 * `dual` has one even while Hermes is the harness answering. A payload from a
 * server that predates the `edition` field reads as OpenClaw, which is what
 * those builds were.
 *
 * Here rather than in a component so every screen that offers an OpenClaw
 * update asks the same question: the desktop's "Update available" card did
 * not, and offered a Hermes box an OpenClaw update its updater never performs.
 */
export function shipsOpenclaw(versions: { edition?: string } | null | undefined): boolean {
  return versions?.edition !== "hermes";
}

/**
 * Which components the desktop's "Update available" card names. A component
 * whose `updateAvailable` is absent or null (an older server, or one that could
 * not check) is compared on its versions, as the card always did; OpenClaw
 * counts only where {@link shipsOpenclaw} says the device has one.
 */
export function updateNoticeComponents(versions: {
  clawbox?: UpdateComponentVersion | null;
  openclaw?: UpdateComponentVersion | null;
  edition?: string;
} | null | undefined): { clawbox: boolean; openclaw: boolean } {
  const needs = (c: UpdateComponentVersion | null | undefined): boolean =>
    c?.updateAvailable ?? (!!c?.target && c.target !== c.current);
  return {
    clawbox: needs(versions?.clawbox),
    openclaw: shipsOpenclaw(versions) && needs(versions?.openclaw),
  };
}
