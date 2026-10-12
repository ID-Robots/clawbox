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
  state: "starting" | "live" | "restarting" | "offline";
  url: string | null;
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

  const create = useCallback(async (input: { appId: string; mode: "temporary" | "permanent"; ttlMinutes?: number; apiAllow?: string[] }): Promise<string | null> => {
    const res = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    if (!res.ok) {
      const body = await readJson(res);
      return typeof body.error === "string" ? body.error : "error";
    }
    await refresh();
    return null;
  }, [refresh]);

  const disable = useCallback(async (appId: string): Promise<boolean> => {
    const res = await fetch(ENDPOINT, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId }) });
    await refresh();
    return res.ok;
  }, [refresh]);

  return { links, refresh, create, disable };
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
}: {
  link: PublicLinkInfo | undefined;
  onCreate: () => void;
  onDisable: () => void;
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
  return (
    <>
      <div data-testid="ctx-public-link-status" className="px-4 py-1.5 text-xs text-emerald-300/90 font-medium flex items-center gap-2">
        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>public</span>
        {url ? statusLine(t, link, locale) : t("publicLink.starting")}
      </div>
      {url && (
        <>
          <button onClick={() => { void navigator.clipboard?.writeText(url); }} data-testid="ctx-public-link-copy" className={ROW}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>content_copy</span> {t("publicLink.copy")}
          </button>
          <button onClick={() => { window.open(url, "_blank", "noopener,noreferrer"); }} data-testid="ctx-public-link-open" className={ROW}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_new</span> {t("publicLink.open")}
          </button>
        </>
      )}
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

/** "Create public link": temporary or permanent, and — closed by default — which of the app's API paths visitors may use. */
export function PublicLinkDialog({
  open,
  appId,
  appName,
  link,
  onCreate,
  onClose,
}: {
  open: boolean;
  appId: string;
  appName: string;
  link: PublicLinkInfo | undefined;
  onCreate: (input: { appId: string; mode: "temporary" | "permanent"; ttlMinutes?: number; apiAllow?: string[] }) => Promise<string | null>;
  onClose: () => void;
}) {
  const { t } = useT();
  const panelRef = useModalDialog<HTMLDivElement>({ open, onClose });
  const [mode, setMode] = useState<"temporary" | "permanent">("temporary");
  const [minutes, setMinutes] = useState(DURATIONS[1].minutes);
  const [api, setApi] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!open || typeof document === "undefined") return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const apiAllow = api.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
    const failure = await onCreate({ appId, mode, ...(mode === "temporary" ? { ttlMinutes: minutes } : {}), ...(apiAllow.length ? { apiAllow } : {}) }).catch(() => "error");
    setBusy(false);
    if (failure) setError(failure === "error" ? t("publicLink.error") : failure);
  };

  const field = { background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 9, color: "rgba(255,255,255,0.9)", fontSize: 12.5, padding: "7px 10px" } as const;
  const quiet = { padding: "7px 14px", borderRadius: 9, fontSize: 12.5, cursor: "pointer", background: "rgba(255,255,255,0.08)", border: "none", color: "rgba(255,255,255,0.75)" } as const;
  const primary = { padding: "7px 14px", borderRadius: 9, fontSize: 12.5, cursor: "pointer", background: "#f97316", border: "none", color: "#1c1207", fontWeight: 600 } as const;

  return createPortal(
    <div onClick={onClose} data-testid="public-link-overlay" style={{ position: "fixed", inset: 0, zIndex: 10020, background: "rgba(0,0,0,0.62)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("publicLink.title", { name: appName })}
        data-testid="public-link-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(440px, 100%)", borderRadius: 14, background: "#1c1c22", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 8px 40px rgba(0,0,0,0.6)", padding: "18px 20px", color: "rgba(255,255,255,0.9)" }}
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
                <input readOnly value={link.url} data-testid="public-link-url" onFocus={(e) => e.currentTarget.select()} style={{ ...field, width: "100%" }} />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
                  <button type="button" onClick={onClose} data-testid="public-link-close" style={quiet}>{t("publicLink.done")}</button>
                  <button
                    type="button"
                    data-testid="public-link-copy"
                    onClick={() => { void navigator.clipboard?.writeText(link.url ?? ""); setCopied(true); }}
                    style={primary}
                  >
                    {copied ? t("publicLink.copied") : t("publicLink.copy")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p data-testid="public-link-starting" style={{ margin: 0, fontSize: 12.5, color: "rgba(255,255,255,0.8)" }}>{t("publicLink.starting")}</p>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
                  <button type="button" onClick={onClose} data-testid="public-link-close" style={quiet}>{t("publicLink.done")}</button>
                </div>
              </>
            )}
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
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
              {t("publicLink.api")}
              <input data-testid="public-link-api" value={api} onChange={(e) => setApi(e.target.value)} placeholder="/api/scores" spellCheck={false} autoCapitalize="off" autoCorrect="off" style={field} />
              <span style={{ fontSize: 11.5, color: "rgba(255,255,255,0.5)", lineHeight: 1.45 }}>{t("publicLink.apiHint")}</span>
            </label>
            {error && <p role="alert" data-testid="public-link-error" style={{ margin: 0, fontSize: 12, color: "#fca5a5" }}>{error}</p>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={onClose} data-testid="public-link-cancel" style={quiet}>{t("cancel")}</button>
              <button type="button" disabled={busy} onClick={() => { void submit(); }} data-testid="public-link-submit" style={{ ...primary, opacity: busy ? 0.6 : 1 }}>
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
