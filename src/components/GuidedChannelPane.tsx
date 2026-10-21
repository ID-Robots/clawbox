"use client";

// The Settings pane for the guided channels (Slack, …): a live status card, a
// pairing-code approval for new senders, and the setup card with the channel's
// own steps and credential fields.
//
// One component for every such channel, driven by CHANNEL_SPECS, so the
// channels cannot drift apart in how they report a save or a status. The hub
// row and its status read live in SettingsApp; this pane gets the status it
// already holds and asks for a re-read after every change.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import StatusMessage from "./StatusMessage";
import { useT } from "@/lib/i18n";
import { copyToClipboard } from "@/lib/clipboard";

export type GuidedChannel = "slack" | "signal" | "msteams";

export const GUIDED_CHANNEL_IDS: readonly GuidedChannel[] = ["slack", "signal", "msteams"];

/** Guided channels that ship switched off (CLAWBOX_PREVIEW_CHANNELS turns them on). */
export const PREVIEW_GUIDED_CHANNELS: readonly GuidedChannel[] = ["signal", "msteams"];

/** What /setup-api/<channel>/status answers, narrowed. */
export interface GuidedChannelStatus {
  configured: boolean;
  /**
   * "connected" / "offline"; "listening" for a channel the service delivers
   * to (the box is up, whether the service reaches it is not visible here);
   * null when the harness could not be asked.
   */
  state: "connected" | "listening" | "offline" | null;
  /** True only when the channel is genuinely up; null when nobody could be asked. */
  receiving: boolean | null;
  tokenRejected: boolean;
  tokenUnresolved: boolean;
  team: string | null;
  botName: string | null;
  /** The channel's own account id where it has one (Signal's number). */
  account: string | null;
  /** Something the box itself lacks for this channel (signal-cli for Signal). */
  prerequisiteMissing: boolean;
  /** Where on the box a delivering service must reach (Teams). */
  endpoint: { path: string; port: number } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Narrow a status payload; anything unexpected reads as "not configured". */
export function toGuidedChannelStatus(data: unknown): GuidedChannelStatus {
  const d = isRecord(data) ? data : {};
  return {
    configured: d.configured === true,
    state: d.state === "connected" || d.state === "listening" || d.state === "offline" ? d.state : null,
    receiving: typeof d.receiving === "boolean" ? d.receiving : null,
    tokenRejected: d.tokenRejected === true,
    tokenUnresolved: d.tokenUnresolved === true,
    team: optionalText(d.team),
    botName: optionalText(d.botName),
    account: optionalText(d.account),
    prerequisiteMissing: d.signalCli === false,
    endpoint: toEndpoint(d.endpoint),
  };
}

function toEndpoint(value: unknown): { path: string; port: number } | null {
  if (!isRecord(value)) return null;
  const { path, port } = value;
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { path, port };
}

interface FieldSpec {
  /** Key in the configure request body. */
  name: string;
  labelKey: string;
  /** A shape hint, never a translation (token prefixes, ids). */
  placeholder: string;
  secret: boolean;
}

interface StepSpec {
  key: string;
  link?: { href: string; labelKey: string };
}

interface ChannelSpec {
  /** "fields": paste credentials. "signal-link": scan a QR code from a phone. */
  setup: "fields" | "signal-link";
  labelKey: string;
  icon: string;
  accent: string;
  guideTitleKey: string;
  steps: StepSpec[];
  fields: FieldSpec[];
  /** A reassurance shown under the steps (e.g. Socket Mode needs no public address). */
  noteKey?: string;
  /** Offer the app manifest from /setup-api/<channel>/manifest. */
  manifest?: { titleKey: string; copyKey: string; copiedKey: string };
  /** Save codes with a channel-specific message; the rest are shared. */
  codeKeys: Record<string, string>;
  /** Shown instead of the setup when the box lacks what the channel needs. */
  prerequisiteKey?: string;
  /** How the status card names the account (`{account}`), where there is one. */
  accountKey?: string;
  /** What a successful save says, where "connected" would overclaim. */
  successKey?: string;
  /** Explains the endpoint a delivering service must reach (`{port}`, `{path}`). */
  endpointKey?: string;
}

const CHANNEL_SPECS: Record<GuidedChannel, ChannelSpec> = {
  slack: {
    setup: "fields",
    labelKey: "settings.slack",
    icon: "tag",
    accent: "#E01E5A",
    guideTitleKey: "settings.slackGuideTitle",
    steps: [
      { key: "settings.slackStep1", link: { href: "https://api.slack.com/apps", labelKey: "settings.slackOpenApps" } },
      { key: "settings.slackStep2" },
      { key: "settings.slackStep3" },
      { key: "settings.slackStep4" },
    ],
    fields: [
      { name: "botToken", labelKey: "settings.slackBotToken", placeholder: "xoxb-…", secret: true },
      { name: "appToken", labelKey: "settings.slackAppToken", placeholder: "xapp-…", secret: true },
    ],
    noteKey: "settings.slackSocketModeNote",
    manifest: {
      titleKey: "settings.slackManifest",
      copyKey: "settings.slackCopyManifest",
      copiedKey: "settings.slackManifestCopied",
    },
    codeKeys: {
      token_format: "settings.slackTokenFormat",
      bot_token_rejected: "settings.slackBotTokenRejected",
      app_token_rejected: "settings.slackAppTokenRejected",
      app_token_scope: "settings.slackAppTokenScope",
      slack_unavailable: "settings.channelServiceUnavailable",
    },
  },
  signal: {
    setup: "signal-link",
    labelKey: "settings.signal",
    icon: "chat_bubble",
    accent: "#3A76F0",
    guideTitleKey: "settings.signalGuideTitle",
    steps: [
      { key: "settings.signalStep1" },
      { key: "settings.signalStep2" },
      { key: "settings.signalStep3" },
    ],
    fields: [{ name: "account", labelKey: "settings.signalAccount", placeholder: "+15551234567", secret: false }],
    codeKeys: {
      account_format: "settings.signalAccountFormat",
      signal_cli_missing: "settings.signalCliMissing",
      signal_cli_unavailable: "settings.channelServiceUnavailable",
      signal_account_unknown: "settings.signalAccountUnknown",
      signal_daemon_unreachable: "settings.signalDaemonUnreachable",
    },
    prerequisiteKey: "settings.signalCliMissing",
    accountKey: "settings.signalNumber",
  },
  msteams: {
    setup: "fields",
    labelKey: "settings.msteams",
    icon: "groups",
    accent: "#6264A7",
    guideTitleKey: "settings.teamsGuideTitle",
    steps: [
      {
        key: "settings.teamsStep1",
        link: { href: "https://portal.azure.com/#create/Microsoft.AzureBot", labelKey: "settings.teamsOpenPortal" },
      },
      { key: "settings.teamsStep2" },
      { key: "settings.teamsStep3" },
      { key: "settings.teamsStep4" },
    ],
    fields: [
      { name: "appId", labelKey: "settings.teamsAppId", placeholder: "00000000-0000-0000-0000-000000000000", secret: false },
      { name: "tenantId", labelKey: "settings.teamsTenantId", placeholder: "00000000-0000-0000-0000-000000000000", secret: false },
      { name: "appPassword", labelKey: "settings.teamsAppPassword", placeholder: "••••••••••••••••", secret: true },
    ],
    codeKeys: {
      id_format: "settings.teamsIdFormat",
      token_format: "settings.teamsSecretRejected",
      secret_rejected: "settings.teamsSecretRejected",
      app_not_found: "settings.teamsAppNotFound",
      tenant_not_found: "settings.teamsTenantNotFound",
      msteams_unavailable: "settings.channelServiceUnavailable",
    },
    accountKey: "settings.teamsAppIdShort",
    successKey: "settings.teamsSaveListening",
    endpointKey: "settings.teamsEndpointHint",
  },
};

/** How often the pane asks whether the phone has scanned the QR code. */
const LINK_POLL_MS = 2_000;

/** Save codes every guided channel shares, and their message keys. */
const SHARED_CODE_KEYS: Record<string, string> = {
  tokens_required: "settings.channelFieldsRequired",
  plugin_install_failed: "settings.channelSavePluginFailed",
  plugin_install_timeout: "settings.channelSavePluginFailed",
  token_unresolved: "settings.channelSaveTokenUnresolved",
  channel_unverified: "settings.channelSaveUnverified",
  not_connected: "settings.channelSaveNotConnected",
  restart_pending: "settings.channelSaveRestartPending",
};

const PAIRING_CODE_KEYS: Record<string, string> = {
  invalid_code: "settings.channelPairingInvalid",
  not_found: "settings.channelPairingNotFound",
  locked_out: "settings.channelPairingLocked",
};

type Notice = { type: "success" | "error" | "info"; message: string } | null;

interface GuidedChannelPaneProps {
  channel: GuidedChannel;
  /** The hub's last read of /setup-api/<channel>/status; null while unread. */
  status: GuidedChannelStatus | null;
  /** Ask the hub to re-read the status (after a save, an approval, or Retry). */
  onRefresh: () => void;
}

export default function GuidedChannelPane({ channel, status, onRefresh }: GuidedChannelPaneProps) {
  const { t } = useT();
  const spec = CHANNEL_SPECS[channel];
  const channelName = t(spec.labelKey);
  const idBase = useId();

  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [reconfigure, setReconfigure] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [approving, setApproving] = useState(false);
  const [pairingNotice, setPairingNotice] = useState<Notice>(null);
  const [manifest, setManifest] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showSetup = status !== null && (!status.configured || reconfigure);

  // The manifest is asked for only while the setup card is on screen: on a
  // Hermes box it is a CLI run.
  useEffect(() => {
    if (!spec.manifest || !showSetup || manifest !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/setup-api/${channel}/manifest`, { cache: "no-store" });
        if (!r.ok) return;
        const d: unknown = await r.json();
        if (!cancelled && isRecord(d) && typeof d.manifest === "string") setManifest(d.manifest);
      } catch {
        // The steps still work without it; the box may be offline.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channel, spec.manifest, showSetup, manifest]);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const codeMessage = useCallback(
    (code: unknown): string | null => {
      if (typeof code !== "string") return null;
      const key = spec.codeKeys[code] ?? SHARED_CODE_KEYS[code];
      return key ? t(key, { channel: channelName }) : null;
    },
    [spec.codeKeys, t, channelName],
  );

  const allFilled = spec.fields.every((f) => (values[f.name] ?? "").trim() !== "");

  const save = () => {
    if (!allFilled) {
      setNotice({ type: "error", message: t("settings.channelFieldsRequired") });
      return;
    }
    void saveBody(Object.fromEntries(spec.fields.map((f) => [f.name, (values[f.name] ?? "").trim()])));
  };

  const saveBody = async (body: Record<string, string>) => {
    if (saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const r = await fetch(`/setup-api/${channel}/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d: unknown = await r.json().catch(() => ({}));
      const data = isRecord(d) ? d : {};
      if (r.ok && data.success === true) {
        setNotice({ type: "success", message: t(spec.successKey ?? "settings.channelSaveConnected") });
        setValues({});
        setReconfigure(false);
      } else {
        const message = codeMessage(data.code) ?? t("settings.channelSaveFailed");
        // A save that wrote but is not live yet is a warning, not a refusal.
        // `token_unresolved` wrote nothing to the harness, so what was typed
        // stays for the next attempt.
        const written = r.ok && data.code !== "token_unresolved";
        setNotice({ type: written ? "info" : "error", message });
        if (written) {
          setValues({});
          setReconfigure(false);
        }
      }
    } catch {
      setNotice({ type: "error", message: t("settings.channelSaveFailed") });
    } finally {
      setSaving(false);
      onRefresh();
    }
  };

  const approve = async () => {
    const code = pairingCode.trim();
    if (!code || approving) return;
    setApproving(true);
    setPairingNotice(null);
    try {
      const r = await fetch(`/setup-api/${channel}/pairing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const d: unknown = await r.json().catch(() => ({}));
      const data = isRecord(d) ? d : {};
      if (r.ok && data.success === true) {
        setPairingCode("");
        setPairingNotice({ type: "success", message: t("settings.channelPairingApproved") });
      } else {
        const key = typeof data.code === "string" ? PAIRING_CODE_KEYS[data.code] : undefined;
        setPairingNotice({ type: "error", message: t(key ?? "settings.channelPairingNotFound") });
      }
    } catch {
      setPairingNotice({ type: "error", message: t("settings.channelSaveFailed") });
    } finally {
      setApproving(false);
    }
  };

  const copyManifest = async () => {
    if (!manifest) return;
    if (await copyToClipboard(manifest)) {
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    }
  };

  // ── Signal: link the box as a device of a phone's account ────────────────
  type LinkView =
    | { state: "idle" }
    | { state: "waiting"; uri: string | null }
    | { state: "linked"; account: string | null }
    | { state: "failed"; reason: string };
  const [link, setLink] = useState<LinkView>({ state: "idle" });
  const linkSaved = useRef(false);

  const readLink = (d: unknown): LinkView => {
    const data = isRecord(d) ? d : {};
    if (data.state === "waiting") return { state: "waiting", uri: optionalText(data.uri) };
    if (data.state === "linked") return { state: "linked", account: optionalText(data.account) };
    if (data.state === "failed") return { state: "failed", reason: optionalText(data.reason) ?? "error" };
    return { state: "idle" };
  };

  const startLink = async () => {
    setNotice(null);
    linkSaved.current = false;
    try {
      const r = await fetch(`/setup-api/${channel}/link`, { method: "POST" });
      const d: unknown = await r.json().catch(() => ({}));
      if (!r.ok) {
        const data = isRecord(d) ? d : {};
        setNotice({ type: "error", message: codeMessage(data.code) ?? t("settings.signalLinkFailed") });
        return;
      }
      setLink(readLink(d));
    } catch {
      setNotice({ type: "error", message: t("settings.signalLinkFailed") });
    }
  };

  const cancelLink = async () => {
    setLink({ state: "idle" });
    try {
      await fetch(`/setup-api/${channel}/link`, { method: "DELETE" });
    } catch {
      // The attempt times out on the box by itself.
    }
  };

  // Poll while a QR code is on screen; stop as soon as the phone answered.
  useEffect(() => {
    if (spec.setup !== "signal-link" || link.state !== "waiting") return;
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`/setup-api/${channel}/link`, { cache: "no-store" });
        if (r.ok) setLink(readLink(await r.json()));
      } catch {
        // keep the code on screen; the next poll asks again
      }
    }, LINK_POLL_MS);
    return () => clearInterval(timer);
  }, [channel, spec.setup, link.state]);

  // Linked: finish the setup with the number signal-cli reported, once. When
  // it reported none, the manual field below takes the number instead.
  const saveBodyRef = useRef(saveBody);
  saveBodyRef.current = saveBody;
  useEffect(() => {
    if (link.state !== "linked" || !link.account || linkSaved.current) return;
    linkSaved.current = true;
    void saveBodyRef.current({ account: link.account });
  }, [link]);

  // Where a delivering service (Teams) must reach the box: the one setting the
  // owner has to make outside ClawBox, so it is shown in both cards.
  const endpointBox =
    spec.endpointKey && status?.endpoint ? (
      <div className="flex items-start gap-2 mt-4 px-3 py-2.5 rounded-lg bg-amber-500/[0.08] border border-amber-500/20" data-testid={`${channel}-endpoint`}>
        <span className="material-symbols-rounded text-amber-400 shrink-0" style={{ fontSize: 18 }} aria-hidden="true">public</span>
        <p className="text-xs text-amber-200/90 m-0 leading-relaxed">
          {t(spec.endpointKey, { port: status.endpoint.port, path: status.endpoint.path })}
        </p>
      </div>
    ) : null;

  // ── Status view: one tone, one icon, one title, one remedy ───────────────
  const view = (() => {
    if (!status) return null;
    if (status.tokenRejected) {
      return {
        tone: "warn" as const,
        icon: "key_off",
        title: t("settings.channelStateRejected", { channel: channelName }),
        hint: t("settings.channelStateRejectedHint"),
      };
    }
    if (status.tokenUnresolved) {
      return {
        tone: "warn" as const,
        icon: "lock_reset",
        title: t("settings.channelStateUnresolved"),
        hint: t("settings.channelStateUnresolvedHint"),
      };
    }
    if (status.state === "connected") {
      return {
        tone: "live" as const,
        icon: "check_circle",
        title: status.botName ?? t("settings.botConnected"),
        hint: t("settings.channelStateConnectedHint"),
      };
    }
    if (status.state === "listening") {
      return {
        tone: "live" as const,
        icon: "hearing",
        title: t("settings.channelStateListening", { channel: channelName }),
        hint: t("settings.channelStateConnectedHint"),
      };
    }
    if (status.state === "offline") {
      return {
        tone: "warn" as const,
        icon: "cloud_off",
        title: t("settings.channelStateOffline"),
        hint: t("settings.channelStateOfflineHint", { channel: channelName }),
      };
    }
    return {
      tone: "neutral" as const,
      icon: "help",
      title: t("settings.channelStateUnknown"),
      hint: t("settings.channelStateUnknownHint"),
    };
  })();

  return (
    <div className="max-w-xl space-y-5" data-testid={`settings-section-${channel}`}>
      {/* Status card */}
      <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: spec.accent }} aria-hidden="true">
            {spec.icon}
          </span>
          <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.status")}</h3>
          {PREVIEW_GUIDED_CHANNELS.includes(channel) && (
            <span className="ml-auto text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20">
              {t("settings.channelPreviewBadge")}
            </span>
          )}
        </div>

        {status === null ? (
          <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5 animate-pulse">
            <div className="w-10 h-10 rounded-full bg-white/[0.08] shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-32 rounded bg-white/[0.08]" />
              <div className="h-2 w-20 rounded bg-white/[0.06]" />
            </div>
          </div>
        ) : !status.configured ? (
          <div className="flex items-center gap-4 rounded-xl px-4 py-3.5 border bg-white/[0.03] border-white/[0.06]">
            <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center shrink-0">
              <span className="material-symbols-rounded text-[var(--text-muted)] opacity-60" style={{ fontSize: 22 }} aria-hidden="true">link_off</span>
            </div>
            <div className="text-sm text-[var(--text-secondary)]">{t("settings.notConfigured")}</div>
          </div>
        ) : view ? (
          <div data-testid={`${channel}-status-card`} data-state={status.tokenRejected ? "rejected" : status.state ?? "unknown"}>
            <div
              className={`flex items-center gap-4 rounded-xl px-4 py-3.5 border ${
                view.tone === "live"
                  ? "bg-green-500/[0.06] border-green-500/15"
                  : view.tone === "warn"
                    ? "bg-amber-500/[0.06] border-amber-500/15"
                    : "bg-white/[0.03] border-white/[0.06]"
              }`}
            >
              <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center shrink-0">
                <span
                  className={`material-symbols-rounded ${
                    view.tone === "live" ? "text-green-400" : view.tone === "warn" ? "text-amber-400" : "text-[var(--text-muted)] opacity-60"
                  }`}
                  style={{ fontSize: 22 }}
                  aria-hidden="true"
                >
                  {view.icon}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-[var(--text-primary)] font-medium truncate">{view.title}</div>
                {spec.accountKey && status.account && (
                  <div className="text-xs text-[var(--text-muted)] mt-0.5 truncate">
                    {t(spec.accountKey, { account: status.account })}
                  </div>
                )}
                {status.team && (
                  <div className="text-xs text-[var(--text-muted)] mt-0.5 truncate">
                    {t("settings.channelInWorkspace", { team: status.team })}
                  </div>
                )}
                {status.state === "connected" && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                    <span className="text-xs text-green-400/80">{t("settings.channelLive")}</span>
                  </div>
                )}
                <div className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">{view.hint}</div>
              </div>
            </div>
            {!reconfigure && (
              <div className="flex items-center gap-4 mt-4">
                <button
                  type="button"
                  onClick={() => {
                    setReconfigure(true);
                    setNotice(null);
                  }}
                  className="text-sm text-[var(--coral-bright)] hover:text-orange-300 bg-transparent border-none cursor-pointer p-0 font-medium"
                >
                  {t("settings.reconfigureBot")}
                </button>
                <button
                  type="button"
                  onClick={onRefresh}
                  className="text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer p-0"
                >
                  {t("settings.channelCheckAgain")}
                </button>
              </div>
            )}
          </div>
        ) : null}

        {status?.configured && !reconfigure && endpointBox}
        {notice && !showSetup && <StatusMessage type={notice.type} message={notice.message} />}
      </div>

      {/* New senders: the harness' own DM pairing, on both editions */}
      {status?.configured && !reconfigure && (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid={`${channel}-pairing`}>
          <div className="flex items-center gap-2 mb-2">
            <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">person_add</span>
            <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.channelPairingTitle")}</h3>
          </div>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed mb-3">{t("settings.channelPairingHint")}</p>
          <div className="flex items-center gap-2">
            <label htmlFor={`${idBase}-pairing`} className="sr-only">{t("settings.channelPairingPlaceholder")}</label>
            <input
              id={`${idBase}-pairing`}
              value={pairingCode}
              onChange={(e) => {
                setPairingCode(e.target.value);
                setPairingNotice(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && approve()}
              placeholder={t("settings.channelPairingPlaceholder")}
              spellCheck={false}
              autoComplete="off"
              maxLength={32}
              className="flex-1 min-w-0 px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm font-mono uppercase tracking-wider text-[var(--text-primary)] outline-none focus:border-orange-400/60 focus:bg-white/[0.06] transition-all placeholder-white/15 placeholder:normal-case placeholder:tracking-normal placeholder:font-sans"
            />
            <button
              type="button"
              onClick={approve}
              disabled={approving || !pairingCode.trim()}
              className="px-4 py-2.5 bg-white/[0.08] hover:bg-white/[0.12] disabled:opacity-30 text-[var(--text-primary)] rounded-xl text-sm font-semibold cursor-pointer border-none transition-all"
            >
              {approving ? (
                <span className="material-symbols-rounded motion-safe:animate-spin" style={{ fontSize: 16 }} aria-hidden="true">progress_activity</span>
              ) : (
                t("settings.channelPairingApprove")
              )}
            </button>
          </div>
          {pairingNotice && <StatusMessage type={pairingNotice.type} message={pairingNotice.message} />}
        </div>
      )}

      {/* Setup card — not configured yet, or reconfiguring */}
      {showSetup && (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid={`${channel}-setup`}>
          <div className="flex items-center gap-2 mb-4">
            <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">add_circle</span>
            <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
              {reconfigure ? t("settings.reconfigureBot") : t(spec.guideTitleKey)}
            </h3>
          </div>

          <ol className="ml-0 pl-5 leading-[1.9] text-sm text-white/70 list-decimal">
            {spec.steps.map((step) => (
              <li key={step.key}>
                {t(step.key)}
                {step.link && (
                  <>
                    {" "}
                    <a
                      href={step.link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--coral-bright)] hover:text-orange-300 font-semibold no-underline"
                    >
                      {t(step.link.labelKey)}
                    </a>
                  </>
                )}
              </li>
            ))}
          </ol>

          {endpointBox}

          {spec.noteKey && (
            <div className="flex items-start gap-2 mt-4 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06]">
              <span className="material-symbols-rounded text-[var(--text-muted)] shrink-0" style={{ fontSize: 18 }} aria-hidden="true">info</span>
              <p className="text-xs text-[var(--text-secondary)] m-0 leading-relaxed">{t(spec.noteKey)}</p>
            </div>
          )}

          {spec.manifest && manifest && (
            <div className="mt-4" data-testid={`${channel}-manifest`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-medium text-white/35 uppercase tracking-wider">{t(spec.manifest.titleKey)}</span>
                <button
                  type="button"
                  onClick={copyManifest}
                  className="flex items-center gap-1 text-xs text-[var(--coral-bright)] hover:text-orange-300 bg-transparent border-none cursor-pointer p-0 font-medium"
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">{copied ? "check" : "content_copy"}</span>
                  {copied ? t(spec.manifest.copiedKey) : t(spec.manifest.copyKey)}
                </button>
              </div>
              <pre className="max-h-40 overflow-auto text-[11px] leading-snug bg-black/30 border border-white/[0.06] rounded-xl p-3 text-white/60 m-0">{manifest}</pre>
            </div>
          )}

          {spec.setup === "signal-link" && status?.prerequisiteMissing && spec.prerequisiteKey && (
            <div className="flex items-start gap-2 mt-4 px-3 py-2.5 rounded-lg bg-amber-500/[0.08] border border-amber-500/20" data-testid={`${channel}-prerequisite`}>
              <span className="material-symbols-rounded text-amber-400 shrink-0" style={{ fontSize: 18 }} aria-hidden="true">warning</span>
              <p className="text-xs text-amber-200/90 m-0 leading-relaxed">{t(spec.prerequisiteKey)}</p>
            </div>
          )}

          {spec.setup === "signal-link" && !status?.prerequisiteMissing && (
            <div className="mt-5" data-testid={`${channel}-link`} data-state={link.state}>
              {link.state === "waiting" ? (
                <div className="flex flex-col items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.03] p-4">
                  {link.uri ? (
                    <div className="rounded-lg bg-white p-3" data-testid={`${channel}-link-qr`}>
                      <QRCodeSVG value={link.uri} size={184} level="M" />
                    </div>
                  ) : (
                    <span className="material-symbols-rounded motion-safe:animate-spin text-[var(--text-muted)]" style={{ fontSize: 28 }} aria-hidden="true">progress_activity</span>
                  )}
                  <p className="text-xs text-[var(--text-secondary)] m-0 text-center" aria-live="polite">{t("settings.signalWaiting")}</p>
                  <button
                    type="button"
                    onClick={cancelLink}
                    className="text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer"
                  >
                    {t("cancel")}
                  </button>
                </div>
              ) : link.state === "linked" ? (
                <StatusMessage
                  type="success"
                  message={link.account ? t("settings.signalLinked", { account: link.account }) : t("settings.signalLinkedNoNumber")}
                />
              ) : (
                <>
                  {link.state === "failed" && link.reason !== "cancelled" && (
                    <StatusMessage type="error" message={t("settings.signalLinkFailed")} />
                  )}
                  <button
                    type="button"
                    onClick={startLink}
                    className="mt-3 px-5 py-2.5 bg-[#fe6e00] hover:bg-[#ff8b1a] text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-all flex items-center gap-2 shadow-[0_2px_12px_rgba(254,110,0,0.25)]"
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">qr_code_2</span>
                    {t("settings.signalShowQr")}
                  </button>
                </>
              )}
              <h4 className="text-[11px] font-medium text-white/35 uppercase tracking-wider mt-6 mb-0">{t("settings.signalManualTitle")}</h4>
            </div>
          )}

          {!(spec.setup === "signal-link" && status?.prerequisiteMissing) && (
          <>
          <div className="mt-5 space-y-4">
            {spec.fields.map((field) => {
              const inputId = `${idBase}-${field.name}`;
              const visible = !field.secret || shown[field.name] === true;
              return (
                <div key={field.name}>
                  <label htmlFor={inputId} className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">
                    {t(field.labelKey)}
                  </label>
                  <div className="relative">
                    <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] opacity-40" style={{ fontSize: 18 }} aria-hidden="true">
                      {field.secret ? "key" : "badge"}
                    </span>
                    <input
                      id={inputId}
                      type={visible ? "text" : "password"}
                      value={values[field.name] ?? ""}
                      onChange={(e) => {
                        const next = e.target.value;
                        setValues((prev) => ({ ...prev, [field.name]: next }));
                        setNotice(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && save()}
                      placeholder={field.placeholder}
                      spellCheck={false}
                      autoComplete="off"
                      className={`w-full pl-10 ${field.secret ? "pr-10" : "pr-3"} py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none focus:border-orange-400/60 focus:bg-white/[0.06] transition-all placeholder-white/15`}
                    />
                    {field.secret && (
                      <button
                        type="button"
                        onClick={() => setShown((prev) => ({ ...prev, [field.name]: !prev[field.name] }))}
                        aria-label={t(field.labelKey)}
                        aria-pressed={visible}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] opacity-50 hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer p-0.5"
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">{visible ? "visibility_off" : "visibility"}</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {notice && <StatusMessage type={notice.type} message={notice.message} />}

          <div className="flex items-center gap-3 mt-5">
            <button
              type="button"
              onClick={save}
              disabled={saving || !allFilled}
              className="px-6 py-2.5 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-all flex items-center justify-center gap-2 shadow-[0_2px_12px_rgba(254,110,0,0.25)]"
            >
              {saving ? (
                <>
                  <span className="material-symbols-rounded motion-safe:animate-spin" style={{ fontSize: 16 }} aria-hidden="true">progress_activity</span>
                  {t("settings.channelChecking", { channel: channelName })}
                </>
              ) : (
                <>
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">link</span>
                  {t("settings.connect")}
                </>
              )}
            </button>
            {reconfigure && (
              <button
                type="button"
                onClick={() => {
                  setReconfigure(false);
                  setNotice(null);
                  setValues({});
                }}
                className="text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer"
              >
                {t("cancel")}
              </button>
            )}
          </div>
          </>
          )}
        </div>
      )}
    </div>
  );
}
