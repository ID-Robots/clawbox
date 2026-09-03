"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import ClawKeepArt from "./ClawKeepArt";
import StatusMessage from "./StatusMessage";
import { PairChallengeCard, type PairStartResponse } from "./ClawKeepPairChallengeCard";
import { BTN_PRIMARY, BTN_SECONDARY, CARD, FIELD } from "./coding-agent-ui";
import { WEEKDAY_LABEL_KEYS, jsonOrError } from "./clawkeep-ui";

/**
 * ClawKeep's first-run wizard: what it is, pair the box with the portal, seal
 * the backups with a passphrase, and pick when they run. Shown inside the
 * ClawKeep window until the owner finishes it (`status.setupComplete`) or the
 * box is paired.
 *
 * Same shape as the Coding Agent's and Memory Shard's wizards, deliberately:
 * an intro face with no card chrome and the artwork on top, then carded
 * steps, and a completion flag written only at the very end. Every step goes
 * through the routes the dashboard already uses — this is an onboarding path
 * over them, never the only way to change any of it.
 */

type Step = "intro" | "pair" | "protect" | "schedule";

interface PairPollResponse {
  status: "pending" | "configuring" | "complete" | "error";
  error?: string;
}

/** The slice of the status the wizard reads; the dashboard's type is wider. */
export interface ClawKeepWizardStatus {
  paired: boolean;
  encryptionConfigured?: boolean;
  schedule?: {
    enabled: boolean;
    frequency: "daily" | "weekly";
    timeOfDay: string;
    weekday: number;
    retentionKeepLast: number;
  };
}

export default function ClawKeepWizard({
  status,
  agent,
  onStatusChanged,
  onDone,
}: {
  status: ClawKeepWizardStatus;
  /** The name of the agent this box archives — "OpenClaw" or "Hermes". */
  agent: string;
  /** Re-read the status: pairing and the passphrase change it under the wizard. */
  onStatusChanged: () => Promise<void> | void;
  onDone: () => void;
}) {
  const { t } = useT();
  const [step, setStep] = useState<Step>("intro");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ─── Step 1: pairing — the same device-code loop the dashboard runs ───
  const [challenge, setChallenge] = useState<PairStartResponse | null>(null);
  const [pairPhase, setPairPhase] = useState<"" | "pending" | "configuring">("");
  const pollRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  useEffect(() => {
    if (!challenge || (pairPhase !== "pending" && pairPhase !== "configuring")) return;
    // One poll at a time, and none of them outlives this challenge: a slow
    // poll must not overlap the next tick, and an old challenge's late
    // "complete" (after Cancel, or a new code) must not end the new one.
    let disposed = false;
    let inFlight = false;
    const controller = new AbortController();
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const ps = await jsonOrError<PairPollResponse>(
          await fetch("/setup-api/clawkeep/pair/poll", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            signal: controller.signal,
          }),
        );
        if (disposed) return;
        if (ps.status === "complete") {
          stopPolling();
          setChallenge(null);
          setPairPhase("");
          await onStatusChanged();
          return;
        }
        if (ps.status === "configuring") { setPairPhase("configuring"); return; }
        if (ps.status === "error") {
          stopPolling();
          setChallenge(null);
          setPairPhase("");
          setError(ps.error || t("clawkeep.pair.failed"));
        }
      } catch {
        // the next tick retries
      } finally {
        inFlight = false;
      }
    };
    pollRef.current = window.setInterval(tick, Math.max(2, challenge.interval) * 1000);
    void tick();
    return () => {
      disposed = true;
      controller.abort();
      stopPolling();
    };
  }, [challenge, pairPhase, onStatusChanged, stopPolling, t]);

  const startPairing = async () => {
    setBusy("pair");
    setError(null);
    try {
      const start = await jsonOrError<PairStartResponse>(
        await fetch("/setup-api/clawkeep/pair/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      setChallenge(start);
      setPairPhase("pending");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // ─── Step 2: the passphrase — the dashboard's modal, as a step ───
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const passphraseOk = pw.length >= 8 && pw === confirm && acknowledged;

  const savePassphrase = async () => {
    setBusy("protect");
    setError(null);
    try {
      const res = await fetch("/setup-api/clawkeep/encryption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: pw, confirm }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await onStatusChanged();
      setStep("schedule");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // ─── Step 3: when it runs, then done ───
  const [autoBackup, setAutoBackup] = useState(true);
  const [frequency, setFrequency] = useState<"daily" | "weekly">(status.schedule?.frequency ?? "daily");
  const [time, setTime] = useState(status.schedule?.timeOfDay ?? "03:00");
  const [weekday, setWeekday] = useState(status.schedule?.weekday ?? 0);
  const [firstBackup, setFirstBackup] = useState(true);

  const markDone = async () => {
    const res = await fetch("/setup-api/clawkeep/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupComplete: true }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || t("clawkeep.setup.finishFailed"));
    }
  };

  const finish = async () => {
    setBusy("finish");
    setError(null);
    try {
      // The whole object, under the route's own names: the schedule route
      // replaces rather than merges (see the dashboard's ScheduleCard).
      const saved = await fetch("/setup-api/clawkeep/schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: autoBackup,
          frequency,
          timeOfDay: time,
          weekday,
          retentionKeepLast: status.schedule?.retentionKeepLast ?? 0,
        }),
      });
      if (!saved.ok) {
        const body = (await saved.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || t("clawkeep.setup.scheduleFailed"));
      }
      await markDone();
      if (firstBackup && status.paired) {
        // Fire and forget: the dashboard the owner lands on shows the run.
        fetch("/setup-api/clawkeep/backup", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
          .catch(() => { /* the dashboard says so if it did not start */ });
      }
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** Leave the wizard without pairing: the dashboard's own Pair card waits. */
  const skip = async () => {
    setBusy("skip");
    setError(null);
    try {
      await markDone();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const stepNumber = step === "pair" ? 1 : step === "protect" ? 2 : 3;
  const TOTAL_STEPS = 3;
  const nextFromIntro = () => setStep(status.paired ? "protect" : "pair");

  return (
    <div
      className={step === "intro" ? "mt-4 flex-1 flex flex-col" : `${CARD} mt-4`}
      data-testid="clawkeep-wizard"
    >
      {step !== "intro" && (
        <p className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
          {t("clawkeep.setup.stepOf", { n: stepNumber, total: TOTAL_STEPS })}
        </p>
      )}

      {/* ── The front door. Same rules as the coding agent's: the block is
          centred, the text inside it hangs off one left edge. ── */}
      {step === "intro" && (
        <div className="flex-1 flex flex-col items-center justify-center px-4 pb-8">
          <div className="w-full max-w-[26rem] text-left">
            <ClawKeepArt className="mb-7" />
            <h2 className="text-base font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              {t("clawkeep.setup.introTitle")}
            </h2>
            <p className="mt-2.5 text-xs leading-[1.7] text-[var(--text-secondary)]">
              {t("clawkeep.setup.introBody", { agent })}
            </p>
            <div className="mt-7 flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={nextFromIntro}
                data-testid="clawkeep-wizard-enable"
                className={PRIMARY}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">shield_lock</span>
                {t("clawkeep.setup.enable")}
              </button>
              <button
                type="button"
                onClick={() => void skip()}
                disabled={busy !== null}
                data-testid="clawkeep-wizard-skip"
                className="bg-transparent border-none text-xs text-[var(--text-muted)] hover:text-gray-200 cursor-pointer p-0 disabled:opacity-50"
              >
                {busy === "skip" ? t("clawkeep.setup.working") : t("clawkeep.setup.skip")}
              </button>
            </div>
            {error && <div className="mt-3"><StatusMessage type="error" message={error} /></div>}
          </div>
        </div>
      )}

      {/* ── Step 1: pair with the portal. ── */}
      {step === "pair" && (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{t("clawkeep.setup.pairTitle")}</h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
            {t("clawkeep.pair.description", { agent })}
          </p>
          {status.paired ? (
            <p className="mt-3 flex items-center gap-2 text-xs text-emerald-400" data-testid="clawkeep-wizard-paired">
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">check_circle</span>
              {t("clawkeep.setup.paired")}
            </p>
          ) : challenge ? (
            <div className="mt-3">
              <PairChallengeCard
                challenge={challenge}
                phase={pairPhase}
                onCancel={() => { stopPolling(); setChallenge(null); setPairPhase(""); }}
                onGetNewCode={() => void startPairing()}
                busy={busy === "pair"}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void startPairing()}
              disabled={busy !== null}
              data-testid="clawkeep-wizard-pair"
              className={`${PRIMARY} mt-4`}
            >
              {busy === "pair" ? t("clawkeep.pair.connecting") : t("clawkeep.pair.button")}
            </button>
          )}
          {error && <div className="mt-3"><StatusMessage type="error" message={error} /></div>}
          <div className="mt-5 flex items-center justify-between gap-3">
            <button type="button" onClick={() => setStep("intro")} className={BTN_SECONDARY}>{t("clawkeep.setup.back")}</button>
            <button
              type="button"
              onClick={() => setStep("protect")}
              disabled={!status.paired}
              data-testid="clawkeep-wizard-next"
              className={PRIMARY}
            >
              {t("clawkeep.setup.next")}
            </button>
          </div>
        </>
      )}

      {/* ── Step 2: seal the backups. ── */}
      {step === "protect" && (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{t("clawkeep.encryption.setTitle")}</h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{t("clawkeep.encryption.setDescription")}</p>
          {status.encryptionConfigured ? (
            <p className="mt-3 flex items-center gap-2 text-xs text-emerald-400" data-testid="clawkeep-wizard-protected">
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">check_circle</span>
              {t("clawkeep.setup.alreadyProtected")}
            </p>
          ) : (
            <div className="mt-3 space-y-3">
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 flex gap-2">
                <span className="material-symbols-rounded text-amber-300 shrink-0" style={{ fontSize: 18 }} aria-hidden="true">warning</span>
                <p className="text-xs text-amber-100/90 leading-relaxed">
                  {t("clawkeep.encryption.warning1")}{" "}
                  <strong>{t("clawkeep.encryption.warning2")}</strong>
                  {t("clawkeep.encryption.warning3")}
                </p>
              </div>
              <label className="block text-xs font-medium text-white/80">
                {t("clawkeep.encryption.passphraseLabel")}
                <input
                  type="password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  autoComplete="new-password"
                  placeholder={t("clawkeep.encryption.passphrasePlaceholder")}
                  data-testid="clawkeep-wizard-passphrase"
                  className={`${FIELD} mt-1 w-full`}
                />
              </label>
              <label className="block text-xs font-medium text-white/80">
                {t("clawkeep.encryption.confirmLabel")}
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  placeholder={t("clawkeep.encryption.confirmPlaceholder")}
                  data-testid="clawkeep-wizard-confirm"
                  className={`${FIELD} mt-1 w-full`}
                />
              </label>
              {confirm.length > 0 && pw !== confirm && (
                <p className="text-[11px] text-red-300">{t("clawkeep.encryption.mismatch")}</p>
              )}
              <label className="flex items-start gap-2 text-xs text-white/80 leading-relaxed cursor-pointer">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  data-testid="clawkeep-wizard-ack"
                  className="mt-0.5 accent-orange-500"
                />
                <span>
                  {t("clawkeep.encryption.ack1")}{" "}
                  <strong>{t("clawkeep.encryption.ack2")}</strong>
                  {t("clawkeep.encryption.ack3")}
                </span>
              </label>
            </div>
          )}
          {error && <div className="mt-3"><StatusMessage type="error" message={error} /></div>}
          <div className="mt-5 flex items-center justify-between gap-3">
            <button type="button" onClick={() => setStep("pair")} className={BTN_SECONDARY}>{t("clawkeep.setup.back")}</button>
            {status.encryptionConfigured ? (
              <button type="button" onClick={() => setStep("schedule")} data-testid="clawkeep-wizard-next" className={PRIMARY}>
                {t("clawkeep.setup.next")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void savePassphrase()}
                disabled={!passphraseOk || busy !== null}
                data-testid="clawkeep-wizard-next"
                className={PRIMARY}
              >
                {busy === "protect" ? t("clawkeep.encryption.saving") : t("clawkeep.setup.next")}
              </button>
            )}
          </div>
        </>
      )}

      {/* ── Step 3: when it runs. ── */}
      {step === "schedule" && (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{t("clawkeep.setup.scheduleTitle")}</h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{t("clawkeep.setup.scheduleBody")}</p>

          <label className="mt-4 flex items-center justify-between gap-3 text-xs text-[var(--text-primary)]">
            <span>{t("clawkeep.setup.autoBackup")}</span>
            <input
              type="checkbox"
              checked={autoBackup}
              onChange={(e) => setAutoBackup(e.target.checked)}
              data-testid="clawkeep-wizard-auto"
              className="accent-orange-500"
            />
          </label>

          {autoBackup && (
            <div className="mt-3 space-y-3">
              <div className="flex gap-2">
                {(["daily", "weekly"] as const).map((freq) => (
                  <button
                    key={freq}
                    type="button"
                    aria-pressed={frequency === freq}
                    onClick={() => setFrequency(freq)}
                    className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors cursor-pointer ${
                      frequency === freq
                        ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-200"
                        : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-white/5"
                    }`}
                  >
                    {freq === "daily" ? t("clawkeep.schedule.daily") : t("clawkeep.schedule.weekly")}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <label htmlFor="clawkeep-wizard-time" className="text-xs text-[var(--text-muted)] w-16">{t("clawkeep.schedule.time")}</label>
                <input
                  id="clawkeep-wizard-time"
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className={`${FIELD} text-sm`}
                />
                <span className="text-xs text-[var(--text-muted)]">{t("clawkeep.schedule.deviceLocal")}</span>
              </div>
              {frequency === "weekly" && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-[var(--text-muted)] w-16">{t("clawkeep.schedule.day")}</span>
                  <div className="flex gap-1 flex-wrap" role="group" aria-label={t("clawkeep.schedule.day")}>
                    {WEEKDAY_LABEL_KEYS.map((labelKey, idx) => (
                      <button
                        key={labelKey}
                        type="button"
                        aria-pressed={weekday === idx}
                        onClick={() => setWeekday(idx)}
                        className={`px-2.5 py-1 rounded-md text-xs border cursor-pointer ${
                          weekday === idx
                            ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-200"
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

          {status.paired && (
            <label className="mt-4 flex items-center justify-between gap-3 text-xs text-[var(--text-primary)]">
              <span>{t("clawkeep.setup.firstBackup")}</span>
              <input
                type="checkbox"
                checked={firstBackup}
                onChange={(e) => setFirstBackup(e.target.checked)}
                data-testid="clawkeep-wizard-first-backup"
                className="accent-orange-500"
              />
            </label>
          )}

          {error && <div className="mt-3"><StatusMessage type="error" message={error} /></div>}
          <div className="mt-5 flex items-center justify-between gap-3">
            <button type="button" onClick={() => setStep("protect")} className={BTN_SECONDARY}>{t("clawkeep.setup.back")}</button>
            <button
              type="button"
              onClick={() => void finish()}
              disabled={busy !== null}
              data-testid="clawkeep-wizard-finish"
              className={PRIMARY}
            >
              {busy === "finish" ? t("clawkeep.setup.working") : t("clawkeep.setup.finish")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// One button system with the dashboard and the other wizards.
const PRIMARY = BTN_PRIMARY;
