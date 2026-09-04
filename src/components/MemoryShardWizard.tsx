"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import MemoryShardArt from "./MemoryShardArt";
import StatusMessage from "./StatusMessage";
import HelpTip from "./HelpTip";
import { BTN_PRIMARY, BTN_SECONDARY, CARD, FIELD, SEGMENT_OFF, SEGMENT_ON, SEGMENTED_TRACK } from "./coding-agent-ui";
import {
  type ProvisionPhase,
} from "@/lib/memory-shard-state";

/**
 * Memory Shard's first-run wizard: what it is, which folders to read, when to
 * run, and then — the part nothing in ClawBox could do before — getting the
 * embedding model onto the box and pointing the index at it.
 *
 * Same shape as the coding agent's wizard, deliberately: an intro face with no
 * card chrome and the artwork on top, then carded steps, and a completion flag
 * that is only written at the very end.
 */

type Step = "intro" | "folders" | "schedule" | "provision";

interface BrowseAnswer {
  root: string;
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
}

/** One line of Ollama's pull stream. */
/** One NDJSON line from /setup-api/embed/install: a status while the root step runs, then success or error. */
interface PullLine { status?: string; success?: boolean; error?: string }

export default function MemoryShardWizard({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const [step, setStep] = useState<Step>("intro");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ─── Step 2: the folders to read ───
  const [sources, setSources] = useState<string[]>([]);
  const [browse, setBrowse] = useState<BrowseAnswer | null>(null);
  const browseAbort = useRef<AbortController | null>(null);
  // The provisioning flow's own signal. Closing the window mid-download must
  // stop the download: the pull route drops its Ollama connection when the
  // client goes away, precisely so a model is never fetched with nothing in
  // the UI showing it, and a fetch left running here would defeat that.
  const provisionAbort = useRef<AbortController | null>(null);

  const loadSources = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/clawkeep/memory/sources");
      if (res.ok) setSources(((await res.json()) as { paths?: string[] }).paths ?? []);
    } catch {
      // An unreadable list is an empty one here; the step still works.
    }
  }, []);
  useEffect(() => { void loadSources(); }, [loadSources]);
  useEffect(() => () => {
    browseAbort.current?.abort();
    provisionAbort.current?.abort();
  }, []);

  const openBrowse = useCallback(async (dir?: string) => {
    browseAbort.current?.abort();
    const ctl = new AbortController();
    browseAbort.current = ctl;
    setError(null);
    try {
      const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
      let res = await fetch(`/setup-api/coding-agent/browse${qs}`, { signal: ctl.signal });
      if (res.status === 404 && dir) res = await fetch("/setup-api/coding-agent/browse", { signal: ctl.signal });
      if (!res.ok) throw new Error(t("clawkeep.memory.setup.browseFailed"));
      setBrowse((await res.json()) as BrowseAnswer);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(err instanceof Error ? err.message : t("clawkeep.memory.setup.browseFailed"));
    }
  }, [t]);

  const addSource = async (folder: string) => {
    setBusy("add");
    setError(null);
    try {
      const res = await fetch("/setup-api/clawkeep/memory/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: folder }),
      });
      const out = (await res.json().catch(() => null)) as { paths?: string[]; error?: string } | null;
      if (!res.ok) throw new Error(out?.error || t("clawkeep.memory.setup.addFolderFailed"));
      setSources(out?.paths ?? []);
      setBrowse(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("clawkeep.memory.setup.addFolderFailed"));
    } finally {
      setBusy(null);
    }
  };

  const removeSource = async (folder: string) => {
    setBusy(`remove:${folder}`);
    try {
      const res = await fetch("/setup-api/clawkeep/memory/sources", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: folder }),
      });
      const out = (await res.json().catch(() => null)) as { paths?: string[] } | null;
      if (res.ok) setSources(out?.paths ?? []);
    } finally {
      setBusy(null);
    }
  };

  // ─── Step 3: when it runs ───
  const [frequency, setFrequency] = useState<"daily" | "weekly">("daily");
  const [time, setTime] = useState("03:00");
  const [dayOfWeek, setDayOfWeek] = useState(0);

  const saveSchedule = async (signal: AbortSignal) => {
    const res = await fetch("/setup-api/clawkeep/memory/schedule", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      // The whole object, under the route's own names (`timeOfDay`,
      // `weekday` — see MemoryIndexSchedule): this route replaces rather than
      // merges, and a field it does not recognise is reset to its default
      // just like an absent one, which is how the chosen time and day were
      // once quietly saved as 03:00 on Sunday.
      body: JSON.stringify({ enabled: true, frequency, timeOfDay: time, weekday: dayOfWeek }),
      signal,
    });
    if (!res.ok) {
      const out = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(out?.error || t("clawkeep.memory.setup.scheduleFailed"));
    }
  };

  // ─── Step 4: the model, then the first index ───
  const [phase, setPhase] = useState<ProvisionPhase>("idle");
  const [progress, setProgress] = useState<number | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  /**
   * Fetch the embedding model if it is missing, point the index at the
   * embedder on this box, save the schedule, switch the feature on and start
   * the first pass.
   *
   * The embedder is Qwen3-Embedding on ClawBox's own llama.cpp, run as a
   * system unit that the web server's local-AI proxy starts on the first
   * search and stops ten idle minutes later. Nothing here enables or starts
   * it: OpenClaw is pointed at the PROXY, so the wake is part of every
   * search — the ollama-era wizard had to enable a daemon permanently because
   * a search reached it directly and never woke it.
   */
  const provision = async () => {
    provisionAbort.current?.abort();
    const ctl = new AbortController();
    provisionAbort.current = ctl;
    const { signal } = ctl;
    setBusy("provision");
    setError(null);
    try {
      setPhase("checking");
      setDetail(null);
      const status = await fetch("/setup-api/embed/status", { cache: "no-store", signal })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null) as { installed?: boolean } | null;
      // The probe swallows its own failure; an abort is the one it must not.
      if (signal.aborted) return;

      if (!status?.installed) {
        setPhase("pulling-model");
        setProgress(null);
        const pull = await fetch("/setup-api/embed/install", { method: "POST", signal });
        if (!pull.ok || !pull.body) throw new Error(t("clawkeep.memory.setup.pullFailed"));
        // NDJSON, one object per line: `{status}` while the root step runs,
        // then one closing `{success}` or `{error}`. A FAILURE arrives
        // in-stream as a 200 with {error}, which is why the body is read for
        // one even though the response was ok. The download's own progress
        // reaches the journal as lines; a percentage in one is shown when it
        // is there and nothing is guessed when it is not.
        const reader = pull.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              let parsed: PullLine;
              try { parsed = JSON.parse(line) as PullLine; } catch { continue; }
              if (parsed.error) throw new Error(parsed.error);
              if (parsed.status) {
                setDetail(parsed.status);
                const percent = /(\d{1,3})%/.exec(parsed.status);
                if (percent) setProgress(Math.min(100, Number(percent[1])) / 100);
              }
            }
          }
        } finally {
          // Leaving the loop on an error line releases the body rather than
          // holding a locked reader on it until garbage collection; on a
          // stream that has not ended, cancelling is what tells the install
          // route its client is gone.
          await reader.cancel().catch(() => {});
        }
        setProgress(1);
      }

      setPhase("switching-provider");
      setDetail(null);
      const provider = await fetch("/setup-api/clawkeep/memory/provider", { method: "POST", signal });
      if (!provider.ok) {
        const out = (await provider.json().catch(() => null)) as { error?: string } | null;
        throw new Error(out?.error || t("clawkeep.memory.setup.providerFailed"));
      }

      await saveSchedule(signal);

      // The switch and the completion flag together, at the very end: a flag
      // that landed earlier would drop the owner on the home page mid-wizard.
      const done = await fetch("/setup-api/clawkeep/memory/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, setupComplete: true }),
        signal,
      });
      if (!done.ok) throw new Error(t("clawkeep.memory.setup.enableFailed"));

      // The first pass, and a FULL one: the provider switch above changes the
      // index identity, and OpenClaw pauses vector search over an index built
      // for another provider until it is rebuilt — the route's own
      // incremental→full upgrade fires only on an empty index, not a stale
      // one. A 409 means a pass is already going — the box IS indexing, which
      // is all this asked for. Anything else is said here, in the wizard the
      // owner is watching: the card that replaces it would only show "never
      // ran", with no reason.
      const index = await fetch("/setup-api/clawkeep/memory/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "full" }),
        signal,
      });
      if (!index.ok && index.status !== 409) throw new Error(t("clawkeep.memory.startFailed"));

      setPhase("ready");
      onDone();
    } catch (err) {
      // The window closed: there is nobody left to tell.
      if (signal.aborted) return;
      setPhase("failed");
      setError(err instanceof Error ? err.message : t("clawkeep.memory.setup.provisionFailed"));
    } finally {
      if (!signal.aborted) setBusy(null);
    }
  };

  const stepNumber = step === "folders" ? 1 : step === "schedule" ? 2 : 3;
  const TOTAL = 3;

  const phaseLine = (): string => {
    switch (phase) {
      case "checking": return t("clawkeep.memory.setup.phaseChecking");
      case "pulling-model": return progress === null
        ? t("clawkeep.memory.setup.phasePulling")
        : t("clawkeep.memory.setup.phasePullingPercent", { percent: Math.round(progress * 100) });
      case "switching-provider": return t("clawkeep.memory.setup.phaseSwitching");
      case "ready": return t("clawkeep.memory.setup.phaseReady");
      default: return "";
    }
  };

  return (
    <div className={step === "intro" ? "mt-4 flex-1 flex flex-col" : `${CARD} mt-4`} data-testid="memory-shard-wizard">
      {step !== "intro" && (
        <p className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
          {t("clawkeep.memory.setup.stepOf", { n: stepNumber, total: TOTAL })}
        </p>
      )}

      {step === "intro" && (
        <div className="flex-1 flex flex-col items-center justify-center px-4 pb-8">
          <div className="w-full max-w-[26rem] text-left">
            <MemoryShardArt className="mb-7" />
            <h2 className="text-base font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              {t("clawkeep.memory.setup.introTitle")}
            </h2>
            <p className="mt-2.5 text-xs leading-[1.7] text-[var(--text-secondary)]">
              {t("clawkeep.memory.setup.introBody")}
            </p>
            <button
              type="button"
              onClick={() => setStep("folders")}
              data-testid="memory-shard-enable"
              className={`${BTN_PRIMARY} mt-7`}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">rocket_launch</span>
              {t("clawkeep.memory.setup.enable")}
            </button>
          </div>
        </div>
      )}

      {step === "folders" && (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{t("clawkeep.memory.setup.foldersTitle")}</h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{t("clawkeep.memory.setup.foldersBody")}</p>

          <ul className="mt-3 space-y-1.5" data-testid="memory-shard-sources">
            {sources.map((folder) => (
              <li key={folder} className="flex items-center gap-2 rounded-lg bg-[var(--fill-1)] border border-[var(--border-subtle)] px-3 py-2">
                <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 15 }} aria-hidden="true">folder</span>
                <span className="flex-1 truncate font-mono text-[11px] text-[var(--text-secondary)]">{folder}</span>
                <button
                  type="button"
                  onClick={() => void removeSource(folder)}
                  disabled={busy === `remove:${folder}`}
                  className={BTN_SECONDARY}
                >
                  {t("clawkeep.memory.setup.removeFolder")}
                </button>
              </li>
            ))}
            {sources.length === 0 && (
              <li className="text-[11px] text-[var(--text-muted)]">{t("clawkeep.memory.setup.noFolders")}</li>
            )}
          </ul>

          <button type="button" onClick={() => void openBrowse()} className={`${BTN_SECONDARY} mt-3`} data-testid="memory-shard-browse">
            <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">create_new_folder</span>
            {t("clawkeep.memory.setup.addFolder")}
          </button>

          {browse && (
            <div className="mt-2 rounded-xl bg-[var(--fill-1)] border border-[var(--border-subtle)] p-2" data-testid="memory-shard-picker">
              <div className="flex items-center justify-between gap-2 px-1 pb-1">
                <span className="font-mono text-[11px] text-[var(--text-muted)] truncate">{browse.path}</span>
                <button type="button" onClick={() => setBrowse(null)} className={BTN_SECONDARY}>{t("clawkeep.memory.setup.close")}</button>
              </div>
              <ul className="max-h-48 overflow-y-auto">
                {browse.parent && (
                  <li>
                    <button type="button" onClick={() => void openBrowse(browse.parent as string)}
                      className="w-full text-left px-2 py-1 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-white/5">
                      {t("clawkeep.memory.setup.up")}
                    </button>
                  </li>
                )}
                {browse.entries.map((entry) => (
                  <li key={entry.path}>
                    <button type="button" onClick={() => void openBrowse(entry.path)}
                      className="w-full text-left px-2 py-1 rounded-lg text-xs text-[var(--text-primary)] hover:bg-white/5">
                      {entry.name}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => void addSource(browse.path)}
                disabled={busy === "add"}
                data-testid="memory-shard-pick"
                className={`${BTN_SECONDARY} mt-1 w-full`}
              >
                {t("clawkeep.memory.setup.useFolder")}
              </button>
            </div>
          )}

          <div className="mt-5 flex items-center gap-2">
            <button type="button" onClick={() => setStep("schedule")} className={BTN_PRIMARY} data-testid="memory-shard-next-schedule">
              {t("clawkeep.memory.setup.next")}
            </button>
            <span className="text-[11px] text-[var(--text-muted)]">{t("clawkeep.memory.setup.foldersOptional")}</span>
          </div>
        </>
      )}

      {step === "schedule" && (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{t("clawkeep.memory.setup.scheduleTitle")}</h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{t("clawkeep.memory.setup.scheduleBody")}</p>

          <div className={`${SEGMENTED_TRACK} mt-3`}>
            {(["daily", "weekly"] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFrequency(f)}
                aria-pressed={frequency === f}
                data-testid={`memory-shard-freq-${f}`}
                className={frequency === f ? SEGMENT_ON : SEGMENT_OFF}>
                {t(`clawkeep.memory.setup.${f}`)}
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-3">
            <label className="text-xs text-[var(--text-secondary)]" htmlFor="ms-time">{t("clawkeep.memory.setup.time")}</label>
            <input
              id="ms-time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              data-testid="memory-shard-time"
              className={`${FIELD} font-mono`}
            />
          </div>

          {frequency === "weekly" && (
            <div className="mt-3 flex flex-wrap gap-1" role="group" aria-label={t("clawkeep.memory.setup.day")}>
              {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                <button key={d} type="button" onClick={() => setDayOfWeek(d)}
                  aria-pressed={dayOfWeek === d}
                  className={dayOfWeek === d ? SEGMENT_ON : SEGMENT_OFF}>
                  {t(`clawkeep.memory.setup.day${d}`)}
                </button>
              ))}
            </div>
          )}

          <div className="mt-5 flex items-center gap-2">
            <button type="button" onClick={() => setStep("folders")} className={BTN_SECONDARY}>{t("clawkeep.memory.setup.back")}</button>
            <button type="button" onClick={() => setStep("provision")} className={BTN_PRIMARY} data-testid="memory-shard-next-provision">
              {t("clawkeep.memory.setup.next")}
            </button>
          </div>
        </>
      )}

      {step === "provision" && (
        <>
          <div className="mt-1 flex items-center gap-1.5">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t("clawkeep.memory.setup.provisionTitle")}</h2>
            <HelpTip text={t("clawkeep.memory.setup.provisionHint")} label={t("clawkeep.memory.setup.provisionTitle")} testId="memory-shard-provision-help" />
          </div>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{t("clawkeep.memory.setup.provisionBody")}</p>

          {phase !== "idle" && phase !== "failed" && (
            <div className="mt-4 rounded-xl bg-[var(--fill-1)] border border-[var(--border-subtle)] px-3 py-3" data-testid="memory-shard-progress">
              <div className="flex items-center gap-2">
                <span aria-hidden="true"
                  className="inline-block w-3 h-3 rounded-full border-2 border-[var(--coral-bright)] border-t-transparent motion-safe:animate-spin" />
                <span className="text-xs text-[var(--text-secondary)]" data-testid="memory-shard-phase">{phaseLine()}</span>
              </div>
              {phase === "pulling-model" && progress !== null && (
                <div className="mt-2 h-1.5 w-full rounded-full bg-[var(--bg-deep)] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[var(--coral-bright)] transition-[width] duration-300"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
              )}
              {detail && <p className="mt-1.5 font-mono text-[10px] text-[var(--text-muted)] truncate">{detail}</p>}
            </div>
          )}

          <div className="mt-5 flex items-center gap-2">
            <button type="button" onClick={() => setStep("schedule")} disabled={busy === "provision"} className={BTN_SECONDARY}>
              {t("clawkeep.memory.setup.back")}
            </button>
            <button
              type="button"
              onClick={() => void provision()}
              disabled={busy === "provision"}
              data-testid="memory-shard-index-now"
              className={BTN_PRIMARY}
            >
              {busy === "provision" ? t("clawkeep.memory.setup.working") : t("clawkeep.memory.indexNow")}
            </button>
          </div>
        </>
      )}

      {error && <StatusMessage type="error" message={error} />}
    </div>
  );
}
