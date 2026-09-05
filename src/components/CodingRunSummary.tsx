"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { renderText } from "@/lib/chat-markdown";
import { artifactUrl } from "@/lib/use-coding-agent-activity";

/**
 * A run's summary, as the document it wrote: when the run filed a
 * `report.md` in its evidence folder (the runner files the closing message
 * there, and a run may write a fuller one itself) that Markdown is what is
 * drawn, fetched once; until it arrives — and when there is none, or it
 * cannot be read — the record's own summary stands in. Rendered through the
 * chat's renderer, which builds elements from the text and never injects
 * HTML: agent-written words reach the owner's screen as words.
 */
export default function CodingRunSummary({ runId, report, summary, live }: {
  runId: string;
  /** The Markdown file to draw, when the run has one. */
  report: string | null;
  /** The record's summary, drawn until the report is here or when there is none. */
  summary: string | null;
  live: boolean;
}) {
  const { t } = useT();
  // Keyed by the run in the app, so a different run is a fresh mount with
  // `text` back at null; a report that appears later on the same run is
  // fetched by the effect below.
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!report) return;
    const controller = new AbortController();
    fetch(artifactUrl(runId, report), { cache: "no-store", signal: controller.signal })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body) => { if (!controller.signal.aborted) setText(body); })
      .catch(() => { /* the summary stands */ });
    return () => controller.abort();
  }, [runId, report]);
  const body = text ?? summary;
  return (
    <>
      {body ? (
        <div
          data-testid="coding-agent-summary"
          data-source={text !== null ? "report" : "summary"}
          className="mt-2 text-xs text-[var(--text-secondary)] leading-relaxed min-w-0 break-words [&_img]:max-w-full [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-[var(--text-primary)] [&_h1]:mt-2 [&_h2]:text-xs [&_h2]:font-semibold [&_h2]:text-[var(--text-primary)] [&_h2]:mt-2 [&_h3]:font-semibold [&_h3]:text-[var(--text-primary)] [&_h3]:mt-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/30 [&_pre]:p-2 [&_code]:font-mono"
        >
          {renderText(body, t("chat.table"))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-[var(--text-muted)]">{live ? t("codingAgent.noSummaryYet") : t("codingAgent.noSummary")}</p>
      )}
    </>
  );
}
