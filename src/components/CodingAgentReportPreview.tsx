"use client";

import { useEffect, useId, useState } from "react";
import { useModalDialog } from "@/hooks/useModalDialog";
import { useT } from "@/lib/i18n";
import { renderText } from "@/lib/chat-markdown";
import { artifactUrl } from "@/lib/use-coding-agent-activity";

/**
 * One markdown artifact of a run — report.md, or any .md the run wrote —
 * drawn as markdown in a dialog over the Coding Agent app.
 *
 * The bytes were WRITTEN BY THE DELEGATED AGENT. That is why the artifacts
 * route serves them as text/plain, and why this never hands them to the DOM
 * as HTML: the chat's renderer builds React elements out of the text, so an
 * `<img onerror>` or a `<script>` in a report is the literal characters on
 * the owner's screen and nothing more. It is the same renderer the
 * assistant's replies go through, so a report reads the way the chat does.
 *
 * A component of its own, mounted only while open, rather than state inside
 * the app: the shared dialog hook needs its panel in the very commit that
 * turns it on, and gives back focus in, Tab kept inside, Escape to close and
 * focus restored to the artifact's name afterwards.
 */
type Loaded = { text: string } | { failed: true } | null;

export default function CodingAgentReportPreview({
  runId,
  name,
  onClose,
}: {
  runId: string;
  name: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const titleId = useId();
  const panelRef = useModalDialog<HTMLDivElement>({ onClose });
  const [loaded, setLoaded] = useState<Loaded>(null);

  // No reset here: the app keys this component by run and file, so a
  // different artifact is a fresh mount with `loaded` back at null.
  useEffect(() => {
    const controller = new AbortController();
    fetch(artifactUrl(runId, name), { cache: "no-store", signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => setLoaded({ text }))
      .catch(() => {
        // Closing the dialog mid-fetch aborts it; that is not a failure.
        if (!controller.signal.aborted) setLoaded({ failed: true });
      });
    return () => controller.abort();
  }, [runId, name]);

  return (
    // Backdrop: dismissal only. The dialog role sits on the panel — on the
    // backdrop the accessible dialog would be the whole viewport and its name
    // would swallow every bit of the app behind the scrim.
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="coding-agent-report"
        onClick={(e) => e.stopPropagation()}
        className="bg-[var(--bg-elevated)] border border-white/10 rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl min-w-0"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.08]">
          <span className="material-symbols-rounded text-sky-300 shrink-0" style={{ fontSize: 18 }} aria-hidden="true">
            description
          </span>
          <h3 id={titleId} className="text-sm font-semibold min-w-0 flex-1 truncate">{name}</h3>
          {/* The same bytes as text, for copying out or when the markdown
              guessed wrong about a file. Still the text/plain route. */}
          <a
            href={artifactUrl(runId, name)}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] px-2 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 shrink-0"
          >
            {t("codingAgent.reportOpenText")}
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("codingAgent.reportClose")}
            title={t("codingAgent.reportClose")}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-white hover:bg-white/10 shrink-0"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">close</span>
          </button>
        </div>
        {/* The body scrolls on its own, so it needs a tab stop of its own or a
            keyboard reader cannot reach the lines below the fold (WCAG 2.1.1).
            Tables and code blocks inside scroll sideways inside themselves —
            the renderer already wraps them — and the wrapper's min-w-0 keeps
            a long unbroken token from pushing the panel wider than the app. */}
        <div
          tabIndex={0}
          className="px-4 py-3 overflow-y-auto min-w-0 text-xs text-[var(--text-secondary)] leading-relaxed break-words [&_img]:max-w-full"
        >
          {loaded === null ? (
            <p className="text-[var(--text-muted)]">{t("codingAgent.reportLoading", { name })}</p>
          ) : "failed" in loaded ? (
            <p role="alert" className="text-red-300">{t("codingAgent.reportFailed", { name })}</p>
          ) : (
            renderText(loaded.text, t("chat.table"))
          )}
        </div>
      </div>
    </div>
  );
}
