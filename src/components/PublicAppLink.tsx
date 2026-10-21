"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/useModalDialog";

/**
 * The desktop's side of public app links (TASK-1478): the context-menu rows
 * of an app icon, the dialog that creates a link, and the small globe on the
 * icon of an app that is public. Everything that decides anything is
 * server-side (src/lib/public-app-links.ts, scripts/public-app-links.js);
 * this only asks and shows.
 */

export interface PublicLinkInfo {
  appId: string;
  mode: "temporary" | "permanent";
  createdAt: number;
  expiresAt: number | null;
  apiAllow: string[];
  /** The allow-listed prefixes answer reads only. */
  apiReadOnly?: boolean;
  /** Visitors are asked for a password. The password itself is never sent back. */
  passwordProtected?: boolean;
  state: "starting" | "live" | "restarting" | "offline";
  url: string | null;
  /** The token in `url` is masked: only the owner is answered it in clear. */
  tokenMasked?: boolean;
}

/** Does a stored prefix open the app's own /api tree? The serving side matches by prefix, so "/" and "/api/" do. */
function opensAppApi(prefix: string): boolean {
  const p = prefix.replace(/\/+$/, "");
  return p === "" || p === "/api";
}

/**
 * The address this viewer can hand on, or null when there is none. The owner's
 * URL carries the token; anyone else is answered it masked, and a masked token
 * opens nothing. On a link with a password the address without the token shows
 * the password page, so that is the one to share; a link without a password has
 * no address but the owner's.
 */
export function shareableLinkUrl(link: Pick<PublicLinkInfo, "url" | "tokenMasked" | "passwordProtected">): string | null {
  if (!link.url) return null;
  if (!link.tokenMasked) return link.url;
  if (!link.passwordProtected) return null;
  try {
    const bare = new URL(link.url);
    bare.searchParams.delete("k");
    return bare.toString();
  } catch {
    return null;
  }
}

/** What visitors may do with the app's own `/api`: everything (the default), read it, or nothing. */
export type PublicLinkApiAccess = "full" | "read" | "none";

/** Why the server refused: its message, and its code when it gave one. */
export interface PublicLinkFailure {
  message: string;
  code?: string;
}

export interface PublicLinkCreateInput {
  appId: string;
  mode: "temporary" | "permanent";
  ttlMinutes?: number;
  apiAccess?: PublicLinkApiAccess;
  apiAllow?: string[];
  password?: string;
}

export const MIN_LINK_PASSWORD_LENGTH = 8;
const MAX_LINK_PASSWORD_LENGTH = 128;
// No 0/O, 1/l/I: a generated password is read out and typed by other people.
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** A random 20-character password (about 116 bits), from the browser's CSPRNG. */
export function generateLinkPassword(): string {
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  let out = "";
  while (out.length < 20) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    for (const b of bytes) {
      if (b < limit && out.length < 20) out += PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length];
    }
  }
  return out;
}

async function failureOf(res: Response): Promise<PublicLinkFailure> {
  const body = await readJson(res);
  return { message: typeof body.error === "string" ? body.error : "error", ...(typeof body.code === "string" ? { code: body.code } : {}) };
}

const ENDPOINT = "/setup-api/apps/public-link";
const PENDING_POLL_MS = 3000;

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await res.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The owner's public links by app id, kept fresh while any of them is still starting. */
export function usePublicAppLinks(enabled: boolean) {
  const [links, setLinks] = useState<Record<string, PublicLinkInfo>>({});
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await fetch(ENDPOINT, { cache: "no-store" });
      if (!res.ok) return;
      const body = await readJson(res);
      const list = Array.isArray(body.links) ? (body.links as PublicLinkInfo[]) : [];
      if (alive.current) setLinks(Object.fromEntries(list.map((l) => [l.appId, l])));
    } catch {
      // The menu simply offers "create" again; nothing is assumed public.
    }
  }, [enabled]);

  useEffect(() => {
    alive.current = true;
    // Deferred a tick: the answer sets state, and an effect body must not.
    const first = setTimeout(() => { void refresh(); }, 0);
    return () => { alive.current = false; clearTimeout(first); };
  }, [refresh]);

  const pending = Object.values(links).some((l) => l.state !== "live");
  // A temporary link drops off the icon when it expires, without a reload.
  const nextExpiry = Object.values(links).reduce<number | null>((min, l) => (l.expiresAt !== null && (min === null || l.expiresAt < min) ? l.expiresAt : min), null);
  useEffect(() => {
    if (!enabled) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (pending) timers.push(setInterval(() => { void refresh(); }, PENDING_POLL_MS) as unknown as ReturnType<typeof setTimeout>);
    if (nextExpiry !== null) {
      const wait = Math.min(Math.max(nextExpiry - Date.now() + 500, 500), 2_000_000_000);
      timers.push(setTimeout(() => { void refresh(); }, wait));
    }
    return () => { timers.forEach((timer) => { clearTimeout(timer); clearInterval(timer); }); };
  }, [enabled, pending, nextExpiry, refresh]);

  const create = useCallback(async (input: PublicLinkCreateInput): Promise<PublicLinkFailure | null> => {
    const res = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    if (!res.ok) return failureOf(res);
    await refresh();
    return null;
  }, [refresh]);

  /** Set or change the link's password (a string), or remove it (null). The link stays the same. */
  const setPassword = useCallback(async (appId: string, password: string | null): Promise<PublicLinkFailure | null> => {
    const res = await fetch(ENDPOINT, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId, password }) });
    if (!res.ok) return failureOf(res);
    await refresh();
    return null;
  }, [refresh]);

  const disable = useCallback(async (appId: string): Promise<boolean> => {
    const res = await fetch(ENDPOINT, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId }) });
    await refresh();
    return res.ok;
  }, [refresh]);

  return { links, refresh, create, disable, setPassword };
}

function statusLine(t: (key: string, params?: Record<string, string | number>) => string, link: PublicLinkInfo, locale?: string): string {
  if (link.mode === "permanent" || link.expiresAt === null) return t("publicLink.statusPermanent");
  const time = new Date(link.expiresAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  return t("publicLink.statusTemporary", { time });
}

const ROW = "w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3";

/** The rows an app icon's context menu gets: "Create public link", or the link and its off switch. */
export function PublicLinkMenuItems({
  link,
  onCreate,
  onDisable,
  onPassword,
}: {
  link: PublicLinkInfo | undefined;
  onCreate: () => void;
  onDisable: () => void;
  /** Opens the dialog, where the link's password is set, changed or removed. */
  onPassword: () => void;
}) {
  const { t, locale } = useT();
  if (!link) {
    return (
      <button onClick={onCreate} data-testid="ctx-public-link-create" className={ROW}>
        <span className="material-symbols-rounded" style={{ fontSize: 16 }}>public</span> {t("publicLink.create")}
      </button>
    );
  }
  const url = link.url;
  const shareUrl = shareableLinkUrl(link);
  return (
    <>
      <div data-testid="ctx-public-link-status" className="px-4 py-1.5 text-xs text-emerald-300/90 font-medium flex items-center gap-2">
        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>public</span>
        {url ? statusLine(t, link, locale) : t("publicLink.starting")}
      </div>
      <div data-testid="ctx-public-link-password-status" className="px-4 pb-1 text-[11px] text-white/75 flex items-center gap-1.5">
        <span className="material-symbols-rounded" aria-hidden style={{ fontSize: 13 }}>{link.passwordProtected ? "lock" : "lock_open"}</span>
        {t(link.passwordProtected ? "publicLink.password.statusOn" : "publicLink.password.statusOff")}
      </div>
      <div data-testid="ctx-public-link-address-note" className="px-4 pb-1.5 text-[11px] text-white/60">{t("publicLink.addressChanges")}</div>
      {shareUrl && (
        <>
          <button onClick={() => { void navigator.clipboard?.writeText(shareUrl); }} data-testid="ctx-public-link-copy" className={ROW}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>content_copy</span> {t("publicLink.copy")}
          </button>
          <button onClick={() => { window.open(shareUrl, "_blank", "noopener,noreferrer"); }} data-testid="ctx-public-link-open" className={ROW}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_new</span> {t("publicLink.open")}
          </button>
        </>
      )}
      <button onClick={onPassword} data-testid="ctx-public-link-password" className={ROW}>
        <span className="material-symbols-rounded" style={{ fontSize: 16 }}>password</span> {t("publicLink.password.manage")}
      </button>
      <button onClick={onDisable} data-testid="ctx-public-link-disable" className={`${ROW} text-red-400`}>
        <span className="material-symbols-rounded" style={{ fontSize: 16 }}>public_off</span> {t("publicLink.disable")}
      </button>
    </>
  );
}

/** The globe on the icon of an app that is public right now. */
export function PublicLinkBadge({ appId }: { appId: string }) {
  const { t } = useT();
  return (
    <span
      data-testid={`public-link-badge-${appId}`}
      title={t("publicLink.badge")}
      aria-label={t("publicLink.badge")}
      className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-emerald-500 ring-2 ring-black/40 flex items-center justify-center"
    >
      <span className="material-symbols-rounded text-white" aria-hidden style={{ fontSize: 13 }}>public</span>
    </span>
  );
}

const DURATIONS: { minutes: number; key: string }[] = [
  { minutes: 60, key: "publicLink.duration.1h" },
  { minutes: 24 * 60, key: "publicLink.duration.24h" },
  { minutes: 7 * 24 * 60, key: "publicLink.duration.7d" },
];

const FIELD = { background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 9, color: "rgba(255,255,255,0.9)", fontSize: 12.5, padding: "7px 10px" } as const;
const QUIET = { padding: "7px 14px", borderRadius: 9, fontSize: 12.5, cursor: "pointer", background: "rgba(255,255,255,0.08)", border: "none", color: "rgba(255,255,255,0.75)" } as const;
const PRIMARY = { padding: "7px 14px", borderRadius: 9, fontSize: 12.5, cursor: "pointer", background: "#f97316", border: "none", color: "#1c1207", fontWeight: 600 } as const;
const NOTE = { margin: 0, fontSize: 11.5, lineHeight: 1.45, color: "rgba(255,255,255,0.55)" } as const;

type Translate = (key: string, params?: Record<string, string | number>) => string;

function failureText(t: Translate, failure: PublicLinkFailure): string {
  if (failure.code === "password_too_short") return t("publicLink.password.errShort", { min: MIN_LINK_PASSWORD_LENGTH });
  if (failure.code === "password_is_system") return t("publicLink.password.errSame");
  return failure.message === "error" ? t("publicLink.error") : failure.message;
}

/**
 * Where the owner types (or generates) a NEW password for one link. It never
 * asks for the ClawBox password, and `autoComplete="new-password"` keeps the
 * browser from offering the saved one.
 */
function LinkPasswordField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useT();
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <label style={{ display: "grid", gap: 6, fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
        {t("publicLink.password.label")}
        <input
          data-testid="public-link-password-input"
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => { onChange(e.target.value); setCopied(false); }}
          maxLength={MAX_LINK_PASSWORD_LENGTH}
          autoComplete="new-password"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          style={{ ...FIELD, width: "100%", fontFamily: visible ? "ui-monospace, monospace" : undefined }}
        />
      </label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" data-testid="public-link-password-generate" onClick={() => { onChange(generateLinkPassword()); setVisible(true); setCopied(false); }} style={QUIET}>
          {t("publicLink.password.generate")}
        </button>
        <button type="button" data-testid="public-link-password-toggle" aria-pressed={visible} onClick={() => setVisible((v) => !v)} style={QUIET}>
          {t(visible ? "publicLink.password.hide" : "publicLink.password.show")}
        </button>
        <button type="button" data-testid="public-link-password-copy" disabled={!value} onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); }} style={{ ...QUIET, opacity: value ? 1 : 0.5 }}>
          {copied ? t("publicLink.copied") : t("publicLink.password.copy")}
        </button>
      </div>
      <p data-testid="public-link-password-rule" style={NOTE}>{t("publicLink.password.rule", { min: MIN_LINK_PASSWORD_LENGTH })}</p>
    </div>
  );
}

/** For a link that exists: whether it has a password, and the buttons to add, change or remove one. */
function LinkPasswordManager({
  appId,
  link,
  justSet,
  onSetPassword,
  onJustSet,
}: {
  appId: string;
  link: PublicLinkInfo;
  /** The password set in this dialog a moment ago: shown until the dialog closes, because it cannot be read back. */
  justSet: string | null;
  onSetPassword: (appId: string, password: string | null) => Promise<PublicLinkFailure | null>;
  onJustSet: (password: string | null) => void;
}) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [copied, setCopied] = useState(false);
  const isProtected = link.passwordProtected === true;

  const apply = async (password: string | null) => {
    setBusy(true);
    setError(null);
    const failure = await onSetPassword(appId, password).catch((): PublicLinkFailure => ({ message: "error" }));
    setBusy(false);
    if (failure) {
      setError(failureText(t, failure));
      return;
    }
    setChanged(password !== null && isProtected);
    onJustSet(password);
    setCopied(false);
    setEditing(false);
    setValue("");
  };

  return (
    <div data-testid="public-link-password-section" style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.1)", display: "grid", gap: 10 }}>
      <div data-testid="public-link-password-status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: isProtected ? "#6ee7b7" : "rgba(255,255,255,0.75)" }}>
        <span className="material-symbols-rounded" aria-hidden style={{ fontSize: 16 }}>{isProtected ? "lock" : "lock_open"}</span>
        {t(isProtected ? "publicLink.password.statusOn" : "publicLink.password.statusOff")}
      </div>
      {isProtected && justSet && !editing && (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input readOnly value={justSet} aria-label={t("publicLink.password.legend")} data-testid="public-link-password-value" onFocus={(e) => e.currentTarget.select()} style={{ ...FIELD, flex: 1, minWidth: 0, fontFamily: "ui-monospace, monospace" }} />
            <button type="button" data-testid="public-link-password-value-copy" onClick={() => { void navigator.clipboard?.writeText(justSet); setCopied(true); }} style={QUIET}>
              {copied ? t("publicLink.copied") : t("publicLink.password.copy")}
            </button>
          </div>
          <p data-testid="public-link-password-save-now" style={NOTE}>{t("publicLink.password.saveNow")}</p>
        </div>
      )}
      {changed && !editing && <p data-testid="public-link-password-changed" style={NOTE}>{t("publicLink.password.changedNote")}</p>}
      {editing ? (
        <>
          <LinkPasswordField value={value} onChange={(next) => { setValue(next); setError(null); }} />
          {error && <p role="alert" data-testid="public-link-password-error" style={{ margin: 0, fontSize: 12, color: "#fca5a5" }}>{error}</p>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" data-testid="public-link-password-cancel" onClick={() => { setEditing(false); setValue(""); setError(null); }} style={QUIET}>{t("cancel")}</button>
            <button type="button" data-testid="public-link-password-save" disabled={busy || value.length < MIN_LINK_PASSWORD_LENGTH} onClick={() => { void apply(value); }} style={{ ...PRIMARY, opacity: busy || value.length < MIN_LINK_PASSWORD_LENGTH ? 0.6 : 1 }}>
              {t("publicLink.password.save")}
            </button>
          </div>
        </>
      ) : (
        <>
          {error && <p role="alert" data-testid="public-link-password-error" style={{ margin: 0, fontSize: 12, color: "#fca5a5" }}>{error}</p>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" data-testid="public-link-password-edit" disabled={busy} onClick={() => { setEditing(true); setError(null); }} style={QUIET}>
              {t(isProtected ? "publicLink.password.change" : "publicLink.password.add")}
            </button>
            {isProtected && (
              <button type="button" data-testid="public-link-password-remove" disabled={busy} onClick={() => { void apply(null); }} style={{ ...QUIET, color: "#fca5a5" }}>
                {t("publicLink.password.remove")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * "Create public link": temporary or permanent, with or without a password
 * (the owner has to pick one of the two), and — closed by default — which of
 * the app's API paths visitors may use. For a link that exists: its address
 * and its password.
 */
export function PublicLinkDialog({
  open,
  appId,
  appName,
  link,
  onCreate,
  onSetPassword,
  onClose,
}: {
  open: boolean;
  appId: string;
  appName: string;
  link: PublicLinkInfo | undefined;
  onCreate: (input: PublicLinkCreateInput) => Promise<PublicLinkFailure | null>;
  onSetPassword: (appId: string, password: string | null) => Promise<PublicLinkFailure | null>;
  onClose: () => void;
}) {
  const { t } = useT();
  const panelRef = useModalDialog<HTMLDivElement>({ open, onClose });
  const [mode, setMode] = useState<"temporary" | "permanent">("temporary");
  const [minutes, setMinutes] = useState(DURATIONS[1].minutes);
  // The app's own API is open by default: a visitor of an app
  // that cannot reach its API sees a page that loads and then does nothing.
  const [apiAccess, setApiAccess] = useState<PublicLinkApiAccess>("full");
  const [api, setApi] = useState("");
  // No default: whether a link needs a password is the owner's call, every time.
  const [protection, setProtection] = useState<"none" | "password" | null>(null);
  const [password, setPassword] = useState("");
  const [justSet, setJustSet] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!open || typeof document === "undefined") return null;

  const ready = protection === "none" || (protection === "password" && password.length >= MIN_LINK_PASSWORD_LENGTH);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const apiAllow = api.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
    const withPassword = protection === "password";
    const failure = await onCreate({ appId, mode, ...(mode === "temporary" ? { ttlMinutes: minutes } : {}), apiAccess, ...(apiAllow.length ? { apiAllow } : {}), ...(withPassword ? { password } : {}) }).catch((): PublicLinkFailure => ({ message: "error" }));
    setBusy(false);
    if (failure) {
      setError(failureText(t, failure));
      return;
    }
    if (withPassword) setJustSet(password);
    setPassword("");
  };

  const field = FIELD;
  const quiet = QUIET;
  const primary = PRIMARY;

  return createPortal(
    <div onClick={onClose} data-testid="public-link-overlay" className="main-screen-scrim" style={{ position: "fixed", inset: 0, zIndex: 10020, background: "rgba(0,0,0,0.62)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("publicLink.title", { name: appName })}
        data-testid="public-link-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(440px, 100%)", maxHeight: "100%", overflowY: "auto", borderRadius: 14, background: "#1c1c22", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 8px 40px rgba(0,0,0,0.6)", padding: "18px 20px", color: "rgba(255,255,255,0.9)" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <span className="material-symbols-rounded" aria-hidden style={{ fontSize: 22, color: "#f97316" }}>public</span>
          <span style={{ fontSize: 14.5, fontWeight: 600 }}>{t("publicLink.title", { name: appName })}</span>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "rgba(255,255,255,0.7)" }}>{t("publicLink.intro")}</p>

        {link ? (
          <div style={{ marginTop: 14 }}>
            {link.url ? (
              <>
                {/* Only an address that works: a masked token is never shown to be copied by hand either. */}
                {shareableLinkUrl(link) && <input readOnly value={shareableLinkUrl(link) ?? ""} aria-label={t("publicLink.copy")} data-testid="public-link-url" onFocus={(e) => e.currentTarget.select()} style={{ ...field, width: "100%" }} />}
                {/* The note is about the address with the key in it, which only the owner is shown. */}
                {!link.tokenMasked && <p data-testid="public-link-share-note" style={{ margin: "8px 0 0", fontSize: 12, lineHeight: 1.5, color: "rgba(255,255,255,0.75)" }}>{t(link.passwordProtected ? "publicLink.shareThisAddressPassword" : "publicLink.shareThisAddress")}</p>}
                <p data-testid="public-link-address-note" style={{ margin: "6px 0 0", fontSize: 12, lineHeight: 1.5, color: "rgba(255,255,255,0.6)" }}>{t("publicLink.addressChanges")}</p>
                <p data-testid="public-link-api-status" style={{ margin: "6px 0 0", fontSize: 12, lineHeight: 1.5, color: "rgba(255,255,255,0.6)" }}>
                  {/* The app's own /api is what the choice opens; a path typed on top of "Off" does not make it "read and write". */}
                  {t(!link.apiAllow.some(opensAppApi) ? "publicLink.apiAccess.statusNone" : link.apiReadOnly ? "publicLink.apiAccess.statusRead" : "publicLink.apiAccess.statusFull")}
                </p>
              </>
            ) : (
              <p data-testid="public-link-starting" style={{ margin: 0, fontSize: 12.5, color: "rgba(255,255,255,0.8)" }}>{t("publicLink.starting")}</p>
            )}
            <LinkPasswordManager appId={appId} link={link} justSet={justSet} onSetPassword={onSetPassword} onJustSet={setJustSet} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button type="button" onClick={onClose} data-testid="public-link-close" style={quiet}>{t("publicLink.done")}</button>
              {shareableLinkUrl(link) && (
                <button
                  type="button"
                  data-testid="public-link-copy"
                  onClick={() => { void navigator.clipboard?.writeText(shareableLinkUrl(link) ?? ""); setCopied(true); }}
                  style={primary}
                >
                  {copied ? t("publicLink.copied") : t("publicLink.copy")}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
            <div role="radiogroup" aria-label={t("publicLink.create")} style={{ display: "flex", gap: 8 }}>
              {(["temporary", "permanent"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  data-testid={`public-link-mode-${m}`}
                  onClick={() => setMode(m)}
                  style={{ ...quiet, flex: 1, background: mode === m ? "rgba(249,115,22,0.22)" : quiet.background, color: mode === m ? "#fdba74" : quiet.color, outline: mode === m ? "1px solid rgba(249,115,22,0.6)" : "none" }}
                >
                  {t(m === "temporary" ? "publicLink.temporary" : "publicLink.permanent")}
                </button>
              ))}
            </div>
            {mode === "temporary" ? (
              <label style={{ display: "grid", gap: 6, fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
                {t("publicLink.duration")}
                <select data-testid="public-link-duration" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} style={field}>
                  {DURATIONS.map((d) => <option key={d.minutes} value={d.minutes}>{t(d.key)}</option>)}
                </select>
              </label>
            ) : (
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "rgba(255,255,255,0.6)" }}>{t("publicLink.permanentNote")}</p>
            )}
            <div style={{ display: "grid", gap: 8 }}>
              <span id="public-link-protection-label" style={{ fontSize: 12, color: "rgba(255,255,255,0.7)" }}>{t("publicLink.password.legend")}</span>
              <div role="radiogroup" aria-labelledby="public-link-protection-label" style={{ display: "flex", gap: 8 }}>
                {(["password", "none"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={protection === p}
                    data-testid={`public-link-protection-${p}`}
                    onClick={() => { setProtection(p); setError(null); }}
                    style={{ ...quiet, flex: 1, background: protection === p ? "rgba(249,115,22,0.22)" : quiet.background, color: protection === p ? "#fdba74" : quiet.color, outline: protection === p ? "1px solid rgba(249,115,22,0.6)" : "none" }}
                  >
                    {t(p === "password" ? "publicLink.password.require" : "publicLink.password.none")}
                  </button>
                ))}
              </div>
              {protection === null && <p data-testid="public-link-protection-choose" style={NOTE}>{t("publicLink.password.choose")}</p>}
              {protection === "none" && <p data-testid="public-link-protection-none-note" style={NOTE}>{t("publicLink.password.noneNote")}</p>}
              {protection === "password" && <LinkPasswordField value={password} onChange={(value) => { setPassword(value); setError(null); }} />}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              <span id="public-link-api-access-label" style={{ fontSize: 12, color: "rgba(255,255,255,0.7)" }}>{t("publicLink.apiAccess.legend")}</span>
              <div role="radiogroup" aria-labelledby="public-link-api-access-label" style={{ display: "flex", gap: 8 }}>
                {(["full", "read", "none"] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    role="radio"
                    aria-checked={apiAccess === a}
                    data-testid={`public-link-api-access-${a}`}
                    onClick={() => setApiAccess(a)}
                    style={{ ...quiet, flex: 1, background: apiAccess === a ? "rgba(249,115,22,0.22)" : quiet.background, color: apiAccess === a ? "#fdba74" : quiet.color, outline: apiAccess === a ? "1px solid rgba(249,115,22,0.6)" : "none" }}
                  >
                    {t(`publicLink.apiAccess.${a}`)}
                  </button>
                ))}
              </div>
              <p data-testid="public-link-api-access-note" style={NOTE}>{t(`publicLink.apiAccess.${apiAccess}Note`)}</p>
            </div>
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
              {t("publicLink.api")}
              <input data-testid="public-link-api" value={api} onChange={(e) => setApi(e.target.value)} placeholder="/api/scores" spellCheck={false} autoCapitalize="off" autoCorrect="off" style={field} />
              <span style={{ fontSize: 11.5, color: "rgba(255,255,255,0.5)", lineHeight: 1.45 }}>{t("publicLink.apiHint")}</span>
            </label>
            {error && <p role="alert" data-testid="public-link-error" style={{ margin: 0, fontSize: 12, color: "#fca5a5" }}>{error}</p>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={onClose} data-testid="public-link-cancel" style={quiet}>{t("cancel")}</button>
              <button type="button" disabled={busy || !ready} onClick={() => { void submit(); }} data-testid="public-link-submit" style={{ ...primary, opacity: busy || !ready ? 0.6 : 1 }}>
                {t("publicLink.createButton")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
