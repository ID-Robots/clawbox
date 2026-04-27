"use client";

import { useCallback, useEffect, useState } from "react";
import StatusMessage from "./StatusMessage";
import { useT } from "@/lib/i18n";

interface TunnelInfo {
  installed: boolean;
  service: "active" | "inactive" | "failed" | "activating" | "unknown";
  url: string | null;
}

interface StatusResponse {
  tunnel: TunnelInfo;
  portalAddDeviceUrl: string;
  portalWeb: string;
}

const POLL_INTERVAL_MS = 2_000;

export default function RemoteControlPanel() {
  const { t } = useT();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"idle" | "starting" | "stopping" | "regenerating">("idle");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchStatus = useCallback(async (): Promise<StatusResponse | null> => {
    try {
      const res = await fetch("/setup-api/portal/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data = await res.json() as StatusResponse;
      setStatus(data);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("remoteControl.loadFailed"));
      return null;
    }
  }, [t]);

  const readErrorMessage = useCallback(async (res: Response, fallback: string) => {
    const body = (await res.text()).trim();
    if (!body) return fallback;
    try {
      const data = JSON.parse(body) as { error?: string; message?: string };
      if (typeof data.error === "string" && data.error.trim()) return data.error;
      if (typeof data.message === "string" && data.message.trim()) return data.message;
    } catch {
      if (!body.startsWith("<")) return body;
    }
    return fallback;
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const loop = async () => {
      const s = await fetchStatus();
      if (!alive) return;
      setLoading(false);
      const svc = s?.tunnel.service;
      const needsPoll = !s?.tunnel.url && (svc === "active" || svc === "activating");
      if (needsPoll) {
        timer = setTimeout(loop, POLL_INTERVAL_MS);
      } else if (svc === "active") {
        timer = setTimeout(loop, 15_000);
      }
    };
    loop();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [fetchStatus]);

  const handleStart = async () => {
    setAction("starting");
    setError(null);
    try {
      const res = await fetch("/setup-api/portal/start", { method: "POST" });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, t("remoteControl.startFailed")));
      }
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("remoteControl.startFailed"));
    } finally {
      setAction("idle");
    }
  };

  // Restart cloudflared so it negotiates a fresh *.trycloudflare.com host. The
  // device-side heartbeat hook then auto-pushes the new URL to the portal on
  // the next status poll, so the user never has to copy/paste again.
  const handleRegenerate = async () => {
    setAction("regenerating");
    setError(null);
    // Optimistically clear the URL so the UI flips to the "negotiating" state
    // without waiting for the next poll to observe it.
    setStatus(prev => prev ? { ...prev, tunnel: { ...prev.tunnel, url: null } } : prev);
    try {
      const res = await fetch("/setup-api/portal/start", { method: "POST" });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, t("remoteControl.startFailed")));
      }
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("remoteControl.startFailed"));
    } finally {
      setAction("idle");
    }
  };

  const handleStop = async () => {
    setAction("stopping");
    setError(null);
    try {
      const res = await fetch("/setup-api/portal/stop", { method: "POST" });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, t("remoteControl.stopFailed")));
      }
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("remoteControl.stopFailed"));
    } finally {
      setAction("idle");
    }
  };

  const copyUrl = async () => {
    if (!status?.tunnel.url) return;
    try {
      await navigator.clipboard.writeText(status.tunnel.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t("remoteControl.copyFailed"));
    }
  };

  if (loading && !status) {
    return (
      <div className="max-w-xl">
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5 animate-pulse">
          <div className="h-4 w-40 rounded bg-white/[0.08] mb-3" />
          <div className="h-3 w-64 rounded bg-white/[0.06]" />
        </div>
      </div>
    );
  }

  const tunnelInstalled = status?.tunnel.installed ?? false;
  const svc = status?.tunnel.service ?? "unknown";
  const url = status?.tunnel.url ?? null;
  const isRunning = svc === "active" && !!url;
  const isStarting = (svc === "active" || svc === "activating") && !url;
  const busy = action !== "idle";

  const installCmd = "sudo bash install.sh --step cloudflared_install";
  const journalCmd = "journalctl -u clawbox-tunnel";

  return (
    <div className="max-w-xl space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-1">{t("remoteControl.title")}</h2>
        <p className="text-sm text-[var(--text-muted)]">{t("remoteControl.subtitle")}</p>
      </div>

      {error && <StatusMessage type="error" message={error} />}

      {!tunnelInstalled && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] p-4 flex gap-3"
        >
          <span className="material-symbols-rounded text-amber-400 shrink-0" style={{ fontSize: 20 }} aria-hidden="true">warning</span>
          <div className="text-sm text-amber-100/90">
            <strong className="block mb-1">{t("remoteControl.tunnelNotInstalled")}</strong>
            {t("remoteControl.tunnelNotInstalledDesc", { command: installCmd }).split(installCmd).map((seg, i, arr) => (
              <span key={i}>
                {seg}
                {i < arr.length - 1 && <code className="px-1 py-0.5 bg-black/30 rounded text-xs">{installCmd}</code>}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Not started */}
      {tunnelInstalled && svc !== "active" && svc !== "activating" && (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
          <div className="flex items-start gap-4 mb-5">
            <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
              <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 22 }} aria-hidden="true">cloud_off</span>
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium text-[var(--text-primary)] mb-0.5">{t("remoteControl.offTitle")}</div>
              <div className="text-xs text-[var(--text-muted)]">{t("remoteControl.offDesc")}</div>
            </div>
          </div>
          <button
            onClick={handleStart}
            disabled={busy}
            className="w-full px-4 py-3 bg-[var(--coral-bright)] hover:bg-orange-500 disabled:bg-white/10 disabled:text-[var(--text-muted)] disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors border-none cursor-pointer flex items-center justify-center gap-2"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">play_arrow</span>
            {action === "starting" ? t("remoteControl.starting") : t("remoteControl.start")}
          </button>
        </div>
      )}

      {/* Starting */}
      {tunnelInstalled && isStarting && (
        <div className="rounded-2xl border border-[var(--coral-bright)]/40 bg-[var(--surface-card)] p-5 text-center">
          <div className="inline-flex items-center gap-3 text-sm text-[var(--text-secondary)]">
            <span className="w-4 h-4 border-2 border-[var(--coral-bright)] border-t-transparent rounded-full animate-spin" aria-hidden="true" />
            {t("remoteControl.negotiating")}
          </div>
          <div className="text-xs text-[var(--text-muted)] mt-2">{t("remoteControl.negotiatingHint")}</div>
          <button
            onClick={handleStop}
            disabled={busy}
            className="mt-4 text-xs text-[var(--text-muted)] hover:text-red-300 bg-transparent border-none cursor-pointer underline underline-offset-2"
          >
            {action === "stopping" ? t("remoteControl.stopping") : t("remoteControl.cancel")}
          </button>
        </div>
      )}

      {/* Running */}
      {isRunning && (
        <>
          <div className="rounded-2xl border border-green-500/30 bg-green-500/[0.06] p-5">
            <div className="flex items-start gap-4 mb-4">
              <div className="w-10 h-10 rounded-full bg-green-500/15 flex items-center justify-center shrink-0">
                <span className="material-symbols-rounded text-green-400" style={{ fontSize: 22 }} aria-hidden="true">cloud_done</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-[var(--text-primary)] mb-0.5">{t("remoteControl.onlineTitle")}</div>
                <div className="flex items-center gap-1.5 mt-1">
                  <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  <span className="text-xs text-[var(--text-muted)]">{t("remoteControl.onlineDesc")}</span>
                </div>
              </div>
            </div>

            <label className="block text-[10px] uppercase tracking-widest font-semibold text-[var(--text-muted)] mb-2">
              {t("remoteControl.tunnelUrlLabel")}
            </label>
            <div className="flex items-center gap-2 mb-3">
              <input
                readOnly
                value={url!}
                className="flex-1 bg-black/40 border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm font-mono text-[var(--text-primary)] focus:outline-none focus:border-[var(--coral-bright)]/40"
                onFocus={e => e.currentTarget.select()}
                aria-label={t("remoteControl.tunnelUrlLabel")}
              />
              <button
                onClick={copyUrl}
                className="shrink-0 px-3 py-2.5 bg-white/[0.04] hover:bg-white/[0.08] rounded-lg text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-none cursor-pointer flex items-center gap-1.5 transition-colors"
                aria-label={t("remoteControl.copy")}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">
                  {copied ? "check" : "content_copy"}
                </span>
                {copied ? t("remoteControl.copied") : t("remoteControl.copy")}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <a
                href={`${status?.portalWeb ?? "https://openclawhardware.dev"}/portal/devices`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-[var(--coral-bright)]/15 hover:bg-[var(--coral-bright)]/25 border border-[var(--coral-bright)]/40 rounded-lg text-sm font-semibold text-[var(--coral-bright)] hover:text-orange-200 transition-colors no-underline"
              >
                <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">devices</span>
                {t("remoteControl.checkDevices")}
                <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">open_in_new</span>
              </a>
              <button
                onClick={handleRegenerate}
                disabled={busy}
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-white/[0.04] hover:bg-white/[0.08] disabled:bg-white/[0.02] disabled:text-[var(--text-muted)] disabled:cursor-not-allowed border border-white/[0.08] rounded-lg text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
              >
                <span
                  className={`material-symbols-rounded ${action === "regenerating" ? "animate-spin" : ""}`}
                  style={{ fontSize: 16 }}
                  aria-hidden="true"
                >
                  refresh
                </span>
                {action === "regenerating" ? t("remoteControl.regenerating") : t("remoteControl.regenerate")}
              </button>
            </div>
          </div>

          <button
            onClick={handleStop}
            disabled={busy}
            className="w-full px-4 py-2.5 bg-white/5 hover:bg-red-500/15 hover:text-red-300 text-[var(--text-secondary)] rounded-lg transition-colors border-none cursor-pointer text-sm"
          >
            {action === "stopping" ? t("remoteControl.stopping") : t("remoteControl.stop")}
          </button>
        </>
      )}

      {/* Failed */}
      {tunnelInstalled && svc === "failed" && (
        <div role="alert" aria-live="assertive" className="rounded-xl border border-red-500/30 bg-red-500/[0.08] p-4 flex gap-3">
          <span className="material-symbols-rounded text-red-400 shrink-0" style={{ fontSize: 20 }} aria-hidden="true">error</span>
          <div className="text-sm text-red-100/90 flex-1">
            <strong className="block mb-1">{t("remoteControl.failedTitle")}</strong>
            {t("remoteControl.failedDesc", { command: journalCmd }).split(journalCmd).map((seg, i, arr) => (
              <span key={i}>
                {seg}
                {i < arr.length - 1 && <code className="px-1 py-0.5 bg-black/30 rounded text-xs">{journalCmd}</code>}
              </span>
            ))}
          </div>
          <button
            onClick={handleStart}
            disabled={busy}
            className="shrink-0 self-start text-xs text-red-300 hover:text-red-200 bg-transparent border-none cursor-pointer underline underline-offset-2"
          >
            {t("remoteControl.retry")}
          </button>
        </div>
      )}
    </div>
  );
}
