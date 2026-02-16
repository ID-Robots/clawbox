"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Image from "next/image";
import SignalBars from "./SignalBars";
import StatusMessage from "./StatusMessage";

interface WifiNetwork {
  ssid: string;
  signal: number;
  security: string;
  freq: string;
}

interface WifiStepProps {
  onNext: () => void;
}

export default function WifiStep({ onNext }: WifiStepProps) {
  const [networks, setNetworks] = useState<WifiNetwork[] | null>(null);
  const [scanning, setScanning] = useState(true);
  const [scanError, setScanError] = useState(false);
  const [selectedSSID, setSelectedSSID] = useState<string | null>(null);
  const [selectedSecurity, setSelectedSecurity] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const connectControllerRef = useRef<AbortController | null>(null);
  const scanControllerRef = useRef<AbortController | null>(null);

  const scanWifi = useCallback(async () => {
    scanControllerRef.current?.abort();
    const controller = new AbortController();
    scanControllerRef.current = controller;

    setScanning(true);
    setScanError(false);
    setNetworks(null);
    try {
      const res = await fetch("/setup-api/wifi/scan", {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) throw new Error(`Scan failed (${res.status})`);
      const data = await res.json();
      if (controller.signal.aborted) return;
      setNetworks(data.networks || []);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setScanError(true);
    } finally {
      if (!controller.signal.aborted) setScanning(false);
    }
  }, []);

  useEffect(() => {
    scanWifi();
    return () => {
      scanControllerRef.current?.abort();
    };
  }, [scanWifi]);

  const selectNetwork = (ssid: string, security: string) => {
    setSelectedSSID(ssid);
    setSelectedSecurity(security);
    setPassword("");
    setShowPassword(false);
    setStatus(null);
  };

  const closeModal = useCallback(() => setSelectedSSID(null), []);

  const connectWifi = async () => {
    connectControllerRef.current?.abort();
    const controller = new AbortController();
    connectControllerRef.current = controller;

    setConnecting(true);
    setStatus(null);
    try {
      const res = await fetch("/setup-api/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: selectedSSID, password }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Connection failed (${res.status})`);
      }
      // Server confirmed connection succeeded
      showSuccess();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Network error (lost connection to AP) likely means the switch worked,
      // but we can't be certain
      if (err instanceof TypeError && err.message.includes("fetch")) {
        setConnecting(false);
        setStatus({
          type: "error",
          message: "Lost connection to ClawBox. If WiFi switched successfully, reconnect to your home WiFi and visit http://clawbox.local to continue.",
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

  const showSuccess = () => {
    setConnecting(false);
    setStatus({
      type: "success",
      message:
        "Connected! Reconnect to your home WiFi and visit http://clawbox.local to continue.",
    });
    setTimeout(() => {
      closeModal();
      onNext();
    }, 3000);
  };

  // Cleanup connect controller on unmount
  useEffect(() => {
    return () => {
      connectControllerRef.current?.abort();
    };
  }, []);

  // Escape key to close modal + focus management
  useEffect(() => {
    if (!selectedSSID) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    document.addEventListener("keydown", handleKey);
    modalRef.current?.focus();
    return () => document.removeEventListener("keydown", handleKey);
  }, [selectedSSID, closeModal]);

  const isOpen = !selectedSecurity || selectedSecurity === "--";

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
          Connect to your home WiFi to get started.
        </p>

        <div className="border border-[var(--border-subtle)] rounded-lg max-h-[300px] overflow-y-auto bg-[var(--bg-deep)]/50">
          {scanning && (
            <div className="flex items-center justify-center gap-2.5 p-6 text-[var(--text-secondary)] text-sm">
              <div className="spinner" /> Scanning for networks...
            </div>
          )}
          {scanError && (
            <div className="p-6 text-center text-sm text-red-400">
              Scan failed.{" "}
              <button
                type="button"
                onClick={scanWifi}
                className="text-[var(--coral-bright)] underline bg-transparent border-none cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}
          {!scanning && !scanError && networks?.length === 0 && (
            <div className="p-6 text-center text-[var(--text-secondary)] text-sm">
              No networks found.{" "}
              <button
                type="button"
                onClick={scanWifi}
                className="text-[var(--coral-bright)] underline bg-transparent border-none cursor-pointer"
              >
                Try again
              </button>
            </div>
          )}
          {!scanning &&
            !scanError &&
            networks?.map((n) => {
              const bars = Math.min(4, Math.max(1, Math.ceil(n.signal / 25)));
              const hasLock = n.security && n.security !== "--";
              return (
                <button
                  type="button"
                  key={n.ssid}
                  onClick={() => selectNetwork(n.ssid, n.security || "")}
                  aria-label={`${n.ssid}${hasLock ? " (secured)" : " (open)"}`}
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer border-b border-gray-800 last:border-b-0 hover:bg-[var(--surface-card)] transition-colors w-full text-left bg-transparent border-x-0 border-t-0"
                >
                  <SignalBars level={bars} />
                  <span className="flex-1 text-sm font-medium text-gray-200">
                    {n.ssid}
                  </span>
                  {hasLock && (
                    <span className="text-sm shrink-0 text-[var(--text-muted)]">
                      &#128274;
                    </span>
                  )}
                </button>
              );
            })}
        </div>

        <div className="flex items-center gap-3 mt-5">
          <button
            type="button"
            onClick={scanWifi}
            className="px-5 py-2.5 bg-[var(--bg-surface)] text-[var(--text-primary)] border border-gray-600 rounded-lg text-sm font-medium hover:bg-gray-600 transition-colors cursor-pointer"
          >
            Rescan
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

      {/* WiFi password modal */}
      {selectedSSID && (
        <div className="fixed inset-0 flex items-center justify-center z-[100] p-6">
          <div className="fixed inset-0 bg-black/60" aria-hidden="true" role="presentation" />
          <div
            className="relative z-[101] w-full max-w-[400px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded-2xl p-8 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={`Connect to ${selectedSSID}`}
            ref={modalRef}
            tabIndex={-1}
          >
            <h2 className="text-lg font-semibold font-display mb-2">
              Connect to {selectedSSID}
            </h2>
            {!isOpen && (
              <div className="mt-4">
                <label htmlFor="wifi-password" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
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
                    placeholder="Enter WiFi password"
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
            )}
            {status && (
              <StatusMessage type={status.type} message={status.message} />
            )}
            {status?.type !== "success" && (
              <div className="flex items-center gap-3 mt-5">
                <button
                  type="button"
                  onClick={connectWifi}
                  disabled={connecting}
                  className="px-7 py-3 btn-gradient text-white rounded-lg text-sm font-semibold transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] disabled:opacity-50 disabled:hover:scale-100 cursor-pointer"
                >
                  {connecting ? "Connecting..." : "Connect"}
                </button>
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-5 py-2.5 bg-[var(--bg-surface)] text-[var(--text-primary)] border border-gray-600 rounded-lg text-sm font-medium hover:bg-gray-600 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
