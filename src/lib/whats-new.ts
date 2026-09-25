/**
 * The "What's new in 4.1" card (TASK-1059, re-keyed for 4.1 by TASK-1195) —
 * the pure half.
 *
 * Client-safe on purpose: the desktop card, its hook and the route all read
 * this file, so the release the card announces, the two links it carries and
 * the shape of the route's answer are spelled once. Everything that touches the
 * disk or the plan on record is in `@/lib/whats-new-server`.
 *
 * WHEN THE CARD SHOWS. A box whose running version is on the release line the
 * card announces (4.1.0, 4.1.3), until the owner dismisses it. The dismissal is
 * stored in the box's config store, not the browser, so a card dismissed on the
 * laptop does not come back on the phone. It is keyed by
 * {@link WHATS_NEW_RELEASE}, so a box that dismissed the 4.0 card is shown this
 * one, and a later "What's new" card is a new constant here and shows again on
 * every box.
 */

import { PORTAL_PLANS_URL } from "@/lib/clawai-usage";

/**
 * The release this card announces, and the value a dismissal records. It is
 * `major.minor` of package.json's version; release-identity.test.ts holds the
 * two together, so a minor bump without a new card fails there.
 */
export const WHATS_NEW_RELEASE = "4.1";

/**
 * The docs page the card links to: `docs-site/whats-new.mdx`, whose newest
 * section is "ClawBox 4.1". ONE constant, so a page that moves is one edit.
 */
export const WHATS_NEW_DOCS_URL = "https://docs.clawbox.com/whats-new";

/** Campaign tags on the card's portal link, so the portal can count what the card sends it, per release. */
export const WHATS_NEW_UTM: Readonly<Record<string, string>> = {
  utm_source: "box",
  utm_medium: "update_card",
  utm_campaign: `v${WHATS_NEW_RELEASE}`,
};

/**
 * `url` with `params` added to its query string.
 *
 * Through `URL` rather than string concatenation because the plans page is
 * `…/dashboard#subscription`: the query has to go BEFORE the fragment, and a
 * `?utm_…` appended to the end would become part of the fragment, which the
 * browser never sends.
 */
export function withUtm(url: string, params: Readonly<Record<string, string>>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) parsed.searchParams.set(key, value);
  return parsed.toString();
}

/** The portal's plans page, tagged as the update card's. */
export const WHATS_NEW_PLANS_URL = withUtm(PORTAL_PLANS_URL, WHATS_NEW_UTM);

/**
 * The release line of a ClawBox version string, `[major, minor]`, or null when
 * there is none.
 *
 * Takes what the box actually reports: package.json's `4.1.0`, a `v4.1.0` tag,
 * `git describe` output (`v4.1.0-12-gabc123`), and the card's own `4.1`.
 */
export function releaseLineOf(version: string | null | undefined): readonly [major: number, minor: number] | null {
  if (typeof version !== "string") return null;
  const match = /^\s*v?(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/**
 * Is this the running version the card is about? Only the release line it
 * announces: 4.1.0 and 4.1.3, not 4.0.x and not 4.2.0.
 *
 * Not "anything on 4.x", which it was while the card announced 4.0. The card
 * says "What's new in 4.1" above "This box now runs ClawBox {version}", so on
 * any other line those two lines would name different releases. A later release
 * shows no card until it has one of its own.
 */
export function isWhatsNewVersion(version: string | null | undefined): boolean {
  const running = releaseLineOf(version);
  const announced = releaseLineOf(WHATS_NEW_RELEASE);
  return running !== null && announced !== null
    && running[0] === announced[0] && running[1] === announced[1];
}

/** The edition a box could switch to (Settings → Harness). */
export type EditionSwitchTarget = "openclaw" | "hermes";

/**
 * What the card's plan section offers. When neither field is set, the plan on
 * record covers everything, and the card draws no plan section at all.
 */
export interface WhatsNewPlanCta {
  /** Coding Agent and Memory Shard: true when the plan on record is not Pro or Max. */
  paidFeatures: boolean;
  /**
   * The edition this box could be switched to, when the plan on record is not
   * Max. Null when the plan covers the switch, and also when there is no switch
   * to make: a `dual` box has both harnesses, and a box with no edition lock
   * cannot be switched safely.
   */
  editionSwitch: EditionSwitchTarget | null;
}

/** `GET /setup-api/whats-new`. */
export interface WhatsNewState {
  /** Should the desktop draw the card? */
  show: boolean;
  /** The release the card announces ({@link WHATS_NEW_RELEASE}). */
  release: string;
  /** The running ClawBox version, as package.json has it, or null when unreadable. */
  version: string | null;
  /** The edition lock. A `hermes` box gets the Hermes wording. */
  edition: "openclaw" | "hermes" | "dual";
  cta: WhatsNewPlanCta;
  /**
   * A free-month code issued for this box. Always null for now: the portal does
   * not publish one (see `readFreeMonthCode` in `@/lib/whats-new-server`), and
   * the card has no UI for it.
   */
  freeMonthCode: string | null;
  /**
   * Present, and true, only when this answer is a FALLBACK (TASK-1198):
   * something the card depends on could not be read, so the card is hidden
   * rather than drawn from a guess. Absent on every ordinary answer, so the
   * shape a working box sends is the one it always sent.
   */
  unavailable?: true;
}

/** What the plan section offers when the plan on record cannot be read: nothing. */
export const NO_PLAN_CTA: Readonly<WhatsNewPlanCta> = Object.freeze({ paidFeatures: false, editionSwitch: null });

/**
 * The answer for a box whose What's New state could not be read (TASK-1198).
 *
 * HIDDEN, not a 500 and not a guess. The card is an announcement the desktop
 * can live without, and both wrong answers cost more than none: a card drawn
 * over an unreadable dismissal comes back for an owner who closed it, and a
 * plan section drawn over an unreadable plan sells an owner what they may
 * already pay for. The hook draws nothing for `show: false`, exactly as for a
 * box on another release.
 */
export function unavailableWhatsNewState(
  edition: WhatsNewState["edition"] = "openclaw",
  version: string | null = null,
): WhatsNewState {
  return {
    show: false,
    release: WHATS_NEW_RELEASE,
    version,
    edition,
    cta: { ...NO_PLAN_CTA },
    freeMonthCode: null,
    unavailable: true,
  };
}

/** Does the plan section have anything to offer? */
export function hasPlanCta(cta: WhatsNewPlanCta): boolean {
  return cta.paidFeatures || cta.editionSwitch !== null;
}

/** Strip a leading `v` so the card prints `4.1.0`, the way the release notes do. */
export function displayVersion(version: string | null): string | null {
  if (!version) return null;
  return version.trim().replace(/^v/i, "") || null;
}

/**
 * A `WhatsNewState` off the wire, or nothing.
 *
 * A tab left open across an update can be answered by an older or newer
 * server. A payload this build cannot read in full draws no card, rather than
 * a card with holes in it.
 */
export function isWhatsNewState(value: unknown): value is WhatsNewState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<WhatsNewState>;
  const cta = state.cta as Partial<WhatsNewPlanCta> | undefined;
  return typeof state.show === "boolean"
    && typeof state.release === "string"
    && (typeof state.version === "string" || state.version === null)
    && (state.edition === "openclaw" || state.edition === "hermes" || state.edition === "dual")
    && typeof cta === "object" && cta !== null
    && typeof cta.paidFeatures === "boolean"
    && (cta.editionSwitch === "openclaw" || cta.editionSwitch === "hermes" || cta.editionSwitch === null)
    && (typeof state.freeMonthCode === "string" || state.freeMonthCode === null);
}
