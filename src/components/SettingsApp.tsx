"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import { createPortal } from "react-dom";
import StatusMessage from "./StatusMessage";
import SignalBars from "./SignalBars";
import AIProviderIcon from "./AIProviderIcon";
import AiProviderList from "./AiProviderList";
import HarnessPicker from "./HarnessPicker";
import PetPicker from "./PetPicker";
import type { WifiNetwork } from "@/lib/wifi-utils";
import { signalToLevel, dbmToLevel } from "@/lib/wifi-utils";
import { dispatchOpenApp, CHAT_MODEL_STATE_EVENT, notifyProvidersChanged, onProvidersChanged } from "@/lib/ui-events";
import AIModelsStep from "./AIModelsStep";
import TelegramConfiguringOverlay from "./TelegramConfiguringOverlay";
import RemoteControlPanel from "./RemoteControlPanel";
import LocalAiPanel from "./LocalAiPanel";
import VoiceOutputPanel from "./VoiceOutputPanel";
import SystemProfilePanel from "./SystemProfilePanel";
import FreeTierUpgradeCard from "./FreeTierUpgradeCard";
import { copyToClipboard } from "@/lib/clipboard";
import { FACTORY_RESET_CONFIRMATION, isFactoryResetConfirmed } from "@/lib/factory-reset";
import { installPendingRefresh } from "@/lib/email-pending-refresh";
import ClawBoxLoginModal, { type ClawBoxLoginFeature } from "./ClawBoxLoginModal";
import { useClawboxLogin } from "@/lib/use-clawbox-login";
import { I18nProvider, useT, LANGUAGES, type Locale } from "@/lib/i18n";
import { cachedEdition, fetchHarness } from "@/lib/client-harness";
import { isPairingToken, normalizePairingToken, samePairingToken } from "@/lib/telegram-pairing-token";
import { QRCodeSVG } from "qrcode.react";
import type { UpdateState } from "@/lib/updater";
import { RESTART_STEP_ID } from "@/lib/update-constants";
import { cleanVersion } from "@/lib/version-utils";
import { BuildIdentityRows, useBuildIdentity } from "./BuildIdentityPanel";
import { useReconnect } from "@/hooks/useReconnect";
import { useModalDialog } from "@/hooks/useModalDialog";
import { DISCORD_INVITE_URL } from "@/lib/community";

/* ── Types ── */

export interface UISettings {
  wallpaperId: string;
  wpFit: "fill" | "fit" | "center";
  wpBgColor: string;
  wpOpacity: number;
  mascotHidden: boolean;
  wallpapers: { id: string; name: string; image?: string }[];
  customWallpapers: string[];
  onWallpaperChange: (id: string) => void;
  onWpFitChange: (fit: "fill" | "fit" | "center") => void;
  onWpBgColorChange: (color: string) => void;
  onWpOpacityChange: (opacity: number) => void;
  onMascotToggle: (hidden: boolean) => void;
  onWallpaperUpload: () => void;
  onCustomWallpaperDelete: (idx: number) => void;
}

interface SettingsAppProps {
  ui: UISettings;
}

/** Exactly what /setup-api/email/status returns. The address is already
 *  masked server-side and the password is only ever a boolean. */
type EmailMode = "send" | "read" | "answer";

interface EmailStatus {
  configured: boolean;
  address: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  imapHost: string | null;
  allowedSenders: string[];
  inbound: boolean;
  inboundSupported: boolean;
  /** What the assistant may do with the mailbox. */
  mode: EmailMode;
  /** The explicit incoming-server override; null when it is being derived. */
  imapHostExplicit: string | null;
  /** When true, email_send queues a draft instead of sending. */
  askBeforeSend: boolean;
  /** How many drafts are waiting for approval. */
  pendingCount: number;
}

/** One outgoing message the assistant queued, waiting for the owner. */
interface PendingEmail {
  id: string;
  to: string[];
  subject: string;
  preview: string;
  createdAt: number;
}

/**
 * A draft that is no longer waiting, and what became of it.
 *
 * The strip above used to just stop listing such a draft, which is honest about
 * the queue and silent about the mail: an owner who approved on Telegram opened
 * this panel to nothing at all and could not tell "it went out" from "it was
 * deleted" from "this box never had it". The queue is where he comes to find
 * out, so it is where the answer belongs.
 */
interface HandledEmail {
  id: string;
  kind: "sent" | "rejected" | "failed" | "unconfirmed" | "duplicate";
  at: number;
  to: string[];
  subject: string;
  error?: string;
}

/**
 * A draft that was approved, claimed out of the queue and then failed to send.
 * /setup-api/email/pending hands the whole message back for exactly this, so
 * the owner's approved mail is not lost to a transient SMTP error.
 */
interface LostDraft {
  to: string[];
  subject: string;
  body: string;
  /**
   * The send was never confirmed one way or the other, so the heading over this
   * draft must not say it was not sent.
   *
   * The route computes which failure it was and sends the receipt's word back
   * (`ending`). A dropped connection after DATA leaves nobody able to say
   * whether the message arrived, and a confident "This message was not sent" is
   * precisely how an owner is talked into sending it a second time — while the
   * handled strip on the same screen was about to say "could not be confirmed".
   */
  unconfirmed: boolean;
}

/**
 * "Approve from Telegram", as the panel sees it.
 *
 * `ownerChats` is a COUNT and never the ids: the panel only needs to warn that
 * nobody is paired yet, and publishing the household's Telegram user ids into
 * the DOM to say so would be a worse trade than the warning is worth.
 */
interface ChatApprovalState {
  enabled: boolean;
  botConfigured: boolean;
  botUsername: string | null;
  ownerChats: number;
}

/** One shape, one parser. Two hand-rolled copies drift the moment a field moves. */
function parseChatApprovalState(d: unknown): ChatApprovalState {
  const r = (typeof d === "object" && d !== null ? d : {}) as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    botConfigured: r.botConfigured === true,
    botUsername: typeof r.botUsername === "string" ? r.botUsername : null,
    ownerChats: typeof r.ownerChats === "number" ? r.ownerChats : 0,
  };
}

// How often the open approvals strip re-reads the queue, and the focus /
// visible-edge / not-behind-a-hidden-tab rules around it, now live in
// `@/lib/email-pending-refresh` — shared with the chat surface's batch card,
// which asks the same question about the same queue and must not answer it on
// a different schedule.

interface SwapStats { used: number; total: number; percent: number }
interface DiskMount { filesystem: string; size: string; used: string; avail: string; usePercent: number; mountpoint: string }
interface NetworkIface { name: string; ip: string; rx: number; tx: number }
interface ProcessEntry { pid: string; user: string; cpu: number; mem: number; command: string }
interface SystemStats {
  overview: { hostname: string; os: string; kernel: string; uptime: string; arch: string; platform: string };
  cpu: { usage: number; model: string; cores: number; loadAvg: string[]; speed: number };
  memory: { total: number; used: number; free: number; usedPercent: number; swap: SwapStats };
  temperature?: { value: number | null; display: string };
  gpu?: { usage: number };
  storage: DiskMount[];
  network: NetworkIface[];
  processes: ProcessEntry[];
  timestamp: number;
}


// codingAgent is gone from this list on purpose: its settings moved into the
// Coding Agent app itself (the owner asked for them back there).
const SECTIONS = ["appearance", "wifi", "ai", "localAi", "localModels", "voice", "channels", "telegram", "email", "whatsapp", "discord", "remote", "system", "about"] as const;

/**
 * The channels that live behind the single "Messaging Channels" entry — the same idea
 * as GNOME's Online Accounts: one page listing every outside service the
 * assistant can be reached through, each row opening its own settings.
 *
 * They are still ordinary Sections, so their panes, their deep links
 * (`clawbox:open-settings`) and their status lines are unchanged; only the
 * sidebar stops carrying four near-identical entries.
 */
const CHANNEL_SECTIONS = ["telegram", "email", "whatsapp", "discord"] as const;
type ChannelSection = typeof CHANNEL_SECTIONS[number];

const CHANNEL_ITEMS: { id: ChannelSection; icon: string; labelKey: string; hintKey: string }[] = [
  { id: "telegram", icon: "send", labelKey: "settings.telegram", hintKey: "settings.channelsTelegramHint" },
  { id: "email", icon: "mail", labelKey: "settings.email", hintKey: "settings.channelsEmailHint" },
  { id: "whatsapp", icon: "chat", labelKey: "settings.whatsapp", hintKey: "settings.channelsWhatsappHint" },
  { id: "discord", icon: "forum", labelKey: "settings.discord", hintKey: "settings.channelsDiscordHint" },
];

function isChannelSection(id: string): id is ChannelSection {
  return (CHANNEL_SECTIONS as readonly string[]).includes(id);
}

/** The three mailbox modes, in increasing order of what the assistant may do. */
const EMAIL_MODE_OPTIONS: { id: EmailMode; labelKey: string; hintKey: string }[] = [
  { id: "send", labelKey: "settings.emailModeSend", hintKey: "settings.emailModeSendHint" },
  { id: "read", labelKey: "settings.emailModeRead", hintKey: "settings.emailModeReadHint" },
  { id: "answer", labelKey: "settings.emailModeAnswer", hintKey: "settings.emailModeAnswerHint" },
];

const REBOOT_PROBE_GRACE_MS = 8_000;
const REBOOT_PROBE_INTERVAL_MS = 3_000;
const REBOOT_PROBE_TIMEOUT_MS = 2_500;
const REBOOT_HARD_REDIRECT_MS = 45_000;
type Section = typeof SECTIONS[number];

/** Shape of GET /setup-api/whatsapp/status, normalised client-side. */
interface WhatsappStatus {
  supported: boolean;
  state?: "not_configured" | "enabled_not_paired" | "paired" | "unsupported";
  enabled?: boolean;
  paired?: boolean;
  mode?: "bot" | "self-chat" | null;
  allowedUsers?: string[];
  allowAllUsers?: boolean;
  /** null = the bridge directory was not found, which is not "bridge broken". */
  bridgeReady?: boolean | null;
  /**
   * Does the gateway's sender allowlist cover the paired account? Pairing and
   * authorization are separate gates upstream, and a box that clears the first
   * but not the second looks healthy while dropping every message.
   */
  authorized?: boolean;
  receiving?: boolean;
}

/** A PNG data URL that actually carries an image. Mirrors the server's guard. */
const WHATSAPP_QR_DATA_URL_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

/** Phases of GET /setup-api/whatsapp/pair. Mirrors WhatsappPairPhase server-side. */
type WhatsappPairPhase = "idle" | "preparing" | "starting" | "waiting" | "scanned" | "paired" | "error";

/** Shape of GET/POST /setup-api/whatsapp/pair, normalised client-side. */
interface WhatsappPairSnapshot {
  phase: WhatsappPairPhase;
  /** Raw Baileys payload (Hermes). Rendered as a QR; never shown as text. */
  qr: string | null;
  /** Pre-rendered PNG data URL (OpenClaw, whose plugin draws the code itself). */
  qrImage: string | null;
  /** Distinct QR payloads this session — proof the rotation is live. */
  qrCount: number;
  restarts: number;
  error: string | null;
  user: { id: string | null; name: string | null } | null;
}

/* ── Sidebar nav items ── */
const NAV_ITEMS: { id: Section; icon: string; labelKey: string }[] = [
  // Appearance leads because it is the page a new owner reaches for first
  // (wallpaper, mascot, language), and it is where Settings opens — see
  // DEFAULT_SECTION. After that, ordered by how often an owner comes here,
  // not by history: the brain and the ways to reach it first, the box's own
  // machinery next, the once-a-year pages last.
  { id: "appearance", icon: "palette", labelKey: "settings.appearance" },
  // Providers (cloud sign-ins) and Local AI (the on-device model and the
  // inventory of everything running on the box) are neighbours, each with its
  // own provider list on top. "localModels" stays a Section so its deep links
  // land on Local AI.
  { id: "ai", icon: "smart_toy", labelKey: "settings.providers" },
  { id: "localAi", icon: "memory", labelKey: "settings.localAi" },
  // The coding agent's settings — its switch, folder, effort and GitHub
  // account — moved here from the Coding Agent app, which keeps the runs.
  // Next to the AI pages because it is the other thing the assistant does
  // with a model.
  // One entry for every messaging channel; the four panes live behind it
  // (CHANNEL_ITEMS) rather than each claiming a sidebar row of its own.
  { id: "channels", icon: "forum", labelKey: "settings.channels" },
  { id: "voice", icon: "record_voice_over", labelKey: "settings.voice" },
  { id: "wifi", icon: "wifi", labelKey: "settings.network" },
  { id: "remote", icon: "cloud_sync", labelKey: "settings.remote" },
  { id: "system", icon: "monitor_heart", labelKey: "settings.system" },
  { id: "about", icon: "info", labelKey: "settings.about" },
];

// Where Settings opens when no deep link asks for a page. Appearance, which is
// both the first sidebar row and the page an owner actually comes here for —
// wallpaper, mascot, language. It used to open on Providers, so the first thing
// Settings showed was a list of AI credentials.
const DEFAULT_SECTION: Section = "appearance";

/** A deep-link value as a Section, or null. The old Local Models section is
 *  part of Local AI now. */
function toSection(value: unknown): Section | null {
  if (typeof value !== "string" || !(SECTIONS as readonly string[]).includes(value)) return null;
  return value === "localModels" ? "localAi" : (value as Section);
}

// The section a cold open was asked for, read BEFORE the first render so the
// default pane never mounts — and starts its fetches — only to be swapped out
// a tick later. A peek, not a take: the mount effect still deletes the slot,
// because React may run a state initializer twice.
function peekPendingSection(): Section | null {
  if (typeof window === "undefined") return null;
  return toSection((window as Window & { __clawboxPendingSettingsSection?: unknown }).__clawboxPendingSettingsSection);
}

/* ── Discord ── */
// The four states GET /setup-api/discord/status can report, each with exactly
// one remedy in the UI. "connected" is the only one that may render as live.
const DISCORD_STATES = ["connected", "intents-missing", "denied-no-allowlist", "offline"] as const;
type DiscordConnectionState = (typeof DISCORD_STATES)[number];

function isDiscordState(value: unknown): value is DiscordConnectionState {
  return typeof value === "string" && (DISCORD_STATES as readonly string[]).includes(value);
}

/** One row of the "who may talk to the assistant" picker. */
interface DiscordMemberOption {
  id: string;
  displayName: string;
  username: string;
  isOwner: boolean;
  guildName: string;
}

function toDiscordMembers(value: unknown): DiscordMemberOption[] {
  if (!Array.isArray(value)) return [];
  const out: DiscordMemberOption[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const m = entry as Record<string, unknown>;
    if (typeof m.id !== "string") continue;
    out.push({
      id: m.id,
      displayName: typeof m.displayName === "string" ? m.displayName : "",
      username: typeof m.username === "string" ? m.username : "",
      isOwner: m.isOwner === true,
      guildName: typeof m.guildName === "string" ? m.guildName : "",
    });
  }
  return out;
}

function formatBytes(b: number): string {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + " " + u[i];
}

function barColor(pct: number): string {
  return pct >= 90 ? "#ef4444" : pct >= 70 ? "#f97316" : pct >= 50 ? "#eab308" : "#06b6d4";
}

function Toggle({ on, onToggle, label }: { on: boolean; onToggle: (v: boolean) => void; label: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-[var(--text-primary)]">{label}</span>
      <button
        onClick={() => onToggle(!on)}
        className={`relative inline-flex items-center w-10 h-5 rounded-full transition-colors cursor-pointer border-none shrink-0 ${on ? "bg-orange-500" : "bg-white/15"}`}
      >
        <span
          className="absolute w-4 h-4 rounded-full bg-white shadow-md transition-transform duration-200"
          style={{ left: 2, transform: on ? "translateX(18px)" : "translateX(0)" }}
        />
      </button>
    </div>
  );
}

type SectionStatus = { subtitle: string | null };

export default function SettingsApp({ ui }: SettingsAppProps) {
  const { t, locale, setLocale } = useT();
  const navLabel = useCallback((item: { labelKey: string }) => t(item.labelKey), [t]);
  const notifyChatModelStateChanged = useCallback(() => {
    window.dispatchEvent(new Event(CHAT_MODEL_STATE_EVENT));
    // And in the edition-neutral vocabulary, so that "every path that changes
    // the providers emits `clawbox:providers-changed`" is literally true and a
    // listener written against that one name alone is never left deaf.
    notifyProvidersChanged();
  }, []);
  const [langOpen, setLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);
  const currentLang = LANGUAGES.find(l => l.code === locale) ?? LANGUAGES[0];
  const [initialSection] = useState(peekPendingSection);
  const [section, setSection] = useState<Section>(initialSection ?? DEFAULT_SECTION);
  const [openClawAIOfferRequest, setOpenClawAIOfferRequest] = useState(0);
  const [requestedAiProviderId, setRequestedAiProviderId] = useState<string | null>(null);
  const [providerSelectionRequest, setProviderSelectionRequest] = useState(0);
  // Mobile: null means show nav list, a section means show content with back button
  const [mobileSection, setMobileSection] = useState<Section | null>(initialSection);

  // ClawBox account gate — Remote Control needs the user to be signed in to
  // the portal so the tunnel can be claimed. The hook polls /ai-models/status
  // (already the truth source for active provider + tier).
  const clawboxLogin = useClawboxLogin();
  const [loginModal, setLoginModal] = useState<{ open: boolean; feature: ClawBoxLoginFeature }>(
    { open: false, feature: "remote" },
  );
  const requireLoginFor = useCallback((feature: ClawBoxLoginFeature): boolean => {
    // Don't gate while we still don't know — assume logged in to avoid a
    // brief modal flash for users who actually are. The 30s poll will
    // self-correct in either direction.
    if (clawboxLogin.loading) return false;
    if (clawboxLogin.loggedIn) return false;
    setLoginModal({ open: true, feature });
    return true;
  }, [clawboxLogin.loading, clawboxLogin.loggedIn]);

  // Three-state pick for the Remote Control section: needs portal sign-in,
  // needs paid plan, or shows the panel. A bare loading spinner stands in
  // while `clawboxLogin.loading` so we don't flicker between states or
  // leave the pane visibly empty for the ~30 s first-poll window.
  const renderRemoteSection = () => {
    if (clawboxLogin.loading) {
      return (
        <div
          role="status"
          aria-live="polite"
          aria-label="Loading Remote Control"
          className="max-w-xl flex items-center justify-center py-12 text-[var(--text-muted)]"
        >
          <span
            className="material-symbols-rounded animate-spin"
            style={{ fontSize: 24 }}
            aria-hidden="true"
          >
            progress_activity
          </span>
        </div>
      );
    }
    if (!clawboxLogin.loggedIn) {
      return <RemoteLoginPlaceholder onSignIn={() => setLoginModal({ open: true, feature: "remote" })} />;
    }
    if (clawboxLogin.tier === null) {
      return (
        <FreeTierUpgradeCard
          featureName={t("remoteControl.upgrade.featureName")}
          description={t("remoteControl.upgrade.description")}
        />
      );
    }
    return <RemoteControlPanel />;
  };
  // Section setter that intercepts gated sections. Use this everywhere a
  // user action wants to navigate; bypass it for programmatic restorations
  // (URL deep-link, tier-based redirects) where blocking would be confusing.
  const setSectionGated = useCallback((next: Section) => {
    if (next === "remote" && requireLoginFor("remote")) return;
    // The old Local Models section is part of Local AI now.
    if (next === "localModels") next = "localAi";
    setSection(next);
    // Both, so one navigation call works on either layout: the mobile view
    // reads `mobileSection`, and a hub row that only set `section` would
    // leave a phone sitting on the page it was already showing.
    setMobileSection(next);
  }, [requireLoginFor]);

  // Allow other parts of the desktop (e.g. the "new version available" toast)
  // to deep-link into a specific Settings section. Read a pending value left
  // on `window` first, so a deep-link issued before this effect runs (cold
  // open of Settings) isn't lost to a listener-mount race.
  useEffect(() => {
    const apply = (s: unknown) => {
      const next = toSection(s);
      if (!next) return;
      setSection(next);
      setMobileSection(next);
    };
    const requestClawAiOffer = () => {
      setSection("ai");
      setMobileSection("ai");
      setOpenClawAIOfferRequest((current) => current + 1);
    };
    const requestProviderSelection = (providerId: unknown) => {
      if (typeof providerId !== "string" || !providerId.trim()) return;
      setSection("ai");
      setMobileSection("ai");
      setRequestedAiProviderId(providerId);
      setProviderSelectionRequest((current) => current + 1);
    };
    const w = window as Window & {
      __clawboxPendingSettingsSection?: unknown;
      __clawboxPendingClawAiOffer?: unknown;
      __clawboxPendingAiProvider?: unknown;
    };
    if (w.__clawboxPendingSettingsSection !== undefined) {
      apply(w.__clawboxPendingSettingsSection);
      delete w.__clawboxPendingSettingsSection;
    }
    if (w.__clawboxPendingAiProvider !== undefined) {
      requestProviderSelection(w.__clawboxPendingAiProvider);
      delete w.__clawboxPendingAiProvider;
    }
    if (w.__clawboxPendingClawAiOffer) {
      requestClawAiOffer();
      delete w.__clawboxPendingClawAiOffer;
    }
    const handler = (event: Event) =>
      apply((event as CustomEvent<{ section?: string }>).detail?.section);
    const providerHandler = (event: Event) =>
      requestProviderSelection((event as CustomEvent<{ providerId?: string }>).detail?.providerId);
    const offerHandler = () => requestClawAiOffer();
    window.addEventListener("clawbox:open-settings-section", handler);
    window.addEventListener("clawbox:select-ai-provider", providerHandler);
    window.addEventListener("clawbox:open-clawai-offer", offerHandler);
    return () => {
      window.removeEventListener("clawbox:open-settings-section", handler);
      window.removeEventListener("clawbox:select-ai-provider", providerHandler);
      window.removeEventListener("clawbox:open-clawai-offer", offerHandler);
    };
  }, []);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Close language dropdown on click outside
  useEffect(() => {
    if (!langOpen) return;
    const handler = (e: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) setLangOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [langOpen]);

  /* ── System stats ──
   * Poll only when System section is visible (live CPU/mem/temp/etc.),
   * but always fetch once when About is open so the static fields
   * (arch/platform) render instead of "...".
   */
  const [stats, setStats] = useState<SystemStats | null>(null);
  // Which commit this box is really running, and whether that agrees with the
  // code on its disk. Fetched only where it is shown (About + System).
  const buildIdentity = useBuildIdentity(section === "system" || section === "about");
  useEffect(() => {
    if (section !== "system" && section !== "about") return;
    const poll = () => fetch("/setup-api/system/stats", { cache: "no-store" }).then(r => r.json()).then(setStats).catch(() => {});
    poll();
    if (section !== "system") return;
    const iv = setInterval(poll, 3000);
    return () => clearInterval(iv);
  }, [section]);

  /* ── System update ── */
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [updateStarted, setUpdateStarted] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateConfirm, setUpdateConfirm] = useState(false);
  const [versionInfo, setVersionInfo] = useState<{
    clawbox: { current: string; target: string | null; updateAvailable?: boolean };
    openclaw: { current: string | null; target: string | null; updateAvailable?: boolean };
    // Both optional: a device that has not been updated yet still answers
    // /update/versions with the old two-key shape.
    hermes?: { current: string | null; target: string | null; updateAvailable?: boolean };
    edition?: "openclaw" | "hermes" | "dual";
  } | null>(null);
  const [versionLoading, setVersionLoading] = useState(false);
  const [updateBranch, setUpdateBranch] = useState<string | null>(null);
  const [branchInput, setBranchInput] = useState("");
  const [branchSaving, setBranchSaving] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [betaEnabled, setBetaEnabled] = useState(false);
  const [betaConfirm, setBetaConfirm] = useState(false);
  const [betaSaving, setBetaSaving] = useState(false);
  const updatePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const updatePollControllerRef = useRef<AbortController | null>(null);

  const stopUpdatePolling = useCallback(() => {
    if (updatePollRef.current) { clearInterval(updatePollRef.current); updatePollRef.current = null; }
    updatePollControllerRef.current?.abort();
    updatePollControllerRef.current = null;
  }, []);

  const startUpdatePolling = useCallback(() => {
    if (updatePollRef.current) return;
    const controller = new AbortController();
    updatePollControllerRef.current = controller;
    let failureCount = 0;
    let serverWentDown = false;
    updatePollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/setup-api/update/status", { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) { failureCount++; if (failureCount >= 3) serverWentDown = true; return; }
        if (serverWentDown) { window.location.reload(); return; }
        failureCount = 0;
        const data: UpdateState = await res.json();
        if (controller.signal.aborted) return;
        setUpdateState(data);
        if (data.phase !== "running") stopUpdatePolling();
      } catch {
        if (controller.signal.aborted) return;
        failureCount++;
        if (failureCount >= 3) serverWentDown = true;
      }
    }, 2000);
  }, [stopUpdatePolling]);

  useEffect(() => () => stopUpdatePolling(), [stopUpdatePolling]);

  // Auto-dismiss the update overlay once the update finishes. Full updates
  // (with a `restart` step) get a longer grace window and a hard navigation
  // to `/` so the browser picks up any freshly built client bundle; scoped
  // updates just clear the overlay in place.
  useEffect(() => {
    if (updateState?.phase !== "completed") return;
    const isFullUpdate = updateState.steps.some(s => s.id === RESTART_STEP_ID);
    const timer = setTimeout(() => {
      if (isFullUpdate) {
        stopUpdatePolling();
        // replace() instead of assigning href so Back doesn't land on the
        // stale Settings URL whose in-memory state is already gone.
        window.location.replace("/");
        return;
      }
      setUpdateStarted(false);
      setUpdateError(null);
      setUpdateState(null);
      stopUpdatePolling();
    }, isFullUpdate ? 5000 : 3000);
    return () => clearTimeout(timer);
  }, [updateState?.phase, updateState?.steps, stopUpdatePolling]);

  // Load version info and beta status on mount
  useEffect(() => {
    // /update/status only returns versions when phase=idle and not completed.
    // Use the dedicated /update/versions endpoint which always reports them.
    fetch("/setup-api/update/versions")
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.clawbox || data?.openclaw) setVersionInfo(data); })
      .catch(() => {});
    fetch("/setup-api/system/update-branch")
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.branch === "beta") setBetaEnabled(true); })
      .catch(() => {});
  }, []);



  const saveUpdateBranch = async (branch: string) => {
    setBranchSaving(true);
    setBranchError(null);
    try {
      const res = await fetch("/setup-api/system/update-branch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ branch: branch || null }) });
      const data = await res.json();
      if (res.ok) { setUpdateBranch(data.branch ?? null); } else { setBranchError(data.error || t("settings.failedSetBranch")); }
    } catch (err) { setBranchError(err instanceof Error ? err.message : t("settings.failedSetBranch")); } finally { setBranchSaving(false); }
  };

  const toggleBeta = async (enable: boolean) => {
    if (enable) {
      setBetaConfirm(true);
      return;
    }
    setBetaSaving(true);
    try {
      const res = await fetch("/setup-api/system/update-branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: null }),
      });
      if (res.ok) {
        setBetaEnabled(false);
        setUpdateBranch(null);
        setBranchInput("");
      }
    } catch {} finally { setBetaSaving(false); }
  };

  const confirmBeta = async () => {
    setBetaConfirm(false);
    setBetaSaving(true);
    try {
      const res = await fetch("/setup-api/system/update-branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: "beta" }),
      });
      if (res.ok) {
        setBetaEnabled(true);
        setUpdateBranch("beta");
        setBranchInput("beta");
      }
    } catch {} finally { setBetaSaving(false); }
  };

  const triggerUpdate = async () => {
    setUpdateStarted(true);
    setUpdateError(null);
    setUpdateState(null);
    try {
      const res = await fetch("/setup-api/update/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) });
      if (!res.ok) { const data = await res.json().catch(() => ({})); setUpdateError(typeof data.error === "string" ? data.error : t("settings.failedStartUpdate")); return; }
      startUpdatePolling();
    } catch (err) { setUpdateError(err instanceof Error ? err.message : t("settings.failedStartUpdate")); }
  };

  const triggerOpenclawUpdate = async () => {
    setUpdateStarted(true);
    setUpdateError(null);
    setUpdateState(null);
    try {
      const res = await fetch("/setup-api/update/openclaw", { method: "POST" });
      if (!res.ok) { const data = await res.json().catch(() => ({})); setUpdateError(typeof data.error === "string" ? data.error : t("settings.failedStartUpdate")); return; }
      startUpdatePolling();
    } catch (err) { setUpdateError(err instanceof Error ? err.message : t("settings.failedStartUpdate")); }
  };

  /* ── WiFi ── */
  const [ssid, setSsid] = useState("");
  const [wifiPass, setWifiPass] = useState("");
  const [wifiConnecting, setWifiConnecting] = useState(false);
  const [wifiStatus, setWifiStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [connectedSSID, setConnectedSSID] = useState<string | null>(null);
  const [wifiQuality, setWifiQuality] = useState<{ signalDbm: number | null; bitrateMbps: number | null; pingMs: number | null }>({ signalDbm: null, bitrateMbps: null, pingMs: null });
  const [ethernet, setEthernet] = useState<{ connected: boolean; iface: string | null }>({ connected: false, iface: null });

  const [wifiNetworks, setWifiNetworks] = useState<WifiNetwork[] | null>(null);
  const [wifiScanning, setWifiScanning] = useState(false);
  const [showManualWifi, setShowManualWifi] = useState(false);

  const scanWifiNetworks = async () => {
    setWifiScanning(true);
    try {
      // Try live scan first, fall back to cached scan (live fails in AP mode)
      const res = await fetch("/setup-api/wifi/scan?live=1", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.networks?.length > 0) {
          setWifiNetworks(data.networks);
          setWifiScanning(false);
          return;
        }
      }
      const cached = await fetch("/setup-api/wifi/scan");
      if (cached.ok) {
        const data = await cached.json();
        setWifiNetworks(data.networks?.length > 0 ? data.networks : []);
      }
    } catch { /* ignored */ }
    setWifiScanning(false);
  };

  const selectNetwork = (net: { ssid: string }) => {
    setSsid(net.ssid);
    setShowManualWifi(false);
    setWifiPass("");
    setWifiStatus(null);
  };

  /* ── Hotspot ── */
  const [hotspotEnabled, setHotspotEnabled] = useState<boolean | null>(null);
  const [hotspotSSID, setHotspotSSID] = useState("ClawBox-Setup");
  const [hotspotToggling, setHotspotToggling] = useState(false);
  // The hotspot route saves the SETTINGS and then tries to move the radio, and
  // those are two different outcomes. It used to answer both with
  // `{ success: true, apRestarted: false }`, so a toggle whose AP command threw
  // flipped this switch and said nothing — a box still broadcasting behind a
  // control that reads "off". It now names the verdict; this is where a failed
  // one is shown.
  const [hotspotApWarning, setHotspotApWarning] = useState<string | null>(null);
  const [hotspotSSIDInput, setHotspotSSIDInput] = useState("ClawBox-Setup");
  const [hotspotSSIDSaving, setHotspotSSIDSaving] = useState(false);
  const [hotspotSSIDStatus, setHotspotSSIDStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [hotspotHasPassword, setHotspotHasPassword] = useState(false);
  const [hotspotActive, setHotspotActive] = useState<boolean | null>(null);
  const [hotspotBlockedBy, setHotspotBlockedBy] = useState<string | null>(null);
  const [hotspotPassword, setHotspotPassword] = useState("");
  const [hotspotPasswordShow, setHotspotPasswordShow] = useState(false);
  const [hotspotPasswordSaving, setHotspotPasswordSaving] = useState(false);
  const [hotspotPasswordStatus, setHotspotPasswordStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [hotspotConfirmEnable, setHotspotConfirmEnable] = useState(false);
  const [savedNetworks, setSavedNetworks] = useState<{ name: string; priority: number; device: string | null }[]>([]);
  const [savedEditing, setSavedEditing] = useState<string | null>(null);
  const [savedNewPassword, setSavedNewPassword] = useState("");
  const [savedShowPassword, setSavedShowPassword] = useState(false);
  const [savedBusy, setSavedBusy] = useState<string | null>(null);
  const [savedStatus, setSavedStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const refreshSavedNetworks = async () => {
    try {
      const r = await fetch("/setup-api/wifi/saved");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (Array.isArray(d.profiles)) setSavedNetworks(d.profiles);
    } catch (err) {
      console.warn("[SettingsApp] refreshSavedNetworks failed:", err);
    }
  };
  useEffect(() => { void refreshSavedNetworks(); }, []);
  const updateSavedPassword = async (name: string) => {
    if (savedNewPassword.length < 8 || savedNewPassword.length > 63) {
      setSavedStatus({ type: "error", message: t("settings.security.wifiPasswordLength") });
      return;
    }
    setSavedBusy(name); setSavedStatus(null);
    try {
      const r = await fetch("/setup-api/wifi/update", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: name, password: savedNewPassword, action: "update" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || t("settings.security.failed"));
      setSavedStatus({ type: "success", message: t("settings.security.wifiPasswordUpdated", { ssid: name }) });
      setSavedEditing(null); setSavedNewPassword("");
    } catch (err) {
      setSavedStatus({ type: "error", message: err instanceof Error ? err.message : t("settings.security.failed") });
    } finally {
      setSavedBusy(null);
    }
  };
  const forgetSavedNetwork = async (name: string) => {
    if (!window.confirm(`Forget WiFi network "${name}"? You'll need its password to reconnect.`)) return;
    setSavedBusy(name); setSavedStatus(null);
    try {
      const r = await fetch("/setup-api/wifi/update", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: name, action: "forget" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed");
      setSavedStatus({ type: "success", message: `Forgot ${name}` });
      void refreshSavedNetworks();
    } catch (err) {
      setSavedStatus({ type: "error", message: err instanceof Error ? err.message : "Failed" });
    } finally {
      setSavedBusy(null);
    }
  };

  /* ── User name (used by mascot greetings) ── */
  const [userName, setUserName] = useState<string>("");
  const [userNameSaved, setUserNameSaved] = useState<string>("");
  const userNameSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether the user has touched the field locally — without this,
  // a slow GET /preferences could resolve after the user already started
  // typing and overwrite their input mid-keystroke. Same flag also
  // guards the periodic refetch below so an agent write that lands
  // mid-edit doesn't clobber the user's in-flight typing.
  const userNameEditedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Refetch every 5 s so a name the agent just persisted via the
    // `preferences_set` MCP tool ("Hey, I'm Krasi" → agent writes
    // ui_user_name → field updates here without a manual reload).
    // The userNameEditedRef gate keeps the user's local typing
    // authoritative — once they touch the field, polling backs off
    // entirely until the next mount.
    const tick = () => {
      fetch("/setup-api/preferences?keys=ui_user_name", { cache: "no-store" })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (cancelled || !data) return;
          if (userNameEditedRef.current) return;
          const next = typeof data.ui_user_name === "string" ? data.ui_user_name : "";
          // Avoid noisy state updates when the value didn't change —
          // React's strict-equality bail-out covers it but the input
          // still re-renders on parent state churn otherwise.
          setUserName(prev => prev === next ? prev : next);
          setUserNameSaved(prev => prev === next ? prev : next);
        })
        .catch(() => { /* transient — try again next tick */ })
        .finally(() => {
          // Stop scheduling once the user has started typing — otherwise
          // we'd keep firing fetches every 5s with results discarded by
          // the userNameEditedRef guard above. Effect cleanup re-mounts
          // (after page navigation, etc.) restart polling fresh.
          if (!cancelled && !userNameEditedRef.current) timer = setTimeout(tick, 5_000);
        });
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      // Cancel any debounce-pending POST so a tab-close or section-switch
      // mid-debounce doesn't fire after the component is gone.
      if (userNameSaveTimerRef.current) {
        clearTimeout(userNameSaveTimerRef.current);
        userNameSaveTimerRef.current = null;
      }
    };
  }, []);
  const persistUserName = useCallback((value: string) => {
    if (userNameSaveTimerRef.current) clearTimeout(userNameSaveTimerRef.current);
    // Debounce so every keystroke doesn't hit the API; the mascot only
    // needs the latest committed value.
    userNameSaveTimerRef.current = setTimeout(() => {
      fetch("/setup-api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ui_user_name: value.trim() }),
      })
        .then((res) => {
          // Only treat the write as committed if the server actually accepted
          // it. Previously every completed fetch flipped the "Saved." badge —
          // including 4xx/5xx — which lied to the user when the preference
          // never landed.
          if (!res.ok) {
            throw new Error(`preferences POST failed (${res.status})`);
          }
          setUserNameSaved(value.trim());
          window.dispatchEvent(new Event("clawbox-user-name-changed"));
        })
        .catch(() => { /* keep local edit; next save attempt will retry */ });
    }, 600);
  }, []);

  /* ── Local URL (mDNS hostname) ── */
  const [hostname, setHostname] = useState<string>("");
  const [ipv4, setIpv4] = useState<string>("");
  const [hostnameInput, setHostnameInput] = useState<string>("");
  const [hostnameStatus, setHostnameStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [hostnameSaving, setHostnameSaving] = useState(false);
  const [hostnameConfirm, setHostnameConfirm] = useState(false);
  const [hostnameRebootTo, setHostnameRebootTo] = useState<string | null>(null);
  const [sysCurrentPassword, setSysCurrentPassword] = useState("");
  const [sysCurrentVerified, setSysCurrentVerified] = useState(false);
  const [sysVerifying, setSysVerifying] = useState(false);
  const [sysPassword, setSysPassword] = useState("");
  const [sysPasswordConfirm, setSysPasswordConfirm] = useState("");
  const [sysPasswordShow, setSysPasswordShow] = useState(false);
  const [sysNewShow, setSysNewShow] = useState(false);
  const [sysConfirmShow, setSysConfirmShow] = useState(false);
  const [sysPasswordSaving, setSysPasswordSaving] = useState(false);
  const [sysPasswordStatus, setSysPasswordStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [sysPasswordConfirmOpen, setSysPasswordConfirmOpen] = useState(false);
  const [sysPasswordConfirmReveal, setSysPasswordConfirmReveal] = useState(false);
  const closeSystemPasswordConfirm = useCallback(() => {
    if (!sysPasswordSaving) setSysPasswordConfirmOpen(false);
  }, [sysPasswordSaving]);
  const systemPasswordConfirmPanelRef = useModalDialog<HTMLDivElement>({
    open: sysPasswordConfirmOpen,
    onClose: closeSystemPasswordConfirm,
  });
  const verifyCurrentPassword = async () => {
    if (!sysCurrentPassword) return;
    setSysVerifying(true);
    setSysPasswordStatus(null);
    try {
      const r = await fetch("/setup-api/system/credentials/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: sysCurrentPassword }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || t("settings.security.verificationFailed"));
      setSysCurrentVerified(true);
    } catch (err) {
      setSysCurrentVerified(false);
      setSysPasswordStatus({ type: "error", message: err instanceof Error ? err.message : t("settings.security.verificationFailed") });
    } finally {
      setSysVerifying(false);
    }
  };
  const resetSysPasswordForm = () => {
    setSysCurrentPassword(""); setSysCurrentVerified(false);
    setSysPassword(""); setSysPasswordConfirm("");
    setSysPasswordStatus(null);
    setSysPasswordConfirmOpen(false); setSysPasswordConfirmReveal(false);
  };
  const validateNewPassword = (): string | null => {
    if (sysPassword.length < 8) return t("settings.security.errorTooShort");
    if (sysPassword !== sysPasswordConfirm) return t("settings.security.errorMismatch");
    if (sysPassword === sysCurrentPassword) return t("settings.security.errorSameAsCurrent");
    if (/[\r\n\x00-\x1f\x7f]/.test(sysPassword)) return t("settings.security.errorInvalidChars");
    return null;
  };

  const requestSystemPasswordChange = () => {
    if (!sysCurrentVerified) return;
    const err = validateNewPassword();
    if (err) { setSysPasswordStatus({ type: "error", message: err }); return; }
    setSysPasswordStatus(null);
    setSysPasswordConfirmReveal(false);
    setSysPasswordConfirmOpen(true);
  };

  const saveSystemPassword = async () => {
    if (!sysCurrentVerified) return;
    const err = validateNewPassword();
    if (err) { setSysPasswordStatus({ type: "error", message: err }); return; }
    setSysPasswordSaving(true);
    setSysPasswordStatus(null);
    try {
      const r = await fetch("/setup-api/system/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: sysCurrentPassword, password: sysPassword }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || t("settings.security.failed"));
      resetSysPasswordForm();
      setSysPasswordStatus({ type: "success", message: t("settings.security.updateSuccess") });
    } catch (err) {
      setSysPasswordStatus({ type: "error", message: err instanceof Error ? err.message : t("settings.security.failed") });
    } finally {
      setSysPasswordSaving(false);
    }
  };
  // After a device rename the box reboots and reappears at a new .local origin;
  // poll it, then redirect there — with a hard fallback so we never hang if the
  // cross-origin probe is unreliable. Same grace/poll/settle engine as the
  // setup handoff overlays (see useReconnect).
  useReconnect({
    enabled: !!hostnameRebootTo,
    // no-cors: the response is opaque so we can't inspect status, but any
    // fulfilled fetch means TCP+HTTP completed — enough signal the box is back.
    probe: async () => {
      try {
        await fetch(`${hostnameRebootTo}setup-api/setup/status`, {
          method: "GET",
          mode: "no-cors",
          cache: "no-store",
          signal: AbortSignal.timeout(REBOOT_PROBE_TIMEOUT_MS),
        });
        return true;
      } catch {
        return false;
      }
    },
    onReady: () => {
      if (hostnameRebootTo) window.location.replace(hostnameRebootTo);
    },
    graceMs: REBOOT_PROBE_GRACE_MS,
    intervalMs: REBOOT_PROBE_INTERVAL_MS,
    hardTimeoutMs: REBOOT_HARD_REDIRECT_MS,
  });
  const localUrl = hostname ? `${hostname}.local` : "";
  const proto = typeof window !== "undefined" ? window.location.protocol : "http:";
  const port = typeof window !== "undefined" && window.location.port ? `:${window.location.port}` : "";
  const fullLocalUrl = localUrl ? `${proto}//${localUrl}${port}` : "";
  // Prefer the IP: on home networks the access point often drops wired→Wi-Fi
  // mDNS multicast, so `<hostname>.local` resolution is unreliable. The IP is
  // the dependable address; `.local` is shown as a best-effort fallback.
  const ipUrl = ipv4 ? `${proto}//${ipv4}${port}` : "";
  const primaryUrl = ipUrl || fullLocalUrl;
  const primaryLabel = ipv4 || localUrl;
  const [copiedLocalUrl, setCopiedLocalUrl] = useState(false);
  const copyLocalUrl = async () => {
    if (!primaryUrl) return;
    // Shared helper — falls back to the textarea + execCommand path on
    // plain http origins (clawbox.local etc.) where the modern Clipboard
    // API is blocked by the secure-context requirement.
    if (await copyToClipboard(primaryUrl)) {
      setCopiedLocalUrl(true);
      setTimeout(() => setCopiedLocalUrl(false), 1500);
    }
  };

  useEffect(() => {
    fetch("/setup-api/wifi/status").then(r => r.json()).then(d => {
      if (d.connected && d.ssid) setConnectedSSID(d.ssid);
      setWifiQuality({ signalDbm: d.signalDbm ?? null, bitrateMbps: d.bitrateMbps ?? null, pingMs: d.pingMs ?? null });
    }).catch(() => {});
    fetch("/setup-api/wifi/ethernet").then(r => r.json()).then(d => {
      setEthernet({ connected: !!d.connected, iface: d.iface ?? null });
    }).catch(() => {});
    fetch("/setup-api/system/hotspot").then(r => r.json()).then(d => {
      setHotspotEnabled(d.enabled ?? true);
      if (d.ssid) { setHotspotSSID(d.ssid); setHotspotSSIDInput(d.ssid); }
      setHotspotHasPassword(!!d.hasPassword);
      setHotspotActive(!!d.active);
      setHotspotBlockedBy(d.blockedBy ?? null);
    }).catch(() => {});
    fetch("/setup-api/system/hostname").then(r => r.json()).then(d => {
      if (d.hostname) {
        setHostname(d.hostname);
        setHostnameInput(d.hostname);
      }
      if (typeof d.ipv4 === "string") setIpv4(d.ipv4);
    }).catch(() => {});
  }, []);

  const saveHostname = async () => {
    const name = hostnameInput.trim().toLowerCase().replace(/\.local$/, "");
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
      setHostnameStatus({ type: "error", message: t("settings.hostnameInvalid") });
      return;
    }
    if (name === hostname) {
      setHostnameConfirm(false);
      return;
    }
    setHostnameSaving(true);
    setHostnameStatus(null);
    try {
      const res = await fetch("/setup-api/system/hostname", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname: name }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setHostnameStatus({ type: "error", message: data.error || t("settings.hostnameSaveFailed") });
        setHostnameSaving(false);
        setHostnameConfirm(false);
        return;
      }
      setHostnameStatus({ type: "success", message: t("settings.hostnameRestarting", { fqdn: `${name}.local` }) });
      setHostnameConfirm(false);
      const proto = typeof window !== "undefined" ? window.location.protocol : "http:";
      const port = typeof window !== "undefined" && window.location.port ? `:${window.location.port}` : "";
      const newUrl = `${proto}//${name}.local${port}/`;
      setHostnameRebootTo(newUrl);
      try {
        await fetch("/setup-api/system/power", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "restart" }),
        });
      } catch { /* device reboots, connection drops */ }
    } catch (err) {
      setHostnameStatus({ type: "error", message: err instanceof Error ? err.message : t("settings.hostnameSaveFailed") });
      setHostnameSaving(false);
      setHostnameConfirm(false);
    }
  };

  /**
   * What a 200 from the hotspot route actually achieved.
   *
   * `apAction` separates the three things the old `apRestarted: false` collapsed
   * into one: a deliberate deferral (the radio is a client, so bouncing the AP
   * would sever this connection), a clean stop, and a toggle that THREW. Only
   * the last one is a problem, and only it carries a `warning`.
   */
  const readHotspotVerdict = async (res: Response): Promise<string | null> => {
    const data = await res.json().catch(() => ({})) as { apAction?: unknown; warning?: unknown };
    if (data.apAction !== "failed") return null;
    return typeof data.warning === "string" && data.warning.trim()
      ? data.warning
      : "Your hotspot settings were saved, but the hotspot itself did not change.";
  };

  const performHotspotToggle = async (newEnabled: boolean) => {
    setHotspotToggling(true);
    setHotspotApWarning(null);
    try {
      const res = await fetch("/setup-api/system/hotspot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: hotspotSSID, enabled: newEnabled }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
      // The switch follows the SAVED setting, which did change. What may not
      // have changed is the radio, and that is what the warning is for — the
      // "off" case especially, where a box goes on broadcasting behind a
      // control that says it stopped.
      setHotspotEnabled(newEnabled);
      setHotspotApWarning(await readHotspotVerdict(res));
    } catch { /* leave state unchanged */ } finally {
      setHotspotToggling(false);
    }
  };

  const toggleHotspot = () => {
    const newEnabled = !hotspotEnabled;
    // Enabling the AP while WiFi is the uplink will drop the WiFi connection
    // (single radio). Confirm so the user isn't surprised.
    if (newEnabled && connectedSSID && !ethernet.connected) {
      setHotspotConfirmEnable(true);
      return;
    }
    void performHotspotToggle(newEnabled);
  };

  const saveHotspotSSID = async () => {
    const next = hotspotSSIDInput.trim();
    if (!next) {
      setHotspotSSIDStatus({ type: "error", message: "Hotspot name is required" });
      return;
    }
    if (next.length > 32) {
      setHotspotSSIDStatus({ type: "error", message: "Hotspot name must be 32 characters or less" });
      return;
    }
    if (next === hotspotSSID) return;
    setHotspotSSIDSaving(true);
    setHotspotSSIDStatus(null);
    try {
      const res = await fetch("/setup-api/system/hotspot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: next, enabled: hotspotEnabled ?? true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed");
      }
      setHotspotSSID(next);
      // The AP verdict lives in ONE place — the card-level warning — and is
      // written on every AP outcome, `null` included. Setting it only on
      // failure would leave a stale warning from an earlier failed toggle
      // sitting over a save that has since worked, which is the same class of
      // wrong answer this PR is about. The field status stays about the field:
      // the name WAS saved, whatever the radio did.
      setHotspotApWarning(await readHotspotVerdict(res));
      setHotspotSSIDStatus({ type: "success", message: "Hotspot name updated" });
    } catch (err) {
      setHotspotSSIDStatus({ type: "error", message: err instanceof Error ? err.message : "Failed" });
    } finally {
      setHotspotSSIDSaving(false);
    }
  };

  const saveHotspotPassword = async () => {
    if (hotspotPassword.length < 8) {
      setHotspotPasswordStatus({ type: "error", message: t("credentials.hotspotPasswordMinLength") });
      return;
    }
    if (hotspotPassword.length > 63) {
      setHotspotPasswordStatus({ type: "error", message: "Password must be 63 characters or less" });
      return;
    }
    setHotspotPasswordSaving(true);
    setHotspotPasswordStatus(null);
    try {
      const res = await fetch("/setup-api/system/hotspot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: hotspotSSID, password: hotspotPassword, enabled: hotspotEnabled ?? true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed");
      }
      setHotspotHasPassword(true);
      setHotspotPassword("");
      // Same rule as the SSID save above: one home for the AP verdict, written
      // on every outcome so a later success clears an earlier failure.
      setHotspotApWarning(await readHotspotVerdict(res));
      setHotspotPasswordStatus({ type: "success", message: "Hotspot password updated" });
    } catch (err) {
      setHotspotPasswordStatus({ type: "error", message: err instanceof Error ? err.message : "Failed" });
    } finally {
      setHotspotPasswordSaving(false);
    }
  };

  const connectWifi = async () => {
    if (!ssid.trim()) return;
    setWifiConnecting(true);
    setWifiStatus(null);
    try {
      const res = await fetch("/setup-api/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: ssid.trim(), password: wifiPass }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
      setWifiStatus({ type: "success", message: t("settings.connectedTo", { ssid }) });
      setConnectedSSID(ssid.trim());
      setSsid("");
      setWifiPass("");
    } catch (err) {
      setWifiStatus({ type: "error", message: err instanceof Error ? err.message : t("settings.connectionFailed") });
    } finally {
      setWifiConnecting(false);
    }
  };

  /* ── AI Provider ── */
  const [aiProvider, setAiProvider] = useState<{ connected: boolean; provider: string | null; providerLabel: string | null; mode: string | null; model: string | null; clawaiTier: "flash" | "pro" | null } | null>(null);
  useEffect(() => {
    if (section !== "ai" && !isMobile) return;
    const load = () => {
      fetch("/setup-api/ai-models/status", { cache: "no-store" }).then(r => r.json()).then(setAiProvider).catch(() => {});
    };
    load();
    // And again whenever the providers change. This card names the ACTIVE
    // provider and its model, so a default chosen from the strip directly above
    // it made the two disagree on screen — the strip showing the new default
    // while the card underneath still named the old one — until the section was
    // left and re-entered. Seen on a live box, in the same window.
    return onProvidersChanged(load);
  }, [section, isMobile]);

  // Device EDITION (openclaw | hermes | dual), tracked the same way AIModelsStep
  // tracks its own copy — seeded from the immutable cache, then confirmed once.
  // It gates exactly one thing here: whether the AI section's own Status card is
  // drawn. On the Hermes edition that card is the hero's twin (same provider,
  // same model, same "connected"), so it is suppressed there and the hero is the
  // single source. On openclaw and dual there is no hero — AIModelsStep renders
  // the OpenClaw picker — so the card stays and is unchanged. Keyed on edition,
  // not the active harness: a dual box's active harness can be hermes while its
  // AI panel is still the OpenClaw picker, which needs the card.
  const [edition, setEdition] = useState<string | null>(() => cachedEdition());
  useEffect(() => {
    if (edition !== null) return;
    let alive = true;
    void fetchHarness().then((d) => {
      if (alive) setEdition(d?.edition || "openclaw");
    });
    return () => { alive = false; };
  }, [edition]);

  // Only the sidebar subtitle reads this; the pane itself (LocalAiPanel) polls
  // its own inventory. Read once when the section opens and again when the
  // providers change — the subtitle names the configured model, which changes
  // through actions, not on its own.
  const [localAiStatus, setLocalAiStatus] = useState<{ configured: boolean; provider: string | null; model: string | null } | null>(null);
  const localTabOpen = section === "localAi";
  useEffect(() => {
    if (!localTabOpen && !isMobile) return;
    const load = () => {
      fetch("/setup-api/setup/status", { cache: "no-store" })
        .then(r => r.json())
        .then(data => setLocalAiStatus({
          configured: !!data.local_ai_configured,
          provider: typeof data.local_ai_provider === "string" ? data.local_ai_provider : null,
          model: typeof data.local_ai_model === "string" ? data.local_ai_model : null,
        }))
        .catch(() => setLocalAiStatus({ configured: false, provider: null, model: null }));
    };
    load();
    return onProvidersChanged(load);
  }, [localTabOpen, isMobile]);

  // Same shape for the coding agent: the sidebar's "On · Max effort" line is
  // the only reader here. Read once when the section opens (or on mobile,
  // where the subtitle is visible from the list), then let the panel hand
  // over every status the route answers with — the switch changes through
  // actions on that panel, not on its own.


  /**
   * WHO NEEDS A CHANNEL'S STATUS.
   *
   * Not just that channel's own pane. The Channels hub draws a live dot and a
   * status line per channel from the very same state, and the four status
   * fetches used to be gated on `section === "<that channel>"` alone — so a
   * cold open of the hub asked nothing and drew every configured channel with
   * no dot and its static hint, exactly as if it were not set up. The owner
   * read that as "not configured" and it only corrected itself once he had
   * opened each pane.
   *
   * The reader stays the harness's own edition-aware status route
   * (/setup-api/<channel>/status); the hub and the pane just share it.
   *
   * ENTERING A PANE STILL RE-ASKS. An earlier revision gated each effect on a
   * boolean that was already `true` on the hub and stayed `true` in the pane,
   * so the channel was probed exactly once per Settings mount — and a status
   * that failed on the cold read could never be retried: the pane it opened
   * sat on its loading skeleton with no request outstanding. That is the
   * probe-once class this file is supposed to be rid of. Each effect keeps
   * `section` in its dependencies, as it did before the hub existed, so every
   * arrival at a channel is a fresh read; the routes' own memos absorb the
   * repeat.
   *
   * Cost: a cold hub open asks all four at once. The fan-out itself is not new
   * — `openclaw-channels.ts` already notes that on mobile, where the panels'
   * `!isMobile` escapes never return early, one section change re-reads every
   * channel — and what bounds it is server-side and per route, not uniform:
   * the shared `channels status` memo (15 s) on the OpenClaw edition, each
   * route's own `HERMES_PROBE_TTL` (15 s) on Hermes, plus 60 s bot-info caches
   * on Telegram and Discord. `/setup-api/email/status` has no memo and needs
   * none — it is a config read with no shell-out. Seeding every channel from
   * ONE `channels status` spawn is TASK-694.
   */
  /**
   * The newest status request per channel.
   *
   * The hub, the pane and every save can have reads in flight at once now that
   * arriving at a pane re-asks. Responses are not ordered, so an older one
   * landing last would write its stale answer over a newer one — turning a
   * just-saved channel back into "not configured". Each refresher claims a
   * generation before it fetches and writes nothing, not even the settled
   * mark, once it has been superseded.
   */
  const channelReqRef = useRef<Record<ChannelSection, number>>({
    telegram: 0,
    email: 0,
    whatsapp: 0,
    discord: 0,
  });
  const claimChannelRead = useCallback(
    (id: ChannelSection) => {
      const gen = channelReqRef.current[id] + 1;
      channelReqRef.current[id] = gen;
      return () => channelReqRef.current[id] === gen;
    },
    [],
  );

  /**
   * Channels whose status route has ANSWERED ONE WAY OR THE OTHER.
   *
   * All four refreshers deliberately keep the last known value when the route
   * 5xxs or the network drops, which is right for a pane that already has one.
   * On a cold hub open there is no last value, so without this a failed read is
   * indistinguishable from a read still in flight: the row would pulse "still
   * asking" for the life of the session over a question nobody is still asking.
   */
  const [settledChannels, setSettledChannels] = useState<ReadonlySet<ChannelSection>>(
    () => new Set(),
  );
  const markChannelSettled = useCallback((id: ChannelSection) => {
    setSettledChannels((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  /**
   * Put a channel back to "being asked".
   *
   * Retrying an unreadable row otherwise changed nothing on screen for the two
   * seconds the CLI takes, and changed nothing again if it failed — a dead
   * press, twice. Dropping the settled mark first makes the row honestly
   * `unknown` ("Checking…", pulsing) for the duration and land on whichever
   * state is true afterwards.
   */
  const unsettleChannel = useCallback((id: ChannelSection) => {
    setSettledChannels((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  /**
   * The hub row's navigating button, per channel.
   *
   * A Retry is rendered only while its row is unreachable, so pressing it
   * unmounts it — and a focused element that disappears drops focus to
   * `<body>`, leaving a keyboard or screen-reader owner nowhere, twice: once
   * while the read runs and again when it lands. Focus moves here instead,
   * which is the control whose accessible name carries the channel's state, so
   * focus follows the answer rather than falling out of the page.
   */
  const channelRowRefs = useRef<Partial<Record<ChannelSection, HTMLButtonElement | null>>>({});
  /** The WhatsApp pane's own root, for the same reason. */
  const whatsappPaneRef = useRef<HTMLDivElement | null>(null);

  /* ── Telegram ── */
  const [tgToken, setTgToken] = useState("");
  const [tgShowToken, setTgShowToken] = useState(false);
  const [tgSaving, setTgSaving] = useState(false);
  const [tgConfiguring, setTgConfiguring] = useState(false);
  const [tgStatus, setTgStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [tgConfigured, setTgConfigured] = useState<boolean | null>(null);
  const [tgBotInfo, setTgBotInfo] = useState<{ username?: string; firstName?: string; link?: string } | null>(null);
  const [tgReconfigure, setTgReconfigure] = useState(false);
  // Promise the overlay awaits before declaring "ready". Resolves when
  // POST /telegram/configure returns success; rejects on failure. This
  // prevents the overlay from completing based on gateway-health alone —
  // during the restart window the old gateway can still answer /health
  // until it actually goes down, which would falsely flash "ready" at
  // the user before the new bot is live.
  const [tgConfigurePromise, setTgConfigurePromise] = useState<Promise<void> | undefined>(undefined);
  const tgSaveControllerRef = useRef<AbortController | null>(null);
  // Telegram progress streaming (the live "Bubbling…" tool-progress drafts).
  // null = loading; default ON when unset on the device.
  const [tgStreaming, setTgStreaming] = useState<boolean | null>(null);
  const [tgStreamingPending, setTgStreamingPending] = useState(false);
  // Telegram pairing / user-access state.
  const [tgApproved, setTgApproved] = useState<Array<{ id: string; name?: string }>>([]);
  const [tgPending, setTgPending] = useState<Array<{ code?: string; id?: string; name?: string; createdAt?: string }> | null>(null);
  const [tgPendingLoading, setTgPendingLoading] = useState(false);
  const [tgPairingCode, setTgPairingCode] = useState("");
  const [tgApproving, setTgApproving] = useState(false);
  const [tgPairingStatus, setTgPairingStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const refreshTelegramStatus = useCallback(async () => {
    const isCurrent = claimChannelRead("telegram");
    try {
      const r = await fetch("/setup-api/telegram/status", { cache: "no-store" });
      if (!isCurrent()) return;
      if (!r.ok) {
        // Don't clobber existing state on a transient error (gateway
        // restarting, 5xx, etc.) — keep the last known bot info visible.
        console.warn("[telegram] /setup-api/telegram/status returned", r.status);
        return;
      }
      const d = await r.json();
      if (!isCurrent()) return;
      setTgConfigured(d.configured ?? false);
      if (d.configured && d.username) {
        setTgBotInfo({ username: d.username, firstName: d.firstName, link: d.link });
      } else {
        setTgBotInfo(null);
      }
    } catch (err) {
      // Network error — likewise keep the last known state instead of
      // flashing "not configured" at the user mid-restart.
      console.warn("[telegram] refresh failed:", err);
    } finally {
      if (isCurrent()) markChannelSettled("telegram");
    }
  }, [markChannelSettled, claimChannelRead]);

  const refreshPairing = useCallback(async () => {
    try {
      const r = await fetch("/setup-api/telegram/pairing", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d.approved)) setTgApproved(d.approved);
    } catch {
      // keep last known approved list on a transient error
    }
  }, []);

  // The status the hub's dot and the pane's card both read.
  //
  // `unsettleChannel` first, and never without the read that follows it: a
  // channel whose hub read failed keeps its settled mark, so entering its pane
  // drew "Could not check" for the whole duration of the pane's OWN fresh read
  // and only then flipped. That is the round-3 pulse pointing the other way —
  // claiming the question is unanswerable while it is being asked. The other
  // three status effects below do the same, for the same reason.
  useEffect(() => {
    if (!isMobile && section !== "telegram" && section !== "channels") return;
    unsettleChannel("telegram");
    refreshTelegramStatus();
  }, [section, isMobile, refreshTelegramStatus, unsettleChannel]);

  // Pane-only detail — the approved list and the streaming toggle have no
  // reader on the hub, so the hub must not pay for them.
  useEffect(() => {
    if (section !== "telegram" && !isMobile) return;
    refreshPairing();
    fetch("/setup-api/telegram/streaming", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setTgStreaming(d ? d.enabled !== false : true))
      .catch(() => setTgStreaming(true));
  }, [section, isMobile, refreshPairing]);

  // Refresh the approved/pending lists when an approval happens anywhere (e.g.
  // the desktop popup) so the Settings list updates without a manual reload.
  useEffect(() => {
    const onApproved = (e: Event) => {
      const code = (e as CustomEvent<{ code?: string }>).detail?.code;
      refreshPairing();
      if (code) setTgPending((prev) => (prev ? prev.filter((req) => !samePairingToken(req.code, code)) : prev));
    };
    window.addEventListener("clawbox:telegram-approved", onApproved);
    return () => window.removeEventListener("clawbox:telegram-approved", onApproved);
  }, [refreshPairing]);

  const toggleTelegramStreaming = useCallback(async (next: boolean) => {
    const prev = tgStreaming;
    setTgStreamingPending(true);
    setTgStreaming(next); // optimistic
    try {
      const res = await fetch("/setup-api/telegram/streaming", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      // 502 = saved but gateway restart failed; the setting still persisted,
      // so keep the optimistic value rather than reverting.
      if (!res.ok && res.status !== 502) {
        setTgStreaming(prev); // revert on a real failure
      }
    } catch {
      setTgStreaming(prev);
    } finally {
      setTgStreamingPending(false);
    }
  }, [tgStreaming]);

  const loadPending = useCallback(async () => {
    setTgPendingLoading(true);
    setTgPairingStatus(null);
    try {
      const r = await fetch("/setup-api/telegram/pairing?pending=1", { cache: "no-store" });
      const d = await r.json();
      if (r.ok) {
        setTgPending(Array.isArray(d.pending) ? d.pending : []);
        if (Array.isArray(d.approved)) setTgApproved(d.approved);
      } else {
        setTgPairingStatus({ type: "error", message: d.error || t("settings.pairingCheckFailed") });
      }
    } catch {
      setTgPairingStatus({ type: "error", message: t("settings.pairingCheckFailed") });
    } finally {
      setTgPendingLoading(false);
    }
  }, [t]);

  const approvePairingCode = useCallback(async (rawCode: string) => {
    // Either the 8-char code the bot DM'd, or a Hermes request id from the
    // pending list — see src/lib/telegram-pairing-token.ts.
    const code = normalizePairingToken(rawCode);
    if (!isPairingToken(code)) {
      setTgPairingStatus({ type: "error", message: t("settings.pairingInvalidCode") });
      return;
    }
    setTgApproving(true);
    setTgPairingStatus(null);
    try {
      const r = await fetch("/setup-api/telegram/pairing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const d = await r.json();
      if (r.ok && d.success) {
        if (Array.isArray(d.approved)) setTgApproved(d.approved);
        setTgPairingCode("");
        setTgPending((prev) => (prev ? prev.filter((req) => !samePairingToken(req.code, code)) : prev));
        window.dispatchEvent(new CustomEvent("clawbox:telegram-approved", { detail: { code } }));
        setTgPairingStatus({ type: "success", message: t("settings.pairingApproveSuccess") });
      } else {
        setTgPairingStatus({ type: "error", message: d.error || t("settings.pairingApproveFailed") });
      }
    } catch {
      setTgPairingStatus({ type: "error", message: t("settings.pairingApproveFailed") });
    } finally {
      setTgApproving(false);
    }
  }, [t]);

  const saveTelegram = async () => {
    if (!tgToken.trim()) {
      setTgStatus({ type: "error", message: t("settings.enterToken") });
      return;
    }
    tgSaveControllerRef.current?.abort();
    const controller = new AbortController();
    tgSaveControllerRef.current = controller;
    setTgSaving(true);
    setTgConfiguring(true);
    setTgStatus(null);

    // Resolver/rejecter exposed so the overlay can await the configure
    // outcome in parallel with its own gateway-health poll. Only when
    // BOTH succeed does the overlay transition to its final "ready"
    // phase — see TelegramConfiguringOverlay's `waitFor` prop.
    const {
      promise: configurePromise,
      resolve: configureResolve,
      reject: configureReject,
    } = Promise.withResolvers<void>();
    // Swallow the rejection at the promise level so unhandled-rejection
    // doesn't fire; the overlay handles the failed state via its own
    // error path (we also call setTgConfiguring(false) below).
    configurePromise.catch(() => {});
    setTgConfigurePromise(configurePromise);

    try {
      const res = await fetch("/setup-api/telegram/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: tgToken.trim() }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        configureReject(new Error("aborted"));
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        configureReject(new Error(data.error || "configure failed"));
        setTgConfiguring(false);
        setTgStatus({ type: "error", message: data.error || t("settings.failedSave") });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) {
        configureReject(new Error("aborted"));
        return;
      }
      if (data.success) {
        configureResolve();
        setTgStatus({ type: "success", message: t("settings.telegramConfigured") });
        setTgConfigured(true);
        setTgReconfigure(false);
        setTgToken("");
        // A token change resets the allowlist server-side; clear the lists
        // optimistically and re-fetch so the UI reflects the fresh bot without
        // a manual reload.
        if (data.reset) {
          setTgApproved([]);
          setTgPending(null);
          setTgPairingStatus(null);
        }
        refreshPairing();
      } else {
        configureReject(new Error(data.error || "configure returned success=false"));
        setTgConfiguring(false);
        setTgStatus({ type: "error", message: data.error || t("settings.failedSave") });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        configureReject(err);
        return;
      }
      configureReject(err);
      setTgConfiguring(false);
      setTgStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    } finally {
      if (!controller.signal.aborted) setTgSaving(false);
    }
  };

  /* ── Email (SMTP) ── */
  // Gmail's submission endpoint, used only to prefill the form. The device
  // itself has no Gmail-specific path: any SMTP server works.
  const GMAIL_SMTP_HOST = "smtp.gmail.com";
  // Only ever a placeholder now: leaving the incoming-server field blank lets
  // the device derive it from the outgoing one.
  const GMAIL_IMAP_HOST = "imap.gmail.com";
  const [emailStatus, setEmailStatus] = useState<EmailStatus | null>(null);
  const [emailAddress, setEmailAddress] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailShowPassword, setEmailShowPassword] = useState(false);
  const [emailHost, setEmailHost] = useState(GMAIL_SMTP_HOST);
  const [emailPort, setEmailPort] = useState("587");
  const [emailMode, setEmailMode] = useState<EmailMode>("send");
  // Empty means "derive it from the outgoing server" — the panel only sends a
  // value when the user typed one, so smtp.gmail.com keeps implying
  // imap.gmail.com without pinning it into the saved config.
  const [emailImapHost, setEmailImapHost] = useState("");
  const [emailAllowedSenders, setEmailAllowedSenders] = useState("");
  const [emailAskBeforeSend, setEmailAskBeforeSend] = useState(true);
  const [emailPending, setEmailPending] = useState<PendingEmail[]>([]);
  const [emailHandled, setEmailHandled] = useState<HandledEmail[]>([]);
  const [emailPendingBusy, setEmailPendingBusy] = useState<string | null>(null);
  const [emailLostDraft, setEmailLostDraft] = useState<LostDraft | null>(null);
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailTesting, setEmailTesting] = useState(false);
  const [emailReconfigure, setEmailReconfigure] = useState(false);
  // `info` is the third tone, and it exists because two are not enough here: a
  // send the box handed over and never heard back is neither a success nor a
  // failure, and both of the other two are a claim nothing can support.
  const [emailMsg, setEmailMsg] = useState<{ type: "success" | "error" | "info"; message: string } | null>(null);
  const emailSaveControllerRef = useRef<AbortController | null>(null);
  const [chatApproval, setChatApproval] = useState<ChatApprovalState | null>(null);
  const [chatApprovalToken, setChatApprovalToken] = useState("");
  const [chatApprovalBusy, setChatApprovalBusy] = useState(false);

  const refreshEmailStatus = useCallback(async () => {
    const isCurrent = claimChannelRead("email");
    try {
      const r = await fetch("/setup-api/email/status", { cache: "no-store" });
      if (!isCurrent() || !r.ok) return;
      const d = await r.json();
      if (!isCurrent()) return;
      // Every field is guarded: the component test's fetch stub answers unknown
      // URLs with {}, and a transient 5xx must not blank the panel either.
      setEmailStatus({
        configured: d?.configured === true,
        address: typeof d?.address === "string" ? d.address : null,
        smtpHost: typeof d?.smtpHost === "string" ? d.smtpHost : null,
        smtpPort: typeof d?.smtpPort === "number" ? d.smtpPort : null,
        imapHost: typeof d?.imapHost === "string" ? d.imapHost : null,
        allowedSenders: Array.isArray(d?.allowedSenders)
          ? d.allowedSenders.filter((s: unknown): s is string => typeof s === "string")
          : [],
        inbound: d?.inbound === true,
        inboundSupported: d?.inboundSupported === true,
        mode: d?.mode === "read" || d?.mode === "answer" ? d.mode : "send",
        imapHostExplicit: typeof d?.imapHostExplicit === "string" ? d.imapHostExplicit : null,
        // Absent means an older device that has no gate — reporting `false`
        // matches what such a device actually does.
        askBeforeSend: d?.askBeforeSend === true,
        pendingCount: typeof d?.pendingCount === "number" ? d.pendingCount : 0,
      });
    } catch {
      // keep the last known state rather than flashing "not configured"
    } finally {
      if (isCurrent()) markChannelSettled("email");
    }
  }, [markChannelSettled, claimChannelRead]);

  /**
   * The approval queue. Session-gated server-side (the MCP bearer is refused
   * there on purpose), so this only ever succeeds for a logged-in browser.
   */
  const refreshEmailPending = useCallback(async () => {
    try {
      const r = await fetch("/setup-api/email/pending", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      setEmailPending(
        Array.isArray(d?.pending)
          ? d.pending
              .filter((p: unknown): p is PendingEmail => typeof p === "object" && p !== null)
              .map((p: Record<string, unknown>) => ({
                id: String(p.id ?? ""),
                to: Array.isArray(p.to) ? p.to.filter((x): x is string => typeof x === "string") : [],
                subject: typeof p.subject === "string" ? p.subject : "",
                preview: typeof p.preview === "string" ? p.preview : "",
                createdAt: typeof p.createdAt === "number" ? p.createdAt : 0,
              }))
          : [],
      );
      // Read out of the SAME response as the queue, never a second request:
      // two requests can catch a draft in neither answer, and the panel would
      // then show the one state that is never true — no draft, and no word
      // about where it went.
      setEmailHandled(
        Array.isArray(d?.outcomes)
          ? d.outcomes
              .filter((o: unknown): o is Record<string, unknown> => typeof o === "object" && o !== null)
              .filter(
                (o: Record<string, unknown>) =>
                  typeof o.id === "string"
                  && typeof o.at === "number"
                  && (o.kind === "sent" || o.kind === "rejected" || o.kind === "failed"
                    || o.kind === "unconfirmed" || o.kind === "duplicate"),
              )
              .map((o: Record<string, unknown>): HandledEmail => ({
                id: String(o.id),
                kind: o.kind as HandledEmail["kind"],
                at: o.at as number,
                to: Array.isArray(o.to) ? o.to.filter((x): x is string => typeof x === "string") : [],
                subject: typeof o.subject === "string" ? o.subject : "",
                ...(typeof o.error === "string" ? { error: o.error } : {}),
              }))
          : [],
      );
    } catch {
      // keep the last known queue rather than blanking the strip
    }
  }, []);

  const refreshChatApproval = useCallback(async () => {
    try {
      const r = await fetch("/setup-api/email/chat-approval", { cache: "no-store" });
      if (!r.ok) return;
      setChatApproval(parseChatApprovalState(await r.json()));
    } catch {
      // keep the last known state
    }
  }, []);

  // The status the hub's dot and the pane's card both read. Unsettle-then-read,
  // as on the Telegram effect above.
  useEffect(() => {
    if (!isMobile && section !== "email" && section !== "channels") return;
    unsettleChannel("email");
    refreshEmailStatus();
  }, [section, isMobile, refreshEmailStatus, unsettleChannel]);

  // Pane-only detail — the approvals strip and the chat-approval bot.
  useEffect(() => {
    if (section !== "email" && !isMobile) return;
    refreshEmailPending();
    refreshChatApproval();
  }, [section, isMobile, refreshEmailPending, refreshChatApproval]);

  /**
   * KEEP THE QUEUE HONEST WHILE THE PANEL IS OPEN.
   *
   * The approval strip used to be fetched on mount and after this panel's own
   * buttons, and nowhere else — so a draft approved ANYWHERE ELSE went on being
   * listed here as if it were still waiting. That was true of the chat card and
   * of a second browser tab already, and it is unavoidable now that a draft can
   * be approved from Telegram, where this page is not even open.
   *
   * A stale entry in an approvals list is not a cosmetic bug: the owner reads
   * it as "this message has not gone out", and the honest answers are either to
   * re-approve something already sent or to delete a draft that no longer
   * exists. So the strip re-reads the server whenever this tab could have
   * missed something — when it comes back to the foreground, and on a slow tick
   * while it is being looked at.
   *
   * Only while the section is actually on screen, and stopped the moment it is
   * not: this is a Jetson serving its own UI, and a poll that runs behind a
   * hidden tab is a poll nobody is reading.
   *
   * Which is why the guard is `emailPanelVisible` and not the `&& !isMobile`
   * shape the one-shot fetches above use. That shape inverts on a phone —
   * `!isMobile` is false, so the early return never fires and the section is
   * never consulted — and the WhatsApp heartbeat above learned the same lesson
   * the expensive way: an interval that could not be stopped by browsing away.
   * An extra GET on mount costs nothing; a timer that never stops does.
   */
  const emailPanelVisible = isMobile ? mobileSection === "email" : section === "email";

  useEffect(() => {
    if (!emailPanelVisible) return;
    // The pacing — interval, focus, visible-edge, and never behind a hidden tab
    // — is `installPendingRefresh`, shared with the chat surface's batch card so
    // the two cannot drift into disagreeing about how fresh this list is.
    return installPendingRefresh(() => {
      refreshEmailStatus();
      refreshEmailPending();
      // The panel's own state can go stale the same way: an owner who pairs
      // with the approvals bot in Telegram while this is open should stop
      // being told nobody can be asked.
      refreshChatApproval();
    });
  }, [emailPanelVisible, refreshEmailStatus, refreshEmailPending, refreshChatApproval]);

  /** Save a token, flip the switch, or forget the bot. One busy flag for all three. */
  const submitChatApproval = async (body: { enabled?: boolean; botToken?: string } | null) => {
    setChatApprovalBusy(true);
    setEmailMsg(null);
    try {
      const r = await fetch("/setup-api/email/chat-approval", {
        method: body === null ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setEmailMsg({ type: "error", message: typeof d?.error === "string" ? d.error : t("settings.failedSave") });
        return;
      }
      setChatApproval(parseChatApprovalState(d));
      setChatApprovalToken("");
    } catch {
      setEmailMsg({ type: "error", message: t("settings.failedSave") });
    } finally {
      setChatApprovalBusy(false);
    }
  };

  /**
   * Open the setup form on what is actually saved, rather than on the defaults.
   *
   * Done here, in the click, and not in an effect keyed on the status: an effect
   * would also fire on every background refresh and overwrite whatever the user
   * was halfway through typing.
   */
  const openEmailReconfigure = () => {
    setEmailMsg(null);
    if (emailStatus?.configured) {
      setEmailMode(emailStatus.mode);
      setEmailAskBeforeSend(emailStatus.askBeforeSend);
      // The outgoing server too, not only the new fields: leaving these at
      // the Gmail defaults means a Fastmail box reopens the form showing
      // smtp.gmail.com:587, and an owner who only retypes their password
      // saves that host over the working one.
      if (emailStatus.smtpHost) setEmailHost(emailStatus.smtpHost);
      if (emailStatus.smtpPort) setEmailPort(String(emailStatus.smtpPort));
      setEmailImapHost(emailStatus.imapHostExplicit ?? "");
      setEmailAllowedSenders(emailStatus.allowedSenders.join(", "));
    }
    setEmailReconfigure(true);
  };

  const decidePending = async (id: string, action: "approve" | "reject") => {
    setEmailPendingBusy(id);
    setEmailMsg(null);
    setEmailLostDraft(null);
    try {
      const res = await fetch("/setup-api/email/pending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        /**
         * A decision somebody already made is NOT this click failing — but only
         * when it is the decision this click was asking for.
         *
         * The owner tapped *Approve & send* in Telegram, the message went out,
         * and this row was still on screen because the queue is re-read on a
         * schedule. The route answers 404 "no longer waiting" — correctly, this
         * request did nothing — and painting that red put a failure over a send
         * that succeeded, directly above the green "Sent ✓" the handled strip
         * was about to show for the same message.
         *
         * KEYED ON THE GESTURE, because the two directions are not symmetric and
         * reading the ending alone gets both of the crossed cases backwards.
         * *Discard* answered `sent` is the worst outcome available on that click
         * — the owner asked for a message NOT to go out and it went out — and a
         * green banner there congratulates him for it. *Approve & send* answered
         * `rejected` means nothing was sent and nothing will be; the words are
         * honest, and the colour is what is read first.
         *
         * `duplicate` is good news either way: an identical message reached the
         * recipient, so the send happened and this copy is not waiting. An
         * ending of `failed` or `unconfirmed`, and a 404 with no ending at all,
         * stay red — all three are something to look at.
         */
        const ending = typeof data?.ending === "string" ? data.ending : "";
        const asAsked =
          action === "approve"
            ? ending === "sent" || ending === "duplicate"
            : ending === "rejected" || ending === "duplicate";
        /**
         * Neither a success nor a failure, and it needs its own tone.
         *
         * The 502 from an approve carries the receipt's ending too, and
         * `unconfirmed` means the box handed the message over and never heard
         * back. Red "Could not send the message." there is a positive claim
         * nothing in this process can support — and one `refreshEmailPending()`
         * later the handled strip below says "Could not be confirmed — check
         * your Sent folder" about the very same draft. Two verdicts on one
         * screen, and the definite one is the one the owner acts on, by mailing
         * the recipient twice. `info` is the amber StatusMessage already has;
         * the words are the strip's own.
         */
        const unconfirmed = ending === "unconfirmed";
        setEmailMsg({
          type: unconfirmed ? "info" : asAsked ? "success" : "error",
          message: unconfirmed
            ? t("settings.emailHandledUnconfirmed")
            : data?.error || t("settings.emailApproveFailed"),
        });
        // The route claims a draft before it sends, so a failed send has
        // already taken it out of the queue and refreshEmailPending() is about
        // to remove the row. Hold what it handed back, or the message the
        // owner approved disappears from the screen with the error.
        const lost: unknown = data?.draft;
        if (lost && typeof lost === "object") {
          const d = lost as Partial<LostDraft>;
          if (Array.isArray(d.to) && typeof d.subject === "string" && typeof d.body === "string") {
            setEmailLostDraft({ to: d.to.map(String), subject: d.subject, body: d.body, unconfirmed });
          }
        }
      } else {
        setEmailMsg({
          type: "success",
          message: action === "approve" ? t("settings.emailApproved") : t("settings.emailRejected"),
        });
      }
    } catch (err) {
      setEmailMsg({ type: "error", message: err instanceof Error ? err.message : t("settings.emailApproveFailed") });
    } finally {
      setEmailPendingBusy(null);
      refreshEmailPending();
      refreshEmailStatus();
    }
  };

  const saveEmail = async () => {
    if (!emailAddress.trim()) {
      setEmailMsg({ type: "error", message: t("settings.emailEnterAddress") });
      return;
    }
    if (!emailPassword) {
      setEmailMsg({ type: "error", message: t("settings.emailEnterPassword") });
      return;
    }
    emailSaveControllerRef.current?.abort();
    const controller = new AbortController();
    emailSaveControllerRef.current = controller;
    setEmailSaving(true);
    setEmailMsg(null);
    try {
      const res = await fetch("/setup-api/email/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: emailAddress.trim(),
          password: emailPassword,
          smtpHost: emailHost.trim(),
          smtpPort: Number(emailPort) || 587,
          mode: emailMode,
          askBeforeSend: emailAskBeforeSend,
          // Only ever the EXPLICIT override. Left blank, the device derives it
          // from the outgoing server (smtp.gmail.com -> imap.gmail.com).
          imapHost: emailMode === "send" ? "" : emailImapHost.trim(),
          allowedSenders: emailMode === "answer" ? emailAllowedSenders : "",
        }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        setEmailMsg({ type: "error", message: data?.error || t("settings.failedSave") });
        return;
      }
      // The app password is in memory for as long as this panel is open;
      // drop it the moment the device has accepted it.
      setEmailPassword("");
      setEmailReconfigure(false);
      refreshEmailPending();
      setEmailMsg({
        type: data.warning ? "error" : "success",
        message: data.warning || t("settings.emailConfigured"),
      });
      refreshEmailStatus();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setEmailMsg({ type: "error", message: err instanceof Error ? err.message : t("settings.failedSave") });
    } finally {
      if (!controller.signal.aborted) setEmailSaving(false);
    }
  };

  const sendTestEmail = async () => {
    setEmailTesting(true);
    setEmailMsg(null);
    try {
      const res = await fetch("/setup-api/email/test", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        setEmailMsg({ type: "error", message: data?.error || t("settings.emailTestFailed") });
        return;
      }
      setEmailMsg({
        type: "success",
        message: t("settings.emailTestSent", { address: emailStatus?.address || "" }),
      });
    } catch (err) {
      setEmailMsg({ type: "error", message: err instanceof Error ? err.message : t("settings.emailTestFailed") });
    } finally {
      setEmailTesting(false);
    }
  };

  const disconnectEmail = async () => {
    setEmailSaving(true);
    setEmailMsg(null);
    try {
      const res = await fetch("/setup-api/email/configure", { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        setEmailMsg({ type: "error", message: data?.error || t("settings.failedSave") });
        return;
      }
      setEmailReconfigure(false);
      setEmailMode("send");
      setEmailPending([]);
      // The receipts go with the queue — the route clears them server-side for
      // the same reason, and leaving them on screen would keep the disconnected
      // account's recipients and subjects up until the next poll.
      setEmailHandled([]);
      // And the same for the one draft this panel keeps in full. It is rendered
      // on its own condition, not on `configured`, so a failed send from the
      // account just disconnected would sit there — recipients, subject and
      // body — until another approval happened to fail.
      setEmailLostDraft(null);
      setEmailMsg({ type: "success", message: t("settings.emailDisconnected") });
      refreshEmailStatus();
    } catch (err) {
      setEmailMsg({ type: "error", message: err instanceof Error ? err.message : t("settings.failedSave") });
    } finally {
      setEmailSaving(false);
    }
  };

  /* ── WhatsApp ──
   *
   * The panel owns the whole channel now, pairing included: /whatsapp/pair
   * drives the same Baileys bridge `hermes whatsapp` drives and hands back the
   * raw QR payload, so the QR below is rendered from real pairing material
   * rather than instructions to go and find a terminal. */
  const [waStatus, setWaStatus] = useState<WhatsappStatus | null>(null);
  const [waNumber, setWaNumber] = useState("");
  const [waSaving, setWaSaving] = useState(false);
  const [waMsg, setWaMsg] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const refreshWhatsapp = useCallback(async () => {
    const isCurrent = claimChannelRead("whatsapp");
    try {
      const r = await fetch("/setup-api/whatsapp/status", { cache: "no-store" });
      // keep the last known state rather than flashing "off"
      if (!isCurrent() || !r.ok) return;
      const d = await r.json();
      if (!isCurrent()) return;
      // `verified: false` is the gateway failing to be asked, dressed up as a
      // 200 — the route still has to answer `state: "not_configured"` because
      // the panel needs something to offer an action for. That is the 5xx above
      // wearing a different hat, so it is handled the same way and, crucially,
      // in the same PLACE: three readers each deciding what an unverified
      // answer means is how the hub came to say "Could not check" while the
      // pane one click later said "Not configured", with a Link-a-number button
      // under a phone that was paired. Absent means an older build that cannot
      // tell us either way — verified, so an upgrade never blanks every row.
      if (d?.verified === false) return;
      // Every field is defaulted: an older build (or a stubbed fetch) answering
      // `{}` must render as "no WhatsApp here", never as a half-populated panel.
      setWaStatus({
        supported: d?.supported === true,
        state: d?.state,
        enabled: d?.enabled === true,
        paired: d?.paired === true,
        mode: d?.mode ?? null,
        allowedUsers: Array.isArray(d?.allowedUsers) ? d.allowedUsers : [],
        allowAllUsers: d?.allowAllUsers === true,
        bridgeReady: d?.bridgeReady ?? null,
        authorized: d?.authorized === true,
        receiving: d?.receiving === true,
      });
    } catch {
      // transient — keep the previous state
    } finally {
      if (isCurrent()) markChannelSettled("whatsapp");
    }
  }, [markChannelSettled, claimChannelRead]);

  // Unsettle-then-read, as on the Telegram effect above.
  useEffect(() => {
    if (!isMobile && section !== "whatsapp" && section !== "channels") return;
    unsettleChannel("whatsapp");
    refreshWhatsapp();
  }, [section, isMobile, refreshWhatsapp, unsettleChannel]);

  const saveWhatsapp = useCallback(
    async (payload: { allowedUsers?: string[]; mode?: "bot" | "self-chat"; enabled?: boolean }) => {
      setWaSaving(true);
      setWaMsg(null);
      try {
        const res = await fetch("/setup-api/whatsapp/configure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          setWaMsg({
            type: "error",
            message:
              data.error === "not_paired"
                ? t("settings.whatsappNotPairedError")
                : data.error || t("settings.failedSave"),
          });
          return false;
        }
        setWaMsg({
          type: "success",
          message:
            data.warning === "restart_pending"
              ? t("settings.whatsappSavedRestartPending")
              : data.warning === "no_allowed_users"
                ? t("settings.whatsappSavedNoUsers")
                : t("settings.whatsappSaved"),
        });
        await refreshWhatsapp();
        return true;
      } catch (err) {
        setWaMsg({
          type: "error",
          message: `${t("settings.failedSave")}: ${err instanceof Error ? err.message : err}`,
        });
        return false;
      } finally {
        setWaSaving(false);
      }
    },
    [refreshWhatsapp, t],
  );

  const addWhatsappNumber = useCallback(async () => {
    const raw = waNumber.trim();
    if (!raw) return;
    const current = waStatus?.allowedUsers ?? [];
    const ok = await saveWhatsapp({ allowedUsers: [...current, raw] });
    if (ok) setWaNumber("");
  }, [waNumber, waStatus, saveWhatsapp]);

  const removeWhatsappNumber = useCallback(
    async (number: string) => {
      const current = waStatus?.allowedUsers ?? [];
      await saveWhatsapp({ allowedUsers: current.filter((n) => n !== number) });
    },
    [waStatus, saveWhatsapp],
  );

  /* ── WhatsApp pairing ──
   *
   * The poll below is not a progress bar, it is the session's heartbeat: the
   * server keeps the bridge alive only while these GETs keep arriving, and
   * reaps it a minute after they stop. So the effect must run for every phase
   * that is not terminal — including "starting", which is where a session sits
   * during the seconds between a bridge restart and the next QR. */
  const [waPair, setWaPair] = useState<WhatsappPairSnapshot | null>(null);
  const [waPairBusy, setWaPairBusy] = useState(false);
  const [waAdvanced, setWaAdvanced] = useState(false);
  const [waUnpairConfirm, setWaUnpairConfirm] = useState(false);

  const readPairSnapshot = useCallback((d: unknown): WhatsappPairSnapshot => {
    const raw = (d ?? {}) as Record<string, unknown>;
    const phase = typeof raw.phase === "string" ? raw.phase : "idle";
    return {
      phase: (["idle", "preparing", "starting", "waiting", "scanned", "paired", "error"] as const).includes(
        phase as WhatsappPairPhase,
      )
        ? (phase as WhatsappPairPhase)
        : "idle",
      qr: typeof raw.qr === "string" && raw.qr.length > 0 ? raw.qr : null,
      // Prefix AND payload. `"data:image/png;base64,"` on its own is a valid
      // data URL for an empty image, and would render a blank square the owner
      // is invited to scan. Same rule as readQrDataUrl() server-side.
      qrImage: WHATSAPP_QR_DATA_URL_RE.test(String(raw.qrImage ?? "")) ? (raw.qrImage as string) : null,
      qrCount: typeof raw.qrCount === "number" ? raw.qrCount : 0,
      restarts: typeof raw.restarts === "number" ? raw.restarts : 0,
      error: typeof raw.error === "string" ? raw.error : null,
      user:
        raw.user && typeof raw.user === "object"
          ? {
              id: typeof (raw.user as { id?: unknown }).id === "string" ? ((raw.user as { id: string }).id) : null,
              name:
                typeof (raw.user as { name?: unknown }).name === "string"
                  ? ((raw.user as { name: string }).name)
                  : null,
            }
          : null,
    };
  }, []);

  const startWhatsappPairing = useCallback(
    async (force = false) => {
      setWaPairBusy(true);
      setWaMsg(null);
      // Show "preparing" the instant the click lands: on a box with no
      // node_modules the POST below does not return until npm has finished,
      // and a dead button for two minutes reads as a broken one.
      setWaPair({ phase: "preparing", qr: null, qrImage: null, qrCount: 0, restarts: 0, error: null, user: null });
      try {
        const res = await fetch("/setup-api/whatsapp/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setWaPair({
            phase: "error",
            qr: null,
            qrImage: null,
            qrCount: 0,
            restarts: 0,
            error: typeof data?.error === "string" ? data.error : "start_failed",
            user: null,
          });
          return;
        }
        setWaPair(readPairSnapshot(data));
      } catch {
        setWaPair({ phase: "error", qr: null, qrImage: null, qrCount: 0, restarts: 0, error: "start_failed", user: null });
      } finally {
        setWaPairBusy(false);
      }
    },
    [readPairSnapshot],
  );

  const cancelWhatsappPairing = useCallback(async () => {
    setWaPairBusy(true);
    try {
      await fetch("/setup-api/whatsapp/pair", { method: "DELETE" });
    } catch {
      // The reaper collects the session anyway once the polls stop.
    } finally {
      setWaPair(null);
      setWaPairBusy(false);
    }
  }, []);

  const unpairWhatsappPhone = useCallback(async () => {
    setWaPairBusy(true);
    setWaMsg(null);
    try {
      const res = await fetch("/setup-api/whatsapp/unpair", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setWaMsg({ type: "error", message: t("settings.whatsappUnpairFailed") });
        return;
      }
      setWaPair(null);
      setWaUnpairConfirm(false);
      setWaMsg({ type: "success", message: t("settings.whatsappUnpairDone") });
      await refreshWhatsapp();
    } catch {
      setWaMsg({ type: "error", message: t("settings.whatsappUnpairFailed") });
    } finally {
      setWaPairBusy(false);
    }
  }, [refreshWhatsapp, t]);

  /* Baileys reports the linked account as "<number>:<device>@s.whatsapp.net".
     Only the number half is meaningful to an owner, and it is the same digits
     the allowlist uses, so show that and drop the device suffix. */
  const waPairedNumber = (() => {
    const id = waPair?.user?.id;
    if (id) {
      const digits = id.split(/[:@]/)[0].replace(/\D/g, "");
      if (digits) return `+${digits}`;
    }
    return null;
  })();

  const waPairPhase = waPair?.phase ?? null;
  const waPairActive =
    waPairPhase === "preparing" || waPairPhase === "starting" || waPairPhase === "waiting" || waPairPhase === "scanned";

  /* Which section is actually on screen.
     `section` is the desktop sidebar selection; on mobile the rendered panel is
     `mobileSection`, and null there means the nav list, with no panel at all.
     The one-shot status fetches elsewhere in this file get away with
     `&& !isMobile` because an extra GET costs nothing. This is different: the
     pairing poll is a 2 s heartbeat that a live `node bridge.js` on the Jetson
     stays alive for, so "is the panel visible" has to be the real answer. With
     `!isMobile` the guard inverted on a phone — the interval never stopped and
     the DELETE never fired, so browsing away from WhatsApp left the server
     renewing lastPollAt forever and the reaper could never collect the bridge. */
  const whatsappVisible = isMobile ? mobileSection === "whatsapp" : section === "whatsapp";

  useEffect(() => {
    if (!waPairActive) return;
    if (!whatsappVisible) return;

    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/setup-api/whatsapp/pair", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const snap = readPairSnapshot(await res.json());
        if (cancelled) return;
        setWaPair(snap);
        // The channel status behind the panel (enabled / paired / receiving)
        // only changes once, at the moment of success. Refresh it there rather
        // than polling two routes for five minutes.
        if (snap.phase === "paired") await refreshWhatsapp();
      } catch {
        // A dropped poll is not a failed pairing; the next tick re-reads.
      }
    }, 2_000);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [waPairActive, whatsappVisible, readPairSnapshot, refreshWhatsapp]);

  /* Leaving the WhatsApp panel stops the heartbeat, and the server reaps the
     bridge a minute later. Tell it now instead, so a browsed-away session does
     not hold a Baileys socket open for that minute. */
  useEffect(() => {
    if (whatsappVisible) return;
    if (!waPairActive) return;
    void fetch("/setup-api/whatsapp/pair", { method: "DELETE" }).catch(() => {});
    setWaPair(null);
  }, [whatsappVisible, waPairActive]);

  /* ── Discord ── */
  // Three things can leave a Discord bot configured and silent, and only the
  // first was ever visible here:
  //   * the token is dead                  -> dcTokenRejected
  //   * MESSAGE CONTENT was never enabled  -> dcIntentsMissing / state
  //     "intents-missing"
  //   * nothing is on the allowlist        -> state "denied-no-allowlist",
  //     fixed by the member picker below
  // The status card renders exactly one of the four states the route reports,
  // each next to the one thing that fixes it.
  const [dcToken, setDcToken] = useState("");
  const [dcShowToken, setDcShowToken] = useState(false);
  const [dcSaving, setDcSaving] = useState(false);
  const [dcStatus, setDcStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [dcConfigured, setDcConfigured] = useState<boolean | null>(null);
  const [dcBotName, setDcBotName] = useState<string | null>(null);
  // Discord itself said the stored token is dead — surfaced even while the
  // section otherwise reads "configured", because nothing else would explain a
  // bot that is set up and silent.
  const [dcTokenRejected, setDcTokenRejected] = useState(false);
  const [dcReconfigure, setDcReconfigure] = useState(false);
  // Application ID is only ever used in the browser to build the invite URL —
  // it is public (it is in the invite link itself) and is never sent to the box.
  const [dcAppId, setDcAppId] = useState("");
  // What the gateway actually reports, not what a stored token implies.
  const [dcState, setDcState] = useState<DiscordConnectionState | null>(null);
  // The picker. `dcMembers` is what the bot can see; `dcSelected` is what the
  // owner has ticked. Both come back from configure and from status.
  const [dcMembers, setDcMembers] = useState<DiscordMemberOption[]>([]);
  const [dcSelected, setDcSelected] = useState<string[]>([]);
  const [dcAllowlistSupported, setDcAllowlistSupported] = useState(true);
  const [dcAllowAllUsers, setDcAllowAllUsers] = useState(false);
  const [dcMembersSaving, setDcMembersSaving] = useState(false);
  // Set when the preflight refused the save. Kept until the next save attempt
  // so the fix instructions stay on screen while the owner follows them.
  const [dcIntentsMissing, setDcIntentsMissing] = useState<string[] | null>(null);
  const [dcMembersUnavailable, setDcMembersUnavailable] = useState(false);
  const dcSaveControllerRef = useRef<AbortController | null>(null);

  const refreshDiscordStatus = useCallback(async () => {
    const isCurrent = claimChannelRead("discord");
    try {
      const r = await fetch("/setup-api/discord/status", { cache: "no-store" });
      if (!isCurrent()) return;
      if (!r.ok) {
        // Transient error — keep the last known state rather than flashing
        // "not configured" at someone whose bot is fine.
        console.warn("[discord] /setup-api/discord/status returned", r.status);
        return;
      }
      const d = await r.json();
      if (!isCurrent()) return;
      setDcConfigured(d.configured ?? false);
      setDcBotName(typeof d.username === "string" ? d.username : null);
      setDcTokenRejected(d.tokenRejected === true);
      setDcState(isDiscordState(d.state) ? d.state : null);
      setDcAllowlistSupported(d.allowlistSupported !== false);
      setDcAllowAllUsers(d.allowAllUsers === true);
      // The server owns the allowlist; the picker only ever proposes a change.
      if (Array.isArray(d.allowedUserIds)) {
        setDcSelected(d.allowedUserIds.filter((id: unknown) => typeof id === "string"));
      }
    } catch (err) {
      console.warn("[discord] refresh failed:", err);
    } finally {
      if (isCurrent()) markChannelSettled("discord");
    }
  }, [markChannelSettled, claimChannelRead]);

  // The member list costs Discord API calls, so it is fetched only while the
  // Discord section is actually open — never from the status poll that backs
  // the sidebar subtitle.
  const refreshDiscordMembers = useCallback(async () => {
    try {
      const r = await fetch("/setup-api/discord/members", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      if (d.supported === false) {
        setDcAllowlistSupported(false);
        return;
      }
      if (d.configured === false) return;
      setDcMembers(toDiscordMembers(d.members));
      setDcMembersUnavailable(d.available === false);
      if (Array.isArray(d.allowedUserIds)) {
        setDcSelected(d.allowedUserIds.filter((id: unknown) => typeof id === "string"));
      }
    } catch (err) {
      console.warn("[discord] member refresh failed:", err);
    }
  }, []);

  // Unsettle-then-read, as on the Telegram effect above.
  useEffect(() => {
    if (!isMobile && section !== "discord" && section !== "channels") return;
    unsettleChannel("discord");
    refreshDiscordStatus();
  }, [section, isMobile, refreshDiscordStatus, unsettleChannel]);

  useEffect(() => {
    if (section !== "discord") return;
    if (!dcConfigured) return;
    refreshDiscordMembers();
  }, [section, dcConfigured, refreshDiscordMembers]);

  useEffect(() => () => dcSaveControllerRef.current?.abort(), []);

  // The invite link is assembled client-side from a public Application ID.
  // 274878286912 = view channels + send messages + read history + attach files
  // + embed links + send in threads + add reactions: what the agent needs to
  // hold a conversation, and nothing that can moderate or manage a server.
  const DISCORD_INVITE_PERMISSIONS = "274878286912";
  // Trim once and build the link from that exact string: the digits-only test
  // and the interpolation have to see the same value for the guard to mean
  // anything. Bound to one const, "only 15-25 digits, behind a literal
  // https://discord.com/ prefix, ever reaches href" holds by construction.
  const dcAppIdTrimmed = dcAppId.trim();
  const dcAppIdValid = /^\d{15,25}$/.test(dcAppIdTrimmed);
  const dcInviteUrl = dcAppIdValid
    ? `https://discord.com/oauth2/authorize?client_id=${dcAppIdTrimmed}&scope=bot+applications.commands&permissions=${DISCORD_INVITE_PERMISSIONS}`
    : null;

  /** Warning tokens the configure route returns, mapped to translated copy. */
  const discordWarningText = (warning: unknown): string | null => {
    if (warning === "restart_pending") return t("settings.discordSavedRestartPending");
    if (warning === "no_allowed_users") return t("settings.discordSavedNoUsers");
    if (warning === "members_unavailable") return t("settings.discordMembersUnavailable");
    if (warning === "server_members_intent") return t("settings.discordMembersUnavailable");
    // The OpenClaw channel-plugin states. The two install failures share one
    // sentence on purpose — the codes differ so a support log can tell a
    // refused install from a slow one, but the remedy the owner acts on is the
    // same: check the connection and save again.
    if (warning === "plugin_install_failed" || warning === "plugin_install_timeout") {
      return t("settings.discordSavePluginFailed");
    }
    if (warning === "token_unresolved") return t("settings.discordSaveTokenUnresolved");
    if (warning === "channel_unverified") return t("settings.discordSaveUnverified");
    if (warning === "not_connected") return t("settings.discordSaveNotConnected");
    return null;
  };

  const saveDiscord = async () => {
    if (!dcToken.trim()) {
      setDcStatus({ type: "error", message: t("settings.enterToken") });
      return;
    }
    dcSaveControllerRef.current?.abort();
    const controller = new AbortController();
    dcSaveControllerRef.current = controller;
    setDcSaving(true);
    setDcStatus(null);
    setDcIntentsMissing(null);
    try {
      const res = await fetch("/setup-api/discord/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: dcToken.trim() }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        // The preflight refusal is not a sentence, it is a checklist — render
        // the four steps rather than a one-line error nobody can act on.
        if (data.code === "intents_missing") {
          setDcIntentsMissing(
            Array.isArray(data.missingIntents)
              ? data.missingIntents.filter((i: unknown) => typeof i === "string")
              : [],
          );
          setDcStatus({ type: "error", message: t("settings.discordStateIntentsMissingHint") });
          return;
        }
        // A blocking channel state: the credential IS saved, the channel is
        // just not reachable yet, and the panel can say which of the four
        // reasons it was. Falling through to "failed to save" here would be
        // both wrong (it did save) and unactionable.
        const blocked = discordWarningText(data.code);
        if (blocked) {
          setDcStatus({ type: "error", message: blocked });
          setDcConfigured(true);
          setDcToken("");
          setDcReconfigure(false);
          refreshDiscordStatus();
          return;
        }
        // The route already phrases its other errors for a person (bad token vs
        // "couldn't reach Discord"), so show them rather than a generic line.
        setDcStatus({ type: "error", message: data.error || t("settings.failedSave") });
        return;
      }
      setDcStatus({
        type: data.warning ? "error" : "success",
        message: discordWarningText(data.warning) ?? t("settings.discordConfigured"),
      });
      setDcConfigured(true);
      setDcTokenRejected(false);
      setDcBotName(typeof data.username === "string" ? data.username : null);
      setDcMembers(toDiscordMembers(data.members));
      setDcMembersUnavailable(data.warning === "members_unavailable");
      setDcAllowlistSupported(data.allowlistSupported !== false);
      if (Array.isArray(data.allowedUserIds)) {
        setDcSelected(data.allowedUserIds.filter((id: unknown) => typeof id === "string"));
      }
      setDcReconfigure(false);
      setDcToken("");
      refreshDiscordStatus();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setDcStatus({ type: "error", message: t("settings.failedSave") });
    } finally {
      if (!controller.signal.aborted) setDcSaving(false);
    }
  };

  const toggleDiscordMember = (id: string) => {
    setDcStatus(null);
    setDcSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };

  /**
   * Save the picker on its own — the token is already stored, so this is the
   * one write that turns a connected-but-denying bot into a working one.
   */
  const saveDiscordMembers = async () => {
    setDcMembersSaving(true);
    setDcStatus(null);
    try {
      const res = await fetch("/setup-api/discord/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedUserIds: dcSelected }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setDcStatus({
          type: "error",
          message:
            data.code === "empty_allowlist"
              ? t("settings.discordMembersEmptyWarning")
              : data.error || t("settings.failedSave"),
        });
        return;
      }
      setDcStatus({
        type: data.warning ? "error" : "success",
        message: discordWarningText(data.warning) ?? t("settings.discordConfigured"),
      });
      refreshDiscordStatus();
    } catch {
      setDcStatus({ type: "error", message: t("settings.failedSave") });
    } finally {
      setDcMembersSaving(false);
    }
  };

  // One descriptor per state, so the icon, the colour and the sentence cannot
  // drift apart — and so "live" is reachable from exactly one of them.
  const dcStateView = (() => {
    switch (dcState) {
      case "connected":
        return {
          tone: "live" as const,
          icon: "check_circle",
          title: dcBotName || t("settings.discordStateConnected"),
          hint: t("settings.discordStateConnectedHint"),
        };
      case "intents-missing":
        return {
          tone: "warn" as const,
          icon: "report",
          title: t("settings.discordStateIntentsMissing"),
          hint: t("settings.discordStateIntentsMissingHint"),
        };
      case "denied-no-allowlist":
        return {
          tone: "warn" as const,
          icon: "block",
          title: t("settings.discordStateDenied"),
          hint: t("settings.discordStateDeniedHint"),
        };
      case "offline":
        return {
          tone: "idle" as const,
          icon: "link_off",
          title: t("settings.discordStateOffline"),
          hint: t("settings.discordStateOfflineHint"),
        };
      default:
        // No state reported (OpenClaw, or a status call that has not landed
        // yet). Say the bot is set up and stop short of claiming it is live.
        return {
          tone: "idle" as const,
          icon: "forum",
          title: dcBotName || t("settings.botConnected"),
          hint: "",
        };
    }
  })();

  /* ── Factory Reset ── */
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetPassword, setResetPassword] = useState("");
  const [resetTyped, setResetTyped] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSubmitting, setResetSubmitting] = useState(false);

  const [resetPhase, setResetPhase] = useState<"waiting" | "reconnecting" | "done" | null>(null);
  const [resetDots, setResetDots] = useState(0);
  const resetPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resetDotsRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resetReconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetPollControllerRef = useRef<AbortController | null>(null);
  // Every reset attempt owns one generation. A hard timeout increments it so
  // even a fetch implementation that ignores AbortSignal cannot publish a
  // late success and schedule the /setup redirect.
  const resetPollGenerationRef = useRef(0);

  /** Clear every owner-entered value when the reset confirmation is dismissed. */
  const clearResetConfirm = useCallback(() => {
    setResetConfirm(false);
    setResetPassword("");
    setResetTyped("");
    setResetError(null);
  }, []);
  const closeResetConfirm = useCallback(() => {
    // The request has crossed the destructive boundary. Neither Escape nor a
    // stray click may dismiss its progress context until the route answers.
    if (resetSubmitting) return;
    clearResetConfirm();
  }, [clearResetConfirm, resetSubmitting]);
  const factoryResetPanelRef = useModalDialog<HTMLDivElement>({
    open: resetConfirm && !resetting,
    onClose: closeResetConfirm,
  });
  const keepResetProgressOpen = useCallback(() => {
    // Once the wipe was accepted there is no safe dismiss action. Escape is
    // still captured by useModalDialog so it cannot reach the desktop behind.
  }, []);
  const factoryResetProgressPanelRef = useModalDialog<HTMLDivElement>({
    open: resetting && resetPhase !== null,
    onClose: keepResetProgressOpen,
  });

  const resetSetup = async () => {
    if (resetSubmitting) return;
    setResetSubmitting(true);
    setResetError(null);

    // The wipe only starts once the box has accepted the password and the typed
    // word. Until then this stays a plain dialog: the old flow fired the request
    // and went straight to the "erasing…" overlay without ever reading the
    // response, so a refusal looked exactly like a reset in progress.
    let accepted = false;
    try {
      const res = await fetch("/setup-api/setup/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: resetPassword, confirm: resetTyped }),
      });
      accepted = res.ok;
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        setResetError(detail.error || t("settings.factoryResetRefused"));
      }
    } catch {
      // The reset route schedules reboot only after it has returned a success
      // response. A fetch exception therefore gives us no evidence the wipe
      // was accepted; treating it as success strands the UI in reconnect
      // polling when the request never reached the device.
      setResetError(t("settings.connectionFailed"));
    } finally {
      setResetSubmitting(false);
    }

    if (!accepted) return;

    setResetting(true);
    clearResetConfirm();
    setResetPhase("waiting");
    setResetDots(0);
    resetPollControllerRef.current?.abort();
    resetPollControllerRef.current = null;
    const pollGeneration = ++resetPollGenerationRef.current;

    // Animate dots
    resetDotsRef.current = setInterval(() => setResetDots(d => (d + 1) % 4), 500);
    resetReconnectTimeoutRef.current = setTimeout(() => {
      if (resetPollGenerationRef.current !== pollGeneration) return;
      resetReconnectTimeoutRef.current = null;
      resetPollGenerationRef.current += 1;
      if (resetPollRef.current) clearInterval(resetPollRef.current);
      if (resetDotsRef.current) clearInterval(resetDotsRef.current);
      resetPollControllerRef.current?.abort();
      resetPollControllerRef.current = null;
      resetPollRef.current = null;
      resetDotsRef.current = null;
      setResetting(false);
      setResetPhase(null);
      setResetError(t("settings.connectionFailed"));
      setResetConfirm(true);
    }, 5 * 60 * 1000);

    // Wait for device to go down, then poll for reconnect
    setTimeout(() => {
      if (resetPollGenerationRef.current !== pollGeneration) return;
      setResetPhase("reconnecting");
      resetPollRef.current = setInterval(() => {
        if (resetPollGenerationRef.current !== pollGeneration || resetPollControllerRef.current) return;
        const controller = new AbortController();
        resetPollControllerRef.current = controller;
        const requestTimeout = setTimeout(() => controller.abort(), 3000);
        void (async () => {
          try {
            const res = await fetch("/setup-api/setup/status", { signal: controller.signal });
            if (
              res.ok
              && !controller.signal.aborted
              && resetPollGenerationRef.current === pollGeneration
            ) {
              if (resetPollRef.current) clearInterval(resetPollRef.current);
              if (resetDotsRef.current) clearInterval(resetDotsRef.current);
              if (resetReconnectTimeoutRef.current) clearTimeout(resetReconnectTimeoutRef.current);
              resetReconnectTimeoutRef.current = null;
              setResetPhase("done");
              setTimeout(() => {
                if (resetPollGenerationRef.current === pollGeneration) {
                  window.location.replace("/setup");
                }
              }, 1500);
            }
          } catch {
            /* still offline */
          } finally {
            clearTimeout(requestTimeout);
            if (resetPollControllerRef.current === controller) {
              resetPollControllerRef.current = null;
            }
          }
        })();
      }, 3000);
    }, 5000);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      resetPollGenerationRef.current += 1;
      if (resetPollRef.current) clearInterval(resetPollRef.current);
      if (resetDotsRef.current) clearInterval(resetDotsRef.current);
      if (resetReconnectTimeoutRef.current) clearTimeout(resetReconnectTimeoutRef.current);
      resetPollControllerRef.current?.abort();
      resetPollControllerRef.current = null;
    };
  }, []);

  const activeSection = isMobile ? (mobileSection ?? section) : section;
  // A channel pane keeps the Messaging Channels entry lit: the sidebar no longer has a
  // row of its own to highlight, and an unlit sidebar reads as "nowhere".
  const navSection: Section = isChannelSection(activeSection)
    ? "channels"
    : activeSection === "localModels" ? "localAi" : activeSection;
  const visibleNavItems = NAV_ITEMS;
  const resetProgressSteps = [
    {
      id: "erase",
      label: t("settings.erasingSettings"),
      status: resetPhase === "waiting" ? "running" : resetPhase ? "completed" : "pending",
    },
    {
      id: "reconnect",
      label: t("settings.waitingOnline"),
      status:
        resetPhase === "reconnecting"
          ? "running"
          : resetPhase === "done"
            ? "completed"
            : "pending",
    },
    {
      id: "setup",
      label: t("settings.startingSetup"),
      status: resetPhase === "done" ? "running" : "pending",
    },
  ] satisfies Array<{ id: string; label: string; status: "pending" | "running" | "completed" }>;

  const resetOverlayTitle =
    resetPhase === "waiting"
      ? `${t("settings.resetting")}${".".repeat(resetDots)}`
      : resetPhase === "reconnecting"
        ? `${t("settings.reconnecting")}${".".repeat(resetDots)}`
        : t("settings.backOnline");

  const resetOverlayDescription =
    resetPhase === "waiting"
      ? t("settings.erasingSettings")
      : resetPhase === "reconnecting"
        ? t("settings.waitingOnline")
        : t("settings.startingSetup");

  const resetOverlay = resetting && resetPhase && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={factoryResetProgressPanelRef}
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: 2147483647, background: "rgba(13, 17, 23, 1)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="factory-reset-progress-title"
        >
          <style>{`
            @keyframes factory-reset-pulse {
              0%, 100% { opacity: 0.25; transform: scale(1); }
              50% { opacity: 0.1; transform: scale(1.18); }
            }
          `}</style>
          <div
            className="flex flex-col items-center gap-8 max-w-md w-full text-center px-6"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {resetPhase === "done" ? (
              <div className="relative w-28 h-28 flex items-center justify-center">
                <div className="absolute inset-0 rounded-full border-2 border-emerald-500/20" />
                <div className="w-16 h-16 rounded-full flex items-center justify-center bg-[#f97316] shadow-[0_0_40px_rgba(249,115,22,0.28)]">
                  <span className="material-symbols-rounded text-white" style={{ fontSize: 32 }} aria-hidden="true">check</span>
                </div>
              </div>
            ) : (
              <div className="relative w-32 h-32 flex items-center justify-center">
                <div className="absolute inset-0 rounded-full border-[3px] border-white/10 animate-spin" style={{ borderTopColor: "#f97316" }} />
                <div className="absolute inset-3 rounded-full border border-[#f97316]/15" style={{ animation: "factory-reset-pulse 2.5s ease-in-out infinite" }} />
                <Image
                  src="/clawbox-crab.png"
                  alt="ClawBox"
                  width={50}
                  height={50}
                  className="w-[50px] h-[50px] object-contain animate-welcome-powerup relative z-10"
                />
              </div>
            )}

            <div>
              <h2 id="factory-reset-progress-title" className="text-2xl font-bold text-white mb-2">{resetOverlayTitle}</h2>
              <p className="text-sm text-white/45">{resetOverlayDescription}</p>
            </div>

            <div className="w-full max-w-sm space-y-3 text-left bg-white/[0.03] rounded-2xl p-4 border border-white/[0.06]">
              {resetProgressSteps.map((step) => (
                <div key={step.id} className="flex items-start gap-3 text-sm">
                  {step.status === "completed" ? (
                    <span className="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 shrink-0">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                        <path d="M5 12l5 5L19 7" />
                      </svg>
                    </span>
                  ) : step.status === "running" ? (
                    <span className="flex items-center justify-center w-5 h-5 shrink-0">
                      <span className="w-4 h-4 rounded-full border-2 border-[#f97316] border-t-transparent animate-spin" aria-hidden="true" />
                    </span>
                  ) : (
                    <span className="flex items-center justify-center w-5 h-5 rounded-full bg-white/[0.04] shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-white/20" aria-hidden="true" />
                    </span>
                  )}
                  <span className={step.status === "running" ? "text-white font-medium" : step.status === "completed" ? "text-emerald-400/70" : "text-white/25"}>
                    {step.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )
    : null;

  // One dialog, rendered from both the mobile and the desktop tree below. It
  // used to be copy-pasted into each, which is how the two could have drifted.
  const factoryResetDialog = resetConfirm && !resetting && (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div
        ref={factoryResetPanelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="factory-reset-title"
        className="bg-[var(--bg-elevated)] rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-[var(--border-subtle)]"
      >
        <h3 id="factory-reset-title" className="text-lg font-bold text-[var(--text-primary)] mb-2">
          {t("settings.factoryResetTitle")}
        </h3>
        <p className="text-sm text-[var(--text-muted)] mb-5">{t("settings.factoryResetDesc")}</p>

        <label className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5" htmlFor="factory-reset-password">
          {t("settings.security.currentPassword")}
        </label>
        <input
          id="factory-reset-password"
          type="password"
          autoComplete="current-password"
          value={resetPassword}
          onChange={e => { setResetPassword(e.target.value); setResetError(null); }}
          className="w-full mb-4 px-3 py-2.5 bg-white/5 border border-[var(--border-subtle)] rounded-xl text-base text-[var(--text-primary)] outline-none focus:border-[#fe6e00]"
        />

        <label className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5" htmlFor="factory-reset-confirm">
          {t("settings.factoryResetTypeToConfirm", { word: FACTORY_RESET_CONFIRMATION })}
        </label>
        <input
          id="factory-reset-confirm"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={resetTyped}
          onChange={e => { setResetTyped(e.target.value); setResetError(null); }}
          placeholder={FACTORY_RESET_CONFIRMATION}
          className="w-full px-3 py-2.5 bg-white/5 border border-[var(--border-subtle)] rounded-xl text-base text-[var(--text-primary)] outline-none focus:border-[#fe6e00]"
        />

        {resetError && <p className="mt-3 text-xs text-red-400" role="alert">{resetError}</p>}

        <div className="flex gap-3 mt-5">
          <button
            onClick={closeResetConfirm}
            disabled={resetSubmitting}
            className="flex-1 py-2.5 bg-white/5 text-[var(--text-secondary)] rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-white/10 transition-colors disabled:opacity-40"
          >
            {t("cancel")}
          </button>
          <button
            onClick={resetSetup}
            disabled={resetSubmitting || !resetPassword || !isFactoryResetConfirmed(resetTyped)}
            className="flex-1 py-2.5 bg-red-500 text-white rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-red-600 transition-colors disabled:opacity-40 disabled:hover:bg-red-500 disabled:cursor-not-allowed"
          >
            {resetSubmitting ? `${t("settings.resetting")}…` : t("settings.reset")}
          </button>
        </div>
      </div>
    </div>
  );

  // Shared by mobile and desktop. Keeping one dialog prevents the mobile
  // early-return layout from silently dropping password confirmation.
  const systemPasswordConfirmDialog = sysPasswordConfirmOpen && (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div ref={systemPasswordConfirmPanelRef} role="alertdialog" aria-modal="true" aria-labelledby="sys-pw-confirm-title" className="bg-[var(--bg-elevated)] rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-[var(--border-subtle)]">
        <div className="flex items-center gap-2 mb-3">
          <span className="material-symbols-rounded text-amber-400" style={{ fontSize: 22 }}>warning</span>
          <h3 id="sys-pw-confirm-title" className="text-lg font-bold text-[var(--text-primary)]">{t("settings.security.confirmTitle")}</h3>
        </div>
        <p className="text-sm text-[var(--text-muted)] mb-3 leading-relaxed">
          {t("settings.security.confirmBodyPrefix")} <span className="text-[var(--text-primary)] font-medium">{t("settings.security.confirmBodyScope")}</span>{t("settings.security.confirmBodySuffix")}
        </p>
        <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.08] px-3 py-2.5 mb-5">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-[10px] font-semibold text-amber-200/80 uppercase tracking-widest">{t("settings.security.newPassword")}</span>
            <button type="button" onClick={() => setSysPasswordConfirmReveal(v => !v)} className="text-[10px] text-amber-200 hover:text-amber-100 bg-transparent border-none cursor-pointer flex items-center gap-1" aria-label={sysPasswordConfirmReveal ? t("settings.security.hidePassword") : t("settings.security.revealPassword")}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{sysPasswordConfirmReveal ? "visibility_off" : "visibility"}</span>
              {sysPasswordConfirmReveal ? t("settings.security.hide") : t("settings.security.reveal")}
            </button>
          </div>
          <div className="font-mono text-sm text-amber-50 break-all min-h-[1.25rem]">
            {sysPasswordConfirmReveal ? sysPassword : "••••••••"}
          </div>
        </div>
        <div className="flex gap-3">
          <button disabled={sysPasswordSaving} onClick={closeSystemPasswordConfirm} className="flex-1 py-2.5 bg-white/5 text-[var(--text-secondary)] rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-white/10 transition-colors disabled:opacity-50">{t("cancel")}</button>
          <button disabled={sysPasswordSaving} onClick={() => { setSysPasswordConfirmOpen(false); void saveSystemPassword(); }} className="flex-1 py-2.5 bg-[#fe6e00] text-white rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-[#ff8b1a] transition-colors disabled:opacity-50">
            {sysPasswordSaving ? t("settings.security.saving") : t("settings.security.confirmChange")}
          </button>
        </div>
      </div>
    </div>
  );

  const renderContent = () => (
    <>
        {/* ─── Appearance ─── */}
        {activeSection === "appearance" && (
          <div className="max-w-xl space-y-5">

            {/* Your name — used by the mascot for occasional name-greeting popups */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>person</span>
                <label htmlFor="ui-user-name" className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.userName.label")}</label>
              </div>
              <input
                id="ui-user-name"
                type="text"
                value={userName}
                maxLength={40}
                onChange={e => {
                  userNameEditedRef.current = true;
                  setUserName(e.target.value);
                  persistUserName(e.target.value);
                }}
                className="w-full rounded-xl bg-white/[0.04] border border-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-[var(--coral-bright)]/60 focus:bg-white/[0.06]"
              />
              <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                {t("settings.userName.helper")}
                {userNameSaved && userNameSaved === userName.trim() && userNameSaved.length > 0 && (
                  <span className="ml-1 text-emerald-400/80">{t("settings.userName.saved")}</span>
                )}
              </p>
            </div>

            {/* Wallpaper card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>wallpaper</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.wallpaper")}</label>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                {ui.wallpapers.map(wp => {
                  const selected = ui.wallpaperId === wp.id;
                  return (
                    <button
                      key={wp.id}
                      onClick={() => ui.onWallpaperChange(wp.id)}
                      className={`relative rounded-xl overflow-hidden aspect-video transition-all cursor-pointer border-none p-0 group ${
                        selected ? "ring-2 ring-orange-400 ring-offset-2 ring-offset-[#0d1117] scale-[1.02]" : "hover:scale-[1.02] hover:ring-1 hover:ring-white/20 hover:ring-offset-1 hover:ring-offset-[#0d1117]"
                      }`}
                    >
                      {wp.image ? (
                        <img src={wp.image} alt={wp.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-gray-800 to-gray-950" />
                      )}
                      <div className={`absolute inset-0 transition-colors ${selected ? "bg-orange-400/10" : "bg-black/0 group-hover:bg-white/5"}`} />
                      <span className={`absolute bottom-0 inset-x-0 text-[10px] py-1.5 text-center font-medium backdrop-blur-md ${
                        selected ? "bg-orange-500/70 text-white" : "bg-black/50 text-white/70"
                      }`}>{wp.name}</span>
                      {selected && (
                        <span className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-orange-500 flex items-center justify-center shadow-lg">
                          <span className="material-symbols-rounded text-white" style={{ fontSize: 14 }}>check</span>
                        </span>
                      )}
                    </button>
                  );
                })}
                {ui.customWallpapers.map((dataUrl, i) => {
                  const selected = ui.wallpaperId === `custom-${i}`;
                  return (
                    <div
                      key={`custom-${i}`}
                      className="relative aspect-video group"
                    >
                      <button
                        type="button"
                        aria-pressed={selected}
                        aria-label={`Custom ${i + 1}`}
                        onClick={() => ui.onWallpaperChange(`custom-${i}`)}
                        className={`relative w-full h-full rounded-xl overflow-hidden transition-all cursor-pointer border-none p-0 ${
                          selected ? "ring-2 ring-orange-400 ring-offset-2 ring-offset-[#0d1117] scale-[1.02]" : "hover:scale-[1.02]"
                        }`}
                      >
                        <img src={dataUrl} alt="" className="w-full h-full object-cover" />
                        {selected && (
                          <span className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-orange-500 flex items-center justify-center shadow-lg">
                            <span className="material-symbols-rounded text-white" style={{ fontSize: 14 }}>check</span>
                          </span>
                        )}
                        <span className={`absolute bottom-0 inset-x-0 text-[10px] py-1.5 text-center font-medium backdrop-blur-md ${
                          selected ? "bg-orange-500/70 text-white" : "bg-black/50 text-white/70"
                        }`}>Custom {i + 1}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => ui.onCustomWallpaperDelete(i)}
                        aria-label={`Remove Custom ${i + 1}`}
                        className="absolute top-1.5 left-1.5 w-5 h-5 bg-red-500/90 rounded-full text-white opacity-60 group-hover:opacity-100 focus:opacity-100 transition-opacity flex items-center justify-center cursor-pointer border-none shadow-lg"
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 12 }}>close</span>
                      </button>
                    </div>
                  );
                })}
                <button
                  onClick={() => ui.onWallpaperUpload()}
                  className="rounded-xl aspect-video border-2 border-dashed border-[var(--border-subtle)] hover:border-orange-400/40 hover:bg-orange-500/5 flex flex-col items-center justify-center gap-1.5 text-[var(--text-muted)] opacity-60 hover:text-[var(--coral-bright)]/70 transition-all cursor-pointer"
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 24 }}>add_photo_alternate</span>
                  <span className="text-[10px] font-medium">{t("settings.upload")}</span>
                </button>
              </div>
            </div>

            {/* Display Settings card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5 space-y-5">
              <div className="flex items-center gap-2">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>tune</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.display")}</label>
              </div>

              {/* Fit mode */}
              <div>
                <label className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.fitMode")}</label>
                <div className="flex gap-1 bg-white/[0.04] rounded-xl p-1">
                  {(["fill", "fit", "center"] as const).map(mode => {
                    const icons = { fill: "zoom_out_map", fit: "fit_screen", center: "center_focus_strong" };
                    return (
                      <button
                        key={mode}
                        onClick={() => ui.onWpFitChange(mode)}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer border-none capitalize ${
                          ui.wpFit === mode ? "bg-orange-500/15 text-[var(--coral-bright)] shadow-sm" : "text-white/35 hover:text-[var(--text-secondary)] hover:bg-white/[0.04]"
                        }`}
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{icons[mode]}</span>
                        {t(`settings.${mode}`)}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Opacity */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[11px] font-medium text-white/35 uppercase tracking-wider">{t("settings.opacity")}</label>
                  <span className="text-xs font-mono text-[var(--coral-bright)]/80 bg-orange-500/10 px-2 py-0.5 rounded-md">{ui.wpOpacity}%</span>
                </div>
                <div className="relative h-6 flex items-center">
                  <input
                    type="range" min={0} max={100} value={ui.wpOpacity}
                    onChange={e => ui.onWpOpacityChange(parseInt(e.target.value, 10))}
                    className="w-full h-1.5 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#fe6e00] [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[#0d1117] [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_rgba(254,110,0,0.3),0_2px_6px_rgba(0,0,0,0.3)] [&::-webkit-slider-thumb]:cursor-pointer"
                    style={{
                      background: `linear-gradient(to right, #fe6e00 0%, #fe6e00 ${ui.wpOpacity}%, rgba(255,255,255,0.08) ${ui.wpOpacity}%, rgba(255,255,255,0.08) 100%)`,
                    }}
                  />
                </div>
              </div>

              {/* Background color */}
              <div>
                <label className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.bgColor")}</label>
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <input
                      type="color" value={ui.wpBgColor}
                      onChange={e => ui.onWpBgColorChange(e.target.value)}
                      className="w-10 h-10 rounded-xl cursor-pointer border-2 border-[var(--border-subtle)] hover:border-white/20 transition-colors"
                    />
                  </div>
                  <div className="flex items-center gap-2 bg-white/[0.04] rounded-lg px-3 py-2">
                    <span className="text-xs text-[var(--text-muted)] font-mono tracking-wide">{ui.wpBgColor}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Extras card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>auto_awesome</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.extras")}</label>
              </div>
              <Toggle on={!ui.mascotHidden} onToggle={v => {
                const hidden = !v;
                ui.onMascotToggle(hidden);
                window.dispatchEvent(new Event(hidden ? "clawbox-hide-mascot" : "clawbox-show-mascot"));
              }} label={t("settings.showMascot")} />

            </div>

            {/* Mascot pet — Hermes editions only; renders nothing on OpenClaw. */}
            <PetPicker />


            {/* Language card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>translate</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.language")}</label>
              </div>
              <div className="relative" ref={langRef}>
                <button
                  type="button"
                  onClick={() => setLangOpen(v => !v)}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 bg-white/[0.04] border border-[var(--border-subtle)] rounded-lg text-sm text-[var(--text-primary)] hover:border-white/20 transition-colors cursor-pointer"
                >
                  <span className="text-base leading-none">{currentLang.flag}</span>
                  <span className="flex-1 text-left">{currentLang.label}</span>
                  <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 18 }}>
                    {langOpen ? "expand_less" : "expand_more"}
                  </span>
                </button>
                {langOpen && (
                  <div className="absolute z-50 mt-1 w-full bg-[var(--bg-elevated)] border border-white/10 rounded-lg shadow-xl max-h-60 overflow-y-auto">
                    {LANGUAGES.map(lang => (
                      <button
                        key={lang.code}
                        type="button"
                        onClick={() => { setLocale(lang.code as Locale); setLangOpen(false); }}
                        className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm transition-colors cursor-pointer border-none ${
                          lang.code === locale
                            ? "bg-orange-500/15 text-[var(--coral-bright)]"
                            : "text-white/70 hover:bg-white/[0.06]"
                        }`}
                      >
                        <span className="text-base leading-none">{lang.flag}</span>
                        <span className="flex-1 text-left">{lang.label}</span>
                        {lang.code === locale && (
                          <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 16 }}>check</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ─── Network ─── */}
        {activeSection === "wifi" && (
          <div className="max-w-xl space-y-5">

            {/* Connection status card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>wifi</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.status")}</label>
              </div>
              {connectedSSID ? (
                <div className="flex items-center gap-4 bg-green-500/[0.06] border border-green-500/15 rounded-xl px-4 py-3.5">
                  <div className="w-10 h-10 rounded-full bg-green-500/15 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-green-400" style={{ fontSize: 22 }}>wifi</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-[var(--text-primary)] font-medium truncate">{connectedSSID}</div>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                      <span className="text-xs text-green-400/80">WiFi · {t("settings.connected")}</span>
                      {wifiQuality.signalDbm !== null && (
                        <span className="text-[10px] text-white/45">· {dbmToLevel(wifiQuality.signalDbm)} bars · {wifiQuality.signalDbm} dBm</span>
                      )}
                      {wifiQuality.bitrateMbps !== null && (
                        <span className="text-[10px] text-white/45">· {Math.round(wifiQuality.bitrateMbps)} Mbps</span>
                      )}
                      {wifiQuality.pingMs !== null && (
                        <span className="text-[10px] text-white/45">· {wifiQuality.pingMs}ms gw</span>
                      )}
                    </div>
                  </div>
                </div>
              ) : ethernet.connected ? (
                <div className="flex items-center gap-4 bg-green-500/[0.06] border border-green-500/15 rounded-xl px-4 py-3.5">
                  <div className="w-10 h-10 rounded-full bg-green-500/15 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-green-400" style={{ fontSize: 22 }}>settings_ethernet</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-[var(--text-primary)] font-medium truncate">Ethernet{ethernet.iface ? ` (${ethernet.iface})` : ""}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                      <span className="text-xs text-green-400/80">Wired · {t("settings.connected")}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5">
                  <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-[var(--text-muted)] opacity-50" style={{ fontSize: 22 }}>wifi_off</span>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--text-muted)]">{t("settings.noWifiConnection")}</div>
                    <div className="text-xs text-[var(--text-muted)] opacity-50 mt-0.5">{t("settings.connectToNetwork")}</div>
                  </div>
                </div>
              )}

              {primaryLabel && (
                <div className="mt-4 rounded-xl border px-4 py-3 border-white/[0.06] bg-white/[0.03]">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 16 }}>link</span>
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">Access this device at</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <a href={primaryUrl} className="flex-1 min-w-0 text-sm font-mono text-[var(--text-primary)] hover:text-[var(--coral-bright)] truncate underline-offset-2 hover:underline">{primaryLabel}</a>
                    <button
                      onClick={copyLocalUrl}
                      className="px-2.5 py-1.5 bg-white/[0.06] hover:bg-white/[0.12] text-xs text-[var(--text-primary)] rounded-lg cursor-pointer border-none transition-colors flex items-center gap-1"
                      title="Copy URL"
                      aria-label={copiedLocalUrl ? "URL copied" : "Copy URL"}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">{copiedLocalUrl ? "check" : "content_copy"}</span>
                      {copiedLocalUrl ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <span className="sr-only" aria-live="polite">{copiedLocalUrl ? "URL copied to clipboard" : ""}</span>
                  {ipv4 && localUrl && (
                    <p className="text-[11px] text-[var(--text-muted)] mt-2 leading-relaxed">
                      <span className="font-mono text-[var(--text-secondary)]">{localUrl}</span> also works on networks that support mDNS. The IP can change when the device reconnects — reserve it in your router for a permanent address.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Hotspot toggle card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${hotspotEnabled && hotspotActive === false ? "bg-amber-400/15" : hotspotEnabled ? "bg-orange-500/15" : "bg-white/5"}`}>
                    <span className={`material-symbols-rounded ${hotspotEnabled && hotspotActive === false ? "text-amber-300" : hotspotEnabled ? "text-[var(--coral-bright)]" : "text-[var(--text-muted)] opacity-50"}`} style={{ fontSize: 22 }}>wifi_tethering</span>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--text-primary)] font-medium">{t("settings.hotspot")}</div>
                    <div className="text-xs text-white/35 mt-0.5">
                      {hotspotSSID}
                      {hotspotEnabled && hotspotActive === false && <span className="ml-2 text-amber-300/90">• not broadcasting</span>}
                      {hotspotEnabled && hotspotActive === true && <span className="ml-2 text-emerald-300/80">• broadcasting</span>}
                    </div>
                  </div>
                </div>
                <button
                  onClick={toggleHotspot}
                  disabled={hotspotEnabled === null || hotspotToggling}
                  className={`relative w-11 h-6 rounded-full transition-colors cursor-pointer border-none ${hotspotEnabled ? "bg-[#fe6e00]" : "bg-white/10"} ${hotspotToggling ? "opacity-50" : ""}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${hotspotEnabled ? "translate-x-5" : "translate-x-0"}`} />
                </button>
              </div>
              {hotspotApWarning && (
                <div className="mt-3"><StatusMessage type="info" message={hotspotApWarning} /></div>
              )}
              {hotspotEnabled && hotspotActive !== false && (
                <p className="text-[11px] text-[var(--text-muted)] opacity-50 mt-3 leading-relaxed">
                  {t("settings.hotspotDesc", { ssid: hotspotSSID })}
                </p>
              )}
              {hotspotEnabled && hotspotActive === false && (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2.5">
                  <span className="material-symbols-rounded text-amber-300 shrink-0" style={{ fontSize: 18 }}>warning</span>
                  <div className="text-[11px] text-amber-100/90 leading-relaxed">
                    Hotspot is not broadcasting{hotspotBlockedBy ? ` because this device is connected to "${hotspotBlockedBy}" over WiFi` : ""}.
                    The Jetson has a single WiFi radio, so the hotspot can only run when WiFi is disconnected or the device is on Ethernet.
                    Saved settings will apply automatically the next time the AP starts.
                  </div>
                </div>
              )}
              {hotspotEnabled && (
                <div className="mt-4 pt-4 border-t border-white/[0.06]">
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest block mb-2">
                    {t("settings.hotspot")} name
                  </label>
                  <div className="flex items-stretch gap-2 mb-4">
                    <input
                      type="text"
                      value={hotspotSSIDInput}
                      onChange={e => { setHotspotSSIDInput(e.target.value); setHotspotSSIDStatus(null); }}
                      maxLength={32}
                      placeholder="ClawBox-Setup"
                      className="flex-1 min-w-0 px-3.5 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none placeholder-white/15 focus:border-orange-400/60 focus:bg-white/[0.06] transition-all"
                    />
                    <button
                      onClick={saveHotspotSSID}
                      disabled={hotspotSSIDSaving || !hotspotSSIDInput.trim() || hotspotSSIDInput.trim() === hotspotSSID}
                      className="px-4 py-2.5 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-all"
                    >
                      {t("settings.save")}
                    </button>
                  </div>
                  {hotspotSSIDStatus && <div className="mb-4"><StatusMessage type={hotspotSSIDStatus.type} message={hotspotSSIDStatus.message} /></div>}
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest block mb-2">
                    {t("credentials.hotspotPassword")}
                  </label>
                  <div className="flex items-stretch gap-2">
                    <div className="flex-1 flex items-center bg-white/[0.04] border border-white/[0.08] rounded-xl overflow-hidden focus-within:border-orange-400/60 focus-within:bg-white/[0.06] transition-all">
                      <input
                        type={hotspotPasswordShow ? "text" : "password"}
                        value={hotspotPassword}
                        onChange={e => { setHotspotPassword(e.target.value); setHotspotPasswordStatus(null); }}
                        placeholder={hotspotHasPassword ? "••••••••" : "At least 8 characters"}
                        maxLength={63}
                        className="flex-1 min-w-0 px-3.5 py-2.5 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder-white/15"
                      />
                      <button
                        type="button"
                        onClick={() => setHotspotPasswordShow(v => !v)}
                        className="px-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer"
                        aria-label={hotspotPasswordShow ? "Hide password" : "Show password"}
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{hotspotPasswordShow ? "visibility_off" : "visibility"}</span>
                      </button>
                    </div>
                    <button
                      onClick={saveHotspotPassword}
                      disabled={hotspotPasswordSaving || hotspotPassword.length < 8}
                      className="px-4 py-2.5 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-all"
                    >
                      {t("settings.save")}
                    </button>
                  </div>
                  {hotspotPasswordStatus && <div className="mt-3"><StatusMessage type={hotspotPasswordStatus.type} message={hotspotPasswordStatus.message} /></div>}
                </div>
              )}
            </div>

            {/* Local URL (mDNS hostname) card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>link</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.localUrl")}</label>
              </div>
              <p className="text-[11px] text-[var(--text-muted)] opacity-60 mb-3 leading-relaxed">{t("settings.localUrlDesc")}</p>
              <div className="flex items-stretch gap-2">
                <div className="flex-1 flex items-center bg-white/[0.04] border border-white/[0.08] rounded-xl overflow-hidden focus-within:border-orange-400/60 focus-within:bg-white/[0.06] transition-all">
                  <input
                    type="text"
                    value={hostnameInput}
                    onChange={e => { setHostnameInput(e.target.value); setHostnameStatus(null); }}
                    maxLength={63}
                    placeholder="clawbox"
                    className="flex-1 min-w-0 px-3.5 py-2.5 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder-white/15"
                  />
                  <span className="px-3 text-sm text-[var(--text-muted)] opacity-60 select-none">.local</span>
                </div>
                <button
                  onClick={() => setHostnameConfirm(true)}
                  disabled={hostnameSaving || !hostnameInput.trim() || hostnameInput.trim().toLowerCase().replace(/\.local$/, "") === hostname}
                  className="px-4 py-2.5 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-all"
                >
                  {t("settings.save")}
                </button>
              </div>
              {hostnameStatus && <div className="mt-3"><StatusMessage type={hostnameStatus.type} message={hostnameStatus.message} /></div>}
            </div>

            {/* Saved networks card */}
            {savedNetworks.length > 0 && (
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                <div className="flex items-center gap-2 mb-4">
                  <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>bookmark</span>
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">Saved Networks</label>
                </div>
                <div className="space-y-2">
                  {savedNetworks.map(net => {
                    const isActive = !!net.device;
                    const isEditing = savedEditing === net.name;
                    return (
                      <div key={net.name} className="rounded-xl border border-white/[0.06] bg-white/[0.02]">
                        <div className="flex items-center gap-3 px-4 py-3">
                          <span className={`material-symbols-rounded ${isActive ? "text-green-400" : "text-[var(--text-muted)] opacity-60"}`} style={{ fontSize: 20 }}>{isActive ? "wifi" : "wifi_password"}</span>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-[var(--text-primary)] font-medium truncate">{net.name}</div>
                            {isActive && <div className="text-[10px] text-green-400/80 mt-0.5">Connected</div>}
                          </div>
                          <button onClick={() => { setSavedEditing(isEditing ? null : net.name); setSavedNewPassword(""); setSavedStatus(null); }} disabled={savedBusy === net.name} className="px-2 py-1 bg-white/[0.06] hover:bg-white/[0.12] text-xs text-[var(--text-primary)] rounded-lg cursor-pointer border-none transition-colors disabled:opacity-50" title="Edit password" aria-label={`Edit password for ${net.name}`}>
                            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{isEditing ? "close" : "edit"}</span>
                          </button>
                          <button onClick={() => forgetSavedNetwork(net.name)} disabled={savedBusy === net.name} className="px-2 py-1 bg-white/[0.06] hover:bg-red-500/30 text-xs text-[var(--text-primary)] rounded-lg cursor-pointer border-none transition-colors disabled:opacity-50" title="Forget" aria-label={`Forget ${net.name}`}>
                            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>delete</span>
                          </button>
                        </div>
                        {isEditing && (
                          <div className="px-4 pb-3 pt-1 border-t border-white/[0.04]">
                            <div className="flex items-stretch gap-2 mt-2">
                              <div className="flex-1 flex items-center bg-white/[0.04] border border-white/[0.08] rounded-lg overflow-hidden focus-within:border-orange-400/60">
                                <input type={savedShowPassword ? "text" : "password"} value={savedNewPassword} onChange={e => { setSavedNewPassword(e.target.value); setSavedStatus(null); }} placeholder="New password" maxLength={63} className="flex-1 min-w-0 px-3 py-2 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder-white/20" />
                                <button type="button" onClick={() => setSavedShowPassword(v => !v)} className="px-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer">
                                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{savedShowPassword ? "visibility_off" : "visibility"}</span>
                                </button>
                              </div>
                              <button onClick={() => updateSavedPassword(net.name)} disabled={savedBusy === net.name || savedNewPassword.length < 8} className="px-3 py-2 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-lg text-xs font-semibold cursor-pointer border-none">Save</button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {savedStatus && <div className="mt-3"><StatusMessage type={savedStatus.type} message={savedStatus.message} /></div>}
              </div>
            )}

            {/* Connect to network card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>add_circle</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.connectToNetworkBtn")}</label>
              </div>

              {/* Network list */}
              {wifiNetworks === null && !ssid && (
                <button
                  onClick={scanWifiNetworks}
                  disabled={wifiScanning}
                  className="w-full py-2.5 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[var(--text-primary)] rounded-xl text-sm font-medium cursor-pointer transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {wifiScanning ? (
                    <><span className="material-symbols-rounded animate-spin" style={{ fontSize: 16 }}>progress_activity</span> {t("settings.scanning")}</>
                  ) : (
                    <><span className="material-symbols-rounded" style={{ fontSize: 16 }}>wifi_find</span> {t("settings.availableNetworks")}</>
                  )}
                </button>
              )}

              {wifiNetworks !== null && !ssid && (
                <>
                  <div className="border border-white/[0.08] rounded-xl overflow-hidden mb-3">
                    <div className="flex items-center justify-between px-3.5 py-2 border-b border-white/[0.06]">
                      <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.availableNetworks")}</span>
                      <button
                        onClick={scanWifiNetworks}
                        disabled={wifiScanning}
                        className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer p-0.5 disabled:opacity-50 transition-colors"
                      >
                        <span className={`material-symbols-rounded ${wifiScanning ? "animate-spin" : ""}`} style={{ fontSize: 14 }}>refresh</span>
                        {wifiScanning ? t("settings.scanning") : t("wifi.refresh")}
                      </button>
                    </div>
                    {wifiNetworks.length > 0 ? (
                      <div className="max-h-[200px] overflow-y-auto">
                        {wifiNetworks.map((net) => (
                          <button
                            key={net.ssid}
                            onClick={() => selectNetwork(net)}
                            className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left bg-transparent border-none cursor-pointer hover:bg-white/[0.04] transition-colors"
                          >
                            <SignalBars level={signalToLevel(net.signal)} />
                            <span className="flex-1 text-sm text-[var(--text-primary)] truncate">{net.ssid}</span>
                            {net.security && net.security !== "--" && (
                              <span className="material-symbols-rounded text-[var(--text-muted)] opacity-40" style={{ fontSize: 14 }}>lock</span>
                            )}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-[var(--text-muted)] px-3.5 py-3">{t("settings.noNetworks")}</p>
                    )}
                  </div>
                  <button
                    onClick={() => setShowManualWifi(true)}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left bg-transparent border border-white/[0.08] rounded-xl cursor-pointer hover:bg-white/[0.04] transition-colors"
                  >
                    <span className="material-symbols-rounded text-[var(--text-muted)] opacity-40" style={{ fontSize: 16 }}>edit</span>
                    <span className="text-sm text-[var(--text-secondary)]">{t("settings.otherNetwork")}</span>
                  </button>
                </>
              )}

              {/* Connect form (shown after selecting a network or manual entry) */}
              {(ssid !== "" || showManualWifi) && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.networkName")}</label>
                    <div className="relative">
                      <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] opacity-40" style={{ fontSize: 18 }}>router</span>
                      <input
                        type="text" value={ssid} onChange={e => setSsid(e.target.value)}
                        placeholder={t("settings.enterNetworkName")}
                        readOnly={!showManualWifi && wifiNetworks !== null}
                        className="w-full pl-10 pr-4 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none focus:border-orange-400/60 focus:bg-white/[0.06] transition-all placeholder-white/15"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.password")}</label>
                    <div className="relative">
                      <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] opacity-40" style={{ fontSize: 18 }}>lock</span>
                      <input
                        type="password" value={wifiPass} onChange={e => setWifiPass(e.target.value)}
                        placeholder={t("settings.enterPassword")}
                        autoFocus
                        className="w-full pl-10 pr-4 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none focus:border-orange-400/60 focus:bg-white/[0.06] transition-all placeholder-white/15"
                        onKeyDown={e => e.key === "Enter" && connectWifi()}
                      />
                    </div>
                  </div>
                  {/* Hotspot warning */}
                  <div className="flex items-start gap-2.5 bg-amber-500/[0.07] border border-amber-500/15 rounded-xl px-3.5 py-3">
                    <span className="material-symbols-rounded text-amber-400 shrink-0 mt-0.5" style={{ fontSize: 16 }}>warning</span>
                    <p className="text-xs text-amber-300/70 leading-relaxed">
                      {t("settings.wifiWarning")}
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={connectWifi}
                      disabled={wifiConnecting || !ssid.trim()}
                      className="flex-1 py-2.5 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-all flex items-center justify-center gap-2 shadow-[0_2px_12px_rgba(254,110,0,0.25)]"
                    >
                      {wifiConnecting ? (
                        <><span className="material-symbols-rounded animate-spin" style={{ fontSize: 16 }}>progress_activity</span> {t("connecting")}</>
                      ) : (
                        <><span className="material-symbols-rounded" style={{ fontSize: 16 }}>link</span> {t("settings.connect")}</>
                      )}
                    </button>
                    <button
                      onClick={() => { setSsid(""); setWifiPass(""); setWifiStatus(null); setShowManualWifi(false); }}
                      className="py-2.5 px-4 bg-transparent border border-white/[0.08] text-[var(--text-secondary)] rounded-xl text-sm cursor-pointer hover:bg-white/[0.04] transition-all"
                    >
                      {t("settings.back")}
                    </button>
                  </div>
                  {wifiStatus && <StatusMessage type={wifiStatus.type} message={wifiStatus.message} />}
                </div>
              )}
            </div>

          </div>
        )}

        {/* ─── Providers: the cloud sign-ins, the owner's connected ones listed first ─── */}
        {activeSection === "ai" && (
          <div className="max-w-xl space-y-5">
            <AiProviderList />

            {/* No status card here. The AI Providers panel below opens with the
                hero, which names the active provider, its model and its
                connection — this card said the same three things one card
                higher. It was already suppressed on the Hermes edition for
                exactly that reason; the hero now renders on every edition, so
                the reason applies everywhere and the twin is gone. The two
                affordances only this card carried both survive inside the
                panel: the plan picker shows the ClawBox AI tier and links the
                portal dashboard. */}

            <I18nProvider><AIModelsStep
              embedded
              providerIds={["clawai", "openai", "anthropic", "google", "openrouter"]}
              defaultProviderId="clawai"
              currentProviderId={aiProvider?.provider ?? null}
              currentModel={aiProvider?.model ?? null}
              openClawAIOfferRequest={openClawAIOfferRequest}
              requestedProviderId={requestedAiProviderId}
              providerSelectionRequest={providerSelectionRequest}
              title="Connect AI Provider"
              description="Choose the primary AI service your assistant should use day to day"
              onConfigured={() => {
                fetch("/setup-api/ai-models/status", { cache: "no-store" }).then(r => r.json()).then(setAiProvider).catch(() => {});
                notifyChatModelStateChanged();
                window.dispatchEvent(new Event("clawbox:primary-ai-configured"));
              }}
            /></I18nProvider>
          </div>
        )}

        {/* ─── Local AI: everything on the box, one grouped list ─── */}
        {activeSection === "localAi" && (
          <LocalAiPanel active={localTabOpen} edition={edition} />
        )}


        {/* ─── Voice ─── */}
        {activeSection === "voice" && (
          <VoiceOutputPanel active={activeSection === "voice"} />
        )}

        {/* ─── Accounts (the hub) ───
            One page for every messaging channel the assistant can be reached
            through, in the shape people already know from GNOME's Online
            Accounts: a row per channel with its live status, opening that
            channel's own settings. */}
        {activeSection === "channels" && (
          <div className="max-w-xl space-y-5">
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-1">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>forum</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
                  {t("settings.channelsConnect")}
                </label>
              </div>
              <p className="text-[11px] text-[var(--text-muted)] mb-4 leading-relaxed">{t("settings.channelsHelper")}</p>
              <div className="rounded-xl border border-white/[0.08] overflow-hidden divide-y divide-white/[0.06]" data-testid="settings-channels-list">
                {CHANNEL_ITEMS.map((item) => {
                  const state = channelState(item.id);
                  const connected = state === "connected";
                  const { subtitle } = sectionStatus(item.id);
                  const refreshChannel = {
                    telegram: refreshTelegramStatus,
                    email: refreshEmailStatus,
                    whatsapp: refreshWhatsapp,
                    discord: refreshDiscordStatus,
                  }[item.id];
                  return (
                    <div
                      key={item.id}
                      className="w-full flex items-center hover:bg-white/[0.04] transition-colors"
                    >
                      {/* The row navigates; Retry is its SIBLING, not a control
                          nested inside it. A <button> may not contain another
                          interactive element: the retry's label would be
                          absorbed into the accessible name of the control that
                          navigates away, and browse mode commonly flattens the
                          inner one out of reach entirely. */}
                      <button
                        type="button"
                        ref={(el) => { channelRowRefs.current[item.id] = el; }}
                        onClick={() => setSectionGated(item.id)}
                        data-testid={`settings-channel-${item.id}`}
                        data-state={state}
                        className="flex-1 min-w-0 flex items-center gap-3 px-3 py-3 text-left bg-transparent border-none cursor-pointer"
                      >
                        {/* The ligature IS the glyph's text, so without this the
                            row's accessible name began "chat", "send", "mail",
                            "forum" — read out before the channel's own name. */}
                        <span className="flex items-center justify-center w-9 h-9 rounded-lg shrink-0 bg-white/[0.06]" aria-hidden="true">
                          <span className="material-symbols-rounded" style={{ fontSize: 20, color: connected ? "var(--coral-bright)" : "var(--text-muted)" }}>
                            {item.icon}
                          </span>
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm text-[var(--text-primary)] font-medium truncate">{t(item.labelKey)}</span>
                          {/* State first, subtitle second. A subtitle is only
                              ever a description of an ANSWER, so when there is
                              no answer it must not be allowed to speak: reading
                              `subtitle ?? …` here let a route that says "not
                              configured" without being able to verify it print
                              those very words over a live channel.
                              The words are part of the row's accessible name,
                              which is what actually carries the state to a
                              screen reader — a live region that appears already
                              populated does not reliably announce. */}
                          <span className="block text-[11px] text-[var(--text-muted)] truncate">
                            {state === "unknown"
                              ? t("settings.checking")
                              : state === "unreachable"
                                ? t("settings.statusUnavailable")
                                : (subtitle ?? t(item.hintKey))}
                          </span>
                        </span>
                        {/* A mark per state: set up, still asking, and asked but
                            unanswered. "Still asking" used to look exactly like
                            "nothing there", which is the bug this row had. The
                            dot means the channel is CONFIGURED, not that traffic
                            is flowing — `channelConnected` does not read the
                            routes' `receiving` field (TASK-693). */}
                        {connected ? (
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" aria-hidden="true" />
                        ) : state === "unknown" ? (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-white/25 shrink-0 animate-pulse motion-reduce:animate-none"
                            aria-hidden="true"
                          />
                        ) : state === "unreachable" ? (
                          <span className="w-1.5 h-1.5 rounded-full bg-white/25 shrink-0" aria-hidden="true" />
                        ) : null}
                        <span className="material-symbols-rounded text-[var(--text-muted)] shrink-0" style={{ fontSize: 18 }} aria-hidden="true">
                          chevron_right
                        </span>
                      </button>
                      {/* A dead end needs a way out. Named per channel, because
                          up to four rows can be unreachable at once and four
                          controls all called "Retry" name nothing. */}
                      {state === "unreachable" && (
                        <button
                          type="button"
                          data-testid={`settings-channel-retry-${item.id}`}
                          aria-label={`${t("settings.retry")} — ${t(item.labelKey)}`}
                          onClick={() => {
                            // Before anything re-renders: this button is about
                            // to unmount under its own click, and focus must
                            // land on the row rather than on <body>.
                            channelRowRefs.current[item.id]?.focus();
                            unsettleChannel(item.id);
                            void refreshChannel();
                          }}
                          className="text-[11px] text-[var(--coral-bright)] shrink-0 mr-3 px-1 py-1 bg-transparent border-none cursor-pointer hover:underline"
                        >
                          {t("settings.retry")}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* The way back out of a channel pane, now that the sidebar has no
            row of its own for it. */}
        {isChannelSection(activeSection) && (
          <div className="max-w-xl">
            <button
              type="button"
              onClick={() => setSectionGated("channels")}
              data-testid="settings-channels-back"
              className="flex items-center gap-1 mb-3 px-2 py-1 -ml-2 rounded-lg bg-transparent border-none cursor-pointer text-[13px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.05] transition-colors"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">chevron_left</span>
              {t("settings.channels")}
            </button>
          </div>
        )}

        {/* ─── Telegram ─── */}
        {activeSection === "telegram" && (
          <div className="max-w-xl space-y-5">

            {/* Status card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="#f97316"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.96 6.504-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.492-1.302.48-.428-.012-1.252-.242-1.865-.44-.751-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.status")}</label>
              </div>
              {tgConfigured === null ? (
                <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5 animate-pulse">
                  <div className="w-10 h-10 rounded-full bg-white/[0.08] shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-32 rounded bg-white/[0.08]" />
                    <div className="h-2 w-20 rounded bg-white/[0.06]" />
                  </div>
                </div>
              ) : tgConfigured && !tgReconfigure ? (
                <div>
                  <div className="flex items-center gap-4 bg-green-500/[0.06] border border-green-500/15 rounded-xl px-4 py-3.5 mb-4">
                    <div className="w-10 h-10 rounded-full bg-green-500/15 flex items-center justify-center shrink-0">
                      <span className="material-symbols-rounded text-green-400" style={{ fontSize: 22 }}>check_circle</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-[var(--text-primary)] font-medium">
                        {tgBotInfo?.firstName || t("settings.botConnected")}
                      </div>
                      {tgBotInfo?.username && (
                        <div className="text-xs text-[var(--text-muted)] mt-0.5 truncate">@{tgBotInfo.username}</div>
                      )}
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                        <span className="text-xs text-green-400/80">{t("settings.telegramActive")}</span>
                      </div>
                    </div>
                  </div>
                  {tgBotInfo?.link && (
                    <a
                      href={tgBotInfo.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center gap-2 w-full px-4 py-3 mb-4 bg-[#229ED9]/15 hover:bg-[#229ED9]/25 border border-[#229ED9]/40 hover:border-[#229ED9]/60 rounded-lg text-sm font-semibold text-[#5eb8e6] transition-colors no-underline"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>
                      {t("settings.openInTelegram", { name: `@${tgBotInfo.username}` })}
                    </a>
                  )}
                  {/* Progress streaming is the OpenClaw gateway's Telegram
                      channel setting. Hermes runs Telegram from ~/.hermes/.env
                      and has no streaming mode at all, so this switch rendered
                      itself ON (a missing config file reads as "not off") over
                      a route that answered {restarted:true} for a gateway that
                      does not exist. Telegram ITSELF works on Hermes — only
                      this sub-setting does not, so only this row goes. */}
                  {edition !== "hermes" && (
                  <div className="flex items-center justify-between gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5 mb-4">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-[var(--text-primary)] font-medium">{t("settings.telegramProgress")}</div>
                      <p className="text-xs text-[var(--text-secondary)] mt-0.5">{t("settings.telegramProgressHint")}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {tgStreamingPending && (
                        <span className="material-symbols-rounded animate-spin text-[var(--text-muted)]" style={{ fontSize: 18 }} aria-hidden="true">progress_activity</span>
                      )}
                      <button
                        type="button"
                        role="switch"
                        aria-label={t("settings.telegramProgress")}
                        aria-checked={!!tgStreaming}
                        aria-busy={tgStreamingPending}
                        disabled={tgStreamingPending || tgStreaming === null}
                        onClick={() => toggleTelegramStreaming(!tgStreaming)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 ${
                          tgStreaming ? "bg-[var(--coral-bright)]" : "bg-gray-600"
                        }`}
                      >
                        <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${tgStreaming ? "translate-x-6" : "translate-x-1"}`} />
                      </button>
                    </div>
                  </div>
                  )}
                  <button
                    onClick={() => { setTgReconfigure(true); setTgStatus(null); }}
                    className="text-sm text-[var(--coral-bright)] hover:text-orange-300 bg-transparent border-none cursor-pointer underline underline-offset-2"
                  >
                    {t("settings.reconfigureBot")}
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5">
                  <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-[var(--text-muted)] opacity-50" style={{ fontSize: 22 }}>link_off</span>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--text-muted)]">{t("settings.notConfigured")}</div>
                    <div className="text-xs text-[var(--text-muted)] opacity-50 mt-0.5">{t("settings.setupBotBelow")}</div>
                  </div>
                </div>
              )}
            </div>

            {/* User access — pairing approval (only when a bot is configured) */}
            {tgConfigured && !tgReconfigure && !tgConfiguring && (
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                <div className="flex items-center gap-2 mb-1">
                  <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 18 }} aria-hidden="true">group</span>
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.pairingTitle")}</label>
                </div>
                <p className="text-xs text-[var(--text-secondary)] mb-4">{t("settings.pairingHint")}</p>

                {/* Paste a code */}
                <div className="flex items-stretch gap-2">
                  <input
                    type="text"
                    value={tgPairingCode}
                    onChange={(e) => { setTgPairingCode(e.target.value.toUpperCase()); setTgPairingStatus(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter" && !tgApproving) approvePairingCode(tgPairingCode); }}
                    placeholder={t("settings.pairingCodePlaceholder")}
                    aria-label={t("settings.pairingCodePlaceholder")}
                    maxLength={8}
                    spellCheck={false}
                    autoCapitalize="characters"
                    className="flex-1 min-w-0 px-3 py-2.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-[var(--text-primary)] font-mono tracking-[0.3em] uppercase placeholder:tracking-normal placeholder:font-sans focus:outline-none focus:border-[var(--coral-bright)]/60"
                  />
                  <button
                    type="button"
                    disabled={tgApproving || tgPairingCode.trim().length !== 8}
                    onClick={() => approvePairingCode(tgPairingCode)}
                    className="px-4 py-2.5 rounded-lg bg-[var(--coral-bright)] hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold text-white transition-colors shrink-0 inline-flex items-center gap-1.5"
                  >
                    {tgApproving && <span className="material-symbols-rounded animate-spin" style={{ fontSize: 16 }} aria-hidden="true">progress_activity</span>}
                    {t("settings.pairingApprove")}
                  </button>
                </div>

                {tgPairingStatus && <div className="mt-3"><StatusMessage type={tgPairingStatus.type} message={tgPairingStatus.message} /></div>}

                {/* Pending requests — opt-in load (the list CLI is slow on Jetson) */}
                <div className="mt-4">
                  {tgPending === null ? (
                    <button
                      type="button"
                      disabled={tgPendingLoading}
                      onClick={loadPending}
                      className="inline-flex items-center gap-1.5 text-sm text-[var(--coral-bright)] hover:text-orange-300 bg-transparent border-none cursor-pointer disabled:opacity-50 p-0"
                    >
                      <span className={`material-symbols-rounded ${tgPendingLoading ? "animate-spin" : ""}`} style={{ fontSize: 16 }} aria-hidden="true">{tgPendingLoading ? "progress_activity" : "refresh"}</span>
                      {tgPendingLoading ? t("settings.pairingChecking") : t("settings.pairingCheck")}
                    </button>
                  ) : (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-[var(--text-secondary)]">{t("settings.pairingPending")}</span>
                        <button
                          type="button"
                          disabled={tgPendingLoading}
                          onClick={loadPending}
                          className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer disabled:opacity-50 p-0"
                        >
                          <span className={`material-symbols-rounded ${tgPendingLoading ? "animate-spin" : ""}`} style={{ fontSize: 14 }} aria-hidden="true">{tgPendingLoading ? "progress_activity" : "refresh"}</span>
                          {t("settings.pairingCheck")}
                        </button>
                      </div>
                      {tgPending.length === 0 ? (
                        <p className="text-xs text-[var(--text-muted)]">{t("settings.pairingNoPending")}</p>
                      ) : (
                        <ul className="space-y-2 list-none p-0 m-0">
                          {tgPending.map((req, i) => {
                            const label = req.name || req.id || req.code || `#${i + 1}`;
                            return (
                              <li key={req.code || req.id || i} className="flex items-center justify-between gap-3 bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2">
                                <div className="min-w-0">
                                  <div className="text-sm text-[var(--text-primary)] truncate">{label}</div>
                                  {req.id && label !== req.id && <div className="text-xs text-[var(--text-muted)] font-mono truncate">{req.id}</div>}
                                </div>
                                {req.code && (
                                  <button
                                    type="button"
                                    disabled={tgApproving}
                                    onClick={() => approvePairingCode(req.code!)}
                                    className="px-3 py-1.5 rounded-md bg-[var(--coral-bright)]/15 hover:bg-[var(--coral-bright)]/25 border border-[var(--coral-bright)]/40 text-xs font-semibold text-[var(--coral-bright)] transition-colors shrink-0 disabled:opacity-50 cursor-pointer"
                                  >
                                    {t("settings.pairingApprove")}
                                  </button>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </div>

                {/* Approved users */}
                <div className="mt-4 pt-4 border-t border-white/[0.06]">
                  <span className="text-xs font-semibold text-[var(--text-secondary)]">{t("settings.pairingApprovedTitle")}</span>
                  {tgApproved.length === 0 ? (
                    <p className="text-xs text-[var(--text-muted)] mt-1">{t("settings.pairingNoApproved")}</p>
                  ) : (
                    <ul className="mt-2 flex flex-wrap gap-2 list-none p-0 m-0">
                      {tgApproved.map((u) => (
                        <li key={u.id} className="inline-flex items-center gap-1.5 bg-white/[0.04] border border-white/[0.08] rounded-full px-3 py-1 text-xs text-[var(--text-secondary)]">
                          <span className="material-symbols-rounded text-green-400" style={{ fontSize: 14 }} aria-hidden="true">check</span>
                          {u.name ? (
                            <>
                              <span>{u.name}</span>
                              <span className="text-[10px] text-[var(--text-muted)] font-mono">{u.id}</span>
                            </>
                          ) : (
                            <span className="font-mono">{u.id}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}

            {/* Setup card — shown when not configured or reconfiguring */}
            {(tgConfigured === false || tgReconfigure || tgConfiguring) && (
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5 relative overflow-hidden">
                {tgConfiguring && (
                  <TelegramConfiguringOverlay
                    waitFor={tgConfigurePromise}
                    onDone={() => {
                      setTgConfiguring(false);
                      setTgConfigurePromise(undefined);
                      refreshTelegramStatus();
                    }}
                    onTimeout={() => {
                      tgSaveControllerRef.current?.abort();
                      tgSaveControllerRef.current = null;
                      setTgSaving(false);
                      setTgConfiguring(false);
                      setTgConfigurePromise(undefined);
                      setTgStatus({ type: "error", message: t("settings.connectionFailed") });
                      refreshTelegramStatus();
                    }}
                  />
                )}
                <div className={tgConfiguring ? "invisible h-0 overflow-hidden" : ""}>
                <div className="flex items-center gap-2 mb-4">
                  <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>add_circle</span>
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
                    {tgReconfigure ? t("settings.reconfigureBot") : t("settings.setupBot")}
                  </label>
                </div>

                {/* Instructions with QR */}
                <div className="flex gap-4 items-start mb-5">
                  <div className="shrink-0 p-2 bg-white rounded-lg">
                    <QRCodeSVG value="https://t.me/BotFather" size={80} level="M" bgColor="#ffffff" fgColor="#000000" />
                  </div>
                  <ol className="ml-0 pl-5 leading-[1.9] text-sm text-white/70 list-decimal">
                    <li>
                      Scan the QR or open{" "}
                      <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-[var(--coral-bright)] hover:text-orange-300 font-semibold no-underline">
                        @BotFather
                      </a>{" "}
                      in Telegram
                    </li>
                    <li>
                      Send{" "}
                      <code className="bg-white/[0.06] px-1.5 py-0.5 rounded text-xs text-[var(--coral-bright)]">
                        /newbot
                      </code>{" "}
                      and follow the prompts
                    </li>
                    <li>
                      Copy the <strong className="text-[var(--text-primary)]">Bot Token</strong> and paste below
                    </li>
                  </ol>
                </div>

                {/* Token input */}
                <div>
                  <label htmlFor="settings-tg-token" className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.botToken")}</label>
                  <div className="relative">
                    <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] opacity-40" style={{ fontSize: 18 }}>key</span>
                    <input
                      id="settings-tg-token"
                      type={tgShowToken ? "text" : "password"}
                      value={tgToken}
                      onChange={(e) => { setTgToken(e.target.value); setTgStatus(null); }}
                      placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
                      spellCheck={false}
                      autoComplete="off"
                      className="w-full pl-10 pr-10 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none focus:border-orange-400/60 focus:bg-white/[0.06] transition-all placeholder-white/15"
                      onKeyDown={e => e.key === "Enter" && saveTelegram()}
                    />
                    <button
                      type="button"
                      onClick={() => setTgShowToken(v => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] opacity-50 hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer p-0.5"
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{tgShowToken ? "visibility_off" : "visibility"}</span>
                    </button>
                  </div>
                </div>

                {tgStatus && <div className="mt-3"><StatusMessage type={tgStatus.type} message={tgStatus.message} /></div>}

                <div className="flex items-center gap-3 mt-5">
                  <button
                    onClick={saveTelegram}
                    disabled={tgSaving || !tgToken.trim()}
                    className="px-6 py-2.5 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-all flex items-center justify-center gap-2 shadow-[0_2px_12px_rgba(254,110,0,0.25)]"
                  >
                    {tgSaving ? (
                      <>
                        <span className="material-symbols-rounded animate-spin" style={{ fontSize: 16 }}>progress_activity</span>
                        {t("connecting")}
                      </>
                    ) : (
                      <>
                        <span className="material-symbols-rounded" style={{ fontSize: 16 }}>link</span>
                        {t("settings.connect")}
                      </>
                    )}
                  </button>
                  {tgReconfigure && (
                    <button
                      onClick={() => { setTgReconfigure(false); setTgStatus(null); setTgToken(""); }}
                      className="text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer"
                    >
                      {t("cancel")}
                    </button>
                  )}
                </div>
                </div>
              </div>
            )}

          </div>
        )}

        {/* ─── Email ─── */}
        {activeSection === "email" && (
          <div className="max-w-xl space-y-5" data-testid="settings-section-email">

            {/* Status */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">mail</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.status")}</label>
              </div>

              {emailStatus === null ? (
                <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5 animate-pulse">
                  <div className="w-10 h-10 rounded-full bg-white/[0.08] shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-40 rounded bg-white/[0.08]" />
                    <div className="h-2 w-24 rounded bg-white/[0.06]" />
                  </div>
                </div>
              ) : emailStatus.configured && !emailReconfigure ? (
                <div>
                  <div className="flex items-center gap-4 bg-green-500/[0.06] border border-green-500/15 rounded-xl px-4 py-3.5 mb-4">
                    <div className="w-10 h-10 rounded-full bg-green-500/15 flex items-center justify-center shrink-0">
                      <span className="material-symbols-rounded text-green-400" style={{ fontSize: 22 }}>check_circle</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-[var(--text-primary)] font-medium truncate">
                        {t("settings.emailConnected", { address: emailStatus.address || "" })}
                      </div>
                      <div className="text-xs text-[var(--text-muted)] mt-0.5 truncate">
                        {emailStatus.smtpHost}:{emailStatus.smtpPort}
                      </div>
                      {emailStatus.inboundSupported && (
                        <div className="text-xs text-[var(--text-muted)] opacity-70 mt-0.5">
                          {emailStatus.inbound ? t("settings.emailInboundOn") : t("settings.emailInboundOff")}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={sendTestEmail}
                      disabled={emailTesting}
                      className="px-4 py-2.5 rounded-lg bg-[var(--coral-bright)] hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold text-white transition-colors border-none cursor-pointer inline-flex items-center gap-2"
                    >
                      {emailTesting && <span className="material-symbols-rounded animate-spin" style={{ fontSize: 16 }} aria-hidden="true">progress_activity</span>}
                      {emailTesting ? t("settings.emailSendingTest") : t("settings.emailSendTest")}
                    </button>
                    <button
                      type="button"
                      onClick={openEmailReconfigure}
                      className="text-sm text-[var(--coral-bright)] hover:text-orange-300 bg-transparent border-none cursor-pointer underline underline-offset-2"
                    >
                      {t("settings.emailReconfigure")}
                    </button>
                    <button
                      type="button"
                      onClick={disconnectEmail}
                      disabled={emailSaving}
                      className="text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer disabled:opacity-50"
                    >
                      {t("settings.emailDisconnect")}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5">
                  <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-[var(--text-muted)] opacity-50" style={{ fontSize: 22 }}>link_off</span>
                  </div>
                  <div className="text-sm text-[var(--text-muted)]">{t("settings.notConfigured")}</div>
                </div>
              )}

              {emailMsg && <div className="mt-4"><StatusMessage type={emailMsg.type} message={emailMsg.message} /></div>}
            </div>

            {/* Approvals. Only shown when something is actually waiting — an
                empty queue is not news, and this panel is mostly looked at for
                other reasons. Every string here is agent-composed text, so it
                is rendered as text and never as markup. */}
            {emailLostDraft !== null && (
              <div className="rounded-2xl border border-amber-400/30 bg-amber-500/[0.06] p-5" data-testid="settings-email-lost-draft">
                <div className="flex items-center gap-2 mb-3">
                  <span className="material-symbols-rounded text-amber-300" style={{ fontSize: 18 }} aria-hidden="true">warning</span>
                  {/* The heading is a verdict of its own, and there are two of
                      them. "This message was not sent" is right over a refusal
                      the mail server spoke and wrong over a dropped connection,
                      where nobody knows — and the wrong one is the one that
                      gets the recipient mailed twice. */}
                  <span className="text-sm text-[var(--text-primary)]">
                    {t(emailLostDraft.unconfirmed ? "settings.emailApproveUnconfirmedDraft" : "settings.emailApproveFailedDraft")}
                  </span>
                </div>
                <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3.5">
                  <div className="text-xs text-[var(--text-muted)] break-words">
                    {t("settings.emailPendingTo")}: {emailLostDraft.to.join(", ")}
                  </div>
                  <div className="text-sm text-[var(--text-primary)] font-medium mt-1 break-words">{emailLostDraft.subject}</div>
                  <div className="text-xs text-[var(--text-secondary)] mt-1 whitespace-pre-wrap break-words">{emailLostDraft.body}</div>
                </div>
              </div>
            )}

            {emailPending.length > 0 && (
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid="settings-email-approvals">
                <div className="flex items-center gap-2 mb-4">
                  <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">outgoing_mail</span>
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.emailPending")}</label>
                  <span className="ml-auto text-xs font-mono text-[var(--coral-bright)]/70 bg-orange-500/10 px-2 py-0.5 rounded-md">
                    {t("settings.emailPendingCount", { count: String(emailPending.length) })}
                  </span>
                </div>

                <div className="space-y-3">
                  {emailPending.map((draft) => (
                    <div key={draft.id} className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3.5">
                      <div className="text-xs text-[var(--text-muted)] truncate">
                        {t("settings.emailPendingTo")}: {draft.to.join(", ")}
                      </div>
                      <div className="text-sm text-[var(--text-primary)] font-medium mt-1 break-words">{draft.subject}</div>
                      <div className="text-xs text-[var(--text-secondary)] mt-1 whitespace-pre-wrap break-words">{draft.preview}</div>
                      <div className="flex flex-wrap items-center gap-3 mt-3">
                        <button
                          type="button"
                          onClick={() => decidePending(draft.id, "approve")}
                          disabled={emailPendingBusy !== null}
                          className="px-4 py-2 rounded-lg bg-[var(--coral-bright)] hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold text-white transition-colors border-none cursor-pointer inline-flex items-center gap-2"
                        >
                          {emailPendingBusy === draft.id && <span className="material-symbols-rounded animate-spin" style={{ fontSize: 16 }} aria-hidden="true">progress_activity</span>}
                          {t("settings.emailApprove")}
                        </button>
                        <button
                          type="button"
                          onClick={() => decidePending(draft.id, "reject")}
                          disabled={emailPendingBusy !== null}
                          className="text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer disabled:opacity-50"
                        >
                          {t("settings.emailReject")}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* What became of the drafts that are no longer waiting.
                Shown only when there is something to say — an empty
                strip is not news — and it fades on its own, because
                the receipts behind it expire after a day. Every
                string here is agent-composed text and is rendered as
                text, exactly like the queue above it. */}
            {emailHandled.length > 0 && (
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid="settings-email-handled">
                <div className="flex items-center gap-2 mb-4">
                  <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 18 }} aria-hidden="true">history</span>
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.emailHandled")}</label>
                </div>
                <div className="space-y-3">
                  {emailHandled.map((entry) => (
                    <div
                      key={entry.id}
                      data-outcome-id={entry.id}
                      data-outcome-kind={entry.kind}
                      className="rounded-xl bg-white/[0.02] border border-white/[0.06] px-4 py-3"
                    >
                      <div className="text-xs text-[var(--text-muted)] truncate">
                        {t("settings.emailPendingTo")}: {entry.to.join(", ")}
                      </div>
                      <div className="text-sm text-[var(--text-primary)] font-medium mt-1 break-words">{entry.subject}</div>
                      <div
                        className={`text-xs mt-1 break-words ${entry.kind === "sent" ? "text-emerald-300" : entry.kind === "failed" ? "text-red-300" : entry.kind === "unconfirmed" ? "text-amber-300" : "text-[var(--text-muted)]"}`}
                      >
                        {/* Each ending in its own words. "Not sent" over a
                            deletion, a duplicate and a mail-server refusal
                            alike would send the owner looking for a fault in
                            two cases where there is none. */}
                        {entry.kind === "sent"
                          ? t("settings.emailHandledSent", {
                              time: new Date(entry.at).toLocaleTimeString(undefined, {
                                hour: "2-digit",
                                minute: "2-digit",
                              }),
                            })
                          : entry.kind === "rejected"
                            ? t("settings.emailHandledDeleted")
                            : entry.kind === "duplicate"
                              ? t("settings.emailHandledDuplicate")
                              : entry.kind === "unconfirmed"
                                // Never "Not sent": the box handed the message
                                // over and never heard back, and a confident
                                // "not sent" is how a person sends it twice.
                                ? t("settings.emailHandledUnconfirmed")
                                : t("settings.emailHandledFailed", { reason: entry.error || "" })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Approve from chat. Shown only once an account exists AND the
                owner has asked to be asked -- with askBeforeSend off there is
                nothing to approve, and offering the switch would suggest
                otherwise. */}
            {emailStatus?.configured && emailStatus.askBeforeSend && (
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid="settings-email-chat-approval">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">forum</span>
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.emailChatApproval")}</label>
                </div>
                <p className="text-xs text-[var(--text-secondary)] mb-4">{t("settings.emailChatApprovalHelp")}</p>

                {chatApproval?.botConfigured ? (
                  <div className="space-y-3">
                    <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3.5">
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          data-testid="settings-email-chat-approval-toggle"
                          checked={chatApproval.enabled}
                          disabled={chatApprovalBusy}
                          onChange={(e) => submitChatApproval({ enabled: e.target.checked })}
                          className="mt-0.5 accent-[var(--coral-bright)]"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm text-[var(--text-primary)] font-medium">{t("settings.emailChatApprovalOn")}</span>
                          <span className="block text-xs text-[var(--text-secondary)] mt-0.5 break-words">
                            {t("settings.emailChatApprovalConnected", { bot: chatApproval.botUsername ?? "" })}
                          </span>
                        </span>
                      </label>
                    </div>
                    {chatApproval.ownerChats === 0 && (
                      <p className="text-xs text-amber-300/90" data-testid="settings-email-chat-approval-no-peers">
                        {t("settings.emailChatApprovalNoPeers")}
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => submitChatApproval(null)}
                      disabled={chatApprovalBusy}
                      className="text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer disabled:opacity-50 px-0"
                    >
                      {t("settings.emailChatApprovalDisconnect")}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <input
                      type="password"
                      data-testid="settings-email-chat-approval-token"
                      value={chatApprovalToken}
                      onChange={(e) => setChatApprovalToken(e.target.value)}
                      placeholder={t("settings.emailChatApprovalToken")}
                      autoComplete="off"
                      className="w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-white/[0.06] text-base text-[var(--text-primary)] outline-none focus:border-[var(--coral-bright)]/50"
                    />
                    <button
                      type="button"
                      onClick={() => submitChatApproval({ botToken: chatApprovalToken.trim(), enabled: true })}
                      disabled={chatApprovalBusy || chatApprovalToken.trim().length === 0}
                      className="px-4 py-2 rounded-lg bg-[var(--coral-bright)] hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold text-white transition-colors border-none cursor-pointer inline-flex items-center gap-2"
                    >
                      {chatApprovalBusy && <span className="material-symbols-rounded animate-spin" style={{ fontSize: 16 }} aria-hidden="true">progress_activity</span>}
                      {t("settings.emailChatApprovalConnect")}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Setup */}
            {(emailStatus === null || !emailStatus.configured || emailReconfigure) && (
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">add_circle</span>
                  <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.emailAccount")}</label>
                </div>

                {/* The 3-step Gmail guide, in the panel rather than behind a docs link */}
                <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3.5 mb-5">
                  <div className="text-sm text-[var(--text-primary)] font-medium mb-2">{t("settings.emailGuideTitle")}</div>
                  <ol className="ml-0 pl-5 leading-[1.9] text-sm text-[var(--text-secondary)] list-decimal">
                    <li>{t("settings.emailGuideStep1")}</li>
                    <li>
                      {t("settings.emailGuideStep2")}{" "}
                      <a
                        href="https://myaccount.google.com/apppasswords"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--coral-bright)] hover:text-orange-300 font-semibold no-underline"
                      >
                        {t("settings.emailGuideLink")}
                      </a>
                    </li>
                    <li>{t("settings.emailGuideStep3")}</li>
                  </ol>
                  <p className="text-xs text-[var(--text-muted)] mt-2">{t("settings.emailGuideOther")}</p>
                </div>

                <div className="space-y-4">
                  <div>
                    <label htmlFor="settings-email-address" className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.emailAddress")}</label>
                    <input
                      id="settings-email-address"
                      type="email"
                      value={emailAddress}
                      onChange={(e) => { setEmailAddress(e.target.value); setEmailMsg(null); }}
                      placeholder="you@gmail.com"
                      spellCheck={false}
                      autoComplete="off"
                      className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none focus:border-orange-400/60 focus:bg-white/[0.06] transition-all placeholder-white/15"
                    />
                  </div>

                  <div>
                    <label htmlFor="settings-email-password" className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.emailAppPassword")}</label>
                    <div className="relative">
                      <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] opacity-40" style={{ fontSize: 18 }}>key</span>
                      <input
                        id="settings-email-password"
                        type={emailShowPassword ? "text" : "password"}
                        value={emailPassword}
                        onChange={(e) => { setEmailPassword(e.target.value); setEmailMsg(null); }}
                        placeholder="abcd efgh ijkl mnop"
                        spellCheck={false}
                        autoComplete="off"
                        className="w-full pl-10 pr-10 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none focus:border-orange-400/60 focus:bg-white/[0.06] transition-all placeholder-white/15"
                        onKeyDown={(e) => e.key === "Enter" && saveEmail()}
                      />
                      <button
                        type="button"
                        onClick={() => setEmailShowPassword((v) => !v)}
                        aria-label={emailShowPassword ? "Hide password" : "Show password"}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] opacity-50 hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer p-0.5"
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{emailShowPassword ? "visibility_off" : "visibility"}</span>
                      </button>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <div className="flex-1 min-w-0">
                      <label htmlFor="settings-email-host" className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.emailHost")}</label>
                      <input
                        id="settings-email-host"
                        type="text"
                        value={emailHost}
                        onChange={(e) => { setEmailHost(e.target.value); setEmailMsg(null); }}
                        spellCheck={false}
                        autoComplete="off"
                        className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none focus:border-orange-400/60 transition-all"
                      />
                    </div>
                    <div className="w-24 shrink-0">
                      <label htmlFor="settings-email-port" className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.emailPort")}</label>
                      <input
                        id="settings-email-port"
                        type="text"
                        inputMode="numeric"
                        value={emailPort}
                        onChange={(e) => { setEmailPort(e.target.value.replace(/[^0-9]/g, "")); setEmailMsg(null); }}
                        className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none focus:border-orange-400/60 transition-all"
                      />
                    </div>
                  </div>

                  {/* The three modes, as ONE choice: "answers senders but may
                      not read them" is not a thing, so two booleans would spell
                      states that cannot exist. */}
                  <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3.5">
                    <div className="text-[11px] font-medium text-white/35 uppercase tracking-wider mb-3">{t("settings.emailMode")}</div>
                    <div className="space-y-3" role="radiogroup" aria-label={t("settings.emailMode")}>
                      {EMAIL_MODE_OPTIONS.map((opt) => {
                        // "Answer senders" is Hermes' native adapter and has no
                        // OpenClaw equivalent. Shown disabled with the reason
                        // rather than silently missing, so the panel does not
                        // look different on the two editions for no visible cause.
                        const unavailable = opt.id === "answer" && !emailStatus?.inboundSupported;
                        return (
                          <label
                            key={opt.id}
                            className={`flex items-start gap-3 ${unavailable ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                          >
                            <input
                              type="radio"
                              name="settings-email-mode"
                              data-testid={`settings-email-mode-${opt.id}`}
                              value={opt.id}
                              checked={emailMode === opt.id}
                              disabled={unavailable}
                              onChange={() => { setEmailMode(opt.id); setEmailMsg(null); }}
                              className="mt-0.5 accent-[var(--coral-bright)]"
                            />
                            <span className="min-w-0">
                              <span className="block text-sm text-[var(--text-primary)] font-medium">{t(opt.labelKey)}</span>
                              <span className="block text-xs text-[var(--text-secondary)] mt-0.5">
                                {unavailable ? t("settings.emailModeAnswerUnavailable") : t(opt.hintKey)}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>

                    {emailMode !== "send" && (
                      <div className="mt-4 space-y-3">
                        <div>
                          <label htmlFor="settings-email-imap" className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.emailImapHost")}</label>
                          <input
                            id="settings-email-imap"
                            type="text"
                            value={emailImapHost}
                            onChange={(e) => { setEmailImapHost(e.target.value); setEmailMsg(null); }}
                            placeholder={GMAIL_IMAP_HOST}
                            spellCheck={false}
                            autoComplete="off"
                            className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none focus:border-orange-400/60 transition-all placeholder-white/15"
                          />
                          <p className="text-xs text-[var(--text-muted)] mt-1.5">{t("settings.emailImapHostHint")}</p>
                        </div>

                        {emailMode === "answer" && (
                          <div>
                            <label htmlFor="settings-email-allowed" className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.emailAllowedSenders")}</label>
                            <input
                              id="settings-email-allowed"
                              type="text"
                              value={emailAllowedSenders}
                              onChange={(e) => { setEmailAllowedSenders(e.target.value); setEmailMsg(null); }}
                              placeholder="you@work.com, colleague@work.com"
                              spellCheck={false}
                              autoComplete="off"
                              className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none focus:border-orange-400/60 transition-all placeholder-white/15"
                            />
                            <p className="text-xs text-[var(--text-muted)] mt-1.5">{t("settings.emailAllowedSendersHint")}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Independent of the mode above: that one is about the INBOX,
                      this one is about what leaves the device. */}
                  <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3.5">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        data-testid="settings-email-ask-before-send"
                        checked={emailAskBeforeSend}
                        onChange={(e) => { setEmailAskBeforeSend(e.target.checked); setEmailMsg(null); }}
                        className="mt-0.5 accent-[var(--coral-bright)]"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm text-[var(--text-primary)] font-medium">{t("settings.emailAskBeforeSend")}</span>
                        <span className="block text-xs text-[var(--text-secondary)] mt-0.5">{t("settings.emailAskBeforeSendHint")}</span>
                      </span>
                    </label>
                  </div>

                  <p className="text-xs text-[var(--text-muted)]">{t("settings.emailSecurityNote")}</p>
                </div>

                <div className="flex items-center gap-3 mt-5">
                  <button
                    type="button"
                    onClick={saveEmail}
                    disabled={emailSaving || !emailAddress.trim() || !emailPassword}
                    className="px-6 py-2.5 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-all flex items-center justify-center gap-2 shadow-[0_2px_12px_rgba(254,110,0,0.25)]"
                  >
                    {emailSaving ? (
                      <>
                        <span className="material-symbols-rounded animate-spin" style={{ fontSize: 16 }}>progress_activity</span>
                        {t("connecting")}
                      </>
                    ) : (
                      <>
                        <span className="material-symbols-rounded" style={{ fontSize: 16 }}>link</span>
                        {t("settings.connect")}
                      </>
                    )}
                  </button>
                  {emailReconfigure && (
                    <button
                      type="button"
                      onClick={() => { setEmailReconfigure(false); setEmailMsg(null); setEmailPassword(""); }}
                      className="text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer"
                    >
                      {t("cancel")}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ─── WhatsApp ─── */}
        {activeSection === "whatsapp" && (
          /* `tabIndex={-1}` is not a tab stop; it is somewhere for focus to
             land when the status card's Retry replaces itself. */
          <div className="max-w-xl space-y-5" data-testid="settings-section-whatsapp" ref={whatsappPaneRef} tabIndex={-1}>

            {/* Upstream's ban-risk warning, shown before anything else rather
                than hidden behind a docs link — it is the single most important
                thing an owner needs to know before linking a number. */}
            <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
              <div className="flex gap-3">
                <span className="material-symbols-rounded text-amber-400 shrink-0" style={{ fontSize: 20 }} aria-hidden="true">warning</span>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-amber-200">{t("settings.whatsappRiskTitle")}</div>
                  <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">{t("settings.whatsappRiskBody")}</p>
                </div>
              </div>
            </div>

            {waStatus && !waStatus.supported ? (
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                <div className="text-sm text-[var(--text-primary)] font-medium">{t("settings.whatsappUnsupportedTitle")}</div>
                <p className="text-xs text-[var(--text-secondary)] mt-1.5 leading-relaxed">{t("settings.whatsappUnsupportedBody")}</p>
              </div>
            ) : (
              <>
                {/* Status */}
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                  <h3 className="block text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-4">{t("settings.status")}</h3>
                  {waStatus === null ? (
                    /* Nothing known — but there are two ways to know nothing,
                       and the pane owes the owner the same distinction the hub
                       row draws. Pulsing "loading" over a read that has already
                       come back empty is the row's own bug one screen along:
                       nothing re-asks while the pane is open, so the pulse would
                       run for the life of the mount. */
                    channelState("whatsapp") === "unreachable" ? (
                      <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5" data-testid="whatsapp-status-unavailable">
                        <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center shrink-0">
                          <span className="material-symbols-rounded" style={{ fontSize: 22 }} aria-hidden="true">cloud_off</span>
                        </div>
                        <div className="min-w-0 flex-1 text-sm text-[var(--text-primary)] font-medium">
                          {t("settings.statusUnavailable")}
                        </div>
                        <button
                          type="button"
                          data-testid="whatsapp-status-retry"
                          onClick={() => {
                            // Same reason as the hub's Retry: this card is about
                            // to be replaced by the skeleton, so move focus to
                            // the pane before it goes.
                            whatsappPaneRef.current?.focus();
                            unsettleChannel("whatsapp");
                            void refreshWhatsapp();
                          }}
                          className="text-xs text-[var(--coral-bright)] shrink-0 px-2 py-1 bg-transparent border-none cursor-pointer hover:underline"
                        >
                          {t("settings.retry")}
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5 animate-pulse">
                        <div className="w-10 h-10 rounded-full bg-white/[0.08] shrink-0" />
                        <div className="flex-1 space-y-2">
                          <div className="h-3 w-32 rounded bg-white/[0.08]" />
                          <div className="h-2 w-20 rounded bg-white/[0.06]" />
                        </div>
                      </div>
                    )
                  ) : (
                    <div className={`flex items-center gap-4 rounded-xl px-4 py-3.5 border ${
                      waStatus.receiving
                        ? "bg-green-500/[0.06] border-green-500/15"
                        : waStatus.state === "not_configured"
                          ? "bg-white/[0.03] border-white/[0.06]"
                          : "bg-amber-500/[0.06] border-amber-500/15"
                    }`}>
                      <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center shrink-0">
                        <span className="material-symbols-rounded" style={{ fontSize: 22 }} aria-hidden="true">
                          {waStatus.receiving ? "check_circle" : waStatus.state === "not_configured" ? "link_off" : "pending"}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm text-[var(--text-primary)] font-medium">
                          {waStatus.receiving
                            ? t("settings.whatsappActive")
                            : waStatus.state === "paired"
                              ? t("settings.whatsappPairedIdle")
                              : waStatus.state === "enabled_not_paired"
                                ? t("settings.whatsappEnabledNotPaired")
                                : t("settings.notConfigured")}
                        </div>
                        <div className="text-xs text-[var(--text-muted)] mt-0.5">
                          {waStatus.state === "not_configured"
                            ? t("settings.whatsappNotConfiguredHint")
                            : waStatus.receiving
                              ? t("settings.whatsappActiveHint")
                              : t("settings.whatsappGatewayStopped")}
                        </div>
                      </div>
                    </div>
                  )}
                  {waStatus?.bridgeReady === false && (
                    <p className="text-xs text-amber-300/90 mt-3 leading-relaxed">{t("settings.whatsappBridgeMissing")}</p>
                  )}
                </div>

                {/* Pairing — done here, in the panel, with a real QR */}
                {waStatus && (
                  <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid="whatsapp-pairing">
                    <div className="text-sm text-[var(--text-primary)] font-medium">{t("settings.whatsappPairTitle")}</div>

                    {waStatus.paired || waPair?.phase === "paired" ? (
                      <>
                        <div className="flex items-center gap-3 mt-3 rounded-xl px-4 py-3 border bg-green-500/[0.06] border-green-500/15">
                          <span className="material-symbols-rounded text-green-400 shrink-0" style={{ fontSize: 20 }} aria-hidden="true">
                            check_circle
                          </span>
                          <div className="min-w-0">
                            <div className="text-sm text-[var(--text-primary)] font-medium">{t("settings.whatsappPairedTitle")}</div>
                            {waPairedNumber && (
                              <div className="text-xs text-[var(--text-muted)] mt-0.5 font-mono truncate">
                                {t("settings.whatsappPairedAs", { number: waPairedNumber })}
                              </div>
                            )}
                          </div>
                        </div>

                        <p className="text-xs text-[var(--text-secondary)] mt-3 leading-relaxed">{t("settings.whatsappUnpairHint")}</p>

                        {waUnpairConfirm ? (
                          <div className="flex flex-wrap gap-2 mt-3">
                            <button
                              type="button"
                              onClick={unpairWhatsappPhone}
                              disabled={waPairBusy}
                              className="px-4 py-2 rounded-lg bg-red-500/15 border border-red-500/40 text-sm font-semibold text-red-300 cursor-pointer disabled:opacity-50"
                            >
                              {t("settings.whatsappUnpairConfirm")}
                            </button>
                            <button
                              type="button"
                              onClick={() => setWaUnpairConfirm(false)}
                              disabled={waPairBusy}
                              className="px-4 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-[var(--text-secondary)] cursor-pointer disabled:opacity-50"
                            >
                              {t("settings.whatsappUnpairCancel")}
                            </button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2 mt-3">
                            <button
                              type="button"
                              onClick={() => setWaUnpairConfirm(true)}
                              disabled={waPairBusy}
                              className="px-4 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-[var(--text-secondary)] cursor-pointer disabled:opacity-50"
                            >
                              {t("settings.whatsappUnpair")}
                            </button>
                            <button
                              type="button"
                              onClick={() => startWhatsappPairing(true)}
                              disabled={waPairBusy}
                              className="px-4 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-[var(--text-secondary)] cursor-pointer disabled:opacity-50"
                            >
                              {t("settings.whatsappPairRelink")}
                            </button>
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <p className="text-xs text-[var(--text-secondary)] mt-1.5 leading-relaxed">{t("settings.whatsappPairIntro")}</p>

                        {/* Not started yet, cancelled, or failed to start */}
                        {(waPair === null || waPair.phase === "idle" || waPair.phase === "error") && (
                          <>
                            {waPair?.phase === "error" && (
                              <div role="alert" className="mt-3 rounded-xl border border-red-500/25 bg-red-500/[0.06] px-4 py-3">
                                <div className="text-sm text-red-200 font-medium">{t("settings.whatsappPairFailedTitle")}</div>
                                <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
                                  {waPair.error === "bridge_missing"
                                    ? t("settings.whatsappPairErrBridge")
                                    : waPair.error === "install_failed"
                                      ? t("settings.whatsappPairErrInstall")
                                      : t("settings.whatsappPairErrGeneric")}
                                </p>
                              </div>
                            )}
                            <button
                              type="button"
                              onClick={() => startWhatsappPairing(false)}
                              disabled={waPairBusy}
                              data-testid="whatsapp-pair-start"
                              className="mt-3 px-4 py-2 rounded-lg bg-[var(--coral-bright)]/20 border border-[var(--coral-bright)]/40 text-sm font-semibold text-[var(--coral-bright)] cursor-pointer disabled:opacity-50"
                            >
                              {waPair?.phase === "error" ? t("settings.whatsappPairRetry") : t("settings.whatsappPairButton")}
                            </button>
                          </>
                        )}

                        {/* Bridge dependencies downloading, or socket coming up.
                            Both are "wait a moment", and neither is a failure. */}
                        {(waPair?.phase === "preparing" || waPair?.phase === "starting") && (
                          <div className="flex items-center gap-3 mt-3 rounded-xl px-4 py-3 bg-white/[0.03] border border-white/[0.06]" aria-live="polite">
                            <span className="material-symbols-rounded animate-spin shrink-0" style={{ fontSize: 20 }} aria-hidden="true">
                              progress_activity
                            </span>
                            <div className="min-w-0">
                              <div className="text-sm text-[var(--text-primary)] font-medium">
                                {waPair.phase === "preparing" ? t("settings.whatsappPairPreparing") : t("settings.whatsappPairStarting")}
                              </div>
                              <div className="text-xs text-[var(--text-muted)] mt-0.5 leading-relaxed">
                                {waPair.phase === "preparing"
                                  ? t("settings.whatsappPairPreparingHint")
                                  : t("settings.whatsappPairStartingHint")}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* The QR itself. White plate + marginSize=4 gives the
                            quiet zone the spec asks for; without it a phone
                            camera has to fight the dark panel for the finder
                            patterns. Level L keeps the module count down —
                            these payloads run past 200 characters, and at 256px
                            a denser correction level shrinks each module below
                            what a phone reads at arm's length. */}
                        {waPair?.phase === "waiting" && (waPair.qr || waPair.qrImage) && (
                          <div className="mt-3" aria-live="polite">
                            <div className="text-sm text-[var(--text-primary)] font-medium">{t("settings.whatsappPairScanTitle")}</div>
                            <div className="flex justify-center my-4">
                              <div className="bg-white rounded-xl p-3" data-testid="whatsapp-qr">
                                {/* Two harnesses, one card. The Hermes bridge emits the raw
                                    Baileys payload, so we draw the code ourselves; the
                                    OpenClaw plugin renders it and hands back a PNG, so
                                    there is nothing to draw and re-encoding it would only
                                    lose fidelity. `qr` wins when both are somehow present:
                                    a vector at any zoom beats a fixed bitmap. */}
                                {waPair.qr ? (
                                  <QRCodeSVG
                                    value={waPair.qr}
                                    size={256}
                                    level="L"
                                    marginSize={4}
                                    bgColor="#ffffff"
                                    fgColor="#000000"
                                    title={t("settings.whatsappPairQrLabel")}
                                  />
                                ) : (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={waPair.qrImage as string}
                                    alt={t("settings.whatsappPairQrLabel")}
                                    width={256}
                                    height={256}
                                    className="block"
                                  />
                                )}
                              </div>
                            </div>
                            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{t("settings.whatsappPairScanHint")}</p>
                            <p className="text-xs text-[var(--text-muted)] mt-1.5 leading-relaxed">{t("settings.whatsappPairNoRush")}</p>
                            <button
                              type="button"
                              onClick={cancelWhatsappPairing}
                              disabled={waPairBusy}
                              className="mt-3 px-4 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-[var(--text-secondary)] cursor-pointer disabled:opacity-50"
                            >
                              {t("settings.whatsappPairCancel")}
                            </button>
                          </div>
                        )}

                        {waPair?.phase === "scanned" && (
                          <div className="flex items-center gap-3 mt-3 rounded-xl px-4 py-3 bg-green-500/[0.06] border border-green-500/15" aria-live="polite">
                            <span className="material-symbols-rounded animate-spin shrink-0 text-green-400" style={{ fontSize: 20 }} aria-hidden="true">
                              progress_activity
                            </span>
                            <div className="min-w-0">
                              <div className="text-sm text-[var(--text-primary)] font-medium">{t("settings.whatsappPairScanned")}</div>
                              <div className="text-xs text-[var(--text-muted)] mt-0.5 leading-relaxed">{t("settings.whatsappPairScannedHint")}</div>
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {/* The old terminal route, kept because it still works and
                        is the only path left if the bridge cannot start — but
                        collapsed, because it is no longer how this is done. */}
                    <div className="mt-4 pt-3 border-t border-white/[0.06]">
                      <button
                        type="button"
                        onClick={() => setWaAdvanced((v) => !v)}
                        aria-expanded={waAdvanced}
                        className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none p-0 cursor-pointer"
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">
                          {waAdvanced ? "expand_less" : "expand_more"}
                        </span>
                        {t("settings.whatsappAdvancedToggle")}
                      </button>
                      {waAdvanced && (
                        <ol className="mt-2.5 space-y-2 text-xs text-[var(--text-secondary)] list-decimal list-inside">
                          <li>{t("settings.whatsappPairStep1")}</li>
                          <li>
                            {t("settings.whatsappPairStep2")}{" "}
                            <code className="px-1.5 py-0.5 rounded bg-white/[0.08] text-[var(--text-primary)] font-mono">hermes whatsapp</code>
                          </li>
                          <li>{t("settings.whatsappPairStep3")}</li>
                        </ol>
                      )}
                    </div>
                  </div>
                )}

                {/* Everything below edits the channel, so it may only be
                    offered over a channel that was actually read — the same
                    gate the pairing card above already carries. A live "Add
                    number", mode picker and Enable switch under a "Could not
                    check" card is the hub-versus-pane contradiction again,
                    one card down. */}
                {waStatus && (<>
                {/* Allowlist — the security-critical field */}
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                  <h3 className="block text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-2">{t("settings.whatsappAllowedTitle")}</h3>
                  <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{t("settings.whatsappAllowedHint")}</p>
                  {waStatus?.allowAllUsers && (
                    <p className="text-xs text-amber-300/90 mt-2 leading-relaxed">{t("settings.whatsappAllowAllWarning")}</p>
                  )}
                  <ul className="mt-3 space-y-1.5 list-none p-0">
                    {(waStatus?.allowedUsers ?? []).map((number) => (
                      <li key={number} className="flex items-center justify-between gap-3 bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2">
                        <span className="text-sm text-[var(--text-primary)] font-mono truncate">+{number}</span>
                        <button
                          type="button"
                          onClick={() => removeWhatsappNumber(number)}
                          disabled={waSaving}
                          aria-label={t("settings.whatsappRemoveNumber")}
                          className="text-xs text-[var(--text-muted)] hover:text-red-300 bg-transparent border-none cursor-pointer disabled:opacity-50"
                        >
                          {t("settings.whatsappRemoveNumber")}
                        </button>
                      </li>
                    ))}
                    {waStatus && (waStatus.allowedUsers ?? []).length === 0 && (
                      <li className="text-xs text-[var(--text-muted)]">{t("settings.whatsappNoNumbers")}</li>
                    )}
                  </ul>
                  <div className="flex gap-2 mt-3">
                    <input
                      type="tel"
                      inputMode="tel"
                      value={waNumber}
                      onChange={(e) => setWaNumber(e.target.value)}
                      placeholder={t("settings.whatsappNumberPlaceholder")}
                      aria-label={t("settings.whatsappNumberPlaceholder")}
                      className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-[var(--text-primary)] outline-none focus:border-[var(--coral-bright)]/60"
                    />
                    <button
                      type="button"
                      onClick={addWhatsappNumber}
                      disabled={waSaving || !waNumber.trim()}
                      className="px-4 py-2 rounded-lg bg-[var(--coral-bright)]/20 border border-[var(--coral-bright)]/40 text-sm font-semibold text-[var(--coral-bright)] cursor-pointer disabled:opacity-50"
                    >
                      {t("settings.whatsappAddNumber")}
                    </button>
                  </div>
                </div>

                {/* Mode */}
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                  <h3 className="block text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-3">{t("settings.whatsappModeTitle")}</h3>
                  <div className="space-y-2">
                    {(["bot", "self-chat"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => saveWhatsapp({ mode })}
                        disabled={waSaving}
                        aria-pressed={waStatus?.mode === mode}
                        className={`flex w-full items-start gap-3 rounded-xl px-4 py-3 text-left border cursor-pointer disabled:opacity-50 ${
                          waStatus?.mode === mode
                            ? "bg-[var(--coral-bright)]/12 border-[var(--coral-bright)]/40"
                            : "bg-white/[0.03] border-white/[0.06]"
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block text-sm text-[var(--text-primary)] font-medium">
                            {mode === "bot" ? t("settings.whatsappModeBot") : t("settings.whatsappModeSelf")}
                          </span>
                          <span className="block text-xs text-[var(--text-secondary)] mt-0.5">
                            {mode === "bot" ? t("settings.whatsappModeBotHint") : t("settings.whatsappModeSelfHint")}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Enable — deliberately impossible until a session exists */}
                <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-[var(--text-primary)] font-medium">{t("settings.whatsappEnable")}</div>
                    <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-relaxed">
                      {waStatus?.paired ? t("settings.whatsappEnableHint") : t("settings.whatsappEnableBlocked")}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-label={t("settings.whatsappEnable")}
                    aria-checked={!!waStatus?.enabled}
                    disabled={waSaving || waStatus === null || (!waStatus.paired && !waStatus.enabled)}
                    onClick={() => saveWhatsapp({ enabled: !waStatus?.enabled })}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 ${
                      waStatus?.enabled ? "bg-[var(--coral-bright)]" : "bg-gray-600"
                    }`}
                  >
                    <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${waStatus?.enabled ? "translate-x-6" : "translate-x-1"}`} />
                  </button>
                </div>
                </>)}

                {waMsg && (
                  <div
                    role="status"
                    className={`rounded-xl px-4 py-3 text-sm ${
                      waMsg.type === "success"
                        ? "bg-green-500/10 border border-green-500/20 text-green-300"
                        : "bg-red-500/10 border border-red-500/20 text-red-300"
                    }`}
                  >
                    {waMsg.message}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ─── Discord ─── */}
        {activeSection === "discord" && (
          <div className="max-w-xl space-y-5">

            {/* Status card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-rounded text-[#5865F2]" style={{ fontSize: 18 }} aria-hidden="true">forum</span>
                <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.status")}</span>
              </div>
              {dcConfigured === null ? (
                <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5 animate-pulse">
                  <div className="w-10 h-10 rounded-full bg-white/[0.08] shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-32 rounded bg-white/[0.08]" />
                    <div className="h-2 w-20 rounded bg-white/[0.06]" />
                  </div>
                </div>
              ) : dcConfigured && !dcReconfigure ? (
                <div data-testid="discord-status-card" data-state={dcState ?? "unknown"}>
                  <div
                    className={`flex items-center gap-4 rounded-xl px-4 py-3.5 mb-4 border ${
                      dcStateView.tone === "live"
                        ? "bg-green-500/[0.06] border-green-500/15"
                        : dcStateView.tone === "warn"
                          ? "bg-amber-500/[0.06] border-amber-500/15"
                          : "bg-white/[0.03] border-white/[0.06]"
                    }`}
                  >
                    <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center shrink-0">
                      <span
                        className={`material-symbols-rounded ${
                          dcStateView.tone === "live"
                            ? "text-green-400"
                            : dcStateView.tone === "warn"
                              ? "text-amber-400"
                              : "text-[var(--text-muted)] opacity-60"
                        }`}
                        style={{ fontSize: 22 }}
                        aria-hidden="true"
                      >
                        {dcStateView.icon}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-[var(--text-primary)] font-medium">
                        {dcStateView.title}
                      </div>
                      {/* The live dot is bound to the one state that earns it.
                          It used to show whenever a token was stored, which is
                          how a bot that could not connect at all read as
                          "Discord channel active". */}
                      {dcState === "connected" ? (
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                          <span className="text-xs text-green-400/80">{t("settings.discordActive")}</span>
                        </div>
                      ) : dcStateView.hint ? (
                        <div className="text-xs text-[var(--text-secondary)] mt-0.5 leading-relaxed">
                          {dcStateView.hint}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {dcTokenRejected && (
                    <div className="mb-4">
                      <StatusMessage type="error" message={t("settings.discordTokenRejected")} />
                    </div>
                  )}
                  {dcAllowAllUsers && (
                    <p className="text-xs text-amber-300/90 mb-4 leading-relaxed">
                      {t("settings.discordAllowAllWarning")}
                    </p>
                  )}
                  <button
                    onClick={() => { setDcReconfigure(true); setDcStatus(null); }}
                    className="text-sm text-[var(--coral-bright)] hover:text-orange-300 bg-transparent border-none cursor-pointer underline underline-offset-2"
                  >
                    {t("settings.reconfigureBot")}
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-4 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5">
                  <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
                    <span className="material-symbols-rounded text-[var(--text-muted)] opacity-50" style={{ fontSize: 22 }}>link_off</span>
                  </div>
                  <div>
                    <div className="text-sm text-[var(--text-muted)]">{t("settings.notConfigured")}</div>
                    <div className="text-xs text-[var(--text-muted)] opacity-50 mt-0.5">{t("settings.discordSetupBelow")}</div>
                  </div>
                </div>
              )}
            </div>

            {/* Privileged intents — the checklist that fixes a silent bot.
                Shown either because the save was refused by the preflight, or
                because the gateway is already reporting that failure. Both are
                the same problem, so both get the same four steps. */}
            {(dcIntentsMissing !== null || dcState === "intents-missing") && (
              <div
                className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-5"
                data-testid="discord-intents-fix"
              >
                <div className="flex gap-3 mb-3">
                  <span className="material-symbols-rounded text-amber-400 shrink-0" style={{ fontSize: 20 }} aria-hidden="true">warning</span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-amber-200">{t("settings.discordIntentsFixTitle")}</div>
                    <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
                      {t("settings.discordStateIntentsMissingHint")}
                    </p>
                  </div>
                </div>
                <ol className="ml-0 pl-5 leading-[1.9] text-sm text-white/70 list-decimal">
                  <li>
                    {t("settings.discordIntentsFixStep1")}{" "}
                    <a
                      href="https://discord.com/developers/applications"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--coral-bright)] hover:text-orange-300 underline underline-offset-2"
                    >
                      discord.com/developers
                    </a>
                  </li>
                  <li>{t("settings.discordIntentsFixStep2")}</li>
                  <li>{t("settings.discordIntentsFixStep3")}</li>
                  <li>{t("settings.discordIntentsFixStep4")}</li>
                </ol>
                {dcIntentsMissing !== null && dcIntentsMissing.length > 0 && (
                  <ul className="mt-3 space-y-1 list-none p-0">
                    {dcIntentsMissing.map((intent) => (
                      <li key={intent} className="text-xs font-mono text-amber-200/90">{intent}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Who may talk to the assistant.
                A connected Discord bot denies every message until one of the
                DISCORD_ALLOWED_* variables exists, and says so only in the
                gateway log. This is the panel's answer to that: the members the
                bot can actually see, with the server owner ticked by default. */}
            {dcConfigured && !dcReconfigure && dcAllowlistSupported && (
              <div
                className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5"
                data-testid="discord-members"
              >
                <span className="block text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-2">
                  {t("settings.discordMembersTitle")}
                </span>
                <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                  {t("settings.discordMembersHint")}
                </p>

                {dcMembersUnavailable && (
                  <p className="text-xs text-amber-300/90 mt-2 leading-relaxed">
                    {t("settings.discordMembersUnavailable")}
                  </p>
                )}

                <ul className="mt-3 space-y-1.5 list-none p-0">
                  {dcMembers.map((member) => {
                    const checked = dcSelected.includes(member.id);
                    const label = member.displayName || member.username || member.id;
                    return (
                      <li key={member.id}>
                        <label className="flex items-center gap-3 bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleDiscordMember(member.id)}
                            disabled={dcMembersSaving}
                            className="shrink-0 accent-[var(--coral-bright)]"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm text-[var(--text-primary)] truncate">{label}</span>
                            <span className="block text-xs text-[var(--text-muted)] truncate">
                              {member.isOwner ? t("settings.discordMembersOwner") : member.guildName}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                  {dcMembers.length === 0 && (
                    <li className="text-xs text-[var(--text-muted)]">{t("settings.discordMembersNone")}</li>
                  )}
                </ul>

                {/* The never-empty invariant, made visible. The save is refused
                    server-side too — this is so nobody has to click to find
                    out. */}
                {dcMembers.length > 0 && dcSelected.length === 0 && (
                  <p className="text-xs text-amber-300/90 mt-3 leading-relaxed" data-testid="discord-members-empty">
                    {t("settings.discordMembersEmptyWarning")}
                  </p>
                )}

                {dcMembers.length > 0 && (
                  <button
                    type="button"
                    onClick={saveDiscordMembers}
                    disabled={dcMembersSaving || dcSelected.length === 0}
                    className="mt-3 px-4 py-2 rounded-lg bg-[var(--coral-bright)]/20 border border-[var(--coral-bright)]/40 text-sm font-semibold text-[var(--coral-bright)] cursor-pointer disabled:opacity-50"
                  >
                    {t("settings.discordMembersSave")}
                  </button>
                )}
              </div>
            )}

            {/* Setup card — shown when not configured or reconfiguring */}
            {(dcConfigured === false || dcReconfigure) && (
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                <div className="flex items-center gap-2 mb-4">
                  <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>add_circle</span>
                  <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
                    {dcReconfigure ? t("settings.reconfigureBot") : t("settings.discordGuideTitle")}
                  </span>
                </div>

                <ol className="ml-0 pl-5 leading-[1.9] text-sm text-white/70 list-decimal">
                  <li>
                    {t("settings.discordStep1")}{" "}
                    <a
                      href="https://discord.com/developers/applications"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--coral-bright)] hover:text-orange-300 font-semibold no-underline"
                    >
                      discord.com/developers
                    </a>
                  </li>
                  <li>{t("settings.discordStep2")}</li>
                  <li>{t("settings.discordStep3")}</li>
                  <li>{t("settings.discordStep4")}</li>
                </ol>

                {/* The single most common Discord support ticket — a checklist
                    item, not a docs link. */}
                <div className="flex items-start gap-2 mt-4 px-3 py-2.5 rounded-lg bg-amber-500/[0.08] border border-amber-500/20">
                  <span className="material-symbols-rounded text-amber-400 shrink-0" style={{ fontSize: 18 }} aria-hidden="true">warning</span>
                  <p className="text-xs text-amber-200/90 m-0">{t("settings.discordIntentsWarning")}</p>
                </div>

                {/* Invite-link builder (client-side only) */}
                <div className="mt-5 pt-4 border-t border-white/[0.06]">
                  <span className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.discordInviteTitle")}</span>
                  <p className="text-xs text-[var(--text-secondary)] mb-2">{t("settings.discordInviteHint")}</p>
                  <input
                    id="settings-dc-appid"
                    type="text"
                    value={dcAppId}
                    onChange={(e) => setDcAppId(e.target.value)}
                    placeholder={t("settings.discordAppIdPlaceholder")}
                    aria-label={t("settings.discordAppIdPlaceholder")}
                    inputMode="numeric"
                    spellCheck={false}
                    autoComplete="off"
                    className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] font-mono outline-none focus:border-orange-400/60 focus:bg-white/[0.06] transition-all placeholder-white/15 placeholder:font-sans"
                  />
                  {dcInviteUrl && (
                    <a
                      href={dcInviteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center gap-2 w-full px-4 py-3 mt-3 bg-[#5865F2]/15 hover:bg-[#5865F2]/25 border border-[#5865F2]/40 hover:border-[#5865F2]/60 rounded-lg text-sm font-semibold text-[#98a2ff] transition-colors no-underline"
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">open_in_new</span>
                      {t("settings.discordInviteOpen")}
                    </a>
                  )}
                  <p className="text-[11px] text-[var(--text-muted)] mt-2 mb-0">{t("settings.discordPermissionsNote")}</p>
                </div>

                {/* Token input */}
                <div className="mt-5">
                  <label htmlFor="settings-dc-token" className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">{t("settings.botToken")}</label>
                  <div className="relative">
                    <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] opacity-40" style={{ fontSize: 18 }}>key</span>
                    <input
                      id="settings-dc-token"
                      type={dcShowToken ? "text" : "password"}
                      value={dcToken}
                      onChange={(e) => { setDcToken(e.target.value); setDcStatus(null); }}
                      placeholder="••••••••••••••••••••••••"
                      spellCheck={false}
                      autoComplete="off"
                      className="w-full pl-10 pr-10 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none focus:border-orange-400/60 focus:bg-white/[0.06] transition-all placeholder-white/15"
                      onKeyDown={e => e.key === "Enter" && saveDiscord()}
                    />
                    <button
                      type="button"
                      onClick={() => setDcShowToken(v => !v)}
                      aria-label={t("settings.botToken")}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] opacity-50 hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer p-0.5"
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{dcShowToken ? "visibility_off" : "visibility"}</span>
                    </button>
                  </div>
                </div>

                {dcStatus && <div className="mt-3"><StatusMessage type={dcStatus.type} message={dcStatus.message} /></div>}

                <div className="flex items-center gap-3 mt-5">
                  <button
                    onClick={saveDiscord}
                    disabled={dcSaving || !dcToken.trim()}
                    className="px-6 py-2.5 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-all flex items-center justify-center gap-2 shadow-[0_2px_12px_rgba(254,110,0,0.25)]"
                  >
                    {dcSaving ? (
                      <>
                        <span className="material-symbols-rounded animate-spin" style={{ fontSize: 16 }}>progress_activity</span>
                        {t("settings.discordChecking")}
                      </>
                    ) : (
                      <>
                        <span className="material-symbols-rounded" style={{ fontSize: 16 }}>link</span>
                        {t("settings.connect")}
                      </>
                    )}
                  </button>
                  {dcReconfigure && (
                    <button
                      onClick={() => { setDcReconfigure(false); setDcStatus(null); setDcToken(""); }}
                      className="text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer"
                    >
                      {t("cancel")}
                    </button>
                  )}
                </div>
              </div>
            )}

          </div>
        )}

        {/* ─── System ─── */}
        {activeSection === "system" && (
          <div className="max-w-xl space-y-5">

            <HarnessPicker />

            {/* Desktop environment + Performance mode. Above the read-only
                stats cards on purpose: these are the two controls on this tab
                that change what the box does, and the cards below are what
                they change. TASK-455. */}
            <SystemProfilePanel />

            {stats ? (
              <>
                {/* Device info card */}
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>computer</span>
                    <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.device")}</label>
                    <span className="ml-auto text-xs font-mono text-[var(--coral-bright)]/70 bg-orange-500/10 px-2 py-0.5 rounded-md">{stats.overview.uptime}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                    <div className="flex justify-between"><span className="text-white/35">{t("settings.hostname")}</span><span className="text-[var(--text-primary)] font-mono text-xs">{stats.overview.hostname}</span></div>
                    <div className="flex justify-between"><span className="text-white/35">{t("settings.os")}</span><span className="text-[var(--text-primary)] font-mono text-xs truncate ml-2">{stats.overview.os}</span></div>
                    <div className="flex justify-between"><span className="text-white/35">{t("settings.kernel")}</span><span className="text-[var(--text-primary)] font-mono text-xs truncate ml-2">{stats.overview.kernel}</span></div>
                    <div className="flex justify-between"><span className="text-white/35">{t("settings.arch")}</span><span className="text-[var(--text-primary)]">{stats.overview.arch}</span></div>
                  </div>
                </div>

                {/* CPU + Memory card */}
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>speed</span>
                    <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.resources")}</label>
                  </div>

                  {/* CPU bar */}
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs text-[var(--text-muted)]">{t("settings.cpu")}</span>
                      <span className="text-xs font-mono font-semibold" style={{ color: barColor(stats.cpu.usage) }}>{stats.cpu.usage}%</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.cpu.usage}%`, backgroundColor: barColor(stats.cpu.usage) }} />
                    </div>
                    <div className="flex items-center justify-between mt-1.5">
                      <span className="text-[10px] text-[var(--text-muted)] opacity-50 font-mono truncate max-w-[60%]">{stats.cpu.model}</span>
                      <span className="text-[10px] text-[var(--text-muted)] opacity-50">{stats.cpu.cores} {t("settings.cores")} &middot; Load {stats.cpu.loadAvg[0]}</span>
                    </div>
                  </div>

                  {/* Memory bar */}
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs text-[var(--text-muted)]">{t("settings.memory")}</span>
                      <span className="text-xs font-mono text-[var(--text-muted)]">{formatBytes(stats.memory.used)} / {formatBytes(stats.memory.total)}</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.memory.usedPercent}%`, backgroundColor: barColor(stats.memory.usedPercent) }} />
                    </div>
                    <div className="text-right text-[10px] text-[var(--text-muted)] opacity-50 mt-1">{stats.memory.usedPercent}% &middot; {formatBytes(stats.memory.free)} free</div>
                  </div>

                  {/* Swap bar (if any) */}
                  {stats.memory.swap.total > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs text-[var(--text-muted)]">{t("settings.swap")}</span>
                        <span className="text-xs font-mono text-[var(--text-muted)]">{formatBytes(stats.memory.swap.used)} / {formatBytes(stats.memory.swap.total)}</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.memory.swap.percent}%`, backgroundColor: "#a855f7" }} />
                      </div>
                      <div className="text-right text-[10px] text-[var(--text-muted)] opacity-50 mt-1">{stats.memory.swap.percent}% used</div>
                    </div>
                  )}

                  {/* GPU bar */}
                  {stats.gpu != null && (
                    <div className="mt-4">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs text-[var(--text-muted)]">{t("settings.gpu")}</span>
                        <span className="text-xs font-mono font-semibold" style={{ color: barColor(stats.gpu.usage) }}>{stats.gpu.usage}%</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${stats.gpu.usage}%`, backgroundColor: barColor(stats.gpu.usage) }} />
                      </div>
                    </div>
                  )}
                </div>

                {/* Temperature card */}
                {stats.temperature?.value != null && (
                  <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                    <div className="flex items-center gap-2 mb-4">
                      <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>thermostat</span>
                      <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.temperature")}</label>
                    </div>
                    <div className="flex items-end gap-3">
                      <span className="text-3xl font-mono font-bold" style={{ color: stats.temperature.value > 80 ? "#ef4444" : stats.temperature.value > 60 ? "#f97316" : "#22d3ee" }}>
                        {stats.temperature.display}
                      </span>
                      <span className="text-xs text-[var(--text-muted)] opacity-50 mb-1.5">
                        {stats.temperature.value > 80 ? t("settings.critical") : stats.temperature.value > 60 ? t("settings.warm") : t("settings.normal")}
                      </span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden mt-3">
                      <div
                        className="h-full rounded-full transition-all duration-700"
                        style={{
                          width: `${Math.min(100, (stats.temperature.value / 100) * 100)}%`,
                          backgroundColor: stats.temperature.value > 80 ? "#ef4444" : stats.temperature.value > 60 ? "#f97316" : "#22d3ee",
                        }}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] text-[var(--text-muted)] opacity-40 mt-1.5 font-mono">
                      <span>0°C</span><span>50°C</span><span>100°C</span>
                    </div>
                  </div>
                )}

                {/* Storage card */}
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>hard_drive</span>
                    <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.storage")}</label>
                  </div>
                  <div className="space-y-3">
                    {stats.storage.filter(m => m.mountpoint !== "/boot/efi").map(m => (
                      <div key={m.mountpoint}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs text-[var(--text-secondary)] font-mono">{m.mountpoint}</span>
                          <span className="text-xs text-white/35 font-mono">{m.used} / {m.size}</span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${m.usePercent}%`, backgroundColor: barColor(m.usePercent) }} />
                        </div>
                        <div className="text-right text-[10px] text-[var(--text-muted)] opacity-50 mt-1">{m.usePercent}% &middot; {m.avail} free</div>
                      </div>
                    ))}
                  </div>
                </div>

              </>
            ) : (
              <div className="flex items-center justify-center py-12 text-[var(--text-muted)] opacity-60">
                <div className="w-6 h-6 border-2 border-white/20 rounded-full animate-spin mr-3" style={{ borderTopColor: "#fe6e00" }} />
                <span className="text-sm">{t("settings.loadingStats")}</span>
              </div>
            )}

            {/* Password card — used for both web sign-in and SSH/sudo (PAM-backed) */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>key</span>
                <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.security.passwordLabel")}</label>
              </div>
              {/* Split around the font-mono span: markup can't live in a catalogue
                  value, and `sudo` is a command name that must not be translated. */}
              <p className="text-[11px] text-[var(--text-muted)] opacity-60 mb-3 leading-relaxed">
                {t("settings.security.passwordHintPrefix")} <span className="font-mono">sudo</span>{t("settings.security.passwordHintSuffix")}
              </p>
              <div className="space-y-2">
                <div className="flex items-stretch gap-2">
                  <div className="flex-1 flex items-center bg-white/[0.04] border border-white/[0.08] rounded-lg overflow-hidden focus-within:border-orange-400/60">
                    <label htmlFor="sys-current-password" className="sr-only">{t("settings.security.currentPassword")}</label>
                    <input
                      id="sys-current-password"
                      type={sysPasswordShow ? "text" : "password"}
                      value={sysCurrentPassword}
                      onChange={e => { setSysCurrentPassword(e.target.value); if (sysCurrentVerified) setSysCurrentVerified(false); setSysPasswordStatus(null); }}
                      onKeyDown={e => { if (e.key === "Enter" && !sysCurrentVerified) { e.preventDefault(); void verifyCurrentPassword(); } }}
                      placeholder={t("settings.security.currentPassword")}
                      maxLength={128}
                      autoComplete="current-password"
                      disabled={sysCurrentVerified}
                      className="flex-1 min-w-0 px-3 py-2 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder-white/20 disabled:opacity-60"
                    />
                    <button type="button" onClick={() => setSysPasswordShow(v => !v)} className="px-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer" aria-label={sysPasswordShow ? t("settings.security.hideCurrentPassword") : t("settings.security.showCurrentPassword")}>
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{sysPasswordShow ? "visibility_off" : "visibility"}</span>
                    </button>
                  </div>
                  {sysCurrentVerified ? (
                    <button
                      type="button"
                      onClick={resetSysPasswordForm}
                      className="px-3 py-2 bg-white/[0.06] hover:bg-white/[0.12] text-xs text-[var(--text-primary)] rounded-lg cursor-pointer border-none transition-colors flex items-center gap-1"
                      title={t("settings.security.clearAndReenter")}
                      aria-label={t("settings.security.clearAndReenter")}
                    >
                      <span className="material-symbols-rounded text-emerald-400" style={{ fontSize: 16 }}>check_circle</span>
                      {t("settings.security.reenter")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={verifyCurrentPassword}
                      disabled={sysVerifying || !sysCurrentPassword}
                      className="px-4 py-2 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-lg text-sm font-semibold cursor-pointer border-none transition-all"
                    >
                      {sysVerifying ? t("settings.security.checking") : t("settings.security.verify")}
                    </button>
                  )}
                </div>

                {sysCurrentVerified && (
                  <>
                    <div className="flex items-center bg-white/[0.04] border border-white/[0.08] rounded-lg overflow-hidden focus-within:border-orange-400/60">
                      <label htmlFor="sys-new-password" className="sr-only">{t("settings.security.newPassword")}</label>
                      <input
                        id="sys-new-password"
                        type={sysNewShow ? "text" : "password"}
                        value={sysPassword}
                        onChange={e => { setSysPassword(e.target.value); setSysPasswordStatus(null); }}
                        placeholder={t("settings.security.newPasswordPlaceholder")}
                        maxLength={128}
                        autoComplete="new-password"
                        autoFocus
                        className="flex-1 min-w-0 px-3 py-2 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder-white/20"
                      />
                      <button type="button" onClick={() => setSysNewShow(v => !v)} className="px-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer" aria-label={sysNewShow ? t("settings.security.hideNewPassword") : t("settings.security.showNewPassword")}>
                        <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{sysNewShow ? "visibility_off" : "visibility"}</span>
                      </button>
                    </div>
                    <div className="flex items-center bg-white/[0.04] border border-white/[0.08] rounded-lg overflow-hidden focus-within:border-orange-400/60">
                      <label htmlFor="sys-confirm-password" className="sr-only">{t("settings.security.confirmNewPassword")}</label>
                      <input
                        id="sys-confirm-password"
                        type={sysConfirmShow ? "text" : "password"}
                        value={sysPasswordConfirm}
                        onChange={e => { setSysPasswordConfirm(e.target.value); setSysPasswordStatus(null); }}
                        placeholder={t("settings.security.confirmNewPassword")}
                        maxLength={128}
                        autoComplete="new-password"
                        className="flex-1 min-w-0 px-3 py-2 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder-white/20"
                      />
                      <button type="button" onClick={() => setSysConfirmShow(v => !v)} className="px-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer" aria-label={sysConfirmShow ? t("settings.security.hideConfirmPassword") : t("settings.security.showConfirmPassword")}>
                        <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{sysConfirmShow ? "visibility_off" : "visibility"}</span>
                      </button>
                    </div>
                    {sysPassword.length > 0 && sysPasswordConfirm.length > 0 && sysPassword !== sysPasswordConfirm && (
                      <div role="alert" aria-live="polite" className="text-[11px] text-amber-300/90">{t("settings.security.passwordsDontMatchYet")}</div>
                    )}
                    <div className="flex justify-end">
                      <button
                        onClick={requestSystemPasswordChange}
                        disabled={sysPasswordSaving || sysPassword.length < 8 || sysPassword !== sysPasswordConfirm}
                        className="px-4 py-2 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-lg text-sm font-semibold cursor-pointer border-none transition-all"
                      >
                        {sysPasswordSaving ? t("settings.security.saving") : t("settings.security.updatePassword")}
                      </button>
                    </div>
                  </>
                )}
              </div>
              {sysPasswordStatus && <div className="mt-3"><StatusMessage type={sysPasswordStatus.type} message={sysPasswordStatus.message} /></div>}
            </div>

          </div>
        )}

        {/* ─── Remote Control ─── */}
        {activeSection === "remote" && renderRemoteSection()}

        {/* ─── About ─── */}
        {activeSection === "about" && (<>
          <div className="max-w-xl space-y-6">
            <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">{t("settings.aboutClawBox")}</h2>

            <div className="bg-white/5 rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-4">
                <img src="/icon-512.png" alt="ClawBox" className="w-14 h-14 rounded-2xl" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                <div>
                  <div className="text-lg font-bold text-[var(--text-primary)]">ClawBox</div>
                  <div className="text-xs text-[var(--text-muted)]">{t("settings.personalAI")}</div>
                </div>
              </div>

              <div className="space-y-2 pt-2 border-t border-[var(--border-subtle)]">
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--text-muted)]">{t("settings.version")}</span>
                  <span className="text-[var(--text-primary)]">{versionInfo?.clawbox.current ?? process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown"}</span>
                </div>
                {/* Harness version, per edition. The Hermes SKU ships no
                    OpenClaw at all, so its row could only ever read "not
                    installed" — a meaningless line about software the device
                    was never supposed to have. Show the harness this box
                    actually runs instead; `dual` has both, so it shows both.
                    A server that predates the `edition` field falls through to
                    the OpenClaw row exactly as before. */}
                {versionInfo?.edition !== "hermes" && (
                  <div className="flex justify-between text-sm">
                    <span className="text-[var(--text-muted)]">OpenClaw</span>
                    <span className="text-[var(--text-primary)]">{cleanVersion(versionInfo?.openclaw.current) ?? t("settings.notInstalled")}</span>
                  </div>
                )}
                {versionInfo?.hermes && (
                  <div className="flex justify-between text-sm">
                    <span className="text-[var(--text-muted)]">Hermes</span>
                    <span className="text-[var(--text-primary)]">{versionInfo.hermes.current ?? t("settings.notInstalled")}</span>
                  </div>
                )}
                <BuildIdentityRows identity={buildIdentity} />
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--text-muted)]">{t("settings.runtime")}</span>
                  <span className="text-[var(--text-primary)]">Next.js + Bun</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--text-muted)]">{t("settings.platform")}</span>
                  <span className="text-[var(--text-primary)]">{stats ? `${stats.overview.arch} ${stats.overview.platform}` : "..."}</span>
                </div>
              </div>
            </div>

            <a
              href="https://clawbox.com/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors no-underline"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>help</span>
              {t("settings.documentation")}
              <span className="material-symbols-rounded ml-auto" style={{ fontSize: 16 }}>open_in_new</span>
            </a>

            <a
              href="https://t.me/ClawBoxSupportBot"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors no-underline"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>support_agent</span>
              {t("settings.support")}
              <span className="material-symbols-rounded ml-auto" style={{ fontSize: 16 }}>open_in_new</span>
            </a>

            <a
              href={DISCORD_INVITE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors no-underline"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
              {t("settings.discordCommunity")}
              <span className="material-symbols-rounded ml-auto" style={{ fontSize: 16 }}>open_in_new</span>
            </a>

            {/* Beta toggle */}
            <div className="bg-white/5 rounded-xl px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="material-symbols-rounded text-amber-400" style={{ fontSize: 20 }}>science</span>
                  <div>
                    <span className="text-sm text-[var(--text-primary)]">{t("settings.betaChannel")}</span>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">{t("settings.betaDesc")}</p>
                  </div>
                </div>
                <button
                  onClick={() => toggleBeta(!betaEnabled)}
                  disabled={betaSaving}
                  className={`relative inline-flex items-center w-10 h-5 rounded-full transition-colors cursor-pointer border-none shrink-0 ${betaEnabled ? "bg-amber-500" : "bg-white/15"} ${betaSaving ? "opacity-50" : ""}`}
                >
                  <span
                    className="absolute w-4 h-4 rounded-full bg-white shadow-md transition-transform duration-200"
                    style={{ left: 2, transform: betaEnabled ? "translateX(18px)" : "translateX(0)" }}
                  />
                </button>
              </div>
              {betaEnabled && (
                <p className="text-xs text-amber-400/60 mt-2">{t("settings.betaInstallNote")}</p>
              )}
            </div>

            {/* Only the ClawBox System Update tile is exposed. OpenClaw is
                pinned by ClawBox (config/openclaw-target.txt) and travels
                with the full release, so a standalone "OpenClaw Update"
                button would just confuse customers and let them bypass
                the pin. The current OpenClaw version is still displayed
                in the version-info section above. */}
            <div className="flex gap-2">
              <button
                onClick={() => dispatchOpenApp("system_update")}
                className="flex items-center gap-3 flex-1 bg-green-500/10 rounded-xl px-4 py-3 text-sm text-green-400/80 hover:text-green-400 border border-green-500/20 hover:bg-green-500/15 transition-colors cursor-pointer text-left"
              >
                <span className="material-symbols-rounded shrink-0" style={{ fontSize: 20 }}>system_update</span>
                <div className="flex flex-col min-w-0">
                  <span>{t("settings.systemUpdate")}</span>
                  {cleanVersion(versionInfo?.clawbox.current) && (
                    <span className="text-[11px] text-green-400/60 font-mono truncate">
                      {cleanVersion(versionInfo?.clawbox.current)}
                      {versionInfo?.clawbox.target && <> → <span className="text-green-300">{cleanVersion(versionInfo.clawbox.target)}</span></>}
                    </span>
                  )}
                </div>
              </button>
            </div>

            <button
              onClick={() => setResetConfirm(true)}
              className="flex items-center gap-3 w-full bg-red-500/5 rounded-xl px-4 py-3 text-sm text-red-400/60 hover:text-red-400 transition-colors cursor-pointer"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>restart_alt</span>
              {t("settings.factoryReset")}
            </button>
          </div>

          {/* Beta confirmation dialog */}
          {betaConfirm && (
            <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
              <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-2xl p-6 max-w-sm mx-4 shadow-2xl">
                <div className="flex items-center gap-3 mb-4">
                  <span className="material-symbols-rounded text-amber-400" style={{ fontSize: 28 }}>warning</span>
                  <h3 className="text-lg font-semibold text-[var(--text-primary)]">{t("settings.enableBeta")}</h3>
                </div>
                <div className="space-y-3 mb-6">
                  <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                    {t("settings.betaWarning")}
                  </p>
                  <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                    <p className="text-xs text-red-400 leading-relaxed">
                      {t("settings.betaDisclaimer")}
                    </p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => setBetaConfirm(false)}
                    className="flex-1 px-4 py-2.5 bg-white/10 hover:bg-white/15 text-[var(--text-secondary)] rounded-lg text-sm font-medium cursor-pointer transition-colors"
                  >
                    {t("cancel")}
                  </button>
                  <button
                    onClick={confirmBeta}
                    className="flex-1 px-4 py-2.5 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-sm font-medium cursor-pointer transition-colors"
                  >
                    {t("settings.enableBetaBtn")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>)}
    </>
  );

  // ─── Section status (subtitle) shared by mobile list + desktop sidebar ───
  // SectionStatus type is declared at module scope (above component)
  /** Whether a channel actually holds a working account right now. */
  const channelConnected = (id: ChannelSection): boolean => {
    switch (id) {
      case "telegram": return tgConfigured === true;
      case "email": return emailStatus?.configured === true;
      case "whatsapp": return waStatus?.state === "paired";
      case "discord": return dcConfigured === true;
    }
  };

  /**
   * Whether the server has actually answered for this channel yet. Without
   * this there are only two states in the UI and "we have not asked" renders
   * as "not set up" — the false failure this hub shipped with.
   */
  const channelStatusKnown = (id: ChannelSection): boolean => {
    switch (id) {
      case "telegram": return tgConfigured !== null;
      case "email": return emailStatus !== null;
      case "whatsapp": return waStatus !== null;
      case "discord": return dcConfigured !== null;
    }
  };

  /**
   * The states a channel row may honestly be in.
   *
   * `unknown` and `unreachable` are both "we cannot say", but only one of them
   * is still being worked on: pulsing at the owner after the read has already
   * failed would be its own small lie.
   */
  const channelState = (
    id: ChannelSection,
  ): "connected" | "not-configured" | "unknown" | "unreachable" => {
    if (channelStatusKnown(id)) return channelConnected(id) ? "connected" : "not-configured";
    // Nothing known, and a read is outstanding (or has never run) — including
    // one a Retry just started. Only once it has settled with nothing to show
    // may the row say the channel could not be read.
    return settledChannels.has(id) ? "unreachable" : "unknown";
  };

  const sectionStatus = (id: Section): SectionStatus => {
    switch (id) {
      case "channels": {
        // A count is only true once every channel has answered. This said "Not
        // configured" over a box with three live channels because the hub's
        // fetches had not run yet; reporting "1 connected" off the one channel
        // a deep link happened to load is the same lie with a different
        // number. So: silence while anything is still in flight, as `ai` and
        // `localAi` below already do.
        const connected = CHANNEL_ITEMS.filter((a) => channelConnected(a.id)).length;
        if (CHANNEL_ITEMS.every((a) => channelStatusKnown(a.id))) {
          return {
            subtitle: connected > 0
              ? t("settings.channelsConnectedCount", { n: connected })
              : (t("settings.notConfigured") || "Not configured"),
          };
        }
        // Not everything is known, but nothing is still being asked either —
        // one of the routes could not be reached. Report what was actually
        // confirmed rather than going silent for the rest of the session; the
        // count can only understate, and never says "Not configured" over a
        // channel nobody managed to read.
        const allSettled = CHANNEL_ITEMS.every((a) => channelState(a.id) !== "unknown");
        if (allSettled && connected > 0) {
          return { subtitle: t("settings.channelsConnectedCount", { n: connected }) };
        }
        return { subtitle: null };
      }
      case "appearance": {
        const sub = ui.wallpaperId.startsWith("custom-")
          ? `Custom ${parseInt(ui.wallpaperId.split("-")[1] || "0") + 1}`
          : ui.wallpaperId;
        return { subtitle: sub };
      }
      case "wifi":
        if (connectedSSID) return { subtitle: connectedSSID };
        if (ethernet.connected) return { subtitle: ethernet.iface ? `Ethernet (${ethernet.iface})` : "Ethernet" };
        return { subtitle: t("settings.notConnected") || "Not connected" };
      case "ai": {
        if (aiProvider === null) return { subtitle: null };
        if (!aiProvider.connected) return { subtitle: t("settings.notConfigured") || "Not configured" };
        return { subtitle: aiProvider.providerLabel || (aiProvider.model ? aiProvider.model.split("/").pop() ?? null : null) };
      }
      case "localAi": {
        if (localAiStatus === null) return { subtitle: null };
        if (!localAiStatus.configured) return { subtitle: t("settings.notConfigured") || "Not configured" };
        return { subtitle: localAiStatus.model || localAiStatus.provider };
      }
      case "telegram": {
        if (tgConfigured === null) return { subtitle: null };
        if (!tgConfigured) return { subtitle: t("settings.notConfigured") || "Not configured" };
        return { subtitle: tgBotInfo?.username ? `@${tgBotInfo.username}` : (t("settings.botConnected") || "Connected") };
      }
      case "email": {
        if (emailStatus === null) return { subtitle: null };
        if (!emailStatus.configured) return { subtitle: t("settings.notConfigured") || "Not configured" };
        return { subtitle: emailStatus.address };
      }
      case "whatsapp": {
        if (waStatus === null) return { subtitle: null };
        if (!waStatus.supported) return { subtitle: t("settings.whatsappUnavailable") };
        if (waStatus.state === "paired") {
          return { subtitle: waStatus.receiving ? t("settings.whatsappActive") : t("settings.whatsappPairedIdle") };
        }
        if (waStatus.state === "enabled_not_paired") return { subtitle: t("settings.whatsappEnabledNotPaired") };
        return { subtitle: t("settings.notConfigured") || "Not configured" };
      }
      case "discord": {
        if (dcConfigured === null) return { subtitle: null };
        if (!dcConfigured) return { subtitle: t("settings.notConfigured") || "Not configured" };
        // A problem the owner has to act on outranks the bot's name here: the
        // sidebar is the only place a closed section can say anything at all.
        if (dcState === "intents-missing") return { subtitle: t("settings.discordStateIntentsMissing") };
        if (dcState === "denied-no-allowlist") return { subtitle: t("settings.discordStateDenied") };
        if (dcState === "offline") return { subtitle: t("settings.discordStateOffline") };
        return { subtitle: dcBotName || (t("settings.botConnected") || "Connected") };
      }
      case "remote":
        return { subtitle: null };
      case "system":
        return { subtitle: hostname ? `${hostname}.local` : null };
      case "about":
        return { subtitle: versionInfo?.clawbox?.current ? cleanVersion(versionInfo.clawbox.current) : null };
      default:
        return { subtitle: null };
    }
  };

  // ─── Mobile layout: full-screen nav or full-screen content ───
  if (isMobile) {
    return (
      <div className="flex flex-col h-full bg-[var(--bg-deep)]">
        {mobileSection === null ? (
          /* Nav list — iOS-style grouped rows with status subtitles */
          <div className="flex-1 overflow-y-auto px-4 pt-4 pb-6">
            <h2 className="text-2xl font-bold text-[var(--text-primary)] px-1 mb-4">{t("settings.title")}</h2>
            <nav className="bg-white/[0.04] border border-white/[0.06] rounded-2xl overflow-hidden divide-y divide-white/[0.06]">
              {visibleNavItems.map(item => {
                const { subtitle } = sectionStatus(item.id);
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      if (item.id === "remote" && requireLoginFor("remote")) return;
                      setSection(item.id);
                      setMobileSection(item.id);
                    }}
                    className="flex items-center gap-4 w-full px-4 py-3.5 text-left border-none cursor-pointer transition-colors bg-transparent hover:bg-white/[0.04] active:bg-white/[0.08]"
                  >
                    <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--coral-bright)]/15 shrink-0">
                      <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 22 }}>{item.icon}</span>
                    </span>
                    <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <span className="text-[15px] font-medium text-[var(--text-primary)] leading-tight">{navLabel(item)}</span>
                      {subtitle && (
                        <span className="text-xs text-[var(--text-muted)] truncate">{subtitle}</span>
                      )}
                    </span>
                    <span className="material-symbols-rounded text-[var(--text-muted)] opacity-40 shrink-0" style={{ fontSize: 20 }}>chevron_right</span>
                  </button>
                );
              })}
            </nav>
          </div>
        ) : (
          /* Content — chrome back closes window in one tap. A small "All settings"
              link at the top lets the user switch sections without leaving. */
          <>
            <div className="px-4 pt-3 pb-1 shrink-0">
              <button
                onClick={() => setMobileSection(null)}
                className="flex items-center gap-1 text-xs text-[var(--coral-bright)] hover:text-orange-300 bg-transparent border-none cursor-pointer p-1"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg>
                <span>{t("settings.title")}</span>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {renderContent()}
            </div>
          </>
        )}

        {/* Update confirmation modal */}
      {updateConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded-2xl shadow-2xl p-6 max-w-sm w-full">
            <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">{t("settings.systemUpdate")}</h3>
            <p className="text-sm text-[var(--text-muted)] mb-4 leading-relaxed">
              {t("settings.updateDesc")}
            </p>
            {versionLoading ? (
              <div className="mb-4 text-xs text-[var(--text-muted)] opacity-60">{t("settings.checkingVersions")}</div>
            ) : versionInfo && (
              <div className="mb-4 space-y-2 text-xs">
                <div className="flex items-center justify-between bg-white/[0.04] rounded-lg px-3 py-2">
                  <span className="text-[var(--text-muted)] font-medium">ClawBox</span>
                  <span className="text-[var(--text-primary)]">
                    {versionInfo.clawbox.current}
                    {versionInfo.clawbox.target ? (
                      <span className="text-[var(--text-muted)] opacity-60">{" → "}<span className="text-emerald-400">{versionInfo.clawbox.target}</span></span>
                    ) : (
                      <span className="text-emerald-400 ml-2 text-[10px] uppercase font-semibold">{t("settings.latest")}</span>
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between bg-white/[0.04] rounded-lg px-3 py-2">
                  <span className="text-[var(--text-muted)] font-medium">OpenClaw</span>
                  <span className="text-[var(--text-primary)]">
                    {versionInfo.openclaw.current ?? t("settings.notInstalled")}
                    {versionInfo.openclaw.target ? (
                      <span className="text-[var(--text-muted)] opacity-60">{" → "}<span className="text-emerald-400">{versionInfo.openclaw.target}</span></span>
                    ) : versionInfo.openclaw.current ? (
                      <span className="text-emerald-400 ml-2 text-[10px] uppercase font-semibold">{t("settings.latest")}</span>
                    ) : null}
                  </span>
                </div>
              </div>
            )}
            {/* Branch selector */}
            {!versionLoading && (updateBranch || /^v\d+\.\d+\.\d+-.+/.test(versionInfo?.clawbox.current ?? "")) && (
              <div className="mb-4">
                <label htmlFor="settings-update-branch" className="text-xs text-[var(--text-muted)] opacity-60 mb-1 block">Update branch</label>
                <div className="flex gap-2">
                  <input
                    id="settings-update-branch"
                    type="text"
                    value={branchInput}
                    onChange={(e) => { setBranchInput(e.target.value); setBranchError(null); }}
                    placeholder={t("settings.main")}
                    className="flex-1 bg-white/[0.04] border border-[var(--border-subtle)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] opacity-40 outline-none focus:border-[var(--coral-bright)]"
                  />
                  <button
                    type="button"
                    disabled={branchSaving || branchInput === (updateBranch ?? "")}
                    onClick={() => saveUpdateBranch(branchInput)}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-orange-500 rounded-lg cursor-pointer disabled:opacity-40"
                  >
                    {branchSaving ? "..." : "Set"}
                  </button>
                </div>
                {branchError && <p className="mt-1 text-xs text-red-400">{branchError}</p>}
                {updateBranch && (
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-xs text-emerald-400">{t("settings.pinnedBranch", { branch: updateBranch ?? "" })}</span>
                    <button type="button" onClick={() => { setBranchInput(""); saveUpdateBranch(""); }} className="text-xs text-red-400 hover:text-red-300 cursor-pointer">{t("settings.clearBranch")}</button>
                  </div>
                )}
                {!updateBranch && !branchError && (
                  <p className="mt-1 text-xs text-[var(--text-muted)] opacity-40">{t("settings.branchHint")}</p>
                )}
              </div>
            )}
            <div className="flex items-center gap-3 justify-end">
              <button type="button" onClick={() => setUpdateConfirm(false)} className="px-5 py-2.5 bg-white/10 text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-lg text-sm font-semibold cursor-pointer hover:bg-white/15 transition-colors">
                {t("cancel")}
              </button>
              <button type="button" disabled={branchSaving} onClick={() => { setUpdateConfirm(false); triggerUpdate(); }} className="px-5 py-2.5 bg-orange-500 text-white rounded-lg text-sm font-semibold cursor-pointer hover:bg-orange-600 hover:scale-105 transition-all disabled:opacity-40 disabled:hover:scale-100">
                {t("settings.update")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Factory Reset confirmation modal */}
      {factoryResetDialog}

      <ClawBoxLoginModal
        open={loginModal.open}
        feature={loginModal.feature}
        onClose={() => setLoginModal((m) => ({ ...m, open: false }))}
      />

      {systemPasswordConfirmDialog}

      {/* Hotspot enable confirmation — single-radio collision warning */}
      {hotspotConfirmEnable && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-elevated)] rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-[var(--border-subtle)]">
            <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">Enable hotspot?</h3>
            <p className="text-sm text-[var(--text-muted)] mb-5 leading-relaxed">
              The Jetson has a single WiFi radio. Turning the hotspot on will disconnect this device from <span className="text-[var(--text-primary)] font-medium">{connectedSSID}</span>. You&apos;ll lose internet until you turn the hotspot back off, plug in Ethernet, or reconfigure WiFi.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setHotspotConfirmEnable(false)} className="flex-1 py-2.5 bg-white/5 text-[var(--text-secondary)] rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-white/10 transition-colors">{t("cancel")}</button>
              <button onClick={() => { setHotspotConfirmEnable(false); void performHotspotToggle(true); }} className="flex-1 py-2.5 bg-[#fe6e00] text-white rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-[#ff8b1a] transition-colors">Enable hotspot</button>
            </div>
          </div>
        </div>
      )}

      {/* Hostname confirmation modal */}
      {hostnameConfirm && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-elevated)] rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-[var(--border-subtle)]">
            <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">{t("settings.hostnameConfirmTitle")}</h3>
            <p className="text-sm text-[var(--text-muted)] mb-3 leading-relaxed">
              {t("settings.hostnameConfirmDesc", { fqdn: `${hostnameInput.trim().toLowerCase().replace(/\.local$/, "")}.local` })}
            </p>
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.08] px-3 py-2.5 mb-5 text-[12px] leading-relaxed text-amber-100/90">
              <div className="flex items-start gap-2">
                <span className="material-symbols-rounded text-amber-300 shrink-0" style={{ fontSize: 16 }}>warning</span>
                <div>
                  After reboot you&apos;ll need to reconnect at:
                  <div className="mt-1 font-mono text-amber-50 break-all">http://{hostnameInput.trim().toLowerCase().replace(/\.local$/, "")}.local/</div>
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <button disabled={hostnameSaving} onClick={() => setHostnameConfirm(false)} className="flex-1 py-2.5 bg-white/5 text-[var(--text-secondary)] rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-white/10 transition-colors disabled:opacity-50">
                {t("cancel")}
              </button>
              <button disabled={hostnameSaving} onClick={saveHostname} className="flex-1 py-2.5 bg-[#fe6e00] text-white rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-[#ff8b1a] transition-colors disabled:opacity-50">
                {hostnameSaving ? t("settings.restartingDevice") : t("settings.saveAndRestart")}
              </button>
            </div>
          </div>
        </div>
      )}

        {resetOverlay}
      </div>
    );
  }

  // ─── Desktop layout: sidebar + content ───
  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-[var(--bg-deep)]">
      {/* Sidebar. The nav scrolls on its own so a long section list can never
          grow the row past the window body and paint outside the frame. */}
      <nav className="w-60 shrink-0 min-h-0 overflow-y-auto bg-[var(--bg-surface)] border-r border-[var(--border-subtle)] py-4 px-2 flex flex-col gap-0.5">
        {visibleNavItems.map(item => {
          const active = navSection === item.id;
          const status = sectionStatus(item.id);
          return (
            <button
              key={item.id}
              onClick={() => setSectionGated(item.id)}
              className={`flex shrink-0 items-center gap-3 px-2.5 py-2 rounded-xl text-[15px] border-none cursor-pointer transition-colors text-left ${
                active
                  ? "bg-[var(--coral-bright)]/15 text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:bg-white/[0.05] hover:text-[var(--text-primary)]"
              }`}
            >
              <span className={`flex items-center justify-center w-9 h-9 rounded-lg shrink-0 ${active ? "bg-[var(--coral-bright)]/25" : "bg-white/[0.06]"}`}>
                <span className="material-symbols-rounded" style={{ fontSize: 20, color: active ? "var(--coral-bright)" : "var(--text-muted)" }}>{item.icon}</span>
              </span>
              <span className="flex-1 min-w-0 truncate font-medium">{navLabel(item)}</span>
              {status.subtitle && <span className="sr-only">{status.subtitle}</span>}
            </button>
          );
        })}
        <div className="flex-1" />
      </nav>

      {/* Content */}
      <div className="flex-1 min-w-0 min-h-0 overflow-y-auto p-6 flex flex-col items-center">
        <div className="w-full max-w-3xl flex flex-col items-stretch [&>div]:mx-auto [&>div]:w-full">
          {renderContent()}
        </div>
      </div>

      <ClawBoxLoginModal
        open={loginModal.open}
        feature={loginModal.feature}
        onClose={() => setLoginModal((m) => ({ ...m, open: false }))}
      />

      {/* Update confirmation modal */}
      {updateConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded-2xl shadow-2xl p-6 max-w-sm w-full">
            <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">{t("settings.systemUpdate")}</h3>
            <p className="text-sm text-[var(--text-muted)] mb-4 leading-relaxed">
              {t("settings.updateDesc")}
            </p>
            {versionLoading ? (
              <div className="mb-4 text-xs text-[var(--text-muted)] opacity-60">{t("settings.checkingVersions")}</div>
            ) : versionInfo && (
              <div className="mb-4 space-y-2 text-xs">
                <div className="flex items-center justify-between bg-white/[0.04] rounded-lg px-3 py-2">
                  <span className="text-[var(--text-muted)] font-medium">ClawBox</span>
                  <span className="text-[var(--text-primary)]">
                    {versionInfo.clawbox.current}
                    {versionInfo.clawbox.target ? (
                      <span className="text-[var(--text-muted)] opacity-60">{" → "}<span className="text-emerald-400">{versionInfo.clawbox.target}</span></span>
                    ) : (
                      <span className="text-emerald-400 ml-2 text-[10px] uppercase font-semibold">{t("settings.latest")}</span>
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between bg-white/[0.04] rounded-lg px-3 py-2">
                  <span className="text-[var(--text-muted)] font-medium">OpenClaw</span>
                  <span className="text-[var(--text-primary)]">
                    {versionInfo.openclaw.current ?? t("settings.notInstalled")}
                    {versionInfo.openclaw.target ? (
                      <span className="text-[var(--text-muted)] opacity-60">{" → "}<span className="text-emerald-400">{versionInfo.openclaw.target}</span></span>
                    ) : versionInfo.openclaw.current ? (
                      <span className="text-emerald-400 ml-2 text-[10px] uppercase font-semibold">{t("settings.latest")}</span>
                    ) : null}
                  </span>
                </div>
              </div>
            )}
            {!versionLoading && (updateBranch || /^v\d+\.\d+\.\d+-.+/.test(versionInfo?.clawbox.current ?? "")) && (
              <div className="mb-4">
                <label htmlFor="settings-update-branch-d" className="text-xs text-[var(--text-muted)] opacity-60 mb-1 block">Update branch</label>
                <div className="flex gap-2">
                  <input
                    id="settings-update-branch-d"
                    type="text"
                    value={branchInput}
                    onChange={(e) => { setBranchInput(e.target.value); setBranchError(null); }}
                    placeholder={t("settings.main")}
                    className="flex-1 bg-white/[0.04] border border-[var(--border-subtle)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] opacity-40 outline-none focus:border-[var(--coral-bright)]"
                  />
                  <button
                    type="button"
                    disabled={branchSaving || branchInput === (updateBranch ?? "")}
                    onClick={() => saveUpdateBranch(branchInput)}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-orange-500 rounded-lg cursor-pointer disabled:opacity-40"
                  >
                    {branchSaving ? "..." : "Set"}
                  </button>
                </div>
                {branchError && <p className="mt-1 text-xs text-red-400">{branchError}</p>}
                {updateBranch && (
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-xs text-emerald-400">{t("settings.pinnedBranch", { branch: updateBranch ?? "" })}</span>
                    <button type="button" onClick={() => { setBranchInput(""); saveUpdateBranch(""); }} className="text-xs text-red-400 hover:text-red-300 cursor-pointer">{t("settings.clearBranch")}</button>
                  </div>
                )}
                {!updateBranch && !branchError && (
                  <p className="mt-1 text-xs text-[var(--text-muted)] opacity-40">{t("settings.branchHint")}</p>
                )}
              </div>
            )}
            <div className="flex items-center gap-3 justify-end">
              <button type="button" onClick={() => setUpdateConfirm(false)} className="px-5 py-2.5 bg-white/10 text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-lg text-sm font-semibold cursor-pointer hover:bg-white/15 transition-colors">
                {t("cancel")}
              </button>
              <button type="button" disabled={branchSaving} onClick={() => { setUpdateConfirm(false); triggerUpdate(); }} className="px-5 py-2.5 bg-orange-500 text-white rounded-lg text-sm font-semibold cursor-pointer hover:bg-orange-600 hover:scale-105 transition-all disabled:opacity-40 disabled:hover:scale-100">
                {t("settings.update")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Factory Reset confirmation modal */}
      {factoryResetDialog}

      {/* Hostname confirmation modal */}
      {hostnameConfirm && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-elevated)] rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-[var(--border-subtle)]">
            <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">{t("settings.hostnameConfirmTitle")}</h3>
            <p className="text-sm text-[var(--text-muted)] mb-3 leading-relaxed">
              {t("settings.hostnameConfirmDesc", { fqdn: `${hostnameInput.trim().toLowerCase().replace(/\.local$/, "")}.local` })}
            </p>
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.08] px-3 py-2.5 mb-5 text-[12px] leading-relaxed text-amber-100/90">
              <div className="flex items-start gap-2">
                <span className="material-symbols-rounded text-amber-300 shrink-0" style={{ fontSize: 16 }}>warning</span>
                <div>
                  After reboot you&apos;ll need to reconnect at:
                  <div className="mt-1 font-mono text-amber-50 break-all">http://{hostnameInput.trim().toLowerCase().replace(/\.local$/, "")}.local/</div>
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <button disabled={hostnameSaving} onClick={() => setHostnameConfirm(false)} className="flex-1 py-2.5 bg-white/5 text-[var(--text-secondary)] rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-white/10 transition-colors disabled:opacity-50">
                {t("cancel")}
              </button>
              <button disabled={hostnameSaving} onClick={saveHostname} className="flex-1 py-2.5 bg-[#fe6e00] text-white rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-[#ff8b1a] transition-colors disabled:opacity-50">
                {hostnameSaving ? t("settings.restartingDevice") : t("settings.saveAndRestart")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hotspot enable confirmation — single-radio collision warning (desktop layout) */}
      {hotspotConfirmEnable && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-elevated)] rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-[var(--border-subtle)]">
            <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">Enable hotspot?</h3>
            <p className="text-sm text-[var(--text-muted)] mb-5 leading-relaxed">
              The Jetson has a single WiFi radio. Turning the hotspot on will disconnect this device from <span className="text-[var(--text-primary)] font-medium">{connectedSSID}</span>. You&apos;ll lose internet until you turn the hotspot back off, plug in Ethernet, or reconfigure WiFi.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setHotspotConfirmEnable(false)} className="flex-1 py-2.5 bg-white/5 text-[var(--text-secondary)] rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-white/10 transition-colors">{t("cancel")}</button>
              <button onClick={() => { setHotspotConfirmEnable(false); void performHotspotToggle(true); }} className="flex-1 py-2.5 bg-[#fe6e00] text-white rounded-xl text-sm font-semibold cursor-pointer border-none hover:bg-[#ff8b1a] transition-colors">Enable hotspot</button>
            </div>
          </div>
        </div>
      )}

      {/* System password change confirmation */}
      {systemPasswordConfirmDialog}

      {/* System Update full-screen overlay (portal to escape window stacking context) */}
      {hostnameRebootTo && typeof document !== "undefined" && createPortal(
        <div role="alertdialog" aria-modal="true" aria-live="assertive" aria-labelledby="hostname-reboot-title" className="fixed inset-0 z-[999999] flex items-center justify-center" style={{ background: "rgba(10, 15, 26, 1)" }}>
          <div className="flex flex-col items-center gap-6 max-w-md text-center px-6">
            <div className="relative w-20 h-20" aria-hidden="true">
              <div className="absolute inset-0 rounded-full border-2 border-[#fe6e00]/20 animate-pulse" />
              <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#fe6e00] animate-spin" />
            </div>
            <div className="space-y-2">
              <h2 id="hostname-reboot-title" className="text-xl font-semibold text-white">Restarting device…</h2>
              <p className="text-sm text-white/60 leading-relaxed">
                The Jetson is rebooting with its new name.<br/>You&apos;ll be redirected automatically when it&apos;s back online.
              </p>
            </div>
            <a href={hostnameRebootTo} className="text-xs text-[#fe6e00] hover:text-[#ff8b1a] font-mono underline-offset-2 hover:underline break-all">
              {hostnameRebootTo}
            </a>
            <p className="text-[11px] text-white/30">
              This usually takes 30–60 seconds. If your browser doesn&apos;t redirect, click the link above.
            </p>
          </div>
        </div>,
        document.body,
      )}

      {updateStarted && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[999999] flex items-center justify-center" style={{ background: "rgba(10, 15, 26, 1)" }}>
          <style>{`
            @keyframes update-pulse { 0%, 100% { opacity: 0.3; transform: scale(1); } 50% { opacity: 0.15; transform: scale(1.3); } }
            @keyframes update-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
          `}</style>
          <div className="flex flex-col items-center gap-8 max-w-md w-full text-center px-6">
            {/* Mascot with animated ring */}
            <div className="relative w-28 h-28 flex items-center justify-center">
              {/* Pulse rings */}
              {!(updateError || updateState?.phase === "failed") && updateState?.phase !== "completed" && (
                <>
                  <div className="absolute inset-0 rounded-full border-2 border-[#f97316]/20" style={{ animation: "update-pulse 2.5s ease-in-out infinite" }} />
                  <div className="absolute inset-3 rounded-full border border-[#f97316]/10" style={{ animation: "update-pulse 2.5s ease-in-out infinite 0.5s" }} />
                </>
              )}
              {/* Completed ring */}
              {updateState?.phase === "completed" && (
                <div className="absolute inset-0 rounded-full border-2 border-emerald-500/30" />
              )}
              {/* Error ring */}
              {(updateError || updateState?.phase === "failed") && (
                <div className="absolute inset-0 rounded-full border-2 border-red-500/30" />
              )}
              {/* Logo — matches the welcome screen in the setup wizard */}
              <img
                src="/clawbox-crab.png"
                alt="ClawBox"
                className="w-[50px] h-[50px] object-contain relative z-10"
                style={updateState?.phase === "completed" || updateError || updateState?.phase === "failed" ? {} : { animation: "update-float 3s ease-in-out infinite" }}
              />
            </div>

            <div>
              <h2 className="text-2xl font-bold text-white mb-2">
                {updateState?.phase === "completed" ? t("settings.updateComplete") : updateError || updateState?.phase === "failed" ? t("settings.updateFailed") : t("settings.updating")}
              </h2>
              <p className="text-sm text-white/40">
                {updateState?.phase === "completed"
                  ? (updateState.steps.some(s => s.id === RESTART_STEP_ID) ? t("settings.restartingDevice") : t("settings.updateDone"))
                  : updateError || updateState?.phase === "failed" ? "" : "Please don\u2019t turn off your device"}
              </p>
            </div>

            {updateState && updateState.steps.length > 0 && (
              <div className="w-full max-w-xs space-y-3 text-left bg-white/[0.03] rounded-2xl p-4 border border-white/[0.06]">
                {updateState.steps.map((step) => (
                  <div key={step.id} className="flex items-center gap-3 text-sm">
                    {step.status === "completed" ? (
                      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 shrink-0">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M5 12l5 5L19 7" /></svg>
                      </span>
                    ) : step.status === "running" ? (
                      <span className="flex items-center justify-center w-5 h-5 shrink-0">
                        <span className="w-4 h-4 rounded-full border-2 border-[#f97316] border-t-transparent animate-spin" />
                      </span>
                    ) : step.status === "failed" ? (
                      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-red-500/20 text-red-400 shrink-0">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                      </span>
                    ) : (
                      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-white/[0.04] shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-white/20" />
                      </span>
                    )}
                    <span className={step.status === "running" ? "text-white font-medium" : step.status === "completed" ? "text-emerald-400/70" : step.status === "failed" ? "text-red-400" : "text-white/25"}>
                      {step.label}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {!updateState && !updateError && (
              <div className="flex items-center gap-2 text-sm text-white/40">
                <span className="w-4 h-4 rounded-full border-2 border-[#f97316] border-t-transparent animate-spin" />
                Connecting...
              </div>
            )}
            {(updateError || updateState?.phase === "failed") && (
              <div className="space-y-4">
                <p className="text-sm text-red-400/80">{updateError || updateState?.error || "An error occurred during update"}</p>
                {updateState?.steps.some((step) => step.status === "failed") && (
                  <div className="w-full max-w-xs space-y-2 text-left">
                    {updateState.steps
                      .filter((step) => step.status === "failed")
                      .map((step) => (
                        <div
                          key={`${step.id}-error`}
                          className="rounded-xl border border-red-500/20 bg-red-500/8 px-3 py-2 text-xs text-red-300/90"
                        >
                          <span className="font-semibold text-red-300">{step.label}:</span>{" "}
                          {step.error || t("unknownError")}
                        </div>
                      ))}
                  </div>
                )}
                <button
                  onClick={() => { setUpdateStarted(false); setUpdateError(null); setUpdateState(null); stopUpdatePolling(); }}
                  className="px-6 py-2.5 bg-white/10 text-white rounded-xl text-sm font-medium cursor-pointer hover:bg-white/15 transition-colors border-none"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}

      {resetOverlay}
    </div>
  );
}

function RemoteLoginPlaceholder({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="max-w-xl">
      <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 flex flex-col items-center text-center gap-4">
        <img
          src="/clawbox-crab.png"
          alt=""
          width={48}
          height={48}
          className="select-none pointer-events-none drop-shadow-[0_0_12px_rgba(249,115,22,0.5)]"
        />
        <div>
          <h3 className="text-base font-semibold text-[var(--text-primary)] mb-1">Sign in to use Remote Control</h3>
          <p className="text-sm text-[var(--text-muted)] leading-relaxed">
            Remote Control needs your ClawBox account so the portal can publish a secure tunnel back to this device.
          </p>
        </div>
        <button
          type="button"
          onClick={onSignIn}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl btn-gradient text-sm font-medium text-white cursor-pointer"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>open_in_new</span>
          Open ClawBox Portal
        </button>
      </div>
    </div>
  );
}
