"use client";

import { useT } from "@/lib/i18n";
import { whatsNewEn } from "@/lib/edition-translations/en-whats-new";
import { WHATS_NEW_HIGHLIGHTS } from "@/lib/whats-new";
import { isNamedChannel, type UpdateWhatsNewPanel as Panel } from "@/lib/update-whats-new";

interface UpdateWhatsNewPanelProps {
  /** What to draw — `updateWhatsNewPanel()` of the route's answer. */
  panel: Panel;
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
export default function UpdateWhatsNewPanel({ panel }: UpdateWhatsNewPanelProps) {
  const tr = useFloor();

  const title = panel.kind === "bundled"
    ? tr("whatsNew.highlightsLabel", whatsNewEn["whatsNew.highlightsLabel"])
    : panel.version
      ? tr("update.whatsNewTitle", "What's new in ClawBox {version}", { version: panel.version })
      : tr("update.whatsNewTitleGeneric", "What's new in this update");

  const items = panel.kind === "notes"
    ? panel.highlights.map((item) => ({ key: `${item.title}|${item.body}`, title: item.title, body: item.body }))
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
          <span
            className="mt-0.5 shrink-0 rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]"
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
