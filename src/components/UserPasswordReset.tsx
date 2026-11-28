"use client";

// Settings → System → Users: the owner sets a new password for another user
// who forgot theirs (TASK-2377). `POST /setup-api/users/password` ends every
// session of theirs first, then changes the password through the root-owned
// helper; this form only collects the new password twice.

import { useState } from "react";
import StatusMessage from "./StatusMessage";
import { useT } from "@/lib/i18n";
import { USER_PASSWORD_MAX, USER_PASSWORD_MIN } from "@/lib/username-rules";

const ERROR_KEYS: Record<string, string> = {
  invalid_password: "users.errPassword",
  password_change_unavailable: "users.errResetUnavailable",
  owner_only: "users.errOwnerOnly",
  unknown_user: "users.errNotFound",
  password_changing: "users.errResetBusy",
};

export default function UserPasswordReset({ username, onDone, onCancel, onBusyChange }: {
  username: string;
  /** Told when a reset starts and ends, so the panel holds its other actions meanwhile. */
  onBusyChange?: (busy: boolean) => void;
  /** Called after the password was reset. */
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = password.length > 0 && password.length < USER_PASSWORD_MIN;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSave = !saving && password.length >= USER_PASSWORD_MIN && confirm === password;
  const inputClass = "w-full h-9 px-3 bg-white/[0.06] border border-white/10 rounded-lg text-sm text-white outline-none focus:border-[var(--coral-bright)] transition-colors";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const res = await fetch("/setup-api/users/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        onDone();
        return;
      }
      const data = (await res.json().catch(() => null)) as { code?: unknown } | null;
      const code = typeof data?.code === "string" ? data.code : "";
      setError(ERROR_KEYS[code] ?? "users.errResetFailed");
    } catch {
      setError("users.errResetFailed");
    } finally {
      setSaving(false);
      onBusyChange?.(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="mt-3 ml-12 rounded-lg border border-white/10 bg-white/[0.04] p-3 space-y-2"
      data-testid={`users-reset-${username}`}
      noValidate
    >
      <p className="text-xs font-medium text-white">{t("users.resetTitle", { name: username })}</p>
      <p className="text-[11px] text-white/50 leading-relaxed">{t("users.resetHint")}</p>
      <label className="block text-[11px] text-white/60">
        {t("users.password")}
        <input
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(null); }}
          autoComplete="new-password"
          maxLength={USER_PASSWORD_MAX}
          aria-invalid={tooShort}
          className={`${inputClass} mt-1`}
          data-testid={`users-reset-password-${username}`}
        />
      </label>
      {tooShort && <p className="text-[11px] text-red-400">{t("users.errPassword", { min: USER_PASSWORD_MIN })}</p>}
      <label className="block text-[11px] text-white/60">
        {t("users.confirmPassword")}
        <input
          type="password"
          value={confirm}
          onChange={(e) => { setConfirm(e.target.value); setError(null); }}
          autoComplete="new-password"
          maxLength={USER_PASSWORD_MAX}
          aria-invalid={mismatch}
          className={`${inputClass} mt-1`}
          data-testid={`users-reset-confirm-${username}`}
        />
      </label>
      {mismatch && <p className="text-[11px] text-red-400">{t("users.errMismatch")}</p>}
      {error && <StatusMessage type="error" message={t(error, { min: USER_PASSWORD_MIN })} />}
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={!canSave}
          className="px-3 h-8 rounded-lg text-xs font-medium text-white btn-gradient transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-2"
          data-testid={`users-reset-save-${username}`}
        >
          {saving && <span aria-hidden="true" className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
          {saving ? t("users.resetting") : t("users.resetSave")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="px-3 h-8 rounded-lg text-xs text-white/80 bg-white/10 hover:bg-white/15 transition-colors cursor-pointer disabled:opacity-60"
        >
          {t("users.cancel")}
        </button>
      </div>
    </form>
  );
}
