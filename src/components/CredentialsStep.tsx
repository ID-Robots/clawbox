"use client";

import { useState, useEffect, useRef } from "react";
import StatusMessage from "./StatusMessage";
import { useT } from "@/lib/i18n";

interface CredentialsStepProps {
  onNext: () => void;
}

export default function CredentialsStep({ onNext }: CredentialsStepProps) {
  const { t } = useT();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [hotspotName, setHotspotName] = useState("ClawBox-Setup");
  const [hotspotPassword, setHotspotPassword] = useState("");
  const [showHotspotPassword, setShowHotspotPassword] = useState(false);
  const [confirmHotspotPassword, setConfirmHotspotPassword] = useState("");
  const [showConfirmHotspot, setShowConfirmHotspot] = useState(false);
  const [hotspotEnabled, setHotspotEnabled] = useState(true);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/setup-api/system/hotspot", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && !controller.signal.aborted) {
          if (data.ssid) setHotspotName(data.ssid);
          if (typeof data.enabled === "boolean") setHotspotEnabled(data.enabled);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      saveControllerRef.current?.abort();
    };
  }, []);

  const save = async () => {
    setTouched(true);
    // Validate system password (required)
    if (!password) {
      setStatus({ type: "error", message: t("credentials.passwordRequired") });
      return;
    }
    if (password.length < 8) {
      setStatus({
        type: "error",
        message: t("credentials.passwordMinLength"),
      });
      return;
    }
    if (password !== confirmPassword) {
      setStatus({ type: "error", message: t("credentials.passwordsDontMatch") });
      return;
    }

    // Validate hotspot fields (only when enabled)
    if (hotspotEnabled) {
      if (!hotspotName.trim()) {
        setStatus({ type: "error", message: t("credentials.hotspotNameRequired") });
        return;
      }
      if (!hotspotPassword) {
        setStatus({ type: "error", message: t("credentials.hotspotPasswordRequired") });
        return;
      }
      if (hotspotPassword.length < 8) {
        setStatus({
          type: "error",
          message: t("credentials.hotspotPasswordMinLength"),
        });
        return;
      }
      if (hotspotPassword !== confirmHotspotPassword) {
        setStatus({ type: "error", message: t("credentials.hotspotPasswordsDontMatch") });
        return;
      }
    }

    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;

    setSaving(true);
    setStatus(null);
    try {
      // Save system password if provided
      if (password) {
        const res = await fetch("/setup-api/system/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setStatus({
            type: "error",
            message: data.error || t("credentials.failedSetPassword"),
          });
          return;
        }
      }

      // Save hotspot settings
      const hotspotRes = await fetch("/setup-api/system/hotspot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ssid: hotspotEnabled ? hotspotName.trim() : "ClawBox-Setup",
          password: hotspotEnabled ? (hotspotPassword || undefined) : undefined,
          enabled: hotspotEnabled,
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!hotspotRes.ok) {
        const data = await hotspotRes.json().catch(() => ({}));
        setStatus({
          type: "error",
          message: data.error || t("credentials.failedSaveHotspot"),
        });
        return;
      }

      setStatus({
        type: "success",
        message: t("credentials.settingsSaved"),
      });
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => onNext(), 1500);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  };

  const inputBase = "w-full px-3.5 py-2.5 pr-10 bg-[var(--bg-deep)] border rounded-lg text-sm text-gray-200 outline-none transition-colors placeholder-gray-500";
  const inputBorder = (hasError: boolean) =>
    hasError ? "border-red-500 focus:border-red-500" : "border-gray-600 focus:border-[var(--coral-bright)]";

  const EyeOpen = (
    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>visibility</span>
  );
  const EyeClosed = (
    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>visibility_off</span>
  );

  return (
    <div className="w-full max-w-[520px]">
      <div className="card-surface rounded-2xl p-8">
        <h1 className="text-2xl font-bold font-display mb-2">
          {t("credentials.title")}
        </h1>
        <p className="text-[var(--text-secondary)] mb-5 leading-relaxed">
          {t("credentials.description")}
        </p>

        {/* System Password */}
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">{t("credentials.systemPassword")}</h2>

        <div className="mb-4">
          <label htmlFor="cred-password" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
            {t("credentials.newPassword")}
          </label>
          <div className="relative">
            <input
              id="cred-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
              placeholder={t("credentials.minChars")}
              autoComplete="new-password"
              className={`${inputBase} ${inputBorder(touched && !password)}`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer p-0.5"
            >
              {showPassword ? EyeClosed : EyeOpen}
            </button>
          </div>
        </div>

        <div className="mb-5">
          <label htmlFor="cred-confirm" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
            {t("credentials.confirmPassword")}
          </label>
          <div className="relative">
            <input
              id="cred-confirm"
              type={showConfirm ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
              placeholder={t("credentials.reenterPassword")}
              autoComplete="new-password"
              className={`${inputBase} ${inputBorder(touched && !confirmPassword)}`}
            />
            <button
              type="button"
              onClick={() => setShowConfirm((v) => !v)}
              aria-label={showConfirm ? "Hide password" : "Show password"}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer p-0.5"
            >
              {showConfirm ? EyeClosed : EyeOpen}
            </button>
          </div>
        </div>

        {/* Hotspot Settings */}
        <div className="border-t border-[var(--border-subtle)] pt-5 mb-1">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t("credentials.hotspotSettings")}</h2>
            <button
              type="button"
              role="switch"
              aria-checked={hotspotEnabled}
              aria-label="Enable hotspot"
              onClick={() => setHotspotEnabled((v) => !v)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${
                hotspotEnabled ? "bg-[var(--coral-bright)]" : "bg-gray-600"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                  hotspotEnabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
          <p className="text-[var(--text-muted)] text-xs mb-3">
            {hotspotEnabled
              ? t("credentials.hotspotChangesApply")
              : t("credentials.hotspotDisabled")}
          </p>

          {hotspotEnabled && (
            <>
              <div className="mb-4">
                <label htmlFor="hotspot-name" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
                  {t("credentials.hotspotName")}
                </label>
                <input
                  id="hotspot-name"
                  type="text"
                  value={hotspotName}
                  onChange={(e) => setHotspotName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") save();
                  }}
                  maxLength={32}
                  className={`w-full px-3.5 py-2.5 bg-[var(--bg-deep)] border rounded-lg text-sm text-gray-200 outline-none transition-colors placeholder-gray-500 ${inputBorder(touched && !hotspotName.trim())}`}
                />
              </div>

              <div className="mb-4">
                <label htmlFor="hotspot-password" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
                  {t("credentials.hotspotPassword")}
                </label>
                <div className="relative">
                  <input
                    id="hotspot-password"
                    type={showHotspotPassword ? "text" : "password"}
                    value={hotspotPassword}
                    onChange={(e) => setHotspotPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") save();
                    }}
                    placeholder={t("credentials.minChars")}
                    className={`${inputBase} ${inputBorder(touched && (!hotspotPassword || hotspotPassword !== confirmHotspotPassword))}`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowHotspotPassword((v) => !v)}
                    aria-label={showHotspotPassword ? "Hide password" : "Show password"}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer p-0.5"
                  >
                    {showHotspotPassword ? EyeClosed : EyeOpen}
                  </button>
                </div>
              </div>

              <div>
                <label htmlFor="hotspot-confirm" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
                  {t("credentials.confirmHotspotPassword")}
                </label>
                <div className="relative">
                  <input
                    id="hotspot-confirm"
                    type={showConfirmHotspot ? "text" : "password"}
                    value={confirmHotspotPassword}
                    onChange={(e) => setConfirmHotspotPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") save();
                    }}
                    placeholder={t("credentials.reenterHotspot")}
                    className={`${inputBase} ${inputBorder(touched && hotspotPassword !== confirmHotspotPassword)}`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmHotspot((v) => !v)}
                    aria-label={showConfirmHotspot ? "Hide password" : "Show password"}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer p-0.5"
                  >
                    {showConfirmHotspot ? EyeClosed : EyeOpen}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {status && (
          <StatusMessage type={status.type} message={status.message} />
        )}

        <div className="mt-5">
          <button
            type="button"
            onClick={save}
            disabled={saving || !password || !confirmPassword || (hotspotEnabled && (!hotspotPassword || !confirmHotspotPassword))}
            className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100"
          >
            {saving ? t("saving") : t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
