"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { whatsNewEn } from "@/lib/edition-translations/en-whats-new";
import { isWhatsNewVersion, WHATS_NEW_HIGHLIGHTS } from "@/lib/whats-new";
import { isNamedChannel, type UpdateWhatsNewPanel as Panel } from "@/lib/update-whats-new";

interface UpdateWhatsNewPanelProps {
  /** What to draw — `updateWhatsNewPanel()` of the route's answer. */
  panel: Panel;
  /**
   * `list` (the default) is the /updating screen's muted bullet list. `grid`
   * and `compact` are the System Update window's: four feature cards with
   * their screenshots beside the step list, or one beside a failed run.
   */
  variant?: "list" | "grid" | "compact";
  /** The grid's title level: `h3` where the window it sits in is itself under an `h2`. */
  headingLevel?: "h2" | "h3";
}

/**
 * The highlights the System Update window draws as cards, in the approved
 * layout's order. A release whose catalogue no longer has one of them falls
 * back to its own order, so a new "What's new" never leaves a hole.
 */
export const UPDATE_GRID_PICKS = ["whatsNew.screenshotTitle", "whatsNew.sharedBrowserTitle", "whatsNew.publicLinksTitle", "whatsNew.primeRadiantTitle"];
export const UPDATE_COMPACT_PICKS = ["whatsNew.agentChartTitle"];

type Highlight = (typeof WHATS_NEW_HIGHLIGHTS)[number];

/** `count` highlights: the picks this build carries first, then the catalogue's own order. */
export function pickHighlights(picks: readonly string[], count: number, catalogue: readonly Highlight[] = WHATS_NEW_HIGHLIGHTS): Highlight[] {
  const picked = picks
    .map((key) => catalogue.find((item) => item.title === key))
    .filter((item): item is Highlight => !!item);
  const rest = catalogue.filter((item) => !picked.includes(item));
  return [...picked, ...rest].slice(0, count);
}

interface Card {
  key: string;
  icon: string;
  title: string;
  body: string;
  image: string | null;
}

/**
 * Translated when the catalogue is there, the English floor when it is not —
 * never the raw key. The same rule as the /updating screen's own `tr`: this
 * panel is drawn on the one screen guaranteed to be open while the box is
 * offline, and I18nProvider loads its catalogue through a dynamic import.
 */
function useFloor() {
  const { t } = useT();
  return (key: string, english: string, params?: Record<string, string>) => {
    const value = t(key, params);
    if (value !== key) return value;
    let text = english;
    for (const [name, replacement] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, replacement);
    return text;
  };
}

/*
 * Inline SVG rather than the Material Symbols font the desktop card uses: a
 * font file this page never needed before the server went down cannot be
 * fetched while it is down, and a ligature without its font draws the literal
 * word "auto_awesome".
 */
function SparkleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zm7 11l.95 2.55L22.5 16.5l-2.55.95L19 20l-.95-2.55L15.5 16.5l2.55-.95L19 13zM5 14l.7 1.8 1.8.7-1.8.7L5 19l-.7-1.8-1.8-.7 1.8-.7L5 14z" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

/**
 * "What's new" on the /updating screen (TASK-1205): the highlights of the
 * version being installed, while the owner waits for it.
 *
 * SECONDARY by construction — ReconnectStage draws it beside the step list on
 * a wide screen and after it on a phone, in the muted surface the log line
 * uses, with nothing in it to act on but a link out. It is never empty: the
 * target's own highlights, else this build's own (in the owner's language)
 * when the target is on the release line they describe, else one plain line
 * and the release page.
 */
export default function UpdateWhatsNewPanel({ panel, variant = "list", headingLevel = "h2" }: UpdateWhatsNewPanelProps) {
  const tr = useFloor();

  if (variant !== "list") return <FeatureCards panel={panel} compact={variant === "compact"} headingLevel={headingLevel} />;

  const title = panel.kind === "bundled"
    ? tr("whatsNew.highlightsLabel", whatsNewEn["whatsNew.highlightsLabel"])
    : panel.version
      ? tr("update.whatsNewTitle", "What's new in ClawBox {version}", { version: panel.version })
      : tr("update.whatsNewTitleGeneric", "What's new in this update");

  const items = panel.kind === "notes"
    // Keyed by position too: two identical bullets in the notes are two items.
    ? panel.highlights.map((item, index) => ({ key: `${index}:${item.title}`, title: item.title, body: item.body }))
    : panel.kind === "bundled"
      ? WHATS_NEW_HIGHLIGHTS.map((item) => ({
          key: item.title,
          title: tr(item.title, whatsNewEn[item.title]),
          body: tr(item.body, whatsNewEn[item.body]),
        }))
      : [];

  return (
    <section
      className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/60 px-4 py-4 text-left"
      aria-labelledby="update-whats-new-title"
      data-testid="update-whats-new"
      data-kind={panel.kind}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-orange-500/30 bg-orange-500/15 text-orange-400">
          <SparkleIcon />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="update-whats-new-title" className="m-0 text-sm font-semibold text-[var(--text-primary)]">
            {title}
          </h3>
          {items.length > 0 && (
            <p className="m-0 mt-0.5 text-xs text-[var(--text-muted)]">
              {tr("update.whatsNewIntro", "While you wait, here is what the version being installed brings.")}
            </p>
          )}
        </div>
        {isNamedChannel(panel.channel) && (
          // A QA pin can be a long branch name: it is cut, never allowed to
          // push the header past a phone's width.
          <span
            className="mt-0.5 min-w-0 max-w-[40%] truncate rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]"
            title={panel.channel}
            data-testid="update-whats-new-channel"
          >
            {tr("update.whatsNewChannel", "{channel} channel", { channel: panel.channel })}
          </span>
        )}
      </div>

      {items.length > 0 ? (
        // Highlights read from the release notes are English, whatever the
        // screen's language; say so to a screen reader.
        <ul className="m-0 mt-3 list-none space-y-2.5 p-0" lang={panel.kind === "notes" ? "en" : undefined}>
          {items.map((item) => (
            <li key={item.key} className="flex items-start gap-2.5">
              <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-orange-400/80" aria-hidden="true" />
              <div className="min-w-0">
                {item.title && <div className="text-xs font-semibold text-[var(--text-primary)]">{item.title}</div>}
                {item.body && <div className="text-xs leading-relaxed text-[var(--text-muted)]">{item.body}</div>}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 mt-3 text-xs leading-relaxed text-[var(--text-muted)]">
          {tr(
            "update.whatsNewGeneric",
            "This update brings the latest ClawBox improvements and fixes. The release notes list everything in it.",
          )}
        </p>
      )}

      <a
        href={panel.releaseUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-orange-300 no-underline hover:text-orange-200"
      >
        {tr("update.whatsNewReleaseNotes", "Read the full release notes")}
        <ExternalIcon />
      </a>
    </section>
  );
}

/** A screenshot from public/, gone rather than broken if the box cannot serve it. */
function CardImage({ src, className }: { src: string; className: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a fixed asset from public/, drawn at its own size
    <img
      src={src}
      alt=""
      width={1024}
      height={640}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      className={className}
      data-testid="update-whats-new-image"
    />
  );
}

/**
 * The System Update window's "What's new": the version being installed as
 * feature cards — four beside the step list, one beside a failed run.
 *
 * Drawn from this build's own "What's new" catalogue (screenshot, icon, title
 * and text, in the owner's language, off the box's own disk) whenever the
 * target is on the release line the catalogue describes, even where the
 * release's notes were read: the notes are English text without pictures,
 * the catalogue is the same release told in the owner's language. Notes for
 * another line are cards without pictures; nothing at all is one plain line
 * and the release page. The window was drawn with the Material Symbols font
 * before the box went down, unlike the /updating page, so the cards use the
 * catalogue's own glyphs.
 */
function FeatureCards({ panel, compact, headingLevel }: { panel: Panel; compact: boolean; headingLevel: "h2" | "h3" }) {
  const tr = useFloor();
  const Heading = headingLevel;
  const CardHeading = headingLevel === "h2" ? "h3" : "h4";
  const bundled = panel.kind === "bundled" || isWhatsNewVersion(panel.version);
  const count = compact ? 1 : 4;
  const cards: Card[] = bundled
    ? pickHighlights(compact ? UPDATE_COMPACT_PICKS : UPDATE_GRID_PICKS, count).map((item) => ({
        key: item.title,
        icon: item.icon,
        title: tr(item.title, whatsNewEn[item.title]),
        body: tr(item.body, whatsNewEn[item.body]),
        image: item.image,
      }))
    : panel.kind === "notes"
      ? panel.highlights.slice(0, count).map((item, index) => ({
          key: `${index}:${item.title}`,
          icon: "auto_awesome",
          title: item.title,
          body: item.body,
          image: null,
        }))
      : [];
  // Highlights read from the release notes are English, whatever the screen's
  // language; say so to a screen reader.
  const lang = !bundled && panel.kind === "notes" ? "en" : undefined;
  const title = panel.version
    ? tr("update.whatsNewTitle", "What's new in ClawBox {version}", { version: panel.version })
    : tr("update.whatsNewTitleGeneric", "What's new in this update");
  const generic = tr(
    "update.whatsNewGeneric",
    "This update brings the latest ClawBox improvements and fixes. The release notes list everything in it.",
  );
  const releaseLink = (
    <a
      href={panel.releaseUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-[7px] text-xs font-medium text-orange-300 no-underline hover:text-orange-200"
    >
      {tr("update.whatsNewReleaseNotes", "Read the full release notes")}
      <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14 }}>open_in_new</span>
    </a>
  );

  if (compact) {
    const card = cards[0];
    return (
      <section
        aria-label={title}
        data-testid="update-whats-new"
        data-kind={panel.kind}
        data-variant="compact"
        className="@container border-t border-[var(--border-subtle)] pt-5"
      >
        <div className="flex flex-col gap-4 @sm:flex-row @sm:items-center" lang={lang}>
          {card?.image && (
            <CardImage src={card.image} className="block h-auto w-full max-w-[160px] rounded-[var(--r-1)] border border-[var(--border-subtle)]" />
          )}
          <div className="min-w-0">
            <CardHeading className="m-0 text-sm font-semibold text-[var(--text-primary)]">{card?.title ?? title}</CardHeading>
            <p className="m-0 mt-1.5 text-xs leading-relaxed text-[var(--text-secondary)]">{card ? card.body : generic}</p>
            <div className="mt-2.5">{releaseLink}</div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-label={title} data-testid="update-whats-new" data-kind={panel.kind} data-variant="grid" className="@container min-w-0">
      <div className="mb-[18px] flex items-center justify-between gap-3">
        <Heading className="m-0 font-display text-[19px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">{title}</Heading>
        {cards.length > 0 && (
          <span className="shrink-0 text-xs text-[var(--text-muted)]">{tr("update.highlights", "Highlights")}</span>
        )}
      </div>
      {cards.length > 0 ? (
        <ul className="m-0 grid list-none grid-cols-1 gap-3.5 p-0 @md:grid-cols-2" lang={lang}>
          {cards.map((card) => (
            <li
              key={card.key}
              className="min-w-0 overflow-hidden rounded-[var(--r-2)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]"
            >
              {card.image && (
                <CardImage
                  src={card.image}
                  className="block h-[130px] w-full border-b border-[var(--border-subtle)] object-cover object-top"
                />
              )}
              <div className="p-3.5">
                <CardHeading className="m-0 flex items-start gap-[7px] text-xs font-semibold leading-snug text-[var(--text-primary)]">
                  <span className="material-symbols-rounded shrink-0 text-orange-400" aria-hidden="true" style={{ fontSize: 17 }}>
                    {card.icon}
                  </span>
                  <span className="min-w-0 pt-px">{card.title}</span>
                </CardHeading>
                {card.body && <p className="m-0 mt-2 text-[11px] leading-normal text-[var(--text-secondary)]">{card.body}</p>}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-xs leading-relaxed text-[var(--text-secondary)]">{generic}</p>
      )}
      <div className="mt-[18px]">{releaseLink}</div>
    </section>
  );
}
