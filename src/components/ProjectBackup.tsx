"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { notifyCodingAgentChanged } from "@/lib/ui-events";
import {
  type BackupErrorCode,
  type BackupHistoryEntry,
  type FolderBackupStatus,
  type FolderBackupSummary,
  type LeftOutFile,
  type LeftOutReason,
} from "@/lib/project-backup-shared";
import { Icon } from "./file-icons";
import DeviceCodeCard from "./DeviceCodeCard";
import Switch from "./CodingAgentSwitch";

// ── Projects → GitHub backup, as the owner sees it (TASK-1358) ──────────────
//
// For someone who has never used git: every word on the main path is plain
// ("a private copy", "back up", "the online copy"). The words git itself uses
// — repository, commit, push, remote, branch — appear only inside Advanced,
// each with its plain meaning beside it. The server (src/lib/project-backup.ts)
// does the work and says what happened as a code; this file words it.

type T = (key: string, params?: Record<string, string | number>) => string;

const GITHUB_SIGNUP_URL = "https://github.com/signup";
/** The progress line asks the box what a running backup is doing this often. */
const STAGE_POLL_MS = 1000;
/** GitHub's own floor for the device-flow poll. */
const DEVICE_POLL_FLOOR_S = 5;

const PRIMARY = "inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white btn-gradient hover:opacity-90 cursor-pointer disabled:opacity-40 disabled:cursor-default";
const SECONDARY = "inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer bg-white/[0.06] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.1] disabled:opacity-40 disabled:cursor-default";
const LINK = "inline-flex items-center gap-1 text-xs underline decoration-white/20 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer";
const SECTION = "text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]";

// ── Words ────────────────────────────────────────────────────────────────────

/** "2 hours ago", in the desktop's language. */
export function relativeWhen(at: number, now: number, locale: string): string {
  const diff = at - now;
  const abs = Math.abs(diff);
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  } catch {
    rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  }
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (abs < MIN) return rtf.format(0, "second");
  if (abs < HOUR) return rtf.format(Math.round(diff / MIN), "minute");
  if (abs < DAY) return rtf.format(Math.round(diff / HOUR), "hour");
  if (abs < 30 * DAY) return rtf.format(Math.round(diff / DAY), "day");
  if (abs < 365 * DAY) return rtf.format(Math.round(diff / (30 * DAY)), "month");
  return rtf.format(Math.round(diff / (365 * DAY)), "year");
}

/** "1 Oct 2026, 20:40", in the desktop's language. */
export function formatWhen(at: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
  } catch {
    return new Date(at).toLocaleString();
  }
}

/** The plain sentence for each refusal the backup routes answer. */
export function backupErrorText(t: T, code: unknown, extra: { parent?: unknown } = {}): string {
  switch (code as BackupErrorCode) {
    case "not_pinned": return t("files.backup.errNotPinned");
    case "missing": return t("files.backup.errMissing");
    case "protected": return t("files.backup.errProtected");
    case "inside_repo": return t("files.backup.errInsideRepo", { parent: typeof extra.parent === "string" ? extra.parent : "…" });
    case "no_gh": return t("files.backup.errNoGh");
    case "gh_broken": return t("files.backup.errGhBroken");
    case "gh_unreachable": return t("files.backup.errUnreachable");
    case "not_connected": return t("files.backup.errNotConnected");
    case "name_exhausted": return t("files.backup.errNameExhausted");
    case "missing_scope": return t("files.backup.errScope");
    case "not_private": return t("files.backup.errNotPrivate");
    case "detached": return t("files.backup.errDetached");
    case "unfinished_merge": return t("files.backup.errUnfinishedMerge");
    case "no_upstream": return t("files.backup.errNoUpstream");
    case "remote_ahead": return t("files.backup.errRemoteAhead");
    case "push_refused": return t("files.backup.errPushRefused");
    case "push_auth": return t("files.backup.errPushAuth");
    case "busy": return t("files.backup.errBusy");
    case "has_remote":
    case "not_set_up": return t("files.backup.errNotSetUp");
    default: return t("files.backup.errFailed");
  }
}

/** The line under a project in the Projects list. */
export function backupRowText(summary: FolderBackupSummary | undefined, t: T, locale: string, now: number): string | null {
  if (!summary) return null;
  if (summary.state === "existing_git") return t("files.backup.rowExisting");
  if (summary.state === "none") return t("files.backup.rowNone");
  if (!summary.lastBackupAt) return t("files.backup.rowUnfinished");
  const when = relativeWhen(summary.lastBackupAt, now, locale);
  return summary.auto ? t("files.backup.rowDaily", { when }) : t("files.backup.rowBackedUp", { when });
}

const SECRET_REASONS: readonly LeftOutReason[] = ["secret_name", "secret_content"];

function isLeftOut(v: unknown): v is LeftOutFile {
  return !!v && typeof v === "object" && typeof (v as LeftOutFile).path === "string" && typeof (v as LeftOutFile).reason === "string";
}

function isStatus(v: unknown): v is FolderBackupStatus {
  if (!v || typeof v !== "object") return false;
  const s = v as FolderBackupStatus;
  return ["not_set_up", "backed_up", "existing_git", "refused"].includes(s.state)
    && !!s.folder && typeof s.folder.path === "string"
    && !!s.github && typeof s.github.connected === "boolean";
}

// ── Left out ─────────────────────────────────────────────────────────────────

/** "We left out 2 files that look like passwords or keys" — and, on request, which. */
export function LeftOutNotice({ files }: { files: LeftOutFile[] }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;
  const secret = files.filter((f) => SECRET_REASONS.includes(f.reason)).length;
  const large = files.filter((f) => f.reason === "too_large").length;
  const nested = files.filter((f) => f.reason === "nested_git").length;
  const lines: string[] = [];
  if (secret) lines.push(secret === 1 ? t("files.backup.leftOutSecretOne") : t("files.backup.leftOutSecretMany", { count: secret }));
  if (large) lines.push(large === 1 ? t("files.backup.leftOutLargeOne") : t("files.backup.leftOutLargeMany", { count: large }));
  if (nested) lines.push(nested === 1 ? t("files.backup.leftOutNestedOne") : t("files.backup.leftOutNestedMany", { count: nested }));
  const reasonText = (r: LeftOutReason) => r === "secret_name"
    ? t("files.backup.reasonSecretName")
    : r === "secret_content"
      ? t("files.backup.reasonSecretContent")
      : r === "too_large"
        ? t("files.backup.reasonTooLarge")
        : t("files.backup.reasonNested");
  return (
    <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2.5 flex flex-col gap-1.5" data-testid="project-backup-left-out">
      <div className="flex items-start gap-2">
        <Icon name="shield_lock" size={16} className="text-amber-300 mt-0.5 shrink-0" />
        <div className="flex flex-col gap-0.5 text-xs text-[var(--text-secondary)]">
          {lines.map((line) => <span key={line}>{line}</span>)}
          <span className="text-[var(--text-muted)]">{t("files.backup.leftOutKept")}</span>
        </div>
      </div>
      <button type="button" onClick={() => setOpen((o) => !o)} className={`${LINK} self-start ml-6`} aria-expanded={open} data-testid="project-backup-left-out-toggle">
        {open ? t("files.backup.hideWhich") : t("files.backup.showWhich")}
      </button>
      {open && (
        <ul className="ml-6 flex flex-col gap-0.5 max-h-40 overflow-y-auto" data-testid="project-backup-left-out-list">
          {files.map((f) => (
            <li key={`${f.reason}:${f.path}`} className="text-[11px] text-[var(--text-muted)] break-all">
              <span className="font-mono text-[var(--text-secondary)]">{f.path}</span>
              <span>{" — "}{reasonText(f.reason)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── What is GitHub? ──────────────────────────────────────────────────────────

export function GitHubHelpDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => { rootRef.current?.focus(); }, []);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        ref={rootRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("files.backup.helpTitle")}
        data-testid="project-backup-help"
        className="card-surface rounded-2xl p-5 shadow-2xl flex flex-col gap-3 outline-none w-[min(440px,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }}
      >
        <h3 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Icon name="help" size={20} color="var(--coral-bright)" />
          {t("files.backup.helpTitle")}
        </h3>
        <div className="flex flex-col gap-1.5 text-sm leading-relaxed text-[var(--text-secondary)]">
          <p>{t("files.backup.help1")}</p>
          <p>{t("files.backup.help2")}</p>
          <p>{t("files.backup.help3")}</p>
          <p>{t("files.backup.help4")}</p>
          <p>{t("files.backup.help5")}</p>
        </div>
        <div>
          <div className={`${SECTION} mb-1.5`}>{t("files.backup.helpSteps")}</div>
          <ol className="flex flex-col gap-1 text-sm text-[var(--text-secondary)] list-decimal pl-5">
            <li>{t("files.backup.helpStep1")}</li>
            <li>{t("files.backup.helpStep2")}</li>
            <li>{t("files.backup.helpStep3")}</li>
          </ol>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <a href={GITHUB_SIGNUP_URL} target="_blank" rel="noopener noreferrer" className={SECONDARY} data-testid="project-backup-signup">
            <Icon name="open_in_new" size={16} />
            {t("files.backup.helpSignup")}
          </a>
          <button type="button" onClick={onClose} className={PRIMARY}>{t("files.backup.helpClose")}</button>
        </div>
      </div>
    </div>
  );
}

// ── The suggestion card on the Projects view ─────────────────────────────────

export function BackupSuggestionCard({ onSetUp, onDismiss, onLearnMore }: {
  onSetUp: () => void;
  onDismiss: () => void;
  onLearnMore: () => void;
}) {
  const { t } = useT();
  return (
    <div
      className="flex items-start gap-3 px-4 py-3 rounded-xl border border-[var(--coral-bright)]/30 bg-[var(--coral-bright)]/[0.07]"
      data-testid="files-backup-suggestion"
    >
      <Icon name="cloud_upload" size={24} color="var(--coral-bright)" className="shrink-0 mt-0.5" />
      <div className="flex flex-col gap-2 min-w-0">
        <p className="text-sm text-[var(--text-primary)]">{t("files.backup.suggestTitle")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onSetUp} className={PRIMARY} data-testid="files-backup-suggestion-setup">
            {t("files.backup.suggestSetUp")}
          </button>
          <button type="button" onClick={onDismiss} className={SECONDARY} data-testid="files-backup-suggestion-dismiss">
            {t("files.backup.notNow")}
          </button>
          <button type="button" onClick={onLearnMore} className={LINK}>
            {t("files.backup.whatIsGithub")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── The panel ────────────────────────────────────────────────────────────────

interface Notice {
  kind: "ok" | "error";
  text: string;
  /** What git or gh said — shown under Advanced only. */
  detail?: string;
  leftOut?: LeftOutFile[];
}

type Busy = null | "backup" | "connect" | "auto" | "disconnect";

const JSON_POST = { method: "POST", headers: { "Content-Type": "application/json" } } as const;

function History({ entries, locale }: { entries: BackupHistoryEntry[]; locale: string }) {
  const { t } = useT();
  return (
    <section data-testid="project-backup-history">
      <h4 className={`${SECTION} mb-1.5 flex items-center gap-1.5`}>
        <Icon name="history" size={13} />
        {t("files.backup.history")}
      </h4>
      {entries.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">{t("files.backup.historyEmpty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-white/[0.05] rounded-lg border border-[var(--border-subtle)] bg-white/[0.02]">
          {entries.map((h) => (
            <li key={`${h.at}-${h.commit}`} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
              <span className="text-[var(--text-secondary)]">{formatWhen(h.at, locale)}</span>
              <span className="text-[var(--text-muted)]">
                {h.files === 1 ? t("files.backup.historyFilesOne") : t("files.backup.historyFilesMany", { count: h.files })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Back up one pinned project folder: the first private copy, Back up now,
 * the daily switch, History, Disconnect. `onChanged` tells the Projects view
 * to read its row badges again.
 */
export function ProjectBackupPanel({ folder, onClose, onChanged }: {
  folder: { path: string; name: string };
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { t, locale } = useT();
  const [status, setStatus] = useState<FolderBackupStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [stage, setStage] = useState<"preparing" | "uploading" | "done" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [deviceLogin, setDeviceLogin] = useState<{ userCode: string; verificationUri: string; interval: number } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [name, setName] = useState("");
  const [autoOffer, setAutoOffer] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const nameTouched = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;
  const statusUrl = `/setup-api/project-backup?path=${encodeURIComponent(folder.path)}`;

  useEffect(() => { rootRef.current?.focus(); }, []);

  const load = useCallback(async (): Promise<FolderBackupStatus | null> => {
    try {
      const res = await fetch(statusUrl, { cache: "no-store" });
      const data = await res.json().catch(() => null) as Record<string, unknown> | null;
      if (!res.ok || !isStatus(data)) {
        setLoadError(backupErrorText(tRef.current, data?.code, { parent: data?.parent }));
        return null;
      }
      setStatus(data);
      setLoadError(null);
      setNow(Date.now());
      if (data.suggestedName && !nameTouched.current) setName(data.suggestedName);
      return data;
    } catch {
      setLoadError(tRef.current("files.backup.errFailed"));
      return null;
    }
  }, [statusUrl]);

  useEffect(() => { void load(); }, [load]);

  const runBackup = useCallback(async (kind: "first" | "now", chosenName?: string) => {
    setBusy("backup");
    setNotice(null);
    setAutoOffer(false);
    setConfirmDisconnect(false);
    setStage("preparing");
    let live = true;
    // The progress line follows what the box is actually doing; this read
    // is local to the box and never asks GitHub anything.
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`${statusUrl}&stage=1`, { cache: "no-store" });
        const data = await res.json() as { running?: unknown };
        if (live && (data.running === "preparing" || data.running === "uploading")) setStage(data.running);
      } catch { /* the next tick asks again */ }
    }, STAGE_POLL_MS);
    try {
      const res = await fetch("/setup-api/project-backup", {
        ...JSON_POST,
        body: JSON.stringify(kind === "first"
          ? { action: "first_backup", path: folder.path, ...(chosenName ? { name: chosenName } : {}) }
          : { action: "backup_now", path: folder.path }),
      });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) {
        setStage(null);
        if (data.code === "name_taken" && typeof data.suggestedName === "string") {
          nameTouched.current = false;
          setName(data.suggestedName);
          setStatus((s) => (s ? { ...s, suggestedName: data.suggestedName as string, takenName: String(data.takenName ?? "") } : s));
          setNotice({ kind: "error", text: t("files.backup.nameTaken", { taken: String(data.takenName ?? ""), repo: data.suggestedName }) });
        } else {
          setNotice({
            kind: "error",
            text: backupErrorText(t, data.code, { parent: data.parent }),
            detail: typeof data.detail === "string" ? data.detail : undefined,
          });
        }
        await load();
        return;
      }
      setStage("done");
      const leftOut = Array.isArray(data.leftOut) ? data.leftOut.filter(isLeftOut) : [];
      const files = typeof data.files === "number" ? data.files : 0;
      const text = data.nothingChanged
        ? t("files.backup.nothingChanged")
        : kind === "first"
          ? t("files.backup.doneFirst", { name: folder.name })
          : files === 1 ? t("files.backup.doneFilesOne") : t("files.backup.doneFilesMany", { count: files });
      setNotice({ kind: "ok", text, leftOut });
      if (kind === "first") setAutoOffer(true);
      await load();
      onChanged?.();
    } catch {
      setStage(null);
      setNotice({ kind: "error", text: t("files.backup.errFailed") });
    } finally {
      live = false;
      clearInterval(poll);
      setBusy(null);
    }
  }, [folder.path, folder.name, statusUrl, load, onChanged, t]);

  // ── Connecting GitHub: the Coding Agent's own device flow, then on. ──

  const afterConnect = useRef<() => void>(() => {});
  afterConnect.current = () => {
    notifyCodingAgentChanged();
    void load().then((s) => {
      if (!s || s.state !== "not_set_up" || !s.github.connected) return;
      // A clash is the owner's call: the new name is shown and waits for them.
      if (s.takenName) {
        setNotice({ kind: "ok", text: t("files.backup.connected") });
        return;
      }
      void runBackup("first", s.suggestedName);
    });
  };

  const connect = async () => {
    setBusy("connect");
    setNotice(null);
    try {
      const res = await fetch("/setup-api/coding-agent/github-login", { ...JSON_POST, body: JSON.stringify({ action: "start" }) });
      const data = await res.json().catch(() => ({})) as { userCode?: unknown; verificationUri?: unknown; interval?: unknown };
      if (!res.ok || typeof data.userCode !== "string" || typeof data.verificationUri !== "string") throw new Error("start");
      const n = Number(data.interval);
      setDeviceLogin({
        userCode: data.userCode,
        verificationUri: data.verificationUri,
        interval: Math.max(DEVICE_POLL_FLOOR_S, Number.isFinite(n) && n > 0 ? n : DEVICE_POLL_FLOOR_S),
      });
    } catch {
      setNotice({ kind: "error", text: t("files.backup.connectFailed") });
    } finally {
      setBusy(null);
    }
  };

  const cancelConnect = () => {
    setDeviceLogin(null);
    void fetch("/setup-api/coding-agent/github-login", { ...JSON_POST, body: JSON.stringify({ action: "cancel" }) }).catch(() => { /* the code simply expires */ });
  };

  // The same polling rules as the Coding Agent's card: the route's cadence,
  // re-read from each answer; a transient failure keeps waiting.
  useEffect(() => {
    if (!deviceLogin) return;
    let alive = true;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/setup-api/coding-agent/github-login", { ...JSON_POST, body: JSON.stringify({ action: "poll" }) });
        if (!res.ok || !alive) return;
        const out = await res.json() as { status?: string; interval?: unknown };
        if (!alive) return;
        if (out.status === "pending" && out.interval !== undefined) {
          const n = Number(out.interval);
          const interval = Math.max(DEVICE_POLL_FLOOR_S, Number.isFinite(n) && n > 0 ? n : DEVICE_POLL_FLOOR_S);
          setDeviceLogin((prev) => (prev && prev.interval !== interval ? { ...prev, interval } : prev));
        } else if (out.status === "connected") {
          setDeviceLogin(null);
          afterConnect.current();
        } else if (out.status === "failed") {
          setDeviceLogin(null);
          setNotice({ kind: "error", text: tRef.current("files.backup.connectFailed") });
        }
      } catch { /* keep waiting */ }
    }, deviceLogin.interval * 1000);
    return () => { alive = false; clearInterval(id); };
  }, [deviceLogin]);

  // ── Settings ──

  const setAuto = async (enabled: boolean) => {
    setBusy("auto");
    try {
      const res = await fetch("/setup-api/project-backup", { ...JSON_POST, body: JSON.stringify({ action: "auto", path: folder.path, enabled }) });
      const data = await res.json().catch(() => ({})) as { auto?: unknown; code?: unknown };
      if (!res.ok) {
        setNotice({ kind: "error", text: backupErrorText(t, data.code) });
        return;
      }
      setStatus((s) => (s ? { ...s, auto: data.auto === true, lastAutoError: null } : s));
      setAutoOffer(false);
      onChanged?.();
    } catch {
      setNotice({ kind: "error", text: t("files.backup.errFailed") });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    try {
      const res = await fetch("/setup-api/project-backup", { ...JSON_POST, body: JSON.stringify({ action: "disconnect", path: folder.path }) });
      const data = await res.json().catch(() => ({})) as { code?: unknown };
      if (!res.ok) {
        setNotice({ kind: "error", text: backupErrorText(t, data.code) });
        return;
      }
      setConfirmDisconnect(false);
      setAutoOffer(false);
      setStage(null);
      setNotice({ kind: "ok", text: t("files.backup.disconnected") });
      await load();
      onChanged?.();
    } catch {
      setNotice({ kind: "error", text: t("files.backup.errFailed") });
    } finally {
      setBusy(null);
    }
  };

  // ── Pieces ──

  const working = busy !== null || status?.running != null;

  const progress = stage && (
    <ol className="flex flex-col gap-1.5" data-testid="project-backup-progress" aria-live="polite">
      {(["preparing", "uploading", "done"] as const).map((step, i) => {
        const at = ["preparing", "uploading", "done"].indexOf(stage);
        const state = i < at || stage === "done" ? "done" : i === at ? "now" : "later";
        const label = step === "preparing" ? t("files.backup.stepPreparing") : step === "uploading" ? t("files.backup.stepUploading") : t("files.backup.stepDone");
        return (
          <li key={step} className={`flex items-center gap-2 text-sm ${state === "later" ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
            <Icon
              name={state === "done" ? "check_circle" : state === "now" ? "progress_activity" : "radio_button_unchecked"}
              size={18}
              className={state === "now" ? "motion-safe:animate-spin text-[var(--coral-bright)]" : state === "done" ? "text-emerald-400" : ""}
            />
            {label}
          </li>
        );
      })}
    </ol>
  );

  const noticeBlock = notice && (
    <div className="flex flex-col gap-2">
      <p
        className={`text-sm flex items-start gap-2 ${notice.kind === "ok" ? "text-emerald-300" : "text-red-300"}`}
        role={notice.kind === "error" ? "alert" : "status"}
        data-testid="project-backup-notice"
      >
        <Icon name={notice.kind === "ok" ? "check_circle" : "error"} size={18} className="shrink-0 mt-px" />
        <span>{notice.text}</span>
      </p>
      {notice.leftOut && <LeftOutNotice files={notice.leftOut} />}
    </div>
  );

  const historyAndLeftOut = (s: FolderBackupStatus) => (
    <>
      {!notice?.leftOut && <LeftOutNotice files={s.lastLeftOut} />}
      <History entries={s.history} locale={locale} />
    </>
  );

  const statusLine = (s: FolderBackupStatus) => {
    if (!s.lastBackupAt) return <p className="text-sm text-amber-300" data-testid="project-backup-status-line">{t("files.backup.lastBackupUnfinished")}</p>;
    const n = s.pending?.files;
    const changed = n === undefined ? null : n === 0 ? t("files.backup.changedNone") : n === 1 ? t("files.backup.changedOne") : t("files.backup.changedMany", { count: n });
    return (
      <p className="text-sm text-[var(--text-secondary)]" data-testid="project-backup-status-line">
        {t("files.backup.lastBackup", { when: relativeWhen(s.lastBackupAt, now, locale) })}
        {changed && <span className="text-[var(--text-muted)]">{" · "}{changed}</span>}
      </p>
    );
  };

  const advanced = (body: React.ReactNode) => (
    <div className="border-t border-[var(--border-subtle)] pt-2">
      <button type="button" onClick={() => setAdvancedOpen((o) => !o)} className={LINK} aria-expanded={advancedOpen} data-testid="project-backup-advanced-toggle">
        <Icon name={advancedOpen ? "expand_less" : "expand_more"} size={16} />
        {t("files.backup.advanced")}
      </button>
      {advancedOpen && (
        <div className="mt-2 flex flex-col gap-2 text-xs leading-relaxed text-[var(--text-muted)]" data-testid="project-backup-advanced">
          {body}
          {notice?.detail && <p className="font-mono break-all">{t("files.backup.technical", { detail: notice.detail })}</p>}
        </div>
      )}
    </div>
  );

  const backUpNowButton = (
    <button type="button" onClick={() => void runBackup("now")} disabled={working} className={PRIMARY} data-testid="project-backup-now">
      <Icon name="cloud_upload" size={18} />
      {t("files.backup.backUpNow")}
    </button>
  );

  const openOnGithub = (url: string) => (
    <a href={url} target="_blank" rel="noopener noreferrer" className={SECONDARY} data-testid="project-backup-open">
      <Icon name="open_in_new" size={16} />
      {t("files.backup.openOnGithub")}
    </a>
  );

  // ── The faces ──

  const notSetUp = (s: FolderBackupStatus) => {
    const gh = s.github;
    let action: React.ReactNode;
    if (gh.reason === "unreachable") {
      action = (
        <div className="flex flex-col gap-2 items-start">
          <p className="text-sm text-red-300">{t("files.backup.errUnreachable")}</p>
          <button type="button" onClick={() => void load()} className={SECONDARY}>{t("files.retry")}</button>
        </div>
      );
    } else if (gh.reason === "not_runnable") {
      action = <p className="text-sm text-red-300">{t("files.backup.errGhBroken")}</p>;
    } else if (!gh.installed) {
      action = <p className="text-sm text-red-300">{t("files.backup.errNoGh")}</p>;
    } else if (!gh.connected) {
      action = deviceLogin ? (
        <div className="flex flex-col gap-2" data-testid="project-backup-device">
          <p className="text-xs text-[var(--text-secondary)]">{t("files.backup.deviceIntro")}</p>
          <DeviceCodeCard
            code={deviceLogin.userCode}
            verificationUrl={deviceLogin.verificationUri}
            polling
            onNewCode={() => void connect()}
            testId="project-backup-device-code"
            actions={(
              <button type="button" onClick={cancelConnect} className={LINK}>{t("cancel")}</button>
            )}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2 items-start">
          <p className="text-sm text-[var(--text-secondary)]">{t("files.backup.notConnected")}</p>
          <button type="button" onClick={() => void connect()} disabled={working} className={PRIMARY} data-testid="project-backup-connect">
            <Icon name="link" size={18} />
            {t("files.backup.connectAndBackUp")}
          </button>
        </div>
      );
    } else {
      const repo = name.trim() || s.suggestedName || folder.name;
      action = (
        <div className="flex flex-col gap-2 items-start">
          <p className="text-xs text-[var(--text-muted)] flex items-center gap-1.5">
            <Icon name="account_circle" size={16} />
            {t("files.backup.account", { login: gh.login ?? "" })}
          </p>
          <p className="text-sm text-[var(--text-secondary)]" data-testid="project-backup-name-line">
            {s.takenName && repo === s.suggestedName
              ? t("files.backup.nameTaken", { taken: s.takenName, repo })
              : t("files.backup.willBeCalled", { repo })}
          </p>
          <button type="button" onClick={() => void runBackup("first", name.trim() || s.suggestedName)} disabled={working} className={PRIMARY} data-testid="project-backup-first">
            <Icon name="cloud_upload" size={18} />
            {t("files.backup.backUpNow")}
          </button>
        </div>
      );
    }
    return (
      <>
        <p className="text-sm leading-relaxed text-[var(--text-primary)]" data-testid="project-backup-intro">{t("files.backup.intro")}</p>
        <button type="button" onClick={() => setHelpOpen(true)} className={`${LINK} self-start`} data-testid="project-backup-help-link">
          <Icon name="help" size={14} />
          {t("files.backup.whatIsGithub")}
        </button>
        {!stage && action}
        {advanced(
          <>
            <p>{t("files.backup.advancedNew")}</p>
            {s.isRepo && <p>{t("files.backup.advancedLocalRepo")}</p>}
            {gh.connected && (
              <label className="flex flex-col gap-1">
                <span className="text-[var(--text-secondary)]">{t("files.backup.nameLabel")}</span>
                <input
                  value={name}
                  onChange={(e) => { nameTouched.current = true; setName(e.target.value); }}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  maxLength={100}
                  data-testid="project-backup-name"
                  className="px-3 py-1.5 bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-lg text-sm text-[var(--text-primary)] outline-none focus:border-[var(--coral-bright)]"
                />
                <span>{t("files.backup.nameHint")}</span>
              </label>
            )}
          </>,
        )}
      </>
    );
  };

  const backedUp = (s: FolderBackupStatus) => (
    <>
      <div className="flex items-center gap-2">
        <Icon name="cloud_done" size={20} className="text-emerald-400" />
        <span className="text-sm font-medium text-[var(--text-primary)]">{t("files.backup.backedUpTitle")}</span>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/[0.06] text-[var(--text-muted)] flex items-center gap-1">
          <Icon name="lock" size={12} />
          {t("files.backup.private")}
        </span>
      </div>
      {statusLine(s)}
      <div className="flex flex-wrap gap-2">
        {backUpNowButton}
        {s.repo && openOnGithub(s.repo.webUrl)}
      </div>
      <div className="flex items-start justify-between gap-3 rounded-xl border border-[var(--border-subtle)] bg-white/[0.02] px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm text-[var(--text-primary)]">{t("files.backup.autoLabel")}</div>
          <div className="text-xs text-[var(--text-muted)]">{t("files.backup.autoHint")}</div>
          {s.lastAutoError && (
            <div className="text-xs text-amber-300 mt-1" data-testid="project-backup-auto-error">
              {t("files.backup.autoFailed", { reason: backupErrorText(t, s.lastAutoError.code) })}
            </div>
          )}
        </div>
        <Switch
          checked={s.auto}
          busy={busy === "auto"}
          disabled={working && busy !== "auto"}
          label={t("files.backup.autoLabel")}
          onChange={(next) => void setAuto(next)}
          testId="project-backup-auto"
        />
      </div>
      {historyAndLeftOut(s)}
      {confirmDisconnect ? (
        <div className="rounded-xl border border-red-400/30 bg-red-400/[0.06] px-3 py-2.5 flex flex-col gap-2" data-testid="project-backup-disconnect-confirm">
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{t("files.backup.disconnectConfirm")}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => void disconnect()} disabled={working} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/80 hover:bg-red-500 text-white cursor-pointer disabled:opacity-40">
              {t("files.backup.disconnectYes")}
            </button>
            <button type="button" onClick={() => setConfirmDisconnect(false)} className={SECONDARY}>{t("cancel")}</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirmDisconnect(true)} disabled={working} className={`${LINK} self-start`} data-testid="project-backup-disconnect">
          <Icon name="link_off" size={14} />
          {t("files.backup.disconnect")}
        </button>
      )}
      {advanced(<p>{t("files.backup.advancedCreated", { repo: s.repo?.fullName ?? "", branch: s.repo?.branch ?? "" })}</p>)}
    </>
  );

  const existingGit = (s: FolderBackupStatus) => {
    const remote = s.remote?.label ?? "";
    return (
      <>
        <div className="flex items-start gap-2">
          <Icon name="account_tree" size={20} color="var(--coral-bright)" className="shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-[var(--text-primary)]" data-testid="project-backup-existing">{t("files.backup.existingTitle")}</span>
            <span className="text-sm text-[var(--text-secondary)] leading-relaxed">{t("files.backup.existingBody", { remote })}</span>
            <span className="text-xs text-[var(--text-muted)] leading-relaxed">{t("files.backup.existingKeep")}</span>
          </div>
        </div>
        {s.lastBackupAt && statusLine(s)}
        <div className="flex flex-wrap gap-2">
          {backUpNowButton}
          {s.remote?.webUrl && openOnGithub(s.remote.webUrl)}
        </div>
        {(s.history.length > 0 || s.lastLeftOut.length > 0) && historyAndLeftOut(s)}
        {advanced(<p>{t("files.backup.advancedExisting", { remote, branch: s.remote?.branch ?? "" })}</p>)}
      </>
    );
  };

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => { if (!busy) onClose(); }}>
      <div
        ref={rootRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("files.backup.title", { name: folder.name })}
        data-testid="project-backup-panel"
        className="card-surface rounded-2xl p-5 shadow-2xl flex flex-col gap-3 outline-none w-[min(500px,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !helpOpen) { e.preventDefault(); e.stopPropagation(); onClose(); }
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Icon name="cloud_upload" size={20} color="var(--coral-bright)" />
          <h3 className="text-base font-semibold text-[var(--text-primary)] truncate flex-1">{t("files.backup.title", { name: folder.name })}</h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer"
            aria-label={t("files.backup.close")}
            title={t("files.backup.close")}
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        {/* The outcome first: what is happening, what just happened, and the
            daily-backup offer — never below a History the owner has to
            scroll past to find out whether it worked. */}
        {progress}
        {noticeBlock}
        {autoOffer && status?.state === "backed_up" && !status.auto && (
          <div className="rounded-xl border border-[var(--coral-bright)]/30 bg-[var(--coral-bright)]/[0.07] px-3 py-2.5 flex flex-col gap-2" data-testid="project-backup-auto-offer">
            <div className="text-sm font-medium text-[var(--text-primary)]">{t("files.backup.autoOfferTitle")}</div>
            <div className="text-xs text-[var(--text-secondary)]">{t("files.backup.autoOfferBody")}</div>
            <div className="flex gap-2">
              <button type="button" onClick={() => void setAuto(true)} disabled={working} className={PRIMARY} data-testid="project-backup-auto-offer-yes">
                {t("files.backup.autoOfferYes")}
              </button>
              <button type="button" onClick={() => setAutoOffer(false)} className={SECONDARY}>{t("files.backup.notNow")}</button>
            </div>
          </div>
        )}

        {!status && !loadError && (
          <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <Icon name="progress_activity" size={18} className="motion-safe:animate-spin" />
            {t("files.backup.checking")}
          </div>
        )}
        {loadError && !status && (
          <div className="flex flex-col gap-2 items-start" data-testid="project-backup-load-error">
            <p className="text-sm text-red-300">{loadError}</p>
            <button type="button" onClick={() => void load()} className={SECONDARY}>{t("files.retry")}</button>
          </div>
        )}

        {status?.state === "refused" && (
          <p className="text-sm text-red-300" data-testid="project-backup-refused">
            {backupErrorText(t, status.refusal?.code, { parent: status.refusal?.parent })}
          </p>
        )}
        {status?.state === "not_set_up" && notSetUp(status)}
        {status?.state === "backed_up" && backedUp(status)}
        {status?.state === "existing_git" && existingGit(status)}

      </div>
    </div>
    {/* Beside the panel, not inside it: a click on its backdrop must close
        the help, not bubble on and close the panel under it. */}
    {helpOpen && <GitHubHelpDialog onClose={() => setHelpOpen(false)} />}
    </>
  );
}
