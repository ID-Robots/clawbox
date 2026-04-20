"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { I18nProvider, useT } from "@/lib/i18n";

const DURATION_OPTIONS = [
  { value: 1200, labelKey: "login.20min" },
  { value: 21600, labelKey: "login.6h" },
  { value: 43200, labelKey: "login.12h" },
  { value: 86400, labelKey: "login.24h" },
];

function LoginForm() {
  const { t } = useT();
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [duration, setDuration] = useState(43200);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Incomplete setups should always resume on the dedicated setup route.
  useEffect(() => {
    fetch("/setup-api/setup/status")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data && !data.setup_complete) {
          window.location.replace("/setup");
          return;
        }
        setReady(true);
      })
      .catch(() => setReady(true));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) {
      setError(t("login.passwordRequired"));
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/login-api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, duration }),
      });

      if (!res.ok) {
        let message = `Login failed (${res.status})`;
        try {
          const data = await res.json();
          if (typeof data?.error === "string") message = data.error;
        } catch {
          const text = await res.text().catch(() => "");
          if (text) message = text;
        }
        setError(message);
        setLoading(false);
        return;
      }

      // Redirect to the original page or home — parse via URL with the
      // current origin as base, then enforce same-origin and pathname starts
      // with a single "/" (rejects "//evil.com" and "javascript:" tricks).
      const params = new URLSearchParams(window.location.search);
      const raw = params.get("redirect") || "/";
      let target = "/";
      try {
        const parsed = new URL(raw, window.location.origin);
        if (
          parsed.origin === window.location.origin &&
          parsed.pathname.startsWith("/") &&
          !parsed.pathname.startsWith("//")
        ) {
          target = parsed.pathname + parsed.search + parsed.hash;
        }
      } catch {
        target = "/";
      }
      window.location.href = target;
    } catch {
      setError(t("login.connectionFailed"));
      setLoading(false);
    }
  };

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg-deep)" }}>
        <div className="spinner" role="status" aria-label="Loading" />
      </div>
    );
  }

  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const dateStr = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

  return (
    <div
      className="flex flex-col items-center justify-between sm:justify-center px-5 py-6 sm:py-12 relative overflow-hidden"
      style={{
        minHeight: "100dvh",
        background: "radial-gradient(ellipse at top, rgba(249,115,22,0.15), transparent 60%), radial-gradient(ellipse at bottom, rgba(249,115,22,0.08), transparent 50%), var(--bg-deep)",
      }}
    >
      {/* Mobile clock — hidden on desktop where the card is centered */}
      <div className="flex flex-col items-center gap-1 pt-8 sm:hidden" aria-hidden="true">
        <div className="text-[64px] font-light text-white tabular-nums leading-none" suppressHydrationWarning>{timeStr}</div>
        <div className="text-sm text-white/60 capitalize" suppressHydrationWarning>{dateStr}</div>
      </div>

      <div className="w-full max-w-[380px] flex flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-3">
          <Image src="/clawbox-crab.png" alt="ClawBox" width={96} height={96} className="w-24 h-24 sm:w-[120px] sm:h-[120px] object-contain animate-welcome-powerup" priority />
          <h1 className="text-2xl font-bold font-display text-white">ClawBox</h1>
          <p className="text-sm text-white/50 text-center">{t("login.subtitle")}</p>
        </div>

        <form onSubmit={handleSubmit} className="w-full flex flex-col gap-4">
          <div>
            <label htmlFor="login-password" className="sr-only">{t("login.password")}</label>
            <div className="relative">
              <input
                id="login-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("login.passwordPlaceholder")}
                autoFocus
                autoComplete="current-password"
                className="w-full h-12 px-4 pr-12 bg-white/[0.06] border border-white/10 rounded-xl text-base text-white outline-none focus:border-[var(--coral-bright)] focus:bg-white/[0.08] transition-colors placeholder-white/30"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? t("login.hidePassword") : t("login.showPassword")}
                className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-10 h-10 text-white/40 hover:text-white bg-transparent border-none cursor-pointer"
              >
                <span className="material-symbols-rounded" style={{ fontSize: 20 }}>
                  {showPassword ? "visibility_off" : "visibility"}
                </span>
              </button>
            </div>
          </div>

          <div>
            <span className="block text-[11px] font-semibold text-white/40 uppercase tracking-widest mb-2">
              {t("login.duration")}
            </span>
            <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label={t("login.duration")}>
              {DURATION_OPTIONS.map((opt) => {
                const active = duration === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setDuration(opt.value)}
                    className={`h-10 rounded-lg text-xs font-medium transition-colors cursor-pointer border ${
                      active
                        ? "bg-[var(--coral-bright)]/20 text-[var(--coral-bright)] border-[var(--coral-bright)]/40"
                        : "bg-white/[0.04] text-white/60 border-white/[0.08] hover:bg-white/[0.08] hover:text-white/80"
                    }`}
                  >
                    {t(opt.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <div className="px-3.5 py-2.5 rounded-lg text-xs bg-red-500/10 text-red-400 border border-red-500/20">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !password.trim()}
            className="w-full h-12 btn-gradient text-white rounded-xl text-base font-semibold transition transform active:scale-[0.98] hover:scale-[1.02] shadow-lg shadow-[rgba(249,115,22,0.25)] disabled:opacity-50 disabled:hover:scale-100 cursor-pointer flex items-center justify-center gap-2"
          >
            {loading && (
              <span aria-hidden="true" className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            )}
            {loading ? t("login.loggingIn") : t("login.logIn")}
          </button>
        </form>
      </div>

      {/* Spacer for mobile bottom alignment */}
      <div className="sm:hidden" aria-hidden="true" />
    </div>
  );
}

export default function LoginPage() {
  return (
    <I18nProvider>
      <LoginForm />
    </I18nProvider>
  );
}
