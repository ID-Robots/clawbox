"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StepStatus, UpdateState } from "@/lib/updater";
import { RESTART_STEP_ID } from "@/lib/update-constants";
import { cleanVersion } from "@/lib/version-utils";

interface VersionInfo {
  clawbox: { current: string; target: string | null };
  openclaw: { current: string | null; target: string | null };
}

interface BranchInfo {
  branch: string | null;
}

const CARD = "rounded-xl border border-white/10 bg-[var(--bg-deep)]/70 p-5";

function compareSemver(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const pa = (cleanVersion(a) ?? a).replace(/^v/, "").split(".").map((n) => Number(n) || 0);
  const pb = (cleanVersion(b) ?? b).replace(/^v/, "").split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

function isUpdateAvailable(current: string | null | undefined, target: string | null | undefined): boolean {
  if (!current || !target) return false;
  return compareSemver(target, current) > 0;
}

type Status = "loading" | "up-to-date" | "available" | "updating" | "completed" | "failed" | "fetch-error";

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "completed") {
    return (
      <span className="flex items-center justify-center w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-300 shrink-0">
        <span className="material-symbols-rounded" style={{ fontSize: 14, fontVariationSettings: "'wght' 700" }}>check</span>
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="flex items-center justify-center w-6 h-6 shrink-0">
        <span className="w-4 h-4 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex items-center justify-center w-6 h-6 rounded-full bg-red-500/20 text-red-300 shrink-0">
        <span className="material-symbols-rounded" style={{ fontSize: 14, fontVariationSettings: "'wght' 700" }}>close</span>
      </span>
    );
  }
  return <span className="flex items-center justify-center w-6 h-6 rounded-full bg-white/[0.04] shrink-0">
    <span className="w-1.5 h-1.5 rounded-full bg-white/30" />
  </span>;
}

export default function SystemUpdateApp() {
  const [versions, setVersions] = useState<VersionInfo | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateStarted, setUpdateStarted] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [branchInput, setBranchInput] = useState("");
  const [branchSaving, setBranchSaving] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [betaConfirm, setBetaConfirm] = useState(false);

  const pollRef = useRef<number | null>(null);
  const pollControllerRef = useRef<AbortController | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (pollControllerRef.current) {
      pollControllerRef.current.abort();
      pollControllerRef.current = null;
    }
  }, []);

  const fetchVersions = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/setup-api/update/versions", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as VersionInfo;
      setVersions(data);
      setVersionsError(null);
    } catch (e) {
      setVersionsError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const fetchBranch = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/system/update-branch", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as BranchInfo;
      setBranch(data.branch);
      setBranchInput(data.branch ?? "");
    } catch {
      /* leave defaults */
    }
  }, []);

  useEffect(() => {
    void fetchVersions();
    void fetchBranch();
  }, [fetchVersions, fetchBranch]);

  // If an update is already running when the user opens this app (it was
  // kicked off from Settings, the wizard, or a prior session), immediately
  // join the poll so the live progress shows.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/setup-api/update/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as UpdateState;
        if (cancelled) return;
        if (data.phase === "running") {
          setUpdateStarted(true);
          setUpdateState(data);
          startPolling();
        }
      } catch { /* idle */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current !== null) return;
    const controller = new AbortController();
    pollControllerRef.current = controller;
    let serverWentDown = false;
    let failures = 0;
    pollRef.current = window.setInterval(async () => {
      try {
        const res = await fetch("/setup-api/update/status", { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          failures++;
          if (failures >= 3) serverWentDown = true;
          return;
        }
        if (serverWentDown) {
          window.location.reload();
          return;
        }
        failures = 0;
        const data = (await res.json()) as UpdateState;
        if (controller.signal.aborted) return;
        setUpdateState(data);
        if (data.phase !== "running") {
          stopPolling();
          if (data.phase === "completed") {
            // Re-fetch versions so the dashboard reflects the new ones.
            void fetchVersions();
          }
        }
      } catch {
        if (controller.signal.aborted) return;
        failures++;
        if (failures >= 3) serverWentDown = true;
      }
    }, 2000);
  }, [stopPolling, fetchVersions]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const triggerUpdate = useCallback(async (mode: "full" | "openclaw") => {
    setUpdateStarted(true);
    setUpdateError(null);
    setUpdateState(null);
    try {
      const url = mode === "full" ? "/setup-api/update/run" : "/setup-api/update/openclaw";
      const init: RequestInit = mode === "full"
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) }
        : { method: "POST" };
      const res = await fetch(url, init);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setUpdateError(typeof data.error === "string" ? data.error : `Failed to start update (HTTP ${res.status})`);
        return;
      }
      startPolling();
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : "Failed to start update");
    }
  }, [startPolling]);

  const dismissResult = useCallback(() => {
    setUpdateStarted(false);
    setUpdateError(null);
    setUpdateState(null);
    stopPolling();
  }, [stopPolling]);

  const saveBranch = useCallback(async (next: string | null) => {
    setBranchSaving(true);
    setBranchError(null);
    try {
      const res = await fetch("/setup-api/system/update-branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `HTTP ${res.status}`);
      setBranch(typeof data.branch === "string" ? data.branch : null);
      setBranchInput(typeof data.branch === "string" ? data.branch : "");
    } catch (e) {
      setBranchError((e as Error).message);
    } finally {
      setBranchSaving(false);
    }
  }, []);

  const status: Status = useMemo(() => {
    if (updateStarted) {
      if (updateError || updateState?.phase === "failed") return "failed";
      if (updateState?.phase === "completed") return "completed";
      return "updating";
    }
    if (versionsError && !versions) return "fetch-error";
    if (!versions) return "loading";
    const clawboxAvail = isUpdateAvailable(versions.clawbox.current, versions.clawbox.target);
    const openclawAvail = isUpdateAvailable(versions.openclaw.current, versions.openclaw.target);
    return clawboxAvail || openclawAvail ? "available" : "up-to-date";
  }, [updateStarted, updateError, updateState, versions, versionsError]);

  // ─── HERO ────────────────────────────────────────────────────────────
  const hero = (() => {
    switch (status) {
      case "loading":
        return {
          icon: "hourglass_empty", iconClass: "text-white/40",
          headline: "Checking for updates…", subhead: "Reading device + cloud version manifests.",
          tone: "neutral" as const,
        };
      case "fetch-error":
        return {
          icon: "cloud_off", iconClass: "text-amber-300",
          headline: "Couldn't reach the update server", subhead: versionsError ?? "Check the device's internet connection and try again.",
          tone: "warn" as const,
        };
      case "up-to-date":
        return {
          icon: "verified", iconClass: "text-emerald-300",
          headline: "You're up to date", subhead: "Every component is on the latest release.",
          tone: "good" as const,
        };
      case "available": {
        const updates: string[] = [];
        if (versions && isUpdateAvailable(versions.clawbox.current, versions.clawbox.target)) updates.push("ClawBox");
        if (versions && isUpdateAvailable(versions.openclaw.current, versions.openclaw.target)) updates.push("OpenClaw");
        return {
          icon: "system_update", iconClass: "text-emerald-300",
          headline: `${updates.length} update${updates.length === 1 ? "" : "s"} available`,
          subhead: `New version available for ${updates.join(" and ")}.`,
          tone: "available" as const,
        };
      }
      case "updating":
        return {
          icon: "downloading", iconClass: "text-orange-300",
          headline: "Updating your device", subhead: "Don't power off until this finishes.",
          tone: "busy" as const,
        };
      case "completed":
        return {
          icon: "task_alt", iconClass: "text-emerald-300",
          headline: "Update complete",
          subhead: updateState?.steps.some((s) => s.id === RESTART_STEP_ID) ? "The device will restart in a moment." : "Everything's been updated.",
          tone: "good" as const,
        };
      case "failed":
        return {
          icon: "error", iconClass: "text-red-300",
          headline: "Update failed",
          subhead: updateError || updateState?.error || "One step couldn't complete. See the steps below.",
          tone: "error" as const,
        };
    }
  })();

  const heroBgClass = {
    neutral: "from-white/5 via-white/[0.02]",
    warn: "from-amber-500/10 via-amber-500/5",
    good: "from-emerald-500/10 via-emerald-500/5",
    available: "from-emerald-500/10 via-emerald-500/5",
    busy: "from-orange-500/10 via-orange-500/5",
    error: "from-red-500/10 via-red-500/5",
  }[hero.tone];

  const clawboxAvail = !!versions && isUpdateAvailable(versions.clawbox.current, versions.clawbox.target);
  const openclawAvail = !!versions && isUpdateAvailable(versions.openclaw.current, versions.openclaw.target);

  return (
    <div className="relative h-full w-full overflow-y-auto bg-[var(--bg-app)] text-gray-200">
      <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
        <button
          type="button"
          onClick={() => { void fetchVersions(); }}
          disabled={refreshing || status === "updating"}
          className="px-2.5 py-1 rounded-md border border-white/10 text-xs text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50 cursor-pointer inline-flex items-center gap-1.5"
          title="Re-fetch versions from the update server"
        >
          <span
            className={`material-symbols-rounded ${refreshing ? "animate-spin" : ""}`}
            style={{ fontSize: 14 }}
            aria-hidden="true"
          >
            refresh
          </span>
          {refreshing ? "Checking…" : "Check now"}
        </button>
      </div>

      <div className="min-h-full w-full flex items-start justify-center p-6 pt-10">
        <div className="w-full max-w-2xl space-y-4">
          {/* HERO */}
          <div className={`${CARD} relative overflow-hidden flex flex-col items-center text-center px-6 pt-10 pb-8 bg-gradient-to-br ${heroBgClass} to-transparent`}>
            <div className="relative w-32 h-32 flex items-center justify-center mb-3">
              {(status === "available" || status === "up-to-date" || status === "updating") && (
                <>
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 rounded-full"
                    style={{
                      background: "radial-gradient(circle, rgba(16,185,129,0.35), transparent 70%)",
                      filter: "blur(20px)",
                      opacity: 0.7,
                    }}
                  />
                </>
              )}
              <div className="relative w-24 h-24 rounded-full flex items-center justify-center bg-white/[0.04] border border-white/10">
                <span className={`material-symbols-rounded ${hero.iconClass} ${status === "updating" ? "clawkeep-shelf-glow" : ""}`} style={{ fontSize: 56, fontVariationSettings: "'FILL' 1, 'wght' 600" }}>
                  {hero.icon}
                </span>
              </div>
            </div>
            <h1 className="font-display text-3xl font-bold">{hero.headline}</h1>
            <p className="mt-1.5 max-w-md text-sm text-[var(--text-muted)] leading-relaxed">
              {hero.subhead}
            </p>

            {(status === "available" || status === "up-to-date") && (
              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                {status === "available" && (
                  <button
                    type="button"
                    onClick={() => void triggerUpdate("full")}
                    className="px-6 py-2.5 rounded-full bg-emerald-500 hover:bg-emerald-400 text-black text-sm font-semibold shadow-lg cursor-pointer"
                  >
                    Update everything
                  </button>
                )}
                {status === "up-to-date" && (
                  <button
                    type="button"
                    onClick={() => void fetchVersions()}
                    disabled={refreshing}
                    className="px-6 py-2.5 rounded-full border border-white/15 bg-white/[0.04] text-sm font-semibold text-gray-200 hover:bg-white/[0.08] disabled:opacity-50 cursor-pointer"
                  >
                    {refreshing ? "Checking…" : "Check for updates"}
                  </button>
                )}
              </div>
            )}

            {status === "fetch-error" && (
              <button
                type="button"
                onClick={() => void fetchVersions()}
                disabled={refreshing}
                className="mt-6 px-5 py-2 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-200 text-sm font-semibold hover:bg-amber-500/25 cursor-pointer disabled:opacity-50"
              >
                {refreshing ? "Retrying…" : "Try again"}
              </button>
            )}
          </div>

          {/* COMPONENTS */}
          {versions && status !== "updating" && status !== "completed" && status !== "failed" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <ComponentCard
                name="ClawBox"
                description="Device OS and built-in apps"
                current={versions.clawbox.current}
                target={versions.clawbox.target}
                available={clawboxAvail}
                onUpdate={() => void triggerUpdate("full")}
              />
              <ComponentCard
                name="OpenClaw"
                description="AI agent runtime"
                current={versions.openclaw.current}
                target={versions.openclaw.target}
                available={openclawAvail}
                onUpdate={() => void triggerUpdate("openclaw")}
              />
            </div>
          )}

          {/* PROGRESS */}
          {(status === "updating" || status === "completed" || status === "failed") && (
            <UpdateProgressCard
              state={updateState}
              error={updateError}
              status={status}
              onDismiss={dismissResult}
            />
          )}

          {/* ADVANCED */}
          {status !== "updating" && (
            <div className={CARD}>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
                className="w-full flex items-center justify-between text-left text-sm font-semibold text-gray-100 cursor-pointer"
              >
                <span className="inline-flex items-center gap-2">
                  <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 18 }} aria-hidden="true">tune</span>
                  Advanced options
                </span>
                <span
                  className={`material-symbols-rounded text-[var(--text-muted)] transition-transform ${showAdvanced ? "rotate-180" : ""}`}
                  style={{ fontSize: 18 }}
                  aria-hidden="true"
                >
                  expand_more
                </span>
              </button>

              {showAdvanced && (
                <div className="mt-4 space-y-4">
                  {/* Beta toggle */}
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-sm text-gray-100 inline-flex items-center gap-2">
                        <span className="material-symbols-rounded text-amber-400" style={{ fontSize: 18 }} aria-hidden="true">science</span>
                        Beta channel
                      </div>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">
                        Pulls updates from <code className="bg-black/30 px-1 rounded">beta</code> instead of <code className="bg-black/30 px-1 rounded">main</code>. Pre-release features land here first; expect rough edges.
                      </p>
                    </div>
                    <BetaToggle
                      enabled={branch === "beta"}
                      saving={branchSaving}
                      onEnable={() => setBetaConfirm(true)}
                      onDisable={() => void saveBranch(null)}
                    />
                  </div>

                  {/* Branch override */}
                  <div className="border-t border-white/5 pt-4">
                    <div className="text-sm text-gray-100">Branch override</div>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      Pin updates to a specific git branch (e.g. for QA). Leave blank to follow the configured channel.
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="text"
                        value={branchInput}
                        onChange={(e) => setBranchInput(e.target.value)}
                        placeholder="main / beta / clawkeep"
                        spellCheck={false}
                        className="flex-1 px-2.5 py-1.5 rounded-md bg-[var(--bg-app)] border border-white/10 text-sm font-mono text-gray-200 focus:outline-none focus:border-emerald-500/50"
                      />
                      <button
                        type="button"
                        onClick={() => void saveBranch(branchInput.trim() || null)}
                        disabled={branchSaving || branchInput.trim() === (branch ?? "")}
                        className="px-3 py-1.5 rounded-md bg-emerald-500/15 border border-emerald-500/40 text-emerald-200 text-xs font-semibold disabled:opacity-50 cursor-pointer"
                      >
                        {branchSaving ? "Saving…" : "Save"}
                      </button>
                    </div>
                    {branchError && (
                      <p className="mt-2 text-xs text-red-300">{branchError}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {betaConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="beta-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          onClick={() => setBetaConfirm(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/10 bg-[var(--bg-deep)] shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-5 pt-5">
              <div className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center bg-amber-500/15 text-amber-300">
                <span className="material-symbols-rounded" style={{ fontSize: 22 }}>warning</span>
              </div>
              <h2 id="beta-confirm-title" className="text-base font-semibold text-gray-100">Enable beta updates?</h2>
            </div>
            <div className="px-5 pt-3 pb-4 text-sm leading-relaxed text-[var(--text-secondary)]">
              <p>
                Beta builds may include unfinished features and regressions. They&apos;re great for early
                feedback but can break local state. You can switch back any time, but downgrades aren&apos;t
                always reversible.
              </p>
            </div>
            <div className="flex justify-end gap-2 px-5 pb-5 pt-2 border-t border-white/5">
              <button
                type="button"
                onClick={() => setBetaConfirm(false)}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-white/10 text-gray-200 hover:bg-white/5 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => { setBetaConfirm(false); void saveBranch("beta"); }}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-amber-500 hover:bg-amber-400 text-black cursor-pointer"
              >
                Enable beta
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ComponentCard({
  name,
  description,
  current,
  target,
  available,
  onUpdate,
}: {
  name: string;
  description: string;
  current: string | null;
  target: string | null;
  available: boolean;
  onUpdate: () => void;
}) {
  return (
    <div className={`${CARD} flex flex-col`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-base font-semibold text-gray-100">{name}</div>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">{description}</p>
        </div>
        <span className={`shrink-0 px-2 py-0.5 rounded-full border text-[10px] font-semibold tracking-wider ${available ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" : "bg-white/5 text-[var(--text-muted)] border-white/10"}`}>
          {available ? "UPDATE" : "CURRENT"}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="uppercase tracking-wider text-[10px] text-[var(--text-muted)]">Installed</div>
          <div className="mt-1 font-mono text-gray-100 truncate">{cleanVersion(current ?? "") || current || "—"}</div>
        </div>
        <div>
          <div className="uppercase tracking-wider text-[10px] text-[var(--text-muted)]">Latest</div>
          <div className={`mt-1 font-mono truncate ${available ? "text-emerald-300" : "text-gray-100"}`}>
            {cleanVersion(target ?? "") || target || "—"}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onUpdate}
        disabled={!available}
        className="mt-4 px-3 py-1.5 rounded-md text-xs font-semibold border cursor-pointer disabled:cursor-default disabled:opacity-50 transition-colors bg-emerald-500/15 border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/25"
      >
        {available ? `Update ${name}` : "Up to date"}
      </button>
    </div>
  );
}

function BetaToggle({
  enabled,
  saving,
  onEnable,
  onDisable,
}: {
  enabled: boolean;
  saving: boolean;
  onEnable: () => void;
  onDisable: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => (enabled ? onDisable() : onEnable())}
      disabled={saving}
      aria-pressed={enabled}
      className={`relative inline-flex items-center w-10 h-5 rounded-full transition-colors cursor-pointer border-none shrink-0 ${enabled ? "bg-amber-500" : "bg-white/15"} ${saving ? "opacity-50" : ""}`}
    >
      <span
        className="absolute w-4 h-4 rounded-full bg-white shadow-md transition-transform duration-200"
        style={{ left: 2, transform: enabled ? "translateX(18px)" : "translateX(0)" }}
      />
    </button>
  );
}

function UpdateProgressCard({
  state,
  error,
  status,
  onDismiss,
}: {
  state: UpdateState | null;
  error: string | null;
  status: Status;
  onDismiss: () => void;
}) {
  const failedSteps = state?.steps.filter((s) => s.status === "failed") ?? [];
  return (
    <div className={CARD}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-100">
          {status === "completed" ? "Update finished" : status === "failed" ? "Update stopped" : "In progress"}
        </h2>
        {(status === "completed" || status === "failed") && (
          <button
            type="button"
            onClick={onDismiss}
            className="px-3 py-1 rounded-md text-xs font-medium border border-white/10 text-gray-200 hover:bg-white/5 cursor-pointer"
          >
            Dismiss
          </button>
        )}
      </div>

      {!state && (
        <div className="mt-4 flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <span className="w-4 h-4 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
          Connecting…
        </div>
      )}

      {state && state.steps.length > 0 && (
        <ul className="mt-4 space-y-2">
          {state.steps.map((step) => (
            <li key={step.id} className="flex items-center gap-3 text-sm">
              <StepIcon status={step.status} />
              <span className={
                step.status === "running" ? "text-gray-100 font-medium" :
                step.status === "completed" ? "text-emerald-300/80" :
                step.status === "failed" ? "text-red-300" : "text-[var(--text-muted)]"
              }>
                {step.label}
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="mt-4 text-sm text-red-300">{error}</p>
      )}
      {failedSteps.length > 0 && (
        <ul className="mt-3 space-y-2">
          {failedSteps.map((step) => (
            <li key={`${step.id}-err`} className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              <span className="font-semibold text-red-100">{step.label}:</span>{" "}
              {step.error || "Unknown error"}
            </li>
          ))}
        </ul>
      )}

      {status === "completed" && state?.steps.some((s) => s.id === RESTART_STEP_ID) && (
        <p className="mt-4 text-xs text-[var(--text-muted)]">
          The page will reload once the device is back up.
        </p>
      )}
    </div>
  );
}
