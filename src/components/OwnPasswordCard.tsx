"use client";

import { useState } from "react";

import { useT } from "@/lib/i18n";
import { USER_PASSWORD_MAX, USER_PASSWORD_MIN } from "@/lib/username-rules";

// Settings → Account for a signed-in ClawBox user who is not the owner: their
// OWN Linux password (POST /setup-api/users/me/password). The owner's password
// is the box's and lives in Settings → System; this card is never drawn for
// the owner (SettingsApp's `sectionShown`).

/** The route's refusal codes, each with the line the person reads. */
const ERROR_KEYS: Record<string, string> = {
  wrong_password: "users.password.errWrong",
  invalid_password: "users.password.errInvalid",
  too_many_attempts: "users.password.errTooMany",
  password_change_unavailable: "users.password.errUnavailable",
};

type Status = { type: "ok" | "error"; key: string } | null;

const inputClass =
  "w-full h-10 px-3 rounded-lg bg-white/[0.06] border border-white/10 text-sm text-white outline-none focus:border-[var(--coral-bright)] transition-colors";

export default function OwnPasswordCard() {
  const { t } = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const tooShort = next.length > 0 && next.length < USER_PASSWORD_MIN;
  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = current.length > 0 && next.length >= USER_PASSWORD_MIN && next === confirm && !saving;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/setup-api/users/me/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, password: next }),
      });
      const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
      if (res.ok) {
        setCurrent("");
        setNext("");
        setConfirm("");
        setStatus({ type: "ok", key: "users.password.saved" });
        return;
      }
      const code = typeof body?.code === "string" ? body.code : "";
      setStatus({ type: "error", key: ERROR_KEYS[code] ?? "users.password.errFailed" });
    } catch {
      setStatus({ type: "error", key: "users.password.errFailed" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5"
      data-testid="own-password-card"
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">key</span>
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("users.password.title")}</h3>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] opacity-60 mb-4 leading-relaxed">{t("users.password.hint")}</p>
      <div className="space-y-3">
        <div>
          <label htmlFor="own-password-current" className="block text-xs text-white/60 mb-1.5">{t("users.password.current")}</label>
          <input
            id="own-password-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="own-password-new" className="block text-xs text-white/60 mb-1.5">{t("users.password.new")}</label>
          <input
            id="own-password-new"
            type="password"
            autoComplete="new-password"
            value={next}
            maxLength={USER_PASSWORD_MAX}
            onChange={(e) => setNext(e.target.value)}
            aria-invalid={tooShort}
            aria-describedby={tooShort ? "own-password-new-error" : undefined}
            className={inputClass}
          />
          {tooShort && (
            <p id="own-password-new-error" className="text-[11px] mt-1 text-red-400">
              {t("users.password.errInvalid", { min: USER_PASSWORD_MIN, max: USER_PASSWORD_MAX })}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="own-password-confirm" className="block text-xs text-white/60 mb-1.5">{t("users.password.confirm")}</label>
          <input
            id="own-password-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            maxLength={USER_PASSWORD_MAX}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={mismatch}
            aria-describedby={mismatch ? "own-password-confirm-error" : undefined}
            className={inputClass}
          />
          {mismatch && (
            <p id="own-password-confirm-error" className="text-[11px] mt-1 text-red-400">{t("users.password.errMismatch")}</p>
          )}
        </div>
        <button
          type="submit"
          disabled={!ready}
          data-testid="own-password-save"
          className="h-10 px-4 rounded-lg text-sm font-medium text-white bg-[var(--coral-bright)] disabled:opacity-40 transition-opacity"
        >
          {saving ? t("users.password.saving") : t("users.password.save")}
        </button>
        {status && (
          <p
            role={status.type === "error" ? "alert" : "status"}
            data-testid="own-password-status"
            className={`text-xs leading-relaxed ${status.type === "ok" ? "text-emerald-300" : "text-red-400"}`}
          >
            {t(status.key, { min: USER_PASSWORD_MIN, max: USER_PASSWORD_MAX })}
          </p>
        )}
      </div>
    </form>
  );
}
