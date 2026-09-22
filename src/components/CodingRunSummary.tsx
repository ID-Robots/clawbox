"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { renderText } from "@/lib/chat-markdown";
import { artifactUrl } from "@/lib/use-coding-agent-activity";
import { MARKDOWN_PROSE } from "./coding-agent-ui";

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
          className={`mt-2 ${MARKDOWN_PROSE}`}
        >
          {renderText(body, t("chat.table"))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-[var(--text-muted)]">{live ? t("codingAgent.noSummaryYet") : t("codingAgent.noSummary")}</p>
      )}
    </>
  );
}
