"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "@/lib/clipboard";

interface ClawKeepStatus {
  paired: boolean;
  configured: boolean;
  configPath: string;
  server: string;
  paths: string[];
  exclude: string[];
  schedule: string;
  lastBackupAtMs: number;
  lastHeartbeatAtMs: number;
  lastHeartbeatStatus: string;
  cloudBytes: number;
  snapshotCount: number;
  resticInstalled: boolean;
  daemonInstalled: boolean;
}

interface PairStartResponse {
  user_code: string;
  verification_url: string;
  interval: number;
  code_length: number;
}

interface PairPollResponse {
  status: "pending" | "configuring" | "complete" | "error";
  error?: string;
}

interface BackupResponse {
  ok: boolean;
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
}

const CARD = "rounded-xl border border-white/10 bg-[var(--bg-deep)]/70 p-4";

function timeAgo(ms: number): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 0) return "in the future";
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function formatBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

async function jsonOrError<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body = (await resp.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${resp.status}`);
  }
  return (await resp.json()) as T;
}

export default function ClawKeepApp() {
  const [status, setStatus] = useState<ClawKeepStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "pair" | "backup" | "unpair" | "save">("");
  const [backupResult, setBackupResult] = useState<BackupResponse | null>(null);
  const [pairChallenge, setPairChallenge] = useState<PairStartResponse | null>(null);
  const [pairPhase, setPairPhase] = useState<"" | "pending" | "configuring">("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const pollIntervalRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await jsonOrError<ClawKeepStatus>(
        await fetch("/setup-api/clawkeep", { cache: "no-store" }),
      );
      setStatus(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // RFC 8628 device-code poll loop. While pairing is active we hit
  // /pair/poll every `interval` seconds (the upstream's recommended
  // value). Phases: pending → configuring → complete.
  useEffect(() => {
    if (!pairChallenge) return;
    if (pairPhase !== "pending" && pairPhase !== "configuring") return;

    const tick = async () => {
      try {
        const ps = await jsonOrError<PairPollResponse>(
          await fetch("/setup-api/clawkeep/pair/poll", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }),
        );
        if (ps.status === "complete") {
          stopPolling();
          setPairChallenge(null);
          setPairPhase("");
          await refresh();
          return;
        }
        if (ps.status === "configuring") {
          setPairPhase("configuring");
          return;
        }
        if (ps.status === "error") {
          stopPolling();
          setPairChallenge(null);
          setPairPhase("");
          setError(ps.error || "Pair failed");
          return;
        }
        // "pending" — keep polling
      } catch {
        // swallow — next tick retries
      }
    };

    const stopPolling = () => {
      if (pollIntervalRef.current !== null) {
        window.clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };

    const intervalMs = Math.max(2, pairChallenge.interval) * 1000;
    pollIntervalRef.current = window.setInterval(tick, intervalMs);
    void tick();
    return stopPolling;
  }, [pairChallenge, pairPhase, refresh]);

  const onPair = useCallback(async () => {
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
      setPairChallenge(start);
      setPairPhase("pending");
      window.open(start.verification_url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }, []);

  const onCancelPair = useCallback(() => {
    setPairChallenge(null);
    setPairPhase("");
    setError(null);
  }, []);

  const onUnpair = useCallback(async () => {
    if (!confirm("Unpair this device?")) return;
    setBusy("unpair");
    setError(null);
    try {
      await jsonOrError<{ ok: true }>(
        await fetch("/setup-api/clawkeep/unpair", { method: "POST" }),
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }, [refresh]);

  const onBackup = useCallback(async () => {
    setBusy("backup");
    setError(null);
    setBackupResult(null);
    try {
      const result = await jsonOrError<BackupResponse>(
        await fetch("/setup-api/clawkeep/backup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      setBackupResult(result);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }, [refresh]);

  if (!status && !error) {
    return (
      <div className="h-full w-full flex items-center justify-center text-[var(--text-muted)]">
        Loading…
      </div>
    );
  }

  if (!status) {
    return (
      <div className="h-full w-full flex items-center justify-center p-6">
        <div className={`${CARD} max-w-md text-sm`}>
          <p className="text-red-300">⚠️ Load failed</p>
          {error && <p className="mt-2 text-xs text-[var(--text-muted)]">{error}</p>}
          <button
            type="button"
            onClick={refresh}
            className="mt-3 px-3 py-1.5 rounded-md bg-orange-500 text-white text-xs font-semibold"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-[var(--bg-app)] text-gray-200 p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <header className="flex items-baseline justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold font-display">ClawKeep</h1>
            <p className="text-sm text-[var(--text-muted)]">
              Off-device backups to {status.server.replace(/^https?:\/\//, "")} via restic.
            </p>
          </div>
          {status.paired && (
            <button
              type="button"
              disabled={busy === "unpair"}
              onClick={onUnpair}
              className="px-2.5 py-1 rounded-md border border-white/10 text-xs text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50"
            >
              {busy === "unpair" ? "🔌 Unpairing…" : "Unpair"}
            </button>
          )}
        </header>

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
            ⚠️ {error}
          </div>
        )}

        {pairChallenge ? (
          <PairChallengeCard
            challenge={pairChallenge}
            phase={pairPhase}
            onCancel={onCancelPair}
          />
        ) : status.paired ? (
          <DashboardCard status={status} onBackup={onBackup} busy={busy === "backup"} />
        ) : (
          <PairCard onPair={onPair} busy={busy === "pair"} />
        )}

        {(!status.resticInstalled || !status.daemonInstalled) && <SystemCard status={status} />}

        {backupResult && <BackupResultCard result={backupResult} />}

        {/* Path-list/schedule TOML editor is power-user territory — hide
            by default so the dashboard stays scannable. */}
        {status.paired && (
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-xs text-[var(--text-muted)] hover:text-gray-200 inline-flex items-center gap-1.5 cursor-pointer bg-transparent border-none p-0"
              aria-expanded={showAdvanced}
            >
              <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14 }}>
                {showAdvanced ? "expand_less" : "expand_more"}
              </span>
              {showAdvanced ? "Hide advanced settings" : "Advanced settings"}
            </button>
          </div>
        )}

        {status.paired && showAdvanced && (
          <ConfigCard
            status={status}
            onSaved={refresh}
            onError={setError}
            onBusyChange={(v) => setBusy(v ? "save" : "")}
          />
        )}
      </div>
    </div>
  );
}

function PairCard({ onPair, busy }: { onPair: () => void; busy: boolean }) {
  return (
    <div className={`${CARD} space-y-3`}>
      <h2 className="font-semibold">Pair this device</h2>
      <p className="text-sm text-[var(--text-muted)]">
        Connect to your portal account so this device can mint short-lived R2 credentials and back up to your ClawKeep storage.
      </p>
      <button
        type="button"
        onClick={onPair}
        disabled={busy}
        className="px-3 py-2 rounded-md bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-white text-sm font-semibold"
      >
        {busy ? "🔗 Connecting…" : "Pair with portal"}
      </button>
    </div>
  );
}

function PairChallengeCard({
  challenge,
  phase,
  onCancel,
}: {
  challenge: PairStartResponse;
  phase: "" | "pending" | "configuring";
  onCancel: () => void;
}) {
  const code = challenge.user_code;
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  const flashCopied = useCallback(() => {
    setCopied(true);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }, []);

  // Auto-copy when a fresh code lands. Mirrors what the user just told the
  // portal to expect — they can paste straight into the portal field
  // without re-typing. Re-runs only when the code itself changes so a
  // re-render (e.g. phase transition) doesn't keep stomping the clipboard.
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    void copyToClipboard(code).then((ok) => {
      if (!cancelled && ok) flashCopied();
    });
    return () => {
      cancelled = true;
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, [code, flashCopied]);

  const onCopyClick = useCallback(async () => {
    const ok = await copyToClipboard(code);
    if (ok) flashCopied();
  }, [code, flashCopied]);

  return (
    <div className={`${CARD} space-y-4`}>
      <h2 className="font-semibold">
        {phase === "configuring" ? "🔄 Configuring…" : "👉 Enter this code"}
      </h2>
      <div className="flex items-center justify-center gap-2 py-2">
        <span
          className="select-all cursor-text px-4 py-2 rounded-lg bg-black/40 border border-white/10 font-mono text-2xl tracking-[0.2em] text-orange-200"
          aria-label="Pairing code"
        >
          {code}
        </span>
        <button
          type="button"
          onClick={onCopyClick}
          aria-label={copied ? "Code copied" : "Copy code"}
          className="px-2.5 py-2 rounded-md text-xs font-medium text-orange-300 bg-black/30 border border-white/10 hover:bg-black/50 cursor-pointer transition-colors"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="text-sm text-[var(--text-muted)] text-center">
        On the portal page that opened, type the code and approve.
      </p>
      <div className="flex justify-center gap-2">
        <a
          href={challenge.verification_url}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-orange-300 hover:text-orange-200 underline"
        >
          Re-open portal page
        </a>
        <span className="text-xs text-[var(--text-muted)]">·</span>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-[var(--text-muted)] hover:text-gray-200"
        >
          Cancel
        </button>
      </div>
      <p className="text-xs text-[var(--text-muted)] text-center">
        {phase === "configuring" ? "⏳ Saving token…" : "🕒 Waiting for approval…"}
      </p>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function BackupProgressPanel() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="rounded-xl border border-orange-400/30 bg-gradient-to-br from-orange-500/10 via-orange-500/5 to-transparent p-6">
      <div className="flex items-center gap-4">
        <div
          aria-hidden="true"
          className="shrink-0 w-12 h-12 rounded-full border-4 border-orange-400/30 border-t-orange-400 animate-spin"
        />
        <div className="flex-1 min-w-0">
          <div className="text-base font-semibold text-orange-100">
            Backing up to ClawBox cloud…
          </div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5">
            Restic is scanning files and uploading changes. This can take a few minutes.
          </div>
        </div>
        <div
          className="shrink-0 text-2xl font-mono font-semibold text-orange-100 tabular-nums"
          aria-label="Elapsed time"
        >
          {formatElapsed(elapsed)}
        </div>
      </div>
      <div
        className="mt-4 h-1.5 rounded-full bg-orange-500/15 overflow-hidden"
        role="progressbar"
        aria-label="Backup in progress"
      >
        <div
          className="h-full rounded-full bg-orange-400"
          style={{ animation: "indeterminate 1.6s ease-in-out infinite" }}
        />
      </div>
      <p className="mt-3 text-xs text-[var(--text-muted)]">
        Keep this app open. You can leave the device on and check back later.
      </p>
    </div>
  );
}

function DashboardCard({
  status,
  onBackup,
  busy,
}: {
  status: ClawKeepStatus;
  onBackup: () => void;
  busy: boolean;
}) {
  if (busy) {
    return <BackupProgressPanel />;
  }

  return (
    <div className={`${CARD} space-y-3`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold">Backup status</h2>
        <span
          className={`text-xs ${
            status.lastHeartbeatStatus === "ok" ? "text-emerald-400" : "text-[var(--text-muted)]"
          }`}
        >
          {status.lastHeartbeatStatus || "no runs yet"}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm">
        <Stat label="Last backup" value={timeAgo(status.lastBackupAtMs)} />
        <Stat label="Cloud usage" value={formatBytes(status.cloudBytes)} />
        <Stat label="Snapshots" value={status.snapshotCount.toString()} />
      </div>

      <button
        type="button"
        onClick={onBackup}
        disabled={!status.daemonInstalled || !status.resticInstalled}
        className="px-3 py-2 rounded-md bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-white text-sm font-semibold"
      >
        Back up now
      </button>
    </div>
  );
}

function SystemCard({ status }: { status: ClawKeepStatus }) {
  return (
    <div className={`${CARD} space-y-2 border-amber-500/20 bg-amber-500/5`}>
      <h2 className="font-semibold text-amber-200">⚙️ Setup needed</h2>
      <ul className="text-sm text-amber-100 space-y-1">
        {!status.resticInstalled && (
          <li>
            <code className="bg-black/30 px-1 rounded">restic</code> is not on $PATH. Install with{" "}
            <code className="bg-black/30 px-1 rounded">apt install restic</code>.
          </li>
        )}
        {!status.daemonInstalled && (
          <li>
            <code className="bg-black/30 px-1 rounded">clawkeepd</code> is not on $PATH. From{" "}
            <code className="bg-black/30 px-1 rounded">clawbox/clawkeep</code> run{" "}
            <code className="bg-black/30 px-1 rounded">pip install --user .</code>.
          </li>
        )}
      </ul>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.03] p-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 text-base font-semibold text-gray-100">{value}</div>
    </div>
  );
}

function ConfigCard({
  status,
  onSaved,
  onError,
  onBusyChange,
}: {
  status: ClawKeepStatus;
  onSaved: () => void;
  onError: (msg: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const startEdit = useCallback(async () => {
    try {
      const resp = await fetch("/setup-api/clawkeep/config", { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setDraft(await resp.text());
      setEditing(true);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);

  const cancel = useCallback(() => {
    setEditing(false);
    setDraft("");
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    onBusyChange(true);
    try {
      const resp = await fetch("/setup-api/clawkeep/config", {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: draft,
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${resp.status}`);
      }
      setEditing(false);
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
      onBusyChange(false);
    }
  }, [draft, onBusyChange, onError, onSaved]);

  return (
    <div className={`${CARD} space-y-3`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold">What gets backed up</h2>
        {!editing && (
          <button
            type="button"
            onClick={startEdit}
            className="text-xs text-orange-300 hover:text-orange-200"
          >
            Edit
          </button>
        )}
      </div>

      {!editing ? (
        <div className="space-y-2 text-sm">
          <PathList label="Include" items={status.paths} fallback="(no paths configured — click Edit)" />
          {status.exclude.length > 0 && <PathList label="Exclude" items={status.exclude} />}
          <p className="text-xs text-[var(--text-muted)]">
            Schedule: {status.schedule}. Config file:{" "}
            <code className="bg-black/30 px-1 rounded">{status.configPath}</code>
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="ClawKeep config TOML"
            className="w-full h-72 rounded-md bg-black/40 border border-white/10 p-3 text-xs font-mono text-gray-100 focus:outline-none focus:border-orange-400"
            spellCheck={false}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="px-3 py-1.5 rounded-md bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-white text-xs font-semibold"
            >
              {saving ? "💾 Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              className="px-3 py-1.5 rounded-md border border-white/10 text-xs text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PathList({ label, items, fallback }: { label: string; items: string[]; fallback?: string }) {
  if (!items.length) {
    return <div className="text-xs text-[var(--text-muted)]">{fallback ?? `${label}: (none)`}</div>;
  }
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <ul className="mt-1 space-y-0.5">
        {items.map((p, idx) => (
          <li key={`${idx}-${p}`} className="text-xs font-mono text-gray-200">
            {p}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BackupResultCard({ result }: { result: BackupResponse }) {
  const tail = result.stderrTail || result.stdoutTail || "(no output)";
  return (
    <div
      className={`${CARD} ${
        result.ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5"
      }`}
    >
      <h2 className="font-semibold">
        {result.ok ? "✅ Backup ok" : `❌ Failed (exit ${result.exitCode})`}
      </h2>
      <pre className="mt-2 text-[11px] font-mono text-gray-200/90 whitespace-pre-wrap max-h-48 overflow-auto bg-black/30 p-2 rounded">
        {tail}
      </pre>
    </div>
  );
}
