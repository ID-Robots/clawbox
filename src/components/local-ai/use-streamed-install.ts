"use client";

import { useCallback, useRef, useState } from "react";
import { formatBytes } from "@/lib/format-bytes";
import { useT } from "@/lib/i18n";
import { readInstallStream, type InstallOutcome, type InstallProgress } from "@/lib/install-stream";

type Translate = ReturnType<typeof useT>["t"];

/**
 * A non-2xx answer from an install route, said in the owner's language where
 * the box gave a code it can be said in.
 *
 * `disk_full` is the one refusal with numbers in it, and "not enough space"
 * without them is the sentence that sends somebody to look at the wrong disk.
 * Everything else falls through to the route's own English, because `t()`
 * answers an unknown key with the key itself and THAT must never reach a row —
 * an older server, or a code this build has no word for yet.
 *
 * Exported because the removal paths refuse through the same codes and had each
 * grown their own handling of them.
 */
export function describeRefusal(t: Translate, locale: string, data: Record<string, unknown>): string {
  if (data.code === "disk_full") {
    const need = typeof data.requiredBytes === "number" ? formatBytes(data.requiredBytes, locale) : null;
    const free = typeof data.freeBytes === "number" ? formatBytes(data.freeBytes, locale) : null;
    if (need && free) return t("localModels.install.diskShort", { need, free });
  }
  const code = typeof data.code === "string" ? data.code : null;
  if (code) {
    // The routes speak `snake_case` codes; the catalogue's own key convention
    // is camelCase per segment, and `translations.test.ts` enforces it.
    const camel = code.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    const key = `localModels.install.refusal.${camel}`;
    const said = t(key);
    if (said !== key) return said;
  }
  return typeof data.error === "string" && data.error ? data.error : t("localModels.error.changeFailed");
}

/**
 * Run one install route and keep what it said.
 *
 * Every card on Settings → Local AI drives the same three-state thing — idle,
 * a stream in flight, a verdict that stays on screen — and each of them had to
 * get the same four details right: a refusal that arrives as JSON before the
 * stream starts, the disk refusal's figures, a stream that ends with no
 * verdict, and a request that throws because the box went away. So it lives
 * here once.
 *
 * `busy` is the KEY of the row being worked on rather than a boolean: a card
 * with four sizes has to disable all four buttons and spin exactly one.
 */
export interface StreamedInstall {
  busy: string | null;
  progress: InstallProgress | null;
  outcome: InstallOutcome | null;
  /** Clear the last verdict — what a card does when the owner changes the subject. */
  reset: () => void;
  run: (key: string, request: (signal: AbortSignal) => Promise<Response>) => Promise<boolean>;
  /** Stop the stream in flight. The box is told by the request being dropped. */
  cancel: () => void;
}

export function useStreamedInstall(): StreamedInstall {
  const { t, locale } = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [outcome, setOutcome] = useState<InstallOutcome | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setProgress(null);
    setOutcome(null);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const refusalText = useCallback(
    (data: Record<string, unknown>) => describeRefusal(t, locale, data),
    [locale, t],
  );

  const run = useCallback(async (key: string, request: (signal: AbortSignal) => Promise<Response>) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(key);
    setProgress(null);
    setOutcome(null);
    try {
      const res = await request(controller.signal);
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as Record<string, unknown>));
        setOutcome({ ok: false, error: refusalText(data as Record<string, unknown>) });
        return false;
      }
      const settled = await readInstallStream(res, setProgress);
      setOutcome(settled.ok ? { ok: true } : { ok: false, error: settled.error ?? t("localModels.error.changeFailed") });
      return settled.ok;
    } catch {
      // A stream the owner cancelled is not a failure to report: the request
      // was dropped on purpose and the row goes back to idle.
      if (controller.signal.aborted) setOutcome(null);
      else setOutcome({ ok: false, error: t("localModels.error.unreachable") });
      return false;
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(null);
      setProgress(null);
    }
  }, [refusalText, t]);

  return { busy, progress, outcome, reset, run, cancel };
}
