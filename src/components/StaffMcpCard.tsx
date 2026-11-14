"use client";

// Settings → System → Users: the MCP servers members of staff may use on an
// organisation box, each with that person's own credential (TASK-2377,
// src/lib/staff-mcp.ts). Owner only — the route refuses anyone else, and the
// Users tab is drawn for the owner alone. A credential is write-only here:
// the route answers it masked (`••••abcd`), never in clear.

import { useCallback, useEffect, useRef, useState } from "react";
import StatusMessage from "./StatusMessage";
import { useT } from "@/lib/i18n";

interface ServerRow {
  name: string;
  transport: string | null;
  usable: boolean;
  reason?: string;
  granted: boolean;
  header: string;
}

interface StaffMcpView {
  orgMode: boolean;
  staffMcpSupported: boolean;
  servers: ServerRow[];
  users: Array<{ username: string; credentials: Record<string, string> }>;
  /** False when the change was saved but the assistant's configuration could not be updated. */
  applied?: boolean;
}

const REASON_KEYS: Record<string, string> = {
  transport: "users.staffMcp.reason.transport",
  urlCredential: "users.staffMcp.reason.urlCredential",
  unusable: "users.staffMcp.reason.unusable",
  missing: "users.staffMcp.reason.missing",
  insecure: "users.staffMcp.reason.insecure",
};

function parseView(data: unknown): StaffMcpView | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Partial<StaffMcpView>;
  if (!Array.isArray(d.servers) || !Array.isArray(d.users)) return null;
  return { orgMode: d.orgMode === true, staffMcpSupported: d.staffMcpSupported !== false, servers: d.servers, users: d.users, applied: d.applied };
}

/** The granted list as the server holds it: `{ name: header }`. */
function grantsOf(view: StaffMcpView): Record<string, string> {
  const map: Record<string, string> = {};
  for (const server of view.servers) if (server.granted) map[server.name] = server.header || "Authorization";
  return map;
}

export default function StaffMcpCard({ users, orgMode }: { users: string[]; orgMode: boolean }) {
  const { t } = useT();
  const [view, setView] = useState<StaffMcpView | null>(null);
  const [granted, setGranted] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notApplied, setNotApplied] = useState(false);

  /**
   * The server's view. The grant DRAFT follows it only when it holds no
   * unsaved edit (or the grants themselves were just saved), so saving a
   * member's credential never throws away a grant being edited.
   */
  const viewRef = useRef<StaffMcpView | null>(null);
  const adopt = useCallback((next: StaffMcpView, replaceDraft: boolean) => {
    const prev = viewRef.current;
    viewRef.current = next;
    setView(next);
    setGranted((draft) => (replaceDraft || !prev || JSON.stringify(draft) === JSON.stringify(grantsOf(prev)) ? grantsOf(next) : draft));
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/settings/staff-mcp", { cache: "no-store" });
      const parsed = parseView(await res.json().catch(() => null));
      // A box whose route refuses (another user, an old server) shows nothing;
      // a read that failed says so and offers a retry.
      if (res.status === 403 || res.status === 404) return;
      if (res.ok && parsed) {
        setLoadFailed(false);
        adopt(parsed, false);
      } else {
        setLoadFailed(true);
      }
    } catch {
      setLoadFailed(true);
    }
  }, [adopt]);

  // Re-read when the users or the switch change: a new user gets a row.
  const usersKey = users.join("\n");
  useEffect(() => { void load(); }, [load, usersKey, orgMode]);

  const post = async (key: string, body: unknown) => {
    setBusy(key);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch("/setup-api/settings/staff-mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      const parsed = parseView(data);
      if (!res.ok || !parsed) {
        // The catalogue's sentence, and the route's own reason under it.
        const detail = (data as { error?: unknown } | null)?.error;
        setError(typeof detail === "string" ? `${t("users.staffMcp.failed")} ${detail}` : t("users.staffMcp.failed"));
        return false;
      }
      adopt(parsed, key === "grants");
      setNotApplied(parsed.applied === false);
      setSaved(key);
      return true;
    } catch {
      setError(t("users.staffMcp.failed"));
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!view) {
    if (!loadFailed) return null;
    return (
      <div className="bg-white/5 rounded-xl p-5 space-y-2" data-testid="staff-mcp-card">
        <h4 className="text-sm font-semibold text-white">{t("users.staffMcp.title")}</h4>
        <StatusMessage type="error" message={t("users.staffMcp.loadFailed")} />
        <button type="button" onClick={() => void load()} className="px-3 h-8 rounded-lg text-xs text-white bg-white/10 hover:bg-white/15 cursor-pointer" data-testid="staff-mcp-retry">
          {t("users.staffMcp.retry")}
        </button>
      </div>
    );
  }

  const grantedServers = view.servers.filter((s) => s.granted);
  const inputClass = "h-8 px-2 bg-white/[0.06] border border-white/10 rounded-lg text-xs text-white outline-none focus:border-[var(--coral-bright)] transition-colors";
  const dirty = JSON.stringify(granted) !== JSON.stringify(Object.fromEntries(grantedServers.map((s) => [s.name, s.header])));

  return (
    <div className="bg-white/5 rounded-xl p-5 space-y-3" data-testid="staff-mcp-card">
      <div>
        <h4 className="text-sm font-semibold text-white">{t("users.staffMcp.title")}</h4>
        <p className="text-xs text-white/60 mt-1 leading-relaxed">{t("users.staffMcp.hint")}</p>
        {!orgMode && <p className="text-[11px] text-white/45 mt-1">{t("users.staffMcp.orgOff")}</p>}
      </div>

      {!view.staffMcpSupported && (
        <p className="text-xs text-amber-100/90" data-testid="staff-mcp-hermes">{t("users.staffMcp.hermes")}</p>
      )}

      {view.staffMcpSupported && view.servers.length === 0 && (
        <p className="text-xs text-white/50" data-testid="staff-mcp-none">{t("users.staffMcp.none")}</p>
      )}

      {view.staffMcpSupported && view.servers.length > 0 && (
        <ul className="space-y-2" data-testid="staff-mcp-servers">
          {view.servers.map((server) => {
            // Own properties only: a server named `constructor` is not "granted" by Object's prototype.
            const on = Object.hasOwn(granted, server.name);
            const offerable = server.usable || server.granted;
            return (
              <li key={server.name} className="rounded-lg border border-white/10 p-3">
                <label className={`flex items-center gap-2 text-xs ${offerable ? "text-white cursor-pointer" : "text-white/40"}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!offerable || busy !== null}
                    onChange={(e) => {
                      const next = { ...granted };
                      if (e.target.checked) next[server.name] = server.header || "Authorization";
                      else delete next[server.name];
                      setGranted(next);
                    }}
                    data-testid={`staff-mcp-grant-${server.name}`}
                  />
                  <span>{t("users.staffMcp.allow", { name: server.name })}</span>
                </label>
                {!server.usable && server.reason && (
                  <p className="text-[11px] text-white/45 mt-1 ml-6">
                    {t("users.staffMcp.notUsable", { reason: t(REASON_KEYS[server.reason] ?? "users.staffMcp.reason.unusable") })}
                  </p>
                )}
                {on && (
                  <label className="flex items-center gap-2 mt-2 ml-6 text-[11px] text-white/60">
                    {t("users.staffMcp.header")}
                    <input
                      type="text"
                      value={granted[server.name]}
                      maxLength={64}
                      spellCheck={false}
                      onChange={(e) => setGranted({ ...granted, [server.name]: e.target.value.trim() })}
                      className={`${inputClass} w-40`}
                      data-testid={`staff-mcp-header-${server.name}`}
                    />
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {view.staffMcpSupported && view.servers.length > 0 && (
        <button
          type="button"
          disabled={!dirty || busy !== null}
          onClick={() => void post("grants", { servers: Object.fromEntries(Object.entries(granted).map(([name, header]) => [name, { header }])) })}
          className="px-3 h-8 rounded-lg text-xs font-medium text-white btn-gradient cursor-pointer disabled:opacity-50"
          data-testid="staff-mcp-save-grants"
        >
          {busy === "grants" ? t("users.staffMcp.saving") : t("users.staffMcp.save")}
        </button>
      )}

      {view.staffMcpSupported && grantedServers.length > 0 && (
        <div className="space-y-2" data-testid="staff-mcp-credentials">
          <h5 className="text-xs font-semibold uppercase tracking-wider text-white/50">{t("users.staffMcp.credentials")}</h5>
          {view.users.length === 0 && <p className="text-xs text-white/50">{t("users.staffMcp.noUsers")}</p>}
          {view.users.flatMap((user) =>
            grantedServers.map((server) => {
              const key = `${user.username}\n${server.name}`;
              const masked = user.credentials[server.name];
              return (
                <div key={key} className="flex flex-wrap items-center gap-2 text-xs" data-testid={`staff-mcp-cred-${user.username}-${server.name}`}>
                  <span className="text-white min-w-[9rem]">{t("users.staffMcp.credentialFor", { user: user.username, server: server.name })}</span>
                  <span className={`text-[11px] ${masked ? "text-emerald-300" : "text-white/40"}`}>{masked ?? t("users.staffMcp.notSet")}</span>
                  <input
                    type="password"
                    value={drafts[key] ?? ""}
                    placeholder={t("users.staffMcp.placeholder")}
                    aria-label={t("users.staffMcp.credentialFor", { user: user.username, server: server.name })}
                    autoComplete="off"
                    maxLength={4096}
                    onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })}
                    className={`${inputClass} flex-1 min-w-[8rem]`}
                    data-testid={`staff-mcp-cred-input-${user.username}-${server.name}`}
                  />
                  <button
                    type="button"
                    disabled={!(drafts[key] ?? "").trim() || busy !== null}
                    onClick={() => void post(key, { username: user.username, server: server.name, credential: drafts[key] }).then((ok) => {
                      if (ok) setDrafts((d) => ({ ...d, [key]: "" }));
                    })}
                    className="px-2.5 h-8 rounded-lg text-xs text-white bg-white/10 hover:bg-white/15 cursor-pointer disabled:opacity-50"
                    data-testid={`staff-mcp-cred-save-${user.username}-${server.name}`}
                  >
                    {t("users.staffMcp.set")}
                  </button>
                  {masked && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void post(key, { username: user.username, server: server.name, credential: null })}
                      className="px-2.5 h-8 rounded-lg text-xs text-red-300 bg-red-500/10 hover:bg-red-500/20 cursor-pointer disabled:opacity-50"
                    >
                      {t("users.staffMcp.clear")}
                    </button>
                  )}
                  {saved === key && <span className="text-[11px] text-emerald-300">{t("users.staffMcp.saved")}</span>}
                </div>
              );
            }),
          )}
        </div>
      )}

      {(saved === "grants" || saved === "apply-retry") && !notApplied && <StatusMessage type="success" message={t("users.staffMcp.saved")} />}
      {notApplied && (
        <div className="space-y-2" data-testid="staff-mcp-not-applied">
          <StatusMessage type="error" message={t("users.staffMcp.notApplied")} />
          <button
            type="button"
            disabled={busy !== null}
            // The grants as SAVED — never an unsaved edit made since.
            // Its own key: the answer does not replace a draft being edited.
            onClick={() => void post("apply-retry", { servers: Object.fromEntries(Object.entries(grantsOf(view)).map(([name, header]) => [name, { header }])) })}
            className="px-3 h-8 rounded-lg text-xs text-white bg-white/10 hover:bg-white/15 cursor-pointer disabled:opacity-50"
            data-testid="staff-mcp-apply-retry"
          >
            {t("users.staffMcp.retry")}
          </button>
        </div>
      )}
      {error && <StatusMessage type="error" message={error} />}
    </div>
  );
}
