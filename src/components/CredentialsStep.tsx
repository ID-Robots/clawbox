"use client";

import { useState, useEffect, useRef } from "react";
import StatusMessage from "./StatusMessage";

interface CredentialsStepProps {
  onNext: () => void;
}

export default function CredentialsStep({ onNext }: CredentialsStepProps) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [hotspotName, setHotspotName] = useState("ClawBox-Setup");
  const [hotspotPassword, setHotspotPassword] = useState("");
  const [showHotspotPassword, setShowHotspotPassword] = useState(false);
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
    // Validate system password (if filled)
    if (password || confirmPassword) {
      if (password.length < 8) {
        setStatus({
          type: "error",
          message: "System password must be at least 8 characters",
        });
        return;
      }
      if (password !== confirmPassword) {
        setStatus({ type: "error", message: "Passwords do not match" });
        return;
      }
    }

    // Validate hotspot fields
    if (!hotspotName.trim()) {
      setStatus({ type: "error", message: "Hotspot name is required" });
      return;
    }
    if (hotspotPassword && hotspotPassword.length < 8) {
      setStatus({
        type: "error",
        message: "Hotspot password must be at least 8 characters",
      });
      return;
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
            message: data.error || "Failed to set system password",
          });
          return;
        }
      }

      // Save hotspot settings
      const hotspotRes = await fetch("/setup-api/system/hotspot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ssid: hotspotName.trim(),
          password: hotspotPassword || undefined,
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!hotspotRes.ok) {
        const data = await hotspotRes.json().catch(() => ({}));
        setStatus({
          type: "error",
          message: data.error || "Failed to save hotspot settings",
        });
        return;
      }

      setStatus({
        type: "success",
        message: "Settings saved! Continuing...",
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

  const EyeOpen = (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
  );
  const EyeClosed = (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
  );

  return (
    <div className="w-full max-w-[520px]">
      <div className="card-surface  rounded-2xl p-8">
        <h1 className="text-2xl font-bold font-display mb-2">
          Security
        </h1>
        <p className="text-[var(--text-secondary)] mb-5 leading-relaxed">
          Set a system password and configure your hotspot.
        </p>

        {/* System Password */}
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">System Password</h2>

        <div className="mb-4">
          <label htmlFor="cred-password" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
            New Password
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
              placeholder="Minimum 8 characters"
              autoComplete="new-password"
              className="w-full px-3.5 py-2.5 pr-10 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
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
            Confirm Password
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
              placeholder="Re-enter password"
              autoComplete="new-password"
              className="w-full px-3.5 py-2.5 pr-10 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
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
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Hotspot Settings</h2>
          <p className="text-[var(--text-muted)] text-xs mb-3">
            Changes apply next time the hotspot starts.
          </p>

          <div className="mb-4">
            <label htmlFor="hotspot-name" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
              Hotspot Name
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
              className="w-full px-3.5 py-2.5 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
            />
          </div>

          <div>
            <label htmlFor="hotspot-password" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
              Hotspot Password <span className="text-[var(--text-muted)] font-normal">(optional)</span>
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
                placeholder="Leave empty for open network"
                className="w-full px-3.5 py-2.5 pr-10 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
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
        </div>

        {status && (
          <StatusMessage type={status.type} message={status.message} />
        )}

        <div className="flex items-center gap-3 mt-5">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={onNext}
            className="bg-transparent border-none text-[var(--coral-bright)] text-sm underline cursor-pointer p-1"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
