"use client";

// Settings → Email → Send approved drafts.
//
// Where an e-mail draft the person approved in the chat is sent from: the
// address of the send service on this ClawBox and the one header ClawBox
// authenticates to it with (src/lib/mail-draft-approval-config.ts). The
// owner's alone — the route answers anyone else 403, and this panel then draws
// nothing. The header value is write-only: once saved, the panel only knows
// that there is one.

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";

const ROUTE = "/setup-api/email/draft-approval";

/** Examples, not words: a header name and the shape of a bearer value are the same in every language. */
const AUTH_HEADER_EXAMPLE = "Authorization";
const AUTH_VALUE_EXAMPLE = "Bearer …";
const SAVED_VALUE_MASK = "••••••••";

interface Snapshot {
  enabled: boolean;
  endpoint: string | null;
  authHeader: string;
  hasAuth: boolean;
  active: boolean;
}

type Note = { kind: "ok" | "error"; text: string } | null;

function isSnapshot(value: unknown): value is Snapshot {
  const v = value as Partial<Snapshot> | null;
  return typeof v === "object" && v !== null && typeof v.enabled === "boolean" && typeof v.authHeader === "string";
}

export default function MailDraftApprovalPanel() {
  const { t } = useT();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [authHeader, setAuthHeader] = useState("");
  const [authValue, setAuthValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  const adopt = useCallback((next: Snapshot) => {
    setSnapshot(next);
    setEndpoint(next.endpoint ?? "");
    setAuthHeader(next.authHeader);
    setAuthValue("");
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch(ROUTE, { cache: "no-store" });
        if (!res.ok) return;
        const json: unknown = await res.json();
        if (live && isSnapshot(json)) adopt(json);
      } catch {
        // No panel without an answer: a member of staff, or a box without the route.
      }
    })();
    return () => { live = false; };
  }, [adopt]);

  const send = useCallback(async (method: "POST" | "DELETE", body?: Record<string, unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(ROUTE, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setNote({ kind: "error", text: t("settings.email.draftApproval.failed", { error: typeof json.error === "string" ? json.error : String(res.status) }) });
        return null;
      }
      return json;
    } catch {
      setNote({ kind: "error", text: t("settings.email.draftApproval.failed", { error: "network" }) });
      return null;
    } finally {
      setBusy(false);
    }
  }, [t]);

  const save = useCallback(async (enabled?: boolean) => {
    const body: Record<string, unknown> = {
      endpoint: endpoint.trim() || null,
      authHeader: authHeader.trim() || null,
    };
    if (authValue.trim()) body.authValue = authValue.trim();
    if (enabled !== undefined) body.enabled = enabled;
    const json = await send("POST", body);
    if (json && isSnapshot(json)) {
      adopt(json);
      setNote({ kind: "ok", text: t("settings.email.draftApproval.saved") });
    }
  }, [endpoint, authHeader, authValue, send, adopt, t]);

  const test = useCallback(async () => {
    const json = await send("POST", { action: "test" });
    if (!json) return;
    const result = json.result;
    if (result === "ok") setNote({ kind: "ok", text: t("settings.email.draftApproval.testOk") });
    else if (result === "auth") setNote({ kind: "error", text: t("settings.email.draftApproval.testAuth") });
    else if (result === "unreachable") setNote({ kind: "error", text: t("settings.email.draftApproval.testUnreachable") });
    else setNote({ kind: "error", text: t("settings.email.draftApproval.testBad") });
  }, [send, t]);

  const remove = useCallback(async () => {
    const json = await send("DELETE");
    if (json && isSnapshot(json)) adopt(json);
  }, [send, adopt]);

  if (!snapshot) return null;

  // Locked while a request is on its way: the answer to a save or a remove
  // replaces these fields with what the server holds, so a word typed
  // meanwhile (a new credential above all) would be thrown away unsaved.
  const inputClass =
    "w-full px-4 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06] text-sm text-[var(--text-primary)] outline-none focus:border-[var(--coral-bright)]/50 disabled:opacity-60 disabled:cursor-not-allowed";

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid="settings-email-draft-approval">
      <div className="flex items-center gap-2 mb-2">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">outgoing_mail</span>
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.email.draftApproval.title")}</h3>
      </div>
      <p className="text-xs text-[var(--text-secondary)] mb-4">{t("settings.email.draftApproval.desc")}</p>

      <div className="space-y-3">
        <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3.5">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              data-testid="settings-email-draft-approval-toggle"
              checked={snapshot.enabled}
              disabled={busy || (!snapshot.endpoint && !endpoint.trim())}
              onChange={(e) => { void save(e.target.checked); }}
              className="mt-0.5 accent-[var(--coral-bright)]"
            />
            <span className="block text-sm text-[var(--text-primary)] font-medium">{t("settings.email.draftApproval.enabled")}</span>
          </label>
        </div>

        <label className="block">
          <span className="block text-xs text-[var(--text-secondary)] mb-1">{t("settings.email.draftApproval.endpoint")}</span>
          <input
            type="url"
            data-testid="settings-email-draft-approval-endpoint"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            disabled={busy}
            placeholder="http://127.0.0.1:8790"
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
          <span className="block text-[11px] text-[var(--text-muted)] mt-1">{t("settings.email.draftApproval.endpointHint")}</span>
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
          <label className="block">
            <span className="block text-xs text-[var(--text-secondary)] mb-1">{t("settings.email.draftApproval.authHeader")}</span>
            <input
              type="text"
              data-testid="settings-email-draft-approval-auth-header"
              value={authHeader}
              onChange={(e) => setAuthHeader(e.target.value)}
              disabled={busy}
              placeholder={AUTH_HEADER_EXAMPLE}
              autoComplete="off"
              spellCheck={false}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="block text-xs text-[var(--text-secondary)] mb-1">{t("settings.email.draftApproval.authValue")}</span>
            <input
              type="password"
              data-testid="settings-email-draft-approval-auth-value"
              value={authValue}
              onChange={(e) => setAuthValue(e.target.value)}
              disabled={busy}
              placeholder={snapshot.hasAuth ? SAVED_VALUE_MASK : AUTH_VALUE_EXAMPLE}
              autoComplete="off"
              className={inputClass}
            />
            {snapshot.hasAuth && (
              <span className="block text-[11px] text-[var(--text-muted)] mt-1">{t("settings.email.draftApproval.authValueSaved")}</span>
            )}
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="settings-email-draft-approval-save"
            onClick={() => { void save(); }}
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-[var(--coral-bright)] hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold text-white transition-colors border-none cursor-pointer"
          >
            {t("settings.email.draftApproval.save")}
          </button>
          <button
            type="button"
            data-testid="settings-email-draft-approval-test"
            onClick={() => { void test(); }}
            disabled={busy || !snapshot.endpoint}
            className="px-4 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-50 disabled:cursor-not-allowed text-sm text-[var(--text-primary)] transition-colors border border-white/[0.1] cursor-pointer"
          >
            {t("settings.email.draftApproval.test")}
          </button>
          {(snapshot.endpoint || snapshot.hasAuth) && (
            <button
              type="button"
              data-testid="settings-email-draft-approval-remove"
              onClick={() => { void remove(); }}
              disabled={busy}
              className="text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-none cursor-pointer disabled:opacity-50 px-0"
            >
              {t("settings.email.draftApproval.remove")}
            </button>
          )}
        </div>

        {note && (
          <p
            role="status"
            data-testid="settings-email-draft-approval-note"
            className={note.kind === "ok" ? "text-xs text-emerald-300/90" : "text-xs text-red-300/90"}
          >
            {note.text}
          </p>
        )}
      </div>
    </div>
  );
}
