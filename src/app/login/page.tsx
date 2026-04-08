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

  // If setup isn't complete, redirect to /setup instead of showing login
  useEffect(() => {
    fetch("/setup-api/setup/status")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data && !data.setup_complete) {
          window.location.href = "/setup";
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

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: "var(--bg-deep)" }}>
      <div className="w-full max-w-[380px]">
        <div className="card-surface rounded-2xl p-8">
          <div className="flex flex-col items-center gap-3 mb-6">
            <Image src="/clawbox-crab.png" alt="ClawBox" width={120} height={120} className="w-[120px] h-[120px] object-contain animate-welcome-powerup" priority />
            <h1 className="text-xl font-bold font-display text-[var(--text-primary)]">
              ClawBox
            </h1>
            <p className="text-sm text-[var(--text-muted)]">
              {t("login.subtitle")}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label
                htmlFor="login-password"
                className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5"
              >
                {t("login.password")}
              </label>
              <div className="relative">
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("login.passwordPlaceholder")}
                  autoFocus
                  autoComplete="current-password"
                  className="w-full px-3.5 py-2.5 pr-10 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? t("login.hidePassword") : t("login.showPassword")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer p-0.5"
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 18 }}>
                    {showPassword ? "visibility_off" : "visibility"}
                  </span>
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor="login-duration"
                className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5"
              >
                {t("login.duration")}
              </label>
              <select
                id="login-duration"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="w-full px-3.5 py-2.5 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors cursor-pointer appearance-none"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='%236b7280'%3E%3Cpath d='M7 10l5 5 5-5z'/%3E%3C/svg%3E")`,
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "right 12px center",
                }}
              >
                {DURATION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </option>
                ))}
              </select>
            </div>

            {error && (
              <div className="px-3.5 py-2.5 rounded-lg text-xs bg-red-500/10 text-red-400 border border-red-500/20">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !password.trim()}
              className="w-full py-3 btn-gradient text-white rounded-lg text-sm font-semibold transition transform hover:scale-[1.02] shadow-lg shadow-[rgba(249,115,22,0.25)] disabled:opacity-50 disabled:hover:scale-100 cursor-pointer"
            >
              {loading ? t("login.loggingIn") : t("login.logIn")}
            </button>
          </form>
        </div>
      </div>
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
