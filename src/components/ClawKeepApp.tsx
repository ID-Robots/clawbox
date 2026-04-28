"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
  url: string;
  state: string;
}

interface PairStatusResponse {
  status: "idle" | "pending" | "complete" | "error";
  error: string | null;
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
  const [pairAuthUrl, setPairAuthUrl] = useState<string | null>(null);
  // Tracks whether we're waiting on the portal handoff. Drives the
  // /pair/status poll while the popup is open.
  const [pairWaiting, setPairWaiting] = useState(false);
  const popupRef = useRef<Window | null>(null);

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

  // Listen for the postMessage the /pair/callback page sends to
  // window.opener. Mirrors AIModelsStep.tsx's "clawbox-clawai-auth" handler.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!event.data || typeof event.data !== "object") return;
      if ((event.data as { type?: string }).type !== "clawbox-clawkeep-auth") return;
      const data = event.data as { status?: "complete" | "error"; message?: string };
      setPairWaiting(false);
      setPairAuthUrl(null);
      if (data.status === "complete") {
        setError(null);
        void refresh();
      } else {
        setError(data.message || "ClawKeep pairing failed");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [refresh]);

  // Fallback poll: postMessage can fail to reach us if the popup was
  // blocked or the user closed it before the redirect landed. Walk the
  // server-side session state every 2s while we think pairing is active.
  useEffect(() => {
    if (!pairWaiting) return;
    const id = window.setInterval(() => {
      void (async () => {
        try {
          const ps = await jsonOrError<PairStatusResponse>(
            await fetch("/setup-api/clawkeep/pair/status", { cache: "no-store" }),
          );
          if (ps.status === "complete") {
            setPairWaiting(false);
            setPairAuthUrl(null);
            await refresh();
          } else if (ps.status === "error") {
            setPairWaiting(false);
            setPairAuthUrl(null);
            setError(ps.error || "ClawKeep pairing failed");
          } else if (ps.status === "idle") {
            // Session was cleared server-side (expired). Treat as cancellation.
            setPairWaiting(false);
            setPairAuthUrl(null);
          }
        } catch {
          /* swallow — next tick retries */
        }
      })();
    }, 2000);
    return () => window.clearInterval(id);
  }, [pairWaiting, refresh]);

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
      setPairAuthUrl(start.url);
      popupRef.current = window.open(start.url, "clawkeep-pair", "noopener,noreferrer");
      // Even if popup-blocked, we keep the URL on screen so the user can
      // open it manually and pairing still completes via the same callback.
      setPairWaiting(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }, []);

  const onUnpair = useCallback(async () => {
    if (!confirm("Unpair this device from the portal? Local backup history is kept.")) return;
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
          <p className="text-red-300">Couldn&apos;t load ClawKeep status.</p>
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
              {busy === "unpair" ? "Unpairing…" : "Unpair"}
            </button>
          )}
        </header>

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {status.paired ? (
          <DashboardCard status={status} onBackup={onBackup} busy={busy === "backup"} />
        ) : (
          <PairCard
            onPair={onPair}
            busy={busy === "pair"}
            waiting={pairWaiting}
            authUrl={pairAuthUrl}
          />
        )}

        {(!status.resticInstalled || !status.daemonInstalled) && <SystemCard status={status} />}

        <ConfigCard
          status={status}
          onSaved={refresh}
          onError={setError}
          onBusyChange={(v) => setBusy(v ? "save" : "")}
        />

        {backupResult && <BackupResultCard result={backupResult} />}
      </div>
    </div>
  );
}

function PairCard({
  onPair,
  busy,
  waiting,
  authUrl,
}: {
  onPair: () => void;
  busy: boolean;
  waiting: boolean;
  authUrl: string | null;
}) {
  return (
    <div className={`${CARD} space-y-3`}>
      <h2 className="font-semibold">Pair this device</h2>
      <p className="text-sm text-[var(--text-muted)]">
        Connect to your portal account so this device can mint short-lived R2 credentials and back up to your ClawKeep storage.
      </p>
      <button
        type="button"
        onClick={onPair}
        disabled={busy || waiting}
        className="px-3 py-2 rounded-md bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-white text-sm font-semibold"
      >
        {busy ? "Opening portal…" : waiting ? "Waiting for approval…" : "Pair with portal"}
      </button>
      {waiting && authUrl && (
        <p className="text-xs text-[var(--text-muted)]">
          Approve in the portal tab. If it didn&apos;t open,{" "}
          <a href={authUrl} target="_blank" rel="noreferrer" className="underline text-orange-300">
            click here
          </a>
          .
        </p>
      )}
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
        disabled={busy || !status.daemonInstalled || !status.resticInstalled}
        className="px-3 py-2 rounded-md bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-white text-sm font-semibold"
      >
        {busy ? "Backing up…" : "Back up now"}
      </button>
      {busy && (
        <p className="text-xs text-[var(--text-muted)]">
          Running restic. This can take minutes on a fresh repo — keep this tab open.
        </p>
      )}
    </div>
  );
}

function SystemCard({ status }: { status: ClawKeepStatus }) {
  return (
    <div className={`${CARD} space-y-2 border-amber-500/20 bg-amber-500/5`}>
      <h2 className="font-semibold text-amber-200">Setup needed</h2>
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
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              className="px-3 py-1.5 rounded-md border border-white/10 text-xs text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <span className="text-[10px] text-[var(--text-muted)]">
              Edit as TOML — schema documented in clawkeep-plan.md §7.
            </span>
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
        {result.ok ? "Backup ok" : `Backup failed (exit ${result.exitCode})`}
      </h2>
      <pre className="mt-2 text-[11px] font-mono text-gray-200/90 whitespace-pre-wrap max-h-48 overflow-auto bg-black/30 p-2 rounded">
        {tail}
      </pre>
    </div>
  );
}
