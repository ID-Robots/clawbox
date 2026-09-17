"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import MemoryShardArt from "./MemoryShardArt";
import MemoryShardFolders from "./MemoryShardFolders";
import PaidFeatureGate, { PAID_GATE_POLL_MS, paidGateFace } from "./PaidFeatureGate";
import StatusMessage from "./StatusMessage";
import HelpTip from "./HelpTip";
import { BTN_PRIMARY, BTN_SECONDARY, CARD, FIELD, SEGMENT_OFF, SEGMENT_ON, SEGMENTED_TRACK } from "./coding-agent-ui";
import {
  cloudEmbedderPickable,
  cloudUnavailableNoteKey,
  type EmbedderChoiceStatus,
  type EmbeddingSource,
  parseEmbedderChoiceStatus,
  type ProvisionPhase,
  TIME_OF_DAY,
} from "@/lib/memory-shard-state";
import { useClawboxLogin } from "@/lib/use-clawbox-login";

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


/** One NDJSON line from /setup-api/embed/install: a status while the root step runs, then success or error. */
interface PullLine { status?: string; success?: boolean; error?: string }

export default function MemoryShardWizard({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  // The paid-plan gate (owner's decision, 2026-09-14). Same shape and same
  // reason as the coding agent's wizard: polled, so an owner who subscribes in
  // another tab is let through without reopening the window, and mirrored
  // server-side by /setup-api/clawkeep/memory/enable.
  const clawboxLogin = useClawboxLogin(PAID_GATE_POLL_MS);
  const gated = paidGateFace(clawboxLogin) !== "satisfied";
  const [chosenStep, setStep] = useState<Step>("intro");
  const [startedBusy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The gate governs the WHOLE flow, not just the front door.
   *
   * The plan poll goes on running behind every step, and a subscription that
   * lapses — or a credential that is withdrawn — while the owner is two steps
   * in must not leave the provisioning button live: `clawkeep/memory/enable`
   * would answer 402 at the very end, after the model download had been paid
   * for. While the gate is shut the only step there is, is the intro, which is
   * where the gate itself is drawn and says why.
   *
   * DERIVED, not corrected in an effect — see the same three lines in
   * CodingAgentSetupWizard for the whole of the reasoning. The owner's chosen
   * step is KEPT, so a plan restored in another tab puts them back where they
   * were, with nothing left half-running: the request is aborted below and the
   * phase reads idle, so the button they land on is one they can press.
   */
  const step: Step = gated ? "intro" : chosenStep;
  const busy = gated ? null : startedBusy;

  // ─── Step 2: the folders to read — MemoryShardFolders, shared with the
  // settings page so the two cannot drift. Next waits while it writes, so the
  // owner cannot leave the step before an add has been answered ───
  const [foldersBusy, setFoldersBusy] = useState(false);

  // The provisioning flow's own signal. Closing the window mid-download must
  // stop the download: the pull route drops its Ollama connection when the
  // client goes away, precisely so a model is never fetched with nothing in
  // the UI showing it, and a fetch left running here would defeat that.
  const provisionAbort = useRef<AbortController | null>(null);
  useEffect(() => () => provisionAbort.current?.abort(), []);

  /**
   * A provision still in flight when the plan goes away is stopped.
   *
   * This one IS an effect, because aborting a request is a side effect on an
   * external system rather than a correction of React's own state — and it
   * sets none: the step and the phase the owner then sees are derived, and
   * what the stopped run leaves behind is cleared by that run's own cleanup
   * (see `provision`'s `finally`), which is the only place that knows whether
   * the controller it is holding is still the current one.
   */
  useEffect(() => {
    if (!gated) return;
    provisionAbort.current?.abort();
  }, [gated]);

  // ─── Step 3: when it runs ───
  const [frequency, setFrequency] = useState<"daily" | "weekly">("daily");
  const [time, setTime] = useState("03:00");
  // What the field shows while what it holds is not yet a time; `time` is
  // the last VALID value and the only one that is ever saved.
  const [timeText, setTimeText] = useState<string | null>(null);
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

  // ─── Where the model runs: the ClawBox AI cloud, or this box ───
  // Read on mount so it has answered by the time the last step is on screen.
  // The DEFAULT is the cloud whenever the box says it can be picked — a paid
  // plan and a cloud embedder that answered, or an index already embedded there
  // (the owner's ruling, 2026-09-15: no 640 MB download for a box that has a
  // plan) — and the owner's own pick always wins over that default. A read that
  // fails, or an older server, leaves the model on this box, which is what
  // every box did before; the note under the switch then says WHY, because
  // "not available right now" read as a fault of the box.
  const [embedder, setEmbedder] = useState<EmbedderChoiceStatus | null>(null);
  const [pickedSource, setPickedSource] = useState<EmbeddingSource | null>(null);
  // Whether that read has ANSWERED, apart from what it answered: `embedder` is
  // null both while it is in flight and after it failed, and a press in the
  // first case would take the local path and download 640 MB on a box the
  // cloud model was about to be offered on. A failed read still settles, so
  // the local flow stays reachable.
  const [embedderSettled, setEmbedderSettled] = useState(false);
  useEffect(() => {
    let live = true;
    void fetch("/setup-api/clawkeep/memory/provider", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (live) setEmbedder(parseEmbedderChoiceStatus(body)); })
      .catch(() => {})
      .finally(() => { if (live) setEmbedderSettled(true); });
    return () => { live = false; };
  }, []);
  // The one rule, shared with the settings card — see `cloudEmbedderPickable`.
  // The cloud is the DEFAULT wherever it can be picked, which includes a box
  // whose index is already embedded there but whose probe has not answered.
  const cloudPickable = embedder !== null && cloudEmbedderPickable(embedder);
  const source: EmbeddingSource = pickedSource ?? (cloudPickable ? "cloud" : "local");

  // ─── Step 4: the model, then the first index ───
  const [reachedPhase, setPhase] = useState<ProvisionPhase>("idle");
  const [progress, setProgress] = useState<number | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  /**
   * Derived like the step above, and for the one tick the derivation alone
   * covers: `abort()` is synchronous but the aborted request's cleanup is a
   * microtask later, so without this the gated intro would paint once with
   * the phase the run had reached. The lasting reset is that cleanup's.
   */
  const phase: ProvisionPhase = gated ? "idle" : reachedPhase;

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
    // Re-read at the moment of the act, not only at the render that drew the
    // button. The derived step already puts the intro on screen, so there is
    // nothing to set here — this only catches a click whose handler was
    // already in flight when the gate closed under it.
    if (gated) return;
    provisionAbort.current?.abort();
    const ctl = new AbortController();
    provisionAbort.current = ctl;
    const { signal } = ctl;
    setBusy("provision");
    setError(null);
    try {
      // The model on this box has to be here first; the cloud model has
      // nothing to fetch.
      if (source === "local") {
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
          //
          // The closing line is REQUIRED. A stream that simply ends — the web
          // server restarting mid-download, the connection dropping — has said
          // neither, and reading its end as "done" would switch the provider
          // and start a full reindex against a model that is not on the box,
          // with the owner watching the ready phase.
          const reader = pull.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let finished = false;
          const readLine = (line: string) => {
            if (!line.trim()) return;
            let parsed: PullLine;
            try { parsed = JSON.parse(line) as PullLine; } catch { return; }
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.success === true) finished = true;
            if (parsed.status) {
              setDetail(parsed.status);
              const percent = /(\d{1,3})%/.exec(parsed.status);
              if (percent) setProgress(Math.min(100, Number(percent[1])) / 100);
            }
          };
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) readLine(line);
            }
            // The route ends every line with a newline, but the closing line is
            // the one this step now depends on, so a final line the stream
            // closed on without one is read rather than left in the buffer.
            buffer += decoder.decode();
            readLine(buffer);
          } finally {
            // Leaving the loop on an error line releases the body rather than
            // holding a locked reader on it until garbage collection; on a
            // stream that has not ended, cancelling is what tells the install
            // route its client is gone.
            await reader.cancel().catch(() => {});
          }
          if (!finished) throw new Error(t("clawkeep.memory.setup.pullFailed"));
          setProgress(1);
        }
      }

      setPhase("switching-provider");
      setDetail(null);
      // A box whose index is ALREADY embedded in the cloud has nothing to
      // switch: the cloud can be picked there whatever the live probe said
      // (see `cloudEmbedderPickable`), but the route's switch re-checks that
      // probe and the token and answers 409 on a hiccup — a failed wizard over
      // an index that was never going to move. The local path always posts:
      // its owner's-choice mark is what keeps the next boot's cloud default
      // from moving the index back.
      const alreadyInCloud = source === "cloud" && embedder?.source === "cloud";
      const provider = alreadyInCloud ? null : await fetch(
        "/setup-api/clawkeep/memory/provider",
        source === "cloud"
          ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "cloud" }), signal }
          : { method: "POST", signal },
      );
      if (provider && !provider.ok) {
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
      // Controller IDENTITY, not `signal.aborted`: a second provision installs
      // its own controller before this one's cleanup runs, and a superseded
      // run must never clear the new run's busy state.
      //
      // While this IS still the current controller the run is over however it
      // ended, so an ABORTED one has to leave the wizard idle rather than
      // frozen mid-phase. The gate can reopen — an owner who subscribes in the
      // other tab — and `startedBusy`/`reachedPhase` preserved from a run that
      // was stopped would put them back on a dead button with a progress line
      // behind it and nothing running.
      if (provisionAbort.current === ctl) {
        provisionAbort.current = null;
        setBusy(null);
        if (signal.aborted) setPhase("idle");
      }
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
            {/* See CodingAgentSetupWizard for the whole of the reasoning: the
                gate takes the place the first step would have led to, and the
                button stays on screen, disabled, so the card underneath is
                the answer to "why can I not start this". */}
            {gated && (
              <div className="mt-6">
                <PaidFeatureGate feature="memory_shard" login={clawboxLogin} />
              </div>
            )}
            <button
              type="button"
              onClick={() => setStep("folders")}
              data-testid="memory-shard-enable"
              disabled={gated}
              aria-disabled={gated}
              title={gated ? t("paidGate.buttonBlocked") : undefined}
              className={`${BTN_PRIMARY} mt-7 disabled:opacity-50 disabled:cursor-default`}
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

          <MemoryShardFolders onBusyChange={setFoldersBusy} />

          <div className="mt-5 flex items-center gap-2">
            <button type="button" onClick={() => setStep("schedule")} disabled={foldersBusy} className={BTN_PRIMARY} data-testid="memory-shard-next-schedule">
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
              value={timeText ?? time}
              onChange={(e) => {
                const next = e.target.value;
                if (TIME_OF_DAY.test(next)) { setTime(next); setTimeText(null); }
                else setTimeText(next);
              }}
              onBlur={() => setTimeText(null)}
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
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]" data-testid="memory-shard-provision-body">
            {t(source === "cloud" ? "clawkeep.memory.setup.provisionBodyCloud" : "clawkeep.memory.setup.provisionBody")}
          </p>

          {/* The choice is drawn only where both halves exist: the edition that
              indexes on the box itself has no cloud model to offer. */}
          {embedder?.cloudSupported && (
            <div className="mt-3" data-testid="memory-shard-source">
              <div className={SEGMENTED_TRACK} role="radiogroup" aria-label={t("clawkeep.memory.embedder.title")}>
                {(["cloud", "local"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={source === option}
                    disabled={busy === "provision" || (option === "cloud" && !cloudPickable)}
                    onClick={() => setPickedSource(option)}
                    data-testid={`memory-shard-source-${option}`}
                    className={`${source === option ? SEGMENT_ON : SEGMENT_OFF} disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {t(`clawkeep.memory.embedder.${option}`)}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]" data-testid="memory-shard-source-hint">
                {t(source === "cloud" ? "clawkeep.memory.embedder.cloudHint" : "clawkeep.memory.embedder.localHint")}
              </p>
              {!cloudPickable && (
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]" data-testid="memory-shard-source-cloud-unavailable">
                  {t(cloudUnavailableNoteKey(embedder.cloudReason))}
                </p>
              )}
            </div>
          )}

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
              disabled={busy === "provision" || !embedderSettled}
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
