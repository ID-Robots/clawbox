"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import StatusMessage from "./StatusMessage";

interface WifiStepProps {
  onNext: () => void;
}

export default function WifiStep({ onNext }: WifiStepProps) {
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  const connectWifi = async () => {
    if (!ssid.trim()) return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setConnecting(true);
    setStatus(null);
    try {
      const res = await fetch("/setup-api/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: ssid.trim(), password }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Connection failed (${res.status})`);
      }
      setConnecting(false);
      setStatus({
        type: "success",
        message:
          "Connected! Reconnect to your home WiFi and visit http://clawbox.local to continue.",
      });
      setTimeout(() => onNext(), 3000);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof TypeError && err.message.includes("fetch")) {
        setConnecting(false);
        setStatus({
          type: "error",
          message:
            "Lost connection to ClawBox. If WiFi switched successfully, reconnect to your home WiFi and visit http://clawbox.local to continue.",
        });
        return;
      }
      setStatus({
        type: "error",
        message: `Connection failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      if (!controller.signal.aborted) setConnecting(false);
    }
  };

  return (
    <div className="w-full max-w-[520px]">
      <div className="card-surface rounded-2xl p-8">
        <div className="flex flex-col items-center gap-2 mb-6">
          <Image
            src="/clawbox-logo.png"
            alt="ClawBox"
            width={120}
            height={120}
            className="w-[120px] h-[120px] object-contain"
            priority
          />
          <h1 className="text-2xl font-bold font-display text-center">
            Welcome to{" "}
            <span className="title-gradient">
              ClawBox
            </span>
          </h1>
        </div>
        <p className="text-[var(--text-secondary)] mb-6 leading-relaxed text-center">
          Enter your home WiFi details to connect ClawBox to the internet.
        </p>

        <div className="flex flex-col gap-4">
          <div>
            <label
              htmlFor="wifi-ssid"
              className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5"
            >
              Network Name (SSID)
            </label>
            <input
              id="wifi-ssid"
              type="text"
              value={ssid}
              onChange={(e) => setSsid(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") connectWifi();
              }}
              placeholder="Enter WiFi network name"
              autoComplete="off"
              className="w-full px-3.5 py-2.5 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
            />
          </div>

          <div>
            <label
              htmlFor="wifi-password"
              className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5"
            >
              Password
            </label>
            <div className="relative">
              <input
                id="wifi-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") connectWifi();
                }}
                placeholder="Enter WiFi password (leave empty if open)"
                autoComplete="off"
                className="w-full px-3.5 py-2.5 pr-10 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer p-0.5"
              >
                {showPassword ? (
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                ) : (
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </button>
            </div>
          </div>
        </div>

        {status && (
          <div className="mt-4">
            <StatusMessage type={status.type} message={status.message} />
          </div>
        )}

        <div className="flex items-center gap-3 mt-5">
          <button
            type="button"
            onClick={connectWifi}
            disabled={connecting || !ssid.trim()}
            className="px-7 py-3 btn-gradient text-white rounded-lg text-sm font-semibold transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] disabled:opacity-50 disabled:hover:scale-100 cursor-pointer"
          >
            {connecting ? "Connecting..." : "Connect"}
          </button>
          <button
            type="button"
            onClick={onNext}
            className="bg-transparent border-none text-[var(--coral-bright)] text-sm underline cursor-pointer p-1"
          >
            Skip (Ethernet only)
          </button>
        </div>
      </div>
    </div>
  );
}
