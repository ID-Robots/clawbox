"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { onMemoryShardChanged } from "@/lib/ui-events";
import MemoryShardArt from "./MemoryShardArt";
import MemoryShardWizard from "./MemoryShardWizard";
import MemoryShardSettingsPanel, { type MemoryShardSettingsState } from "./MemoryShardSettingsPanel";
import { BTN_PRIMARY, BTN_SECONDARY } from "./coding-agent-ui";
import type {
  ClawKeepMemoryStatus,
  MemoryIndexMode,
  MemoryIndexSchedule,
  MemoryRunState,
} from "@/lib/clawkeep-memory";
import {
  CARD,
  ConfirmDialog,
  Stat,
  WEEKDAY_LABEL_KEYS,
  formatBytes,
  formatDuration,
  formatNextRun,
  jsonOrError,
  timeAgo,
} from "./clawkeep-ui";

/**
 * Memory Shard — the box's memory index as its own desktop app.
 *
 * Embedding health, indexing controls and the managed schedule (TASK-398).
 * This was a card inside ClawKeep, and moved out because the owner who opens
 * it is asking "what does this box remember, and where is that text going",
 * which is not a backup question; in ClawKeep it sat below the fold of a
 * window about something else. ClawKeep keeps a one-line card pointing here.
 *
 * Deliberately NOT gated on ClawKeep pairing: the memory index is entirely
 * local, and an unpaired box still has one. It IS OpenClaw's index — its own
 * store and its own embedding provider (`clawkeep-memory.ts`) — so the desktop
 * lists the app on the OpenClaw harness only, the way ClawKeep gated the card
 * on the OpenClaw CLI.
 *
 * Everything it shows comes from `openclaw memory status` through
 * /setup-api/clawkeep/memory, which already strips paths, provider errors and
 * raw CLI output before they reach the browser. The routes kept their
 * `clawkeep/` prefix on purpose: renaming them would break nothing for the
 * browser and everything for a box mid-update, whose bundle and server can be
 * a version apart.
 */

/**
 * Is this actually a memory status?
 *
 * Load-bearing, and not defensive programming for its own sake: every e2e
 * ClawKeep test failed on this. Their mock answers any unrecognised
 * `/setup-api/*` path with `{}` and HTTP 200, `jsonOrError` accepted it, and
 * the first render then read `status.run.status` off `undefined` and threw —
 * taking the ENTIRE ClawKeep window down, backups and all, because one
 * subordinate panel got an answer it did not expect.
 *
 * The same thing happens in the field whenever this route answers something
 * else: an older build behind a proxy, a truncated response, a schema that
 * moves on. A panel is not allowed to cost the customer the app it lives in —
 * and now that the panel IS the app, the rule holds for its own window.
 */
function isMemoryStatus(body: unknown): body is ClawKeepMemoryStatus {
  if (!body || typeof body !== "object") return false;
  const b = body as Partial<ClawKeepMemoryStatus>;
  return typeof b.health === "string"
    && typeof b.location === "string"
    && isRunState(b.run)
    && !!b.schedule && typeof b.schedule === "object" && typeof b.schedule.enabled === "boolean";
}

function isRunState(value: unknown): value is MemoryRunState {
  return !!value && typeof value === "object" && typeof (value as Partial<MemoryRunState>).status === "string";
}

/** What the server accepts as a time; anything else is still being typed. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The route names its failures in snake_case (`index_identity_mismatched`);
 * a translation key may only carry alphanumeric segments (the naming rule
 * `translations.test.ts` enforces), so the code is camel-cased before it is
 * pasted into one. Unknown codes still produce a key that resolves to
 * nothing, which is why every caller keeps the server's English as the floor.
 */
function errorKeySuffix(code: string): string {
  return code.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function MemoryIndexCard({ initial, onError }: {
  /** The status the window already read on the way in, when it recognised one.
   *  The card used to throw that payload away and probe again, which cost the
   *  owner a second CLI-backed read — up to 90s on a cold box — to be shown the
   *  figures the window was holding. Its own poll below carries on as before. */
  initial: ClawKeepMemoryStatus | null;
  onError: (msg: string) => void;
}) {
  const { t } = useT();
  // The route's sentences are English, always. Its contract — like every other
  // ClawBox route's — is a stable `code` beside them, so a screen can word the
  // fact in the owner's language; the server's English is the floor until the
  // locale pack carries the key, which is what kept German desktops reading
  // "The index does not match the configured embedding model."
  const tr = useCallback((key: string, english: string) => {
    const value = t(key);
    return value === key ? english : value;
  }, [t]);
  const [status, setStatus] = useState<ClawKeepMemoryStatus | null>(initial);
  const [busy, setBusy] = useState<MemoryIndexMode | null>(null);
  const [confirmFull, setConfirmFull] = useState(false);
  const [draft, setDraft] = useState<MemoryIndexSchedule | null>(initial?.schedule ?? null);
  const [savingSchedule, setSavingSchedule] = useState(false);
  // The time field's text while it is not a valid time yet. Kept OUT of the
  // draft on purpose: every other control spreads the draft into its save,
  // and a half-typed "" in there went to the server, which sanitised it to
  // 03:00 — the saved time was lost to a click on "Daily".
  const [timeText, setTimeText] = useState<string | null>(null);

  // Read through refs, not through the closure: `load` is called from an
  // interval, and a poll that started before the user touched the schedule
  // would otherwise still be seeing no save in flight and would stamp the
  // pre-edit value back over the control.
  const savesInFlightRef = useRef(0);
  const saveSeqRef = useRef(0);
  const loadInFlightRef = useRef(false);

  const load = useCallback(async () => {
    // The status route can block for up to 90s on a cache miss while the CLI
    // probe runs, and the fast tick is 3s. Without this guard the ticks stack
    // concurrent probes on an 8 GB box, which is exactly what they are
    // competing with the indexer for.
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    try {
      const body = await jsonOrError<unknown>(await fetch("/setup-api/clawkeep/memory"));
      // Anything that is not a memory status is ignored outright rather than
      // rendered. The panel keeps its last good reading, or stays on its
      // loading line, and the rest of the window is untouched.
      if (!isMemoryStatus(body)) return;
      setStatus(body);
      // Only adopt the server's schedule while the user is not mid-edit, or a
      // poll landing between two clicks would throw their change away.
      setDraft((prev) => (prev && savesInFlightRef.current > 0 ? prev : body.schedule));
    } catch {
      // A failed poll is not worth a red banner: the panel keeps the last good
      // reading and the next tick corrects it.
    } finally {
      loadInFlightRef.current = false;
    }
  }, []);

  // Poll fast while a run is in flight so "running" turns into a real outcome
  // on its own, and slowly the rest of the time — the status probe shells out
  // to the OpenClaw CLI and this box has 8 GB. The first read happens here too
  // rather than in an effect of its own, which also keeps this off
  // react-hooks/set-state-in-effect.
  const running = status?.run.status === "running";
  // Seeded from the window's own read: asking the route again in the same
  // breath would boot a second OpenClaw probe to be told what is already on
  // screen. Only the FIRST pass of this effect is skipped — a change of
  // cadence re-reads as it always did.
  const seeded = useRef(initial !== null);
  useEffect(() => {
    if (seeded.current) seeded.current = false;
    else void load();
    const id = setInterval(() => { void load(); }, running ? 3_000 : 30_000);
    return () => clearInterval(id);
  }, [load, running]);

  const startIndex = async (mode: MemoryIndexMode) => {
    setBusy(mode);
    try {
      const res = await fetch("/setup-api/clawkeep/memory/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (res.status === 409) {
        // Two different declines wear this code now: single-flight, and the
        // owner's switch being off. "Indexing is already running" over a
        // switched-off shard would send them looking for a run that was never
        // started, so the route's `kind` decides which sentence they get.
        const refusal = await res.json().catch(() => null) as { kind?: unknown } | null;
        onError(refusal?.kind === "disabled"
          ? t("clawkeep.memory.disabledError")
          : t("clawkeep.memory.alreadyRunning"));
      } else {
        const { run } = await jsonOrError<{ run?: unknown }>(res);
        // The route answers with the run it just started. Adopt it now, so
        // the run line reads "running now" and the fast poll begins with the
        // click — not once the first status read comes back, by which time a
        // short pass has already finished.
        if (isRunState(run)) setStatus((prev) => (prev ? { ...prev, run } : prev));
      }
      await load();
    } catch {
      onError(t("clawkeep.memory.startFailed"));
    } finally {
      setBusy(null);
    }
  };

  const saveSchedule = async (next: MemoryIndexSchedule) => {
    setDraft(next);
    // Whatever is saved carries a real time, so the field shows that one.
    setTimeText(null);
    // Nothing is disabled while this is in flight — a control that goes
    // disabled under the keyboard drops focus to <body>, and in the time
    // field that ate the rest of what was being typed. Instead, only the
    // NEWEST save gets to write its answer back: two quick changes can be
    // answered in either order, and the older answer would put the draft
    // back to a value the user had already moved on from.
    const seq = ++saveSeqRef.current;
    savesInFlightRef.current += 1;
    setSavingSchedule(true);
    let failed = false;
    try {
      const body = await jsonOrError<{ schedule: MemoryIndexSchedule; nextRunAtMs: number }>(
        await fetch("/setup-api/clawkeep/memory/schedule", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        }),
      );
      if (seq === saveSeqRef.current) {
        setDraft(body.schedule);
        setStatus((prev) => prev ? { ...prev, schedule: body.schedule, nextRunAtMs: body.nextRunAtMs } : prev);
      }
    } catch {
      failed = true;
      onError(t("clawkeep.memory.scheduleSaveFailed"));
    } finally {
      savesInFlightRef.current -= 1;
      if (savesInFlightRef.current === 0) setSavingSchedule(false);
    }
    if (failed && seq === saveSeqRef.current) await load();
  };

  if (!status) {
    return (
      <div className={`${CARD} text-sm text-[var(--text-muted)]`}>
        {t("clawkeep.memory.title")} — {t("clawkeep.loading")}
      </div>
    );
  }

  const schedule = draft ?? status.schedule;
  const health = status.health;
  const healthTone =
    health === "healthy" ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/[0.07]"
    : health === "degraded" ? "text-amber-200 border-amber-500/40 bg-amber-500/10"
    : health === "unavailable" ? "text-red-300 border-red-500/40 bg-red-500/10"
    : "text-[var(--text-secondary)] border-[var(--border-subtle)] bg-white/5";
  const run = status.run;
  const runLine =
    run.status === "running" ? t("clawkeep.memory.runRunning")
    : run.status === "succeeded" ? t("clawkeep.memory.runSucceeded", { when: timeAgo(run.finishedAtMs, t) })
    : run.status === "failed" ? (run.errorCode && run.error
        ? tr(`clawkeep.memory.runError.${errorKeySuffix(run.errorCode)}`, run.error)
        : run.error || t("clawkeep.memory.runFailed"))
    : t("clawkeep.memory.runNever");
  // Who started it, what it did and how long it took — the record carries all
  // three, and without them a scheduled pass was indistinguishable from a
  // click, and "Index now" on an empty index (which runs a full build, see
  // resolveIndexMode) looked like the incremental pass it was not. Empty on
  // an old state file, and skipped.
  const runDetail = [
    run.trigger === "schedule" ? t("clawkeep.memory.triggerSchedule")
      : run.trigger === "manual" ? t("clawkeep.memory.triggerManual") : "",
    run.mode === "full" ? t("clawkeep.memory.modeFull")
      : run.mode === "incremental" ? t("clawkeep.memory.modeIncremental") : "",
    run.finishedAtMs > 0 && run.durationMs > 0 ? formatDuration(run.durationMs) : "",
  ].filter(Boolean).map((part) => ` · ${part}`).join("");
  // A stock box: the scan found no memory file and the index holds nothing.
  // The CLI says so in an issue that carries a path, which is why the bridge
  // drops it; this is the same fact from the counts alone.
  const nothingToIndex = status.available && health !== "unavailable"
    && status.files === 0 && status.pendingFiles === 0 && status.chunks === 0 && !running;
  // The owner's switch, as the server reports it. Only an EXPLICIT false pauses
  // the controls: a status from a server that predates the switch carries no
  // `enabled` at all, and that box is indexing — greying its buttons out over a
  // field it never sent would be the app inventing a state.
  const paused = status.enabled === false;
  // The banner above says "Run a full reindex", and only a full pass can clear
  // a mismatched or missing identity — an incremental one re-embeds what
  // changed and leaves the rest of the index built for another model. With
  // "Index now" filled and "Full reindex" grey, the advice and the emphasised
  // control pointed at two different buttons.
  const fullReindexAdvised = status.indexIdentity === "mismatched" || status.indexIdentity === "missing";

  return (
    <div className={`${CARD} space-y-4`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-100">🧠 {t("clawkeep.memory.title")}</h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            {status.provider
              ? t("clawkeep.memory.usingModel", { model: status.model || status.provider })
              : t("clawkeep.memory.noModel")}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {/* The whole point of the local embedder: say out loud whether the
              text being embedded left the box. */}
          <span className={`px-2 py-0.5 rounded-md border text-[11px] font-medium ${
            status.location === "local"
              ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/[0.07]"
              : status.location === "cloud"
              ? "text-sky-300 border-sky-500/40 bg-sky-500/10"
              : "text-[var(--text-secondary)] border-[var(--border-subtle)] bg-white/5"
          }`}>
            {status.location === "local" ? t("clawkeep.memory.onDevice")
              : status.location === "cloud" ? t("clawkeep.memory.cloud")
              : status.location === "disabled" ? t("clawkeep.memory.disabled")
              : t("clawkeep.memory.unknown")}
          </span>
          <span className={`px-2 py-0.5 rounded-md border text-[11px] ${healthTone}`}>
            {t(`clawkeep.memory.health.${health}`)}
          </span>
        </div>
      </div>

      {status.error && (
        <p className="text-xs text-amber-200 bg-amber-500/10 border border-amber-500/25 rounded-md px-2.5 py-2" data-testid="memory-shard-status-error">
          {status.errorCode ? tr(`clawkeep.memory.error.${errorKeySuffix(status.errorCode)}`, status.error) : status.error}
        </p>
      )}

      <div className="grid grid-cols-3 gap-3">
        <Stat label={t("clawkeep.memory.files")} value={`${status.files}`} />
        <Stat label={t("clawkeep.memory.chunks")} value={`${status.chunks}`} />
        <Stat label={t("clawkeep.memory.sources")} value={`${status.sourceCount}`} />
        <Stat label={t("clawkeep.memory.pending")} value={`${status.pendingFiles}`} />
        <Stat label={t("clawkeep.memory.failed")} value={`${status.failedItems}`} />
        <Stat label={t("clawkeep.memory.indexSize")} value={status.indexBytes ? formatBytes(status.indexBytes) : "—"} />
      </div>

      {nothingToIndex && (
        <p className="text-[11px] text-[var(--text-muted)]">{t("clawkeep.memory.noFilesYet")}</p>
      )}

      <div className="flex items-center justify-between gap-3 text-xs text-[var(--text-muted)] border-t border-[var(--border-subtle)] pt-3">
        <span className="min-w-0">
          {t("clawkeep.memory.lastRun")}: <span
            className={run.status === "failed" ? "text-red-300" : "text-gray-200"}
            title={run.finishedAtMs ? new Date(run.finishedAtMs).toLocaleString() : undefined}
          >{runLine}{runDetail}</span>
        </span>
        {/* The fingerprint is what makes "this index belongs to this model"
            checkable without printing a path or a key. It stays on one line;
            a long failure message wraps on the left instead. */}
        {status.fingerprint && (
          <span className="font-mono tabular-nums shrink-0 whitespace-nowrap" title={t("clawkeep.memory.fingerprintHelp")}>
            {t("clawkeep.memory.fingerprint")} {status.fingerprint}
          </span>
        )}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy !== null || running || paused}
          onClick={() => void startIndex("incremental")}
          data-testid="memory-shard-index-now"
          className={`${fullReindexAdvised ? BTN_SECONDARY : BTN_PRIMARY} flex-1`}
        >
          {busy !== null || running ? t("clawkeep.memory.indexing") : t("clawkeep.memory.indexNow")}
        </button>
        <button
          type="button"
          disabled={busy !== null || running || paused}
          onClick={() => setConfirmFull(true)}
          data-testid="memory-shard-full-reindex"
          className={`${fullReindexAdvised ? BTN_PRIMARY : BTN_SECONDARY} flex-1`}
        >
          {t("clawkeep.memory.fullReindex")}
        </button>
      </div>

      {/* Disabled buttons with no explanation are the worst version of an off
          switch: the route would refuse these anyway, so say why here. */}
      {paused && (
        <p className="text-[11px] text-amber-400" data-testid="memory-shard-paused">
          {t("clawkeep.memory.pausedHint")}
        </p>
      )}

      <div className="space-y-3 border-t border-[var(--border-subtle)] pt-3" aria-busy={savingSchedule}>
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-xs font-semibold text-gray-100">{t("clawkeep.memory.schedule")}</h4>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              {/* A saved schedule under a switched-off shard arms no timer, so
                  the server answers no next run and this line must not print
                  the em-dash that would leave. */}
              {!schedule.enabled
                ? t("clawkeep.memory.scheduleOff")
                : paused
                  ? t("clawkeep.memory.schedulePaused")
                  : t("clawkeep.memory.nextRun", { when: formatNextRun(status.nextRunAtMs, t) })}
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              aria-label={t("clawkeep.memory.schedule")}
              checked={schedule.enabled}
              onChange={(e) => void saveSchedule({ ...schedule, enabled: e.target.checked })}
            />
            {/* The checkbox itself is off-screen, so the track is what has to
                show the keyboard focus — the desktop's coral, not the track's
                own accent, which would vanish on the switched-on state. */}
            <span className="w-10 h-6 bg-white/10 rounded-full peer-checked:bg-[var(--coral-bright)] transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--coral-bright)]" />
            <span className="absolute left-0.5 top-0.5 w-5 h-5 bg-white rounded-full transition-transform peer-checked:translate-x-4" />
          </label>
        </div>

        {schedule.enabled && (
          <div className="space-y-3">
            <div className="flex gap-2">
              {(["daily", "weekly"] as const).map((freq) => (
                <button
                  key={freq}
                  type="button"
                  onClick={() => void saveSchedule({ ...schedule, frequency: freq })}
                  className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors cursor-pointer ${
                    schedule.frequency === freq
                      ? "bg-[var(--fill-3)] border-transparent text-[var(--text-primary)]"
                      : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-white/5"
                  }`}
                >
                  {freq === "daily" ? t("clawkeep.schedule.daily") : t("clawkeep.schedule.weekly")}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <label htmlFor="clawkeep-memory-time" className="text-xs text-[var(--text-muted)] w-16">
                {t("clawkeep.schedule.time")}
              </label>
              <input
                id="clawkeep-memory-time"
                type="time"
                value={timeText ?? schedule.timeOfDay}
                onChange={(e) => {
                  // A half-entered time arrives as "" (or out of range). Sent
                  // as-is, the server sanitises it to 03:00 and the field
                  // jumps to a time the customer never chose, mid-keystroke.
                  // It stays in the field, and only in the field, until it
                  // is a time.
                  const next = e.target.value;
                  if (TIME_OF_DAY.test(next)) void saveSchedule({ ...schedule, timeOfDay: next });
                  else setTimeText(next);
                }}
                onBlur={() => setTimeText(null)}
                className="px-2.5 py-1.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-sm text-gray-200 focus:outline-none focus:border-[var(--coral-bright)]/50"
              />
              <span className="text-xs text-[var(--text-muted)]">{t("clawkeep.schedule.deviceLocal")}</span>
            </div>
            {schedule.frequency === "weekly" && (
              <div className="flex items-center gap-3">
                <span id="clawkeep-memory-day-label" className="text-xs text-[var(--text-muted)] w-16">
                  {t("clawkeep.schedule.day")}
                </span>
                <div className="flex gap-1 flex-wrap" role="group" aria-labelledby="clawkeep-memory-day-label">
                  {WEEKDAY_LABEL_KEYS.map((labelKey, idx) => (
                    <button
                      key={idx}
                      type="button"
                      aria-pressed={schedule.weekday === idx}
                      onClick={() => void saveSchedule({ ...schedule, weekday: idx })}
                      className={`px-2.5 py-1 rounded-md text-xs border cursor-pointer ${
                        schedule.weekday === idx
                          ? "bg-[var(--fill-3)] border-transparent text-[var(--text-primary)]"
                          : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-white/5"
                      }`}
                    >
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {confirmFull && (
        <ConfirmDialog
          title={t("clawkeep.memory.confirmFullTitle")}
          body={t("clawkeep.memory.confirmFullBody")}
          confirmLabel={t("clawkeep.memory.fullReindex")}
          onCancel={() => setConfirmFull(false)}
          onConfirm={() => {
            setConfirmFull(false);
            void startIndex("full");
          }}
        />
      )}
    </div>
  );
}

export default function MemoryShardApp() {
  const { t } = useT();
  // The card reports failures up rather than painting its own banner, exactly
  // as it did inside ClawKeep, so a declined run or a schedule that would not
  // save reads the same in both windows.
  const [error, setError] = useState<string | null>(null);

  /**
   * The owner's switch and the wizard flag.
   *
   * Read from the memory STATUS, which is the payload that already describes
   * this feature — rather than by poking the write route with an empty body,
   * which was the first shape of this and both ugly and a lint error (a
   * setState reachable synchronously from an effect).
   */
  const [state, setState] = useState<MemoryShardSettingsState | null>(null);
  /** The first read has answered — however it answered. Without this a fresh
   *  box paints the index card for a moment and then swaps it for the wizard. */
  const [resolved, setResolved] = useState(false);
  /** The whole status of that first read, when it was one, so the index card
   *  can paint from it instead of asking the box the same question again. */
  const [firstStatus, setFirstStatus] = useState<ClawKeepMemoryStatus | null>(null);
  /** Which face the window shows. The settings page sits over whichever face
   *  was up — the wizard included — because it is the way back out of itself. */
  const [page, setPage] = useState<"home" | "settings">("home");

  const loadState = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/setup-api/clawkeep/memory", { cache: "no-store", signal });
      if (!res.ok) throw new Error("status");
      const status = await res.json() as { enabled?: boolean; setupComplete?: boolean };
      if (signal?.aborted) return;
      if (isMemoryStatus(status)) setFirstStatus(status);
      // ONLY an explicit boolean opens the wizard.
      //
      // A status this app cannot recognise — the e2e mock answers `{}` with a
      // 200 for any unrecognised /setup-api path, and a server mid-restart can
      // too — must not be read as "this box has never been set up". That would
      // put a configured owner in front of onboarding because one poll came
      // back oddly. Leaving the state unknown keeps the index card up, and the
      // card already knows how to say it is still loading.
      if (typeof status.setupComplete !== "boolean") return;
      setState({ enabled: status.enabled === true, setupComplete: status.setupComplete });
    } catch {
      // Same rule: an unreachable status says nothing about setup.
    } finally {
      // An aborted read is the window closing; there is nobody left to tell.
      if (!signal?.aborted) setResolved(true);
    }
  }, []);

  // The first read is tied to the window, the way the wizard's browse request
  // is: closing it mid-request drops the answer rather than delivering it to a
  // component that is gone.
  useEffect(() => {
    const ctl = new AbortController();
    void loadState(ctl.signal);
    return () => ctl.abort();
  }, [loadState]);

  // The switch can be flipped from another Memory Shard window — or from this
  // app's own settings page — and this window's chip, its buttons and the
  // wizard it may owe the owner all follow it. The visibility half is how a
  // phone returns from /app/memory-shard in another tab.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void loadState(); };
    const off = onMemoryShardChanged(() => { void loadState(); });
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      off();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadState]);

  const showWizard = state !== null && !state.setupComplete;
  /** Exclusive, and in this order: settings wins over the wizard (it is the way
   *  back out), and nothing but the loader paints before the first read. */
  const view = page === "settings"
    ? "settings"
    : !resolved
      ? "loading"
      : showWizard
        ? "wizard"
        : "home";

  return (
    // Same shell as the Coding Agent: a window that fills its frame, one
    // content column, and `data-help-bounds` so a HelpTip measures against the
    // WINDOW rather than the screen.
    <div
      className="h-full flex flex-col bg-[var(--bg-deep)] text-white overflow-y-auto @container"
      data-testid="memory-shard-app"
      data-help-bounds
    >
      <div className="mx-auto w-full max-w-2xl px-5 py-4 flex-1 flex flex-col min-h-0">
        <div className="flex items-center justify-between gap-4 pb-3 mb-1 border-b border-white/[0.06]">
          <div className="flex items-center gap-2 min-w-0">
            <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 20 }} aria-hidden="true">
              diamond
            </span>
            <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              {t("clawkeep.memory.title")}
            </h1>
            {state && (
              // emerald-400 is the product's SEMANTIC "on" tone — the same chip
              // the Coding Agent shows, and the same tone RunProgressBar gives a
              // completed run. The accent green this app used for buttons,
              // toggles and selected segments is gone; this is not that.
              <span
                data-testid="memory-shard-state"
                className={`inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider border rounded-full pl-1.5 pr-2 py-0.5 ${
                  state.enabled
                    ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/[0.07]"
                    : "text-[var(--text-muted)] border-white/15"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`w-1.5 h-1.5 rounded-full ${state.enabled ? "bg-emerald-400" : "bg-[var(--text-muted)]"}`}
                />
                {state.enabled ? t("codingAgent.stateOn") : t("codingAgent.stateOff")}
              </span>
            )}
          </div>
          {/* ONE control on this axis, the Coding Agent's: Settings on the way
              in, Back on the way out. It lives in the app rather than in the
              Settings window so a phone that landed on /app/memory-shard from
              "Open in new tab" reaches the switch with no desktop listening. */}
          <div className="flex items-center gap-2 shrink-0">
            {resolved && (
              <button
                type="button"
                onClick={() => setPage(view === "settings" ? "home" : "settings")}
                data-testid={view === "settings" ? "memory-shard-settings-back" : "memory-shard-open-settings"}
                aria-expanded={view === "settings"}
                className={BTN_SECONDARY}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">
                  {view === "settings" ? "arrow_back" : "settings"}
                </span>
                {view === "settings" ? t("clawkeep.memory.settings.back") : t("clawkeep.memory.settings.open")}
              </button>
            )}
          </div>
        </div>

        {error && (
          <div role="alert" className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label={t("clawkeep.memory.dismiss")}
              className="shrink-0 rounded-md p-0.5 text-red-200/70 hover:text-red-100 hover:bg-red-500/15 cursor-pointer"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">close</span>
            </button>
          </div>
        )}

        {view === "settings" && (
          <div className="mt-3" data-testid="memory-shard-embedded-settings">
            <MemoryShardSettingsPanel
              // Before the first read has answered there is no switch to draw,
              // so the panel is given the off state and its own write is what
              // settles it — the route answers with the box's own truth.
              state={state ?? { enabled: false, setupComplete: false }}
              onChanged={(next) => {
                setState(next);
                // The index card is REMOUNTED when Back brings the home face
                // up, and it seeds itself from `firstStatus` — so the switch
                // just flipped here has to reach that copy now. The status
                // re-read this change also triggers is CLI-backed and can take
                // a minute; until it lands, the card would go on offering
                // "Index now" over a route that refuses it.
                setFirstStatus((prev) => (prev ? { ...prev, enabled: next.enabled } : prev));
              }}
              // Start over lands on the front door, which for a box that has
              // just forgotten its setup is the wizard.
              onReset={() => { setPage("home"); void loadState(); }}
            />
          </div>
        )}

        {/* The window's own artwork rather than an empty column: the first read
            shells out to the OpenClaw CLI and can take a minute and a half on a
            cold box, and a blank body for that long reads as a broken app. The
            art holds still for an owner who asked the OS for reduced motion. */}
        {view === "loading" && (
          <div
            className="flex-1 flex flex-col items-center justify-center px-4 py-10"
            data-testid="memory-shard-loading"
            role="status"
            aria-live="polite"
          >
            <MemoryShardArt className="mb-6" />
            <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
              <span className="material-symbols-rounded motion-safe:animate-spin" style={{ fontSize: 16 }} aria-hidden="true">
                progress_activity
              </span>
              {t("clawkeep.memory.loadingIndex")}
            </p>
          </div>
        )}

        {view === "wizard" && <MemoryShardWizard onDone={() => { void loadState(); }} />}

        {view === "home" && (
          <div className="mt-4"><MemoryIndexCard initial={firstStatus} onError={setError} /></div>
        )}
      </div>
    </div>
  );
}
