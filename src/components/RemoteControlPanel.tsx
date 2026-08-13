"use client";

import { useCallback, useEffect, useState } from "react";
import StatusMessage from "./StatusMessage";
import { useT } from "@/lib/i18n";
import { copyToClipboard } from "@/lib/clipboard";
import { SettingsGroup, SettingsTextField } from "./settings";

/* ── M3 button recipes ──────────────────────────────────────────────────────
   Colour here comes ONLY from the `--set-*` roles declared on `.settings-pane`
   in globals.css — this panel used to hand-type `bg-white/[0.04]`,
   `hover:bg-orange-500`, `border-green-500/30` and friends, and an overlay like
   that ignores whatever palette is under it. A state layer is the on-colour
   composited over its own container at 8% (hover) / 12% (pressed), so every
   button below re-tints itself for free under `[data-agent="hermes"]`.

   Radius is 22px = a true pill at the 44px minimum target; every other radius
   in this file is on the 4/8/12/16/28 scale. Each string is written out in full
   (rather than assembled at runtime) so Tailwind's source scanner sees it. */
const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]";
const BTN_BASE =
  `inline-flex min-h-[44px] cursor-pointer items-center justify-center gap-[8px] rounded-[22px] border-none px-[16px] text-[14px] font-medium leading-[1.2] no-underline transition-colors ${FOCUS_RING} disabled:cursor-not-allowed`;
/** The one primary action of a state: Install, Start. */
const BTN_FILLED =
  `${BTN_BASE} bg-[var(--set-primary)] text-[var(--set-on-primary)] hover:bg-[color-mix(in_srgb,var(--set-on-primary)_8%,var(--set-primary))] active:bg-[color-mix(in_srgb,var(--set-on-primary)_12%,var(--set-primary))] disabled:bg-[color-mix(in_srgb,var(--set-on-surface)_12%,transparent)] disabled:text-[color-mix(in_srgb,var(--set-on-surface)_38%,transparent)]`;
/** Neutral secondary action inside a group: Copy, Regenerate. */
const BTN_TONAL =
  `${BTN_BASE} bg-[var(--set-secondary-container)] text-[var(--set-on-secondary-container)] hover:bg-[color-mix(in_srgb,var(--set-on-secondary-container)_8%,var(--set-secondary-container))] active:bg-[color-mix(in_srgb,var(--set-on-secondary-container)_12%,var(--set-secondary-container))] disabled:opacity-40`;
/** Coral-tinted secondary action — still ACTION, but not the primary one. */
const BTN_TONAL_PRIMARY =
  `${BTN_BASE} bg-[color-mix(in_srgb,var(--set-primary)_14%,transparent)] text-[var(--set-primary)] hover:bg-[color-mix(in_srgb,var(--set-primary)_22%,transparent)] active:bg-[color-mix(in_srgb,var(--set-primary)_28%,transparent)]`;
/** Quiet action that turns something off. Neutral at rest, error on hover —
    exactly the intent the old `hover:text-red-300` carried. */
const BTN_QUIET_DANGER =
  `${BTN_BASE} bg-transparent text-[var(--set-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--set-error)_14%,transparent)] hover:text-[var(--set-error)] active:bg-[color-mix(in_srgb,var(--set-error)_20%,transparent)] disabled:opacity-40`;
/** Same statement as BTN_QUIET_DANGER, but it stands alone under the running
    card rather than inside a group, so it needs its own tonal plate. Spelled as
    a separate constant instead of `${BTN_QUIET_DANGER} bg-…` because two
    background utilities on one element resolve by CSS order, not class order. */
const BTN_STOP =
  `${BTN_BASE} bg-[var(--set-surface-container)] text-[var(--set-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--set-error)_14%,transparent)] hover:text-[var(--set-error)] active:bg-[color-mix(in_srgb,var(--set-error)_20%,transparent)] disabled:opacity-40`;

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
  // Inline autoinstall — replaces the old "run sudo bash install.sh ..."
  // warning text with a one-click button. Posts to the generic install
  // runner which spawns clawbox-root-update@cloudflared_install.service.
  // The handler itself is defined further down — after `fetchStatus` is
  // declared — so its useCallback dependency array doesn't hit the TDZ.
  const [installState, setInstallState] = useState<"idle" | "installing" | "failed">("idle");
  const [installError, setInstallError] = useState<string | null>(null);

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

    // Continuous loop: always reschedule, just adjust cadence by current
    // state. 2 s while the tunnel is mid-startup (active/activating with
    // no URL yet), 15 s otherwise (URL is showing, OR the tunnel is in a
    // terminal non-running state where nothing will change without user
    // action). The previous version exited polling whenever the service
    // wasn't already active — so if you opened Remote Access *before*
    // clicking Start, the loop stopped, then clicking Start transitioned
    // the service to active+no-URL without re-arming polling, and the
    // URL never appeared in the UI until manual page reload.
    const loop = async () => {
      const s = await fetchStatus();
      if (!alive) return;
      setLoading(false);
      const svc = s?.tunnel.service;
      const stillNegotiating = !s?.tunnel.url && (svc === "active" || svc === "activating");
      timer = setTimeout(loop, stillNegotiating ? POLL_INTERVAL_MS : 15_000);
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

  const handleInstallTunnel = useCallback(async () => {
    setInstallError(null);
    setInstallState("installing");
    try {
      const res = await fetch("/setup-api/install/run-step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "cloudflared_install" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setInstallError(data?.error || `cloudflared_install failed (HTTP ${res.status})`);
        setInstallState("failed");
        return;
      }
      // Cloudflared is just a binary install — no reboot needed. Refresh
      // status so the UI flips out of the "not installed" branch as soon
      // as portal/status sees the new binary.
      setInstallState("idle");
      await fetchStatus();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : "Install request failed");
      setInstallState("failed");
    }
  }, [fetchStatus]);

  const copyUrl = async () => {
    if (!status?.tunnel.url) return;
    // Use the shared helper — it tries `navigator.clipboard.writeText`
    // first (only works on https/localhost), then falls back to the
    // legacy textarea + execCommand path that *does* work on plain
    // http origins like http://clawbox.local. Without the fallback the
    // device's own LAN URL would always show "browser blocked clipboard
    // access" because the secure-context check rejects the modern API.
    const ok = await copyToClipboard(status.tunnel.url);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setError(t("remoteControl.copyFailed"));
    }
  };

  if (loading && !status) {
    return (
      <div className="max-w-xl">
        <SettingsGroup divided={false}>
          <div className="animate-pulse px-[16px] py-[16px]">
            {/* `max-w-full` on the wide bar: at 360px the group's content box is
                ~296px, so a fixed 256px bar is fine today — but the pane is a
                resizable window on desktop and the cap costs nothing. */}
            <div className="mb-[12px] h-[16px] w-[160px] max-w-full rounded-[4px] bg-[var(--set-state-pressed)]" />
            <div className="h-[12px] w-[256px] max-w-full rounded-[4px] bg-[var(--set-state-hover)]" />
          </div>
        </SettingsGroup>
      </div>
    );
  }

  const tunnelInstalled = status?.tunnel.installed ?? false;
  const svc = status?.tunnel.service ?? "unknown";
  const url = status?.tunnel.url ?? null;
  const isRunning = svc === "active" && !!url;
  const isStarting = (svc === "active" || svc === "activating") && !url;
  const busy = action !== "idle";

  const journalCmd = "journalctl -u clawbox-tunnel";

  /* The 40px status disc every state opens with. A tonal circle, not a
     `bg-white/5` overlay, and it matches the one the migrated Network section
     draws for its connection row. */
  const disc = (icon: string, tint: "neutral" | "success") => (
    <span
      className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-full"
      style={{
        backgroundColor:
          tint === "success"
            ? "color-mix(in srgb, var(--set-success) 16%, transparent)"
            : "var(--set-state-hover)",
      }}
    >
      <span
        className={
          tint === "success"
            ? "material-symbols-rounded text-[var(--set-success)]"
            : "material-symbols-rounded text-[var(--set-on-surface-variant)]"
        }
        style={{ fontSize: 22 }}
        aria-hidden="true"
      >
        {icon}
      </span>
    </span>
  );

  return (
    /* Root stays a single `max-w-xl` div: the desktop shell centres the pane
       with `[&>div]:mx-auto [&>div]:w-full` on DIRECT children, so an extra
       wrapper or a second root sibling would break centring. Gutters are the
       pane's own (24px desktop / 16px mobile), which is why nothing below
       carries a viewport breakpoint — every reflow here is container-driven so
       it behaves the same in a narrow desktop window and on a 360px phone. */
    <div className="max-w-xl space-y-[16px]">
      <div>
        <h2 className="text-[16px] font-medium leading-[1.3] text-[var(--set-on-surface)]">{t("remoteControl.title")}</h2>
        <p className="mt-[4px] text-[12px] leading-[1.4] text-[var(--set-on-surface-variant)]">{t("remoteControl.subtitle")}</p>
      </div>

      {error && <StatusMessage type="error" message={error} />}

      {!tunnelInstalled && (
        <SettingsGroup divided={false}>
          <div className="flex items-start gap-[16px] px-[16px] py-[12px]">
            {disc("download", "neutral")}
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium leading-[1.3] text-[var(--set-on-surface)]">{t("remoteControl.tunnelNotInstalled")}</div>
              <div className="mt-[2px] text-[12px] leading-[1.4] text-[var(--set-on-surface-variant)]">{t("remoteControl.tunnelInstallDesc")}</div>
            </div>
          </div>
          {installError && (
            /* `whitespace-pre-wrap` is load-bearing — this is a multi-line
               journal tail. `break-words` is the 360px half of that: without it
               a long unbroken systemd token pushes the pane sideways. */
            <p
              role="alert"
              aria-atomic="true"
              className="whitespace-pre-wrap break-words px-[16px] pb-[8px] text-[12px] leading-[1.4] text-[var(--set-error)]"
            >
              {installError}
            </p>
          )}
          <div className="px-[16px] pb-[12px] pt-[4px]">
            <button
              type="button"
              onClick={handleInstallTunnel}
              disabled={installState === "installing"}
              className={`${BTN_FILLED} w-full`}
            >
              {installState === "installing" ? (
                <>
                  <span className="material-symbols-rounded animate-spin" style={{ fontSize: 16 }}>progress_activity</span>
                  {t("remoteControl.tunnelInstalling")}
                </>
              ) : (
                <>
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>download</span>
                  {t("remoteControl.tunnelInstallButton")}
                </>
              )}
            </button>
          </div>
        </SettingsGroup>
      )}

      {/* Not started */}
      {tunnelInstalled && svc !== "active" && svc !== "activating" && (
        <SettingsGroup divided={false}>
          <div className="flex items-start gap-[16px] px-[16px] py-[12px]">
            {disc("cloud_off", "neutral")}
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium leading-[1.3] text-[var(--set-on-surface)]">{t("remoteControl.offTitle")}</div>
              <div className="mt-[2px] text-[12px] leading-[1.4] text-[var(--set-on-surface-variant)]">{t("remoteControl.offDesc")}</div>
            </div>
          </div>
          <div className="px-[16px] pb-[12px] pt-[4px]">
            <button
              onClick={handleStart}
              disabled={busy}
              className={`${BTN_FILLED} w-full`}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">play_arrow</span>
              {action === "starting" ? t("remoteControl.starting") : t("remoteControl.start")}
            </button>
          </div>
        </SettingsGroup>
      )}

      {/* Starting */}
      {tunnelInstalled && isStarting && (
        /* The old card announced "in progress" with a coral OUTLINE. In M3 the
           progress indicator is the statement, so the container stays the same
           neutral tonal plate as every other state and the coral lives in the
           spinner. */
        <SettingsGroup divided={false}>
          <div className="flex flex-col items-center gap-[8px] px-[16px] py-[20px] text-center">
            <div className="inline-flex items-center gap-[12px] text-[14px] text-[var(--set-on-surface)]">
              <span className="h-[16px] w-[16px] shrink-0 animate-spin rounded-full border-2 border-[var(--set-primary)] border-t-transparent" aria-hidden="true" />
              {t("remoteControl.negotiating")}
            </div>
            <div className="text-[12px] leading-[1.4] text-[var(--set-on-surface-variant)]">{t("remoteControl.negotiatingHint")}</div>
            <button
              onClick={handleStop}
              disabled={busy}
              className={`${BTN_QUIET_DANGER} mt-[4px]`}
            >
              {action === "stopping" ? t("remoteControl.stopping") : t("remoteControl.cancel")}
            </button>
          </div>
        </SettingsGroup>
      )}

      {/* Running */}
      {isRunning && (
        <>
          <SettingsGroup divided={false}>
            <div className="flex items-start gap-[16px] px-[16px] py-[12px]">
              {disc("cloud_done", "success")}
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium leading-[1.3] text-[var(--set-on-surface)]">{t("remoteControl.onlineTitle")}</div>
                <div className="mt-[4px] flex items-center gap-[6px]">
                  <span aria-hidden="true" className="h-[6px] w-[6px] shrink-0 animate-pulse rounded-full bg-[var(--set-success)]" />
                  <span className="text-[12px] leading-[1.4] text-[var(--set-on-surface-variant)]">{t("remoteControl.onlineDesc")}</span>
                </div>
              </div>
            </div>

            <div className="px-[16px] pb-[12px]">
              {/* Still NO `htmlFor`, deliberately: the input's accessible name
                  comes solely from its `aria-label`, and adding an association
                  here would change what the field announces. */}
              <label className="mb-[8px] block text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--set-on-surface-variant)]">
                {t("remoteControl.tunnelUrlLabel")}
              </label>
              {/* `flex-wrap` instead of the old fixed row: at 360px the field
                  keeps its 160px floor and the Copy button drops to its own
                  line rather than squeezing the URL to nothing. */}
              <div className="flex flex-wrap items-center gap-[8px]">
                <SettingsTextField
                  readOnly
                  value={url!}
                  /* The last un-declared text input inside the Settings pane.
                     It holds a tunnel URL, never an identity, and it is
                     focused on purpose (the select-all below) — exactly the
                     event a password manager listens for before it opens its
                     autofill tooltip. See the `::backdrop` note in globals.css
                     for what that tooltip used to do to this screen. */
                  autoComplete="off"
                  onFocus={e => e.currentTarget.select()}
                  aria-label={t("remoteControl.tunnelUrlLabel")}
                  className="min-w-[160px] flex-1"
                  inputClassName="font-mono"
                />
                <button
                  onClick={copyUrl}
                  className={`${BTN_TONAL} shrink-0`}
                  aria-label={t("remoteControl.copy")}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">
                    {copied ? "check" : "content_copy"}
                  </span>
                  {copied ? t("remoteControl.copied") : t("remoteControl.copy")}
                </button>
              </div>
            </div>

            {/* Container-driven, NOT `sm:` — this grid lives inside a resizable
                window on desktop and a 16px-gutter pane on a phone, so it has to
                ask its own width: one column at 360/414px, two once the pane can
                actually seat two 180px buttons. */}
            <div
              className="grid gap-[8px] px-[16px] pb-[12px]"
              style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
            >
              <a
                href={`${status?.portalWeb ?? "https://openclawhardware.dev"}/portal/devices`}
                target="_blank"
                rel="noopener noreferrer"
                className={BTN_TONAL_PRIMARY}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">devices</span>
                {t("remoteControl.addDevice")}
                <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">open_in_new</span>
              </a>
              <button
                onClick={handleRegenerate}
                disabled={busy}
                className={BTN_TONAL}
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
          </SettingsGroup>

          <button
            onClick={handleStop}
            disabled={busy}
            className={`${BTN_STOP} w-full`}
          >
            {action === "stopping" ? t("remoteControl.stopping") : t("remoteControl.stop")}
          </button>
        </>
      )}

      {/* Failed */}
      {tunnelInstalled && svc === "failed" && (
        <div
          role="alert"
          aria-live="assertive"
          className="flex flex-wrap gap-[12px] rounded-[16px] px-[16px] py-[12px]"
          style={{ backgroundColor: "color-mix(in srgb, var(--set-error) 10%, transparent)" }}
        >
          <span className="material-symbols-rounded shrink-0 text-[var(--set-error)]" style={{ fontSize: 20 }} aria-hidden="true">error</span>
          <div className="min-w-[160px] flex-1 text-[14px] leading-[1.45] text-[var(--set-on-surface)]">
            <strong className="mb-[4px] block">{t("remoteControl.failedTitle")}</strong>
            {t("remoteControl.failedDesc", { command: journalCmd }).split(journalCmd).map((seg, i, arr) => (
              <span key={i}>
                {seg}
                {i < arr.length - 1 && (
                  <code
                    className="rounded-[4px] px-[4px] py-[2px] font-mono text-[12px] break-words"
                    style={{ backgroundColor: "color-mix(in srgb, var(--set-on-surface) 12%, transparent)" }}
                  >
                    {journalCmd}
                  </code>
                )}
              </span>
            ))}
          </div>
          <button
            onClick={handleStart}
            disabled={busy}
            className={`${BTN_BASE} shrink-0 self-start bg-transparent px-[12px] text-[var(--set-error)] hover:bg-[color-mix(in_srgb,var(--set-error)_16%,transparent)] active:bg-[color-mix(in_srgb,var(--set-error)_22%,transparent)] disabled:opacity-40`}
          >
            {t("remoteControl.retry")}
          </button>
        </div>
      )}
    </div>
  );
}
