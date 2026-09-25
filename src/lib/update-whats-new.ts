/**
 * "What's new" for the version an update is INSTALLING, shown on the /updating
 * screen while the box updates (TASK-1205) — the pure half.
 *
 * Client-safe on purpose: the route, its server half and the update screen all
 * read this file, so the wire shape, the release-page address and the choice
 * of what the panel draws are spelled once. Everything that touches git, the
 * disk or the network is in `@/lib/update-whats-new-server`.
 *
 * WHAT THE PANEL DRAWS, best first:
 *
 *  1. `notes` — the Highlights of the target release, read out of its notes
 *     (`RELEASE-NOTES-<version>.md` on the branch the updater syncs to, else
 *     the GitHub release body for `v<version>`) by `parseReleaseHighlights`.
 *  2. `bundled` — nothing could be read, but the target is on the release line
 *     THIS build's "What's new" card announces: the card's own highlights, in
 *     the owner's language, with no network at all. Decided HERE, on the
 *     client, against the client's own `WHATS_NEW_RELEASE`: the page stays
 *     loaded across the rebuild, so after the restart the route is answered by
 *     the NEW server while this JavaScript is still the old build's, and only
 *     the build that carries the highlights can say which release they are.
 *  3. `generic` — one plain sentence and a link to the release page. Never an
 *     empty panel, even when the route itself could not be reached.
 */

import { displayVersion, isWhatsNewVersion } from "@/lib/whats-new";
import type { ReleaseHighlight } from "@/lib/release-highlights";

export type { ReleaseHighlight } from "@/lib/release-highlights";

/** The repository every ClawBox updates from; install.sh clones the same one. */
export const CLAWBOX_REPO = "ID-Robots/clawbox";

/** The repository's releases page, for when the target has no tag to name. */
export const CLAWBOX_RELEASES_URL = `https://github.com/${CLAWBOX_REPO}/releases`;

/** `GET /setup-api/update/whats-new`. */
export const UPDATE_WHATS_NEW_ENDPOINT = "/setup-api/update/whats-new";

/** A plain `major.minor.patch` (an optional pre-release suffix allowed), without a leading `v`. */
const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * A version string the box may put in a URL, a file name or a git path, or
 * null. `v4.1.0`, ` 4.1.0 ` and `4.1.0` all come back as `4.1.0`; anything
 * else — a branch, a sha, a path — is refused.
 */
export function normalizeVersion(version: unknown): string | null {
  if (typeof version !== "string") return null;
  const bare = displayVersion(version);
  return bare && VERSION_SHAPE.test(bare) ? bare : null;
}

/** The GitHub release page for a version, or the releases list when there is none. */
export function releasePageUrl(version: string | null | undefined): string {
  const bare = normalizeVersion(version);
  return bare ? `${CLAWBOX_RELEASES_URL}/tag/v${encodeURIComponent(bare)}` : CLAWBOX_RELEASES_URL;
}

/** `GET /setup-api/update/whats-new`. */
export interface UpdateWhatsNew {
  /** The version being installed (`4.1.0`), or null when the box cannot say. */
  version: string | null;
  /**
   * The update channel — the branch the updater syncs to (`main`, `beta`, a
   * QA pin) — or null when it could not be read.
   */
  channel: string | null;
  /** `notes` when `highlights` came from the release's notes; `none` when nothing could be read. */
  source: "notes" | "none";
  /** Plain text, capped, in the order the notes list them. Empty unless `source` is `notes`. */
  highlights: ReleaseHighlight[];
  /** Where the full notes are: the tag's release page, else the releases list. */
  releaseUrl: string;
}

/** The answer when nothing about the target could be read. */
export function unknownUpdateWhatsNew(version: string | null = null, channel: string | null = null): UpdateWhatsNew {
  const bare = normalizeVersion(version);
  return { version: bare, channel, source: "none", highlights: [], releaseUrl: releasePageUrl(bare) };
}

function isHighlight(value: unknown): value is ReleaseHighlight {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<ReleaseHighlight>;
  return typeof item.title === "string" && typeof item.body === "string";
}

/**
 * An `UpdateWhatsNew` off the wire, or nothing.
 *
 * The page outlives the server that first answered it (the rebuild replaces
 * it), so a payload this build cannot read in full is treated as no answer —
 * the panel then falls back rather than drawing holes.
 */
export function isUpdateWhatsNew(value: unknown): value is UpdateWhatsNew {
  if (typeof value !== "object" || value === null) return false;
  const answer = value as Partial<UpdateWhatsNew>;
  return (typeof answer.version === "string" || answer.version === null)
    && (typeof answer.channel === "string" || answer.channel === null)
    && (answer.source === "notes" || answer.source === "none")
    && Array.isArray(answer.highlights)
    && answer.highlights.every(isHighlight)
    && typeof answer.releaseUrl === "string"
    && /^https:\/\/github\.com\//.test(answer.releaseUrl);
}

/** What the update screen's panel draws. See the file header for the order. */
export type UpdateWhatsNewPanel =
  | { kind: "notes"; version: string | null; channel: string | null; highlights: ReleaseHighlight[]; releaseUrl: string }
  | { kind: "bundled"; version: string; channel: string | null; releaseUrl: string }
  | { kind: "generic"; version: string | null; channel: string | null; releaseUrl: string };

/**
 * The panel for the route's last answer — or for no answer at all (the route
 * never reached, or answered something this build cannot read).
 */
export function updateWhatsNewPanel(answer: UpdateWhatsNew | null): UpdateWhatsNewPanel {
  if (!answer) return { kind: "generic", version: null, channel: null, releaseUrl: CLAWBOX_RELEASES_URL };
  const version = normalizeVersion(answer.version);
  const releaseUrl = releasePageUrl(version);
  const channel = answer.channel;
  const highlights = answer.highlights.filter((item) => item.title || item.body);
  if (answer.source === "notes" && highlights.length) {
    return { kind: "notes", version, channel, highlights, releaseUrl };
  }
  if (version && isWhatsNewVersion(version)) return { kind: "bundled", version, channel, releaseUrl };
  return { kind: "generic", version, channel, releaseUrl };
}

/**
 * Is `channel` worth naming beside the version? `main` is the release channel
 * every box is on by default, so only another branch (beta, a QA pin) is shown.
 */
export function isNamedChannel(channel: string | null): channel is string {
  return typeof channel === "string" && channel.length > 0 && channel !== "main";
}
