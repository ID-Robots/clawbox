"use client";

// Settings → System → Remote access (SSH). SSH is off by default; the owner
// turns it on here, and only once the box has an owner password — the route
// (src/app/setup-api/system/ssh/route.ts) and the root step behind it refuse
// otherwise. Both directions ask for the current password, the way the
// password card re-proves it before a change.

import { useEffect, useState } from "react";
import StatusMessage from "./StatusMessage";
import { useT } from "@/lib/i18n";

interface SshState {
  enabled: boolean;
  ownerPassword: boolean;
}

export default function RemoteAccessPanel() {
  const { t } = useT();
  const [state, setState] = useState<SshState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/setup-api/system/ssh", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SshState | null) => { if (live && d) setState(d); })
      // Leave the card in its loading state; nothing to act on without an answer.
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const cancel = () => { setConfirming(false); setPassword(""); };

  const submit = async () => {
    if (!state || !password) return;
    const next = !state.enabled;
    setSaving(true);
    setStatus(null);
    try {
      const r = await fetch("/setup-api/system/ssh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next, currentPassword: password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(d.code === "no_owner_password" ? t("settings.ssh.needPassword") : d.error || t("settings.ssh.failed"));
      }
      setState({ ...state, enabled: !!d.enabled });
      setStatus({ type: "success", message: d.enabled ? t("settings.ssh.nowOn") : t("settings.ssh.nowOff") });
      cancel();
    } catch (err) {
      setStatus({ type: "error", message: err instanceof Error ? err.message : t("settings.ssh.failed") });
    } finally {
      setSaving(false);
    }
  };

  const canToggle = !!state && (state.enabled || state.ownerPassword);

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid="settings-ssh-card">
      <div className="flex items-center gap-2 mb-2">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>terminal</span>
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.ssh.title")}</h3>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] opacity-60 mb-3 leading-relaxed">{t("settings.ssh.desc")}</p>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-[var(--text-primary)]" data-testid="settings-ssh-state">
          {state === null ? t("settings.ssh.loading") : state.enabled ? t("settings.ssh.on") : t("settings.ssh.off")}
        </span>
        {!confirming && (
          <button
            type="button"
            onClick={() => { setStatus(null); setConfirming(true); }}
            disabled={!canToggle || saving}
            className="px-4 py-2 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-lg text-sm font-semibold cursor-pointer border-none transition-all"
          >
            {state?.enabled ? t("settings.ssh.turnOff") : t("settings.ssh.turnOn")}
          </button>
        )}
      </div>
      {state && !state.enabled && !state.ownerPassword && (
        <p className="mt-2 text-[11px] text-amber-300/90">{t("settings.ssh.needPassword")}</p>
      )}
      {confirming && (
        <div className="mt-3 space-y-2">
          <label htmlFor="ssh-current-password" className="block text-[11px] text-[var(--text-muted)]">{t("settings.ssh.confirmPrompt")}</label>
          <div className="flex items-stretch gap-2">
            <input
              id="ssh-current-password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }}
              placeholder={t("settings.security.currentPassword")}
              maxLength={128}
              autoComplete="current-password"
              autoFocus
              className="flex-1 min-w-0 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-sm text-[var(--text-primary)] outline-none placeholder-white/20 focus:border-orange-400/60"
            />
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              className="px-3 py-2 bg-white/[0.06] hover:bg-white/[0.12] text-xs text-[var(--text-primary)] rounded-lg cursor-pointer border-none transition-colors"
            >
              {t("settings.ssh.cancel")}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={saving || !password}
              className="px-4 py-2 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-lg text-sm font-semibold cursor-pointer border-none transition-all"
            >
              {saving ? t("settings.ssh.saving") : state?.enabled ? t("settings.ssh.turnOff") : t("settings.ssh.turnOn")}
            </button>
          </div>
        </div>
      )}
      {status && <div className="mt-3"><StatusMessage type={status.type} message={status.message} /></div>}
    </div>
  );
}
