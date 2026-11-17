"use client";

import { useCallback, useEffect, useState } from "react";

import { useT } from "@/lib/i18n";

// Settings → System → Users: the box's audit log — sign-ins and administrator
// actions, newest first (src/lib/audit-log.ts). The owner alone reads it: the
// route answers anyone else 403 and the card stays hidden. Read-only; nothing
// on the box edits or deletes an entry.

// The route's shape, declared here rather than imported.
interface Entry {
  ts: string;
  event: string;
  actor: string | null;
  target?: string;
  ip?: string;
  detail?: Record<string, string | number | boolean | null>;
}

function isEntry(v: unknown): v is Entry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.ts === "string" && typeof e.event === "string" && (e.actor === null || typeof e.actor === "string");
}

const URL_ = "/setup-api/settings/audit-log";
const PAGE = 100;
const MAX = 1000;

/** The events the log can hold, each with its own line (`users.audit.event.<camelCased event>`). */
const EVENTS = new Set([
  "login", "login_failed", "logout", "user_create", "user_remove", "user_password_reset", "password_change",
  "owner_password_change", "org_mode", "openclaw_sharing", "user_limits", "factory_reset", "update_start", "harness_swap",
]);

/** `login_failed` → `loginFailed`: catalogue keys are camelCase. */
function camel(event: string): string {
  return event.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

export default function AuditLogCard() {
  const { t, locale } = useT();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [more, setMore] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (want: number) => {
    setLoading(true);
    try {
      const r = await fetch(`${URL_}?limit=${want}`, { cache: "no-store" });
      if (r.status === 403 || r.status === 401) {
        setHidden(true);
        return;
      }
      const body: unknown = await r.json().catch(() => null);
      const list = (body as { entries?: unknown } | null)?.entries;
      if (!r.ok || !Array.isArray(list)) {
        setFailed(true);
        return;
      }
      setFailed(false);
      setEntries(list.filter(isEntry));
      setMore((body as { more?: unknown }).more === true);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(limit);
  }, [load, limit]);

  if (hidden || (entries === null && !failed)) return null;

  const when = (ts: string): string => {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    try {
      return d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "medium" });
    } catch {
      return d.toLocaleString();
    }
  };

  // The one fact a line needs beyond who and what: a switch's new state, the
  // limits set, a runtime's from → to, a sign-in from outside or locked out.
  const detail = (e: Entry): string => {
    const d = e.detail ?? {};
    const parts: string[] = [];
    if (e.event === "org_mode" || e.event === "openclaw_sharing") {
      if (typeof d.on === "boolean") parts.push(t(d.on ? "users.audit.on" : "users.audit.off"));
    } else if (e.event === "user_limits") {
      const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : null);
      if ([n("uploadMaxMb"), n("homeQuotaMb"), n("chatPerMinute"), n("chatPerHour")].every((v) => v !== null)) {
        parts.push(t("users.audit.limitsDetail", { upload: n("uploadMaxMb")!, quota: n("homeQuotaMb")!, perMinute: n("chatPerMinute")!, perHour: n("chatPerHour")! }));
      }
    } else if (e.event === "harness_swap") {
      if (typeof d.from === "string" && typeof d.to === "string") parts.push(`${d.from} → ${d.to}`);
    }
    if (d.remote === true) parts.push(t("users.audit.remote"));
    if (d.locked === true) parts.push(t("users.audit.locked"));
    return parts.join(" · ");
  };

  return (
    <div className="rounded-xl border border-white/10 p-4 space-y-3" data-testid="audit-log">
      <div className="flex items-start gap-3">
        <span className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-white">{t("users.audit.title")}</h4>
          <p className="text-xs text-white/60 mt-1 leading-relaxed">{t("users.audit.hint")}</p>
        </span>
        <button
          type="button"
          onClick={() => void load(limit)}
          disabled={loading}
          data-testid="audit-log-refresh"
          className="shrink-0 px-3 h-8 rounded-lg text-xs text-white bg-white/10 hover:bg-white/15 cursor-pointer disabled:opacity-50"
        >
          {t("users.audit.refresh")}
        </button>
      </div>
      {failed && <p className="text-[11px] text-[var(--amber-ink)]" role="alert" data-testid="audit-log-failed">{t("users.audit.failed")}</p>}
      {entries && entries.length === 0 && <p className="text-[11px] text-white/45" data-testid="audit-log-empty">{t("users.audit.empty")}</p>}
      {entries && entries.length > 0 && (
        <ul className="max-h-96 overflow-y-auto divide-y divide-white/5 -mx-1" data-testid="audit-log-entries">
          {entries.map((e, i) => {
            const extra = detail(e);
            return (
              <li key={`${e.ts}-${i}`} className="px-1 py-1.5 text-xs" data-testid="audit-log-entry" data-event={e.event}>
                <div className="flex items-baseline gap-2">
                  <span className={`flex-1 min-w-0 ${e.event === "login_failed" ? "text-[var(--amber-ink)]" : "text-white/85"}`}>
                    {EVENTS.has(e.event) ? t(`users.audit.event.${camel(e.event)}`) : e.event}
                    {e.target ? <span className="text-white/60"> · {e.target}</span> : null}
                    {extra ? <span className="text-white/45"> · {extra}</span> : null}
                  </span>
                  <time className="shrink-0 text-[11px] text-white/40" dateTime={e.ts}>{when(e.ts)}</time>
                </div>
                <div className="text-[11px] text-white/45">
                  {e.actor ?? t("users.audit.nobody")}
                  {e.ip ? ` · ${t("users.audit.from", { address: e.ip })}` : ""}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {more && limit < MAX && (
        <button
          type="button"
          onClick={() => setLimit((n) => Math.min(MAX, n + PAGE * 2))}
          disabled={loading}
          data-testid="audit-log-more"
          className="px-3 h-8 rounded-lg text-xs text-white bg-white/10 hover:bg-white/15 cursor-pointer disabled:opacity-50"
        >
          {t("users.audit.more")}
        </button>
      )}
    </div>
  );
}
