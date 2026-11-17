"use client";

import { useCallback, useEffect, useState } from "react";

import { useT } from "@/lib/i18n";
import { formatLimitBytes } from "@/lib/limit-bytes";

// Settings → System → Users: the owner's limits for every other user
// (src/lib/user-limits.ts) and how full each user's home folder is. The owner
// alone sees it — the route answers anyone else 403 and the card stays hidden.

// The route's shape, declared here rather than imported: a client component
// stays a fetch away from the server graph behind it.
type LimitName = "uploadMaxMb" | "homeQuotaMb" | "chatPerMinute" | "chatPerHour";
const LIMIT_NAMES: readonly LimitName[] = ["uploadMaxMb", "homeQuotaMb", "chatPerMinute", "chatPerHour"];
type Limits = Record<LimitName, number>;

interface UsageRow {
  username: string;
  usedBytes: number | null;
  truncated: boolean;
  quotaBytes: number | null;
}

interface LimitsStatus {
  limits: Limits;
  max: Limits;
  orgMode: boolean;
  users: UsageRow[];
}

function isLimits(v: unknown): v is Limits {
  return !!v && typeof v === "object" && LIMIT_NAMES.every((n) => typeof (v as Record<string, unknown>)[n] === "number");
}

// SHAPE-CHECKED, not cast: a body without the fields hides the card.
function isStatus(body: unknown): body is LimitsStatus {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return isLimits(b.limits) && isLimits(b.max) && typeof b.orgMode === "boolean" && Array.isArray(b.users);
}

const URL_ = "/setup-api/settings/user-limits";
const MB = 1024 * 1024;

const LABEL_KEYS: Record<LimitName, string> = {
  uploadMaxMb: "users.limits.uploadMax",
  homeQuotaMb: "users.limits.homeQuota",
  chatPerMinute: "users.limits.chatPerMinute",
  chatPerHour: "users.limits.chatPerHour",
};

export default function UserLimitsCard() {
  const { t } = useT();
  const [status, setStatus] = useState<LimitsStatus | null>(null);
  // What the owner typed, per field, before it is saved.
  const [draft, setDraft] = useState<Record<LimitName, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: "saved" | "failed"; detail?: string } | null>(null);
  // The first read failed for a reason other than "not yours" (403/401):
  // said, with a retry, rather than hidden as if the owner could not see it.
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const accept = useCallback((body: LimitsStatus) => {
    setStatus(body);
    setDraft(Object.fromEntries(LIMIT_NAMES.map((n) => [n, String(body.limits[n])])) as Record<LimitName, string>);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(URL_, { cache: "no-store" });
        if (!alive) return;
        // Not the owner's session: nothing to draw, the card stays hidden —
        // a failure line from an earlier attempt included.
        if (r.status === 401 || r.status === 403) {
          setLoadFailed(false);
          return;
        }
        const body: unknown = r.ok ? await r.json().catch(() => null) : null;
        if (!alive) return;
        if (isStatus(body)) {
          setLoadFailed(false);
          accept(body);
        } else {
          setLoadFailed(true);
        }
      } catch {
        if (alive) setLoadFailed(true);
      }
    })();
    return () => { alive = false; };
  }, [accept, attempt]);

  if (loadFailed && !status) {
    return (
      <div className="rounded-xl border border-white/10 p-4 space-y-2" data-testid="user-limits">
        <h4 className="text-sm font-semibold text-white">{t("users.limits.title")}</h4>
        <p className="text-xs text-[var(--amber-ink)]" role="alert" data-testid="user-limits-load-failed">{t("users.limits.loadFailed")}</p>
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          className="px-3 h-8 rounded-lg text-xs text-white bg-white/10 hover:bg-white/15 cursor-pointer"
          data-testid="user-limits-retry"
        >
          {t("users.staffMcp.retry")}
        </button>
      </div>
    );
  }
  if (!status || !draft) return null;

  const parsed = (name: LimitName): number | null => {
    const raw = draft[name].trim();
    if (!/^\d{1,9}$/.test(raw)) return null;
    const n = Number(raw);
    return n <= status.max[name] ? n : null;
  };
  const invalid = LIMIT_NAMES.filter((n) => parsed(n) === null);
  const changed = LIMIT_NAMES.some((n) => parsed(n) !== status.limits[n]);

  async function save() {
    if (!status || invalid.length > 0) return;
    setBusy(true);
    setNotice(null);
    try {
      // Only what the owner changed: a field they left alone keeps whatever
      // another window may have saved meanwhile.
      const patch = Object.fromEntries(LIMIT_NAMES.filter((n) => parsed(n) !== status.limits[n]).map((n) => [n, parsed(n)]));
      const r = await fetch(URL_, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body: unknown = await r.json().catch(() => null);
      if (r.ok && isStatus(body)) {
        accept(body);
        setNotice({ type: "saved" });
      } else {
        const error = (body as { error?: unknown } | null)?.error;
        setNotice({ type: "failed", detail: typeof error === "string" ? error : undefined });
      }
    } catch {
      setNotice({ type: "failed" });
    } finally {
      setBusy(false);
    }
  }

  // A value as a person reads it beside its field: "100 MB", "10 GB", "no limit".
  const shown = (name: LimitName): string => {
    const n = parsed(name);
    if (n === null) return t("users.limits.invalid", { max: status.max[name] });
    if (n === 0) return t("users.limits.unlimited");
    return name === "uploadMaxMb" || name === "homeQuotaMb" ? formatLimitBytes(n * MB) : "";
  };

  const usage = (row: UsageRow): string => {
    if (row.usedBytes === null) return t("users.limits.usageUnknown");
    const used = row.truncated ? t("users.limits.atLeast", { size: formatLimitBytes(row.usedBytes) }) : formatLimitBytes(row.usedBytes);
    return row.quotaBytes === null ? t("users.limits.usageNoQuota", { used }) : t("users.limits.usage", { used, quota: formatLimitBytes(row.quotaBytes) });
  };

  const inputClass = "w-28 h-9 px-3 bg-white/[0.06] border border-white/10 rounded-lg text-sm text-white outline-none focus:border-[var(--coral-bright)] focus:bg-white/[0.08] transition-colors";

  return (
    <div className="rounded-xl border border-white/10 p-4 space-y-3" data-testid="user-limits">
      <div>
        <h4 className="text-sm font-semibold text-white">{t("users.limits.title")}</h4>
        <p className="text-xs text-white/60 mt-1 leading-relaxed">{t("users.limits.hint")}</p>
      </div>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {LIMIT_NAMES.map((name) => {
          const bad = parsed(name) === null;
          return (
            <label key={name} className="flex items-center gap-3 text-xs text-white/80">
              <span className="flex-1 min-w-0">{t(LABEL_KEYS[name])}</span>
              <input
                type="text"
                inputMode="numeric"
                value={draft[name]}
                onChange={(e) => {
                  setDraft({ ...draft, [name]: e.target.value });
                  setNotice(null);
                }}
                aria-invalid={bad}
                // Held while a save is on its way: what comes back replaces
                // the fields, and a value typed meanwhile would be lost.
                disabled={busy}
                data-testid={`user-limits-${name}`}
                className={`${inputClass} disabled:opacity-60 ${bad ? "border-red-400/70" : ""}`}
              />
              <span className={`w-24 shrink-0 text-[11px] ${bad ? "text-red-400" : "text-white/45"}`}>{shown(name)}</span>
            </label>
          );
        })}
        {!status.orgMode && <p className="text-[11px] text-white/45 leading-relaxed">{t("users.limits.quotaOrgOnly")}</p>}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy || !changed || invalid.length > 0}
            data-testid="user-limits-save"
            className="px-3 h-8 rounded-lg text-xs font-medium text-white btn-gradient cursor-pointer disabled:opacity-50"
          >
            {busy ? t("users.resetting") : t("users.limits.save")}
          </button>
          {notice?.type === "saved" && <span className="text-[11px] text-white/70" role="status" data-testid="user-limits-saved">{t("users.limits.saved")}</span>}
          {notice?.type === "failed" && (
            <span className="text-[11px] text-[var(--amber-ink)]" role="alert" data-testid="user-limits-failed">
              {t("users.limits.failed")}
              {notice.detail ? ` ${notice.detail}` : ""}
            </span>
          )}
        </div>
      </form>
      <div className="space-y-1.5" data-testid="user-limits-usage">
        <h5 className="text-xs font-semibold uppercase tracking-wider text-white/50">{t("users.limits.usageTitle")}</h5>
        {status.users.length === 0 && <p className="text-[11px] text-white/45">{t("users.limits.noUsers")}</p>}
        {status.users.map((row) => {
          const fraction = row.usedBytes !== null && row.quotaBytes ? Math.min(1, row.usedBytes / row.quotaBytes) : null;
          return (
            <div key={row.username} className="text-xs" data-testid={`user-limits-usage-${row.username}`}>
              <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate text-white/85">{row.username}</span>
                <span className={`text-[11px] ${fraction !== null && fraction >= 1 ? "text-[var(--amber-ink)]" : "text-white/55"}`}>{usage(row)}</span>
              </div>
              {fraction !== null && (
                <div className="mt-1 h-1 rounded-full bg-white/10 overflow-hidden" aria-hidden="true">
                  <div
                    className={`h-full rounded-full ${fraction >= 0.9 ? "bg-[var(--amber-ink)]" : "bg-[var(--coral-bright)]"}`}
                    style={{ width: `${Math.max(2, Math.round(fraction * 100))}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
