"use client";

// Settings → Users (TASK-1256, multi-user ClawBox OS). The owner lists,
// creates and removes the box's other users; every one of them is a real
// Linux account with its own password (src/lib/clawbox-users.ts). The route
// behind this panel answers the owner's cookie alone, so the panel only ever
// renders for the owner — it still says so plainly if the route refuses.

import { useCallback, useEffect, useState } from "react";
import StatusMessage from "./StatusMessage";
import { useT } from "@/lib/i18n";
import { checkUsername, USER_PASSWORD_MAX, USER_PASSWORD_MIN } from "@/lib/username-rules";

interface UsersListing {
  owner: { username: string };
  users: Array<{ username: string; createdAt: string }>;
  currentUser: string;
}

// Messages are kept as catalogue KEYS and translated when drawn, so nothing
// here depends on `t`: the list is fetched once, and a language switch
// re-words what is on screen instead of re-fetching it.
type Message = { key: string; params?: Record<string, string | number> };
type Notice = ({ type: "success" | "error" } & Message) | null;

const ERROR_KEYS: Record<string, string> = {
  invalid_username: "users.errInvalidUsername",
  reserved_username: "users.errReserved",
  user_exists: "users.errExists",
  invalid_password: "users.errPassword",
  account_check_failed: "users.errCreateFailed",
  create_failed: "users.errCreateFailed",
  remove_failed: "users.errRemoveFailed",
  not_found: "users.errRemoveFailed",
  cannot_remove_owner: "users.errCannotRemove",
  cannot_remove_self: "users.errCannotRemove",
  owner_only: "users.errOwnerOnly",
};

/** The catalogue key for a route's refusal code, or the fallback key. */
function errorKey(code: unknown, fallback: string): string {
  return (typeof code === "string" && ERROR_KEYS[code]) || fallback;
}

function parseListing(data: unknown): UsersListing | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Partial<UsersListing>;
  if (!d.owner || typeof d.owner.username !== "string" || !Array.isArray(d.users)) return null;
  return {
    owner: { username: d.owner.username },
    users: d.users.filter((u) => u && typeof u.username === "string").map((u) => ({
      username: u.username,
      createdAt: typeof u.createdAt === "string" ? u.createdAt : "",
    })),
    currentUser: typeof d.currentUser === "string" ? d.currentUser : d.owner.username,
  };
}

function Avatar({ name, owner }: { name: string; owner: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold text-white shrink-0"
      style={{ backgroundColor: owner ? "#fe6e00" : "#6366f1" }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export default function UsersPanel() {
  const { t } = useT();
  const [listing, setListing] = useState<UsersListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  /** A stored message, in the current language; the password rule is the one key with a {min}. */
  const say = (key: string, params?: Record<string, string | number>): string =>
    t(key, params ?? (key === "users.errPassword" ? { min: USER_PASSWORD_MIN } : undefined));

  const load = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/users", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setLoadError(errorKey(data?.code, "users.errLoad"));
        return;
      }
      const parsed = parseListing(data);
      if (!parsed) {
        setLoadError("users.errLoad");
        return;
      }
      setListing(parsed);
      setLoadError(null);
    } catch {
      setLoadError("users.errLoad");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const verdict = username ? checkUsername(username) : null;
  const usernameProblem = verdict === "invalid"
    ? t("users.errInvalidUsername")
    : verdict === "reserved"
      ? t("users.errReserved")
      : null;
  const passwordTooShort = password.length > 0 && password.length < USER_PASSWORD_MIN;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canCreate = !creating
    && verdict === "ok"
    && password.length >= USER_PASSWORD_MIN
    && password.length <= USER_PASSWORD_MAX
    && confirm === password;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    setCreating(true);
    setFormError(null);
    setNotice(null);
    try {
      const res = await fetch("/setup-api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setFormError(errorKey(data?.code, "users.errCreateFailed"));
        return;
      }
      const parsed = parseListing(data);
      if (parsed) setListing(parsed);
      else await load();
      setNotice({ type: "success", key: "users.created", params: { name: username } });
      setUsername("");
      setPassword("");
      setConfirm("");
      setShowPassword(false);
    } catch {
      setFormError("users.errCreateFailed");
    } finally {
      setCreating(false);
    }
  };

  const handleRemove = async (name: string) => {
    setRemoving(name);
    setNotice(null);
    try {
      const res = await fetch("/setup-api/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setNotice({ type: "error", key: errorKey(data?.code, "users.errRemoveFailed") });
        await load();
        return;
      }
      const parsed = parseListing(data);
      if (parsed) setListing(parsed);
      else await load();
      setNotice({ type: "success", key: "users.removed", params: { name } });
    } catch {
      setNotice({ type: "error", key: "users.errRemoveFailed" });
    } finally {
      setRemoving(null);
      setConfirmRemove(null);
    }
  };

  const formatDate = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  };

  const inputClass = "w-full h-10 px-3 bg-white/[0.06] border border-white/10 rounded-lg text-sm text-white outline-none focus:border-[var(--coral-bright)] focus:bg-white/[0.08] transition-colors placeholder-white/30";

  return (
    <div className="max-w-xl space-y-5" data-testid="settings-users-section">
      <div>
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">{t("users.title")}</h3>
        <p className="text-sm text-[var(--text-secondary)] mt-1 leading-relaxed">{t("users.intro")}</p>
      </div>

      {/* ── Who can sign in ── */}
      <div className="bg-white/5 rounded-xl p-2" aria-busy={loading}>
        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="spinner" role="status" aria-label={t("loading")} />
          </div>
        )}
        {!loading && loadError && (
          <div className="p-3"><StatusMessage type="error" message={say(loadError)} /></div>
        )}
        {!loading && listing && (
          <ul className="divide-y divide-white/[0.06]" data-testid="users-list">
            <li className="flex items-center gap-3 px-3 py-3">
              <Avatar name={listing.owner.username} owner />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-white truncate">{listing.owner.username}</div>
                <div className="text-xs text-white/50">{t("users.ownerHint")}</div>
              </div>
              <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-[var(--coral-bright)]/15 text-[var(--coral-bright)]">
                {t("users.ownerBadge")}
              </span>
              {listing.currentUser === listing.owner.username && (
                <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-white/10 text-white/70">
                  {t("users.youBadge")}
                </span>
              )}
            </li>
            {listing.users.map((u) => {
              const isSelf = u.username === listing.currentUser;
              const confirming = confirmRemove === u.username;
              const busy = removing === u.username;
              const added = formatDate(u.createdAt);
              return (
                <li key={u.username} className="px-3 py-3" data-testid={`users-row-${u.username}`}>
                  <div className="flex items-center gap-3">
                    <Avatar name={u.username} owner={false} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-white truncate">{u.username}</div>
                      {added && <div className="text-xs text-white/50">{t("users.createdOn", { date: added })}</div>}
                    </div>
                    {isSelf && (
                      <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-white/10 text-white/70">
                        {t("users.youBadge")}
                      </span>
                    )}
                    {!isSelf && !confirming && (
                      <button
                        type="button"
                        onClick={() => { setConfirmRemove(u.username); setNotice(null); }}
                        disabled={!!removing}
                        className="px-3 h-8 rounded-lg text-xs text-red-300 bg-red-500/10 hover:bg-red-500/20 transition-colors cursor-pointer disabled:opacity-50"
                      >
                        {t("users.remove")}
                      </button>
                    )}
                  </div>
                  {confirming && (
                    <div className="mt-3 ml-12 rounded-lg border border-red-500/25 bg-red-500/10 p-3" role="alertdialog" aria-label={t("users.removeConfirm", { name: u.username })}>
                      <p className="text-xs text-red-200 leading-relaxed">{t("users.removeConfirm", { name: u.username })}</p>
                      <div className="flex gap-2 mt-3">
                        <button
                          type="button"
                          onClick={() => void handleRemove(u.username)}
                          disabled={busy}
                          className="px-3 h-8 rounded-lg text-xs font-medium text-white bg-red-500/80 hover:bg-red-500 transition-colors cursor-pointer disabled:opacity-60 inline-flex items-center gap-2"
                        >
                          {busy && <span aria-hidden="true" className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                          {busy ? t("users.removing") : t("users.removeConfirmButton")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRemove(null)}
                          disabled={busy}
                          className="px-3 h-8 rounded-lg text-xs text-white/80 bg-white/10 hover:bg-white/15 transition-colors cursor-pointer disabled:opacity-60"
                        >
                          {t("users.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
            {listing.users.length === 0 && (
              <li className="px-3 py-3 text-xs text-white/50">{t("users.empty")}</li>
            )}
          </ul>
        )}
      </div>
      {notice && <StatusMessage type={notice.type} message={say(notice.key, notice.params)} />}

      {/* ── Add a user ── */}
      {listing && (
        <form onSubmit={handleCreate} className="bg-white/5 rounded-xl p-5 space-y-3" data-testid="users-add-form" noValidate>
          <h4 className="text-sm font-semibold text-white">{t("users.addTitle")}</h4>
          <div>
            <label htmlFor="users-new-name" className="block text-xs text-white/60 mb-1.5">{t("users.username")}</label>
            <input
              id="users-new-name"
              type="text"
              value={username}
              onChange={(e) => { setUsername(e.target.value.trim()); setFormError(null); }}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={32}
              aria-invalid={!!usernameProblem}
              aria-describedby="users-new-name-hint"
              className={inputClass}
            />
            <p id="users-new-name-hint" className={`text-[11px] mt-1 ${usernameProblem ? "text-red-400" : "text-white/40"}`}>
              {usernameProblem ?? t("users.usernameHint")}
            </p>
          </div>
          <div>
            <label htmlFor="users-new-password" className="block text-xs text-white/60 mb-1.5">{t("users.password")}</label>
            <div className="relative">
              <input
                id="users-new-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setFormError(null); }}
                autoComplete="new-password"
                maxLength={USER_PASSWORD_MAX}
                aria-invalid={passwordTooShort}
                aria-describedby={passwordTooShort ? "users-new-password-error" : undefined}
                className={`${inputClass} pr-10`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? t("login.hidePassword") : t("login.showPassword")}
                className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-8 h-8 text-white/40 hover:text-white bg-transparent border-none cursor-pointer"
              >
                <span className="material-symbols-rounded" style={{ fontSize: 18 }}>
                  {showPassword ? "visibility_off" : "visibility"}
                </span>
              </button>
            </div>
            {passwordTooShort && (
              <p id="users-new-password-error" className="text-[11px] mt-1 text-red-400">{t("users.errPassword", { min: USER_PASSWORD_MIN })}</p>
            )}
          </div>
          <div>
            <label htmlFor="users-new-confirm" className="block text-xs text-white/60 mb-1.5">{t("users.confirmPassword")}</label>
            <input
              id="users-new-confirm"
              type={showPassword ? "text" : "password"}
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); setFormError(null); }}
              autoComplete="new-password"
              maxLength={USER_PASSWORD_MAX}
              aria-invalid={mismatch}
              aria-describedby={mismatch ? "users-new-confirm-error" : undefined}
              className={inputClass}
            />
            {mismatch && <p id="users-new-confirm-error" className="text-[11px] mt-1 text-red-400">{t("users.errMismatch")}</p>}
          </div>
          {formError && <StatusMessage type="error" message={say(formError)} />}
          <button
            type="submit"
            disabled={!canCreate}
            className="w-full inline-flex items-center justify-center gap-2 h-10 btn-gradient rounded-lg text-sm font-medium text-white transition-colors cursor-pointer disabled:opacity-50"
          >
            {creating && <span aria-hidden="true" className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            {creating ? t("users.creating") : t("users.create")}
          </button>
        </form>
      )}

      {/* ── What another user gets ── */}
      <div className="rounded-xl border border-white/10 p-4">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-white/50">{t("users.scopeTitle")}</h4>
        <p className="text-xs text-white/60 mt-2 leading-relaxed">{t("users.scopeNote")}</p>
      </div>
    </div>
  );
}
