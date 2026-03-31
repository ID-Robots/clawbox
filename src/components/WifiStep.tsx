"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import SignalBars from "./SignalBars";
import StatusMessage from "./StatusMessage";
import type { WifiNetwork } from "@/lib/wifi-utils";
import { signalToLevel } from "@/lib/wifi-utils";

interface WifiStepProps {
  onNext: () => void;
}

export default function WifiStep({ onNext }: WifiStepProps) {
  const [showWifiList, setShowWifiList] = useState(false);
  const [networks, setNetworks] = useState<WifiNetwork[] | null>(null);
  const [loadingNetworks, setLoadingNetworks] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [selectedNetwork, setSelectedNetwork] = useState<WifiNetwork | null>(null);
  const [manualMode, setManualMode] = useState(false);
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

  const fetchNetworks = async () => {
    setLoadingNetworks(true);
    try {
      const res = await fetch("/setup-api/wifi/scan");
      if (res.ok) {
        const data = await res.json();
        if (data?.networks && data.networks.length > 0) {
          setNetworks(data.networks);
        } else {
          setNetworks([]);
        }
      } else {
        setNetworks([]);
      }
    } catch {
      setNetworks([]);
    } finally {
      setLoadingNetworks(false);
    }
  };

  const rescan = async () => {
    setRescanning(true);
    try {
      // Use iw scan — works in AP mode without dropping the hotspot
      const res = await fetch("/setup-api/wifi/scan?live=1", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.networks && data.networks.length > 0) {
          setNetworks(data.networks);
        }
      }
    } catch {
      // ignored
    }
    setRescanning(false);
  };

  const activeSsid = selectedNetwork?.ssid ?? ssid.trim();

  const connectWifi = async () => {
    if (!activeSsid) return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setConnecting(true);
    setStatus(null);
    try {
      const res = await fetch("/setup-api/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: activeSsid, password }),
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

  const showForm = selectedNetwork || manualMode;

  return (
    <div className="w-full max-w-[520px]">
      <div className="card-surface rounded-2xl p-8">
        <div className="flex flex-col items-center gap-2 mb-6">
          <Image
            src="/clawbox-crab.png"
            alt="ClawBox"
            width={120}
            height={120}
            className="w-[120px] h-[120px] object-contain animate-welcome-powerup"
            priority
          />
          <h1 className="text-2xl font-bold font-display text-center">
            Welcome
          </h1>
        </div>
        <p className="text-[var(--text-secondary)] mb-6 leading-relaxed text-center">
          Connect ClawBox to the internet.
        </p>

        {/* Initial choice: Ethernet or WiFi */}
        {!showForm && !showWifiList && (
          <div className="flex flex-col sm:flex-row gap-3 mt-3">
            <button
              type="button"
              onClick={() => {
                fetch("/setup-api/wifi/connect", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ skip: true }),
                }).catch(() => {});
                onNext();
              }}
              className="w-full sm:flex-1 py-3 btn-gradient text-white rounded-lg text-sm font-semibold transition transform hover:scale-[1.02] shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer"
            >
              Ethernet <span className="ml-1.5 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide rounded bg-white/15 text-white/80 leading-none">Recommended</span>
            </button>
            <button
              type="button"
              onClick={() => { setShowWifiList(true); fetchNetworks(); }}
              className="w-full sm:flex-1 py-3 bg-transparent border border-[#fb923c]/40 text-[#fb923c] rounded-lg text-sm font-semibold cursor-pointer hover:border-[#fb923c] hover:bg-[#fb923c]/10 transition"
            >
              Connect to WiFi
            </button>
          </div>
        )}

        {/* Network list (shown after clicking Connect to WiFi) */}
        {!showForm && showWifiList && !loadingNetworks && networks !== null && (
          <>

            {/* Network list */}
            {networks.length > 0 ? (
              <div className="border border-[var(--border-subtle)] rounded-lg overflow-hidden mb-3">
                <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border-subtle)]/30">
                  <span className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">
                    Available Networks
                  </span>
                  <button
                    type="button"
                    onClick={rescan}
                    disabled={rescanning}
                    aria-label="Refresh networks"
                    className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer p-1 disabled:opacity-50 transition-colors"
                  >
                    <span
                      className={`material-symbols-rounded ${rescanning ? "animate-spin" : ""}`}
                      style={{ fontSize: 16 }}
                    >
                      refresh
                    </span>
                    {rescanning ? "Scanning..." : "Refresh"}
                  </button>
                </div>
                <div className="max-h-[240px] overflow-y-auto">
                  {networks.map((net) => (
                    <button
                      key={net.ssid}
                      type="button"
                      onClick={() => {
                        setSelectedNetwork(net);
                        setSsid(net.ssid);
                        setManualMode(false);
                        setPassword("");
                        setStatus(null);
                      }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left bg-transparent border-none cursor-pointer hover:bg-[var(--bg-surface)]/50 transition-colors border-b border-[var(--border-subtle)]/30 last:border-b-0"
                    >
                      <SignalBars level={signalToLevel(net.signal)} />
                      <span className="flex-1 text-sm text-[var(--text-primary)] truncate">
                        {net.ssid}
                      </span>
                      {net.security && net.security !== "" && net.security !== "--" && (
                        <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 16 }}>
                          lock
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm text-[var(--text-muted)]">
                  No networks found.
                </p>
                <button
                  type="button"
                  onClick={rescan}
                  disabled={rescanning}
                  className="flex items-center gap-1.5 text-xs text-[#fb923c] hover:text-orange-300 bg-transparent border-none cursor-pointer p-1 disabled:opacity-50 transition-colors"
                >
                  <span
                    className={`material-symbols-rounded ${rescanning ? "animate-spin" : ""}`}
                    style={{ fontSize: 16 }}
                  >
                    refresh
                  </span>
                  {rescanning ? "Scanning..." : "Scan now"}
                </button>
              </div>
            )}

            {/* Manual entry option */}
            <button
              type="button"
              onClick={() => {
                setManualMode(true);
                setSelectedNetwork(null);
                setSsid("");
                setPassword("");
                setStatus(null);
              }}
              className="w-full flex items-center gap-3 px-4 py-3 text-left bg-transparent border border-[var(--border-subtle)] rounded-lg cursor-pointer hover:bg-[var(--bg-surface)]/50 transition-colors"
            >
              <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 18 }}>
                edit
              </span>
              <span className="text-sm text-[var(--text-secondary)]">
                Other network...
              </span>
            </button>

            <button
              type="button"
              onClick={() => { setShowWifiList(false); setNetworks(null); }}
              className="bg-transparent border-none text-[#fb923c] text-sm underline cursor-pointer p-1 mt-2"
            >
              Back
            </button>
          </>
        )}

        {/* Loading spinner */}
        {showWifiList && loadingNetworks && (
          <div className="flex items-center justify-center gap-2.5 py-6 text-[var(--text-secondary)] text-sm">
            <div className="spinner !w-5 !h-5 !border-2" /> Finding networks...
          </div>
        )}

        {/* Password form (after selecting a network or manual entry) */}
        {showForm && (
          <>
            <div className="flex flex-col gap-4">
              {manualMode && (
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
                    autoFocus
                    className="w-full px-3.5 py-2.5 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
                  />
                </div>
              )}

              {selectedNetwork && (
                <div className="flex items-center gap-3 px-4 py-3 bg-[var(--bg-surface)] rounded-lg">
                  <SignalBars level={signalToLevel(selectedNetwork.signal)} />
                  <span className="flex-1 text-sm font-medium text-[var(--text-primary)] truncate">
                    {selectedNetwork.ssid}
                  </span>
                  {selectedNetwork.security && selectedNetwork.security !== "" && selectedNetwork.security !== "--" && (
                    <span className="text-xs text-[var(--text-muted)]">
                      {selectedNetwork.security}
                    </span>
                  )}
                </div>
              )}

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
                    autoFocus={!manualMode}
                    className="w-full px-3.5 py-2.5 pr-10 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer p-0.5"
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 18 }}>
                      {showPassword ? "visibility_off" : "visibility"}
                    </span>
                  </button>
                </div>
              </div>
            </div>

            {status && (
              <div className="mt-4">
                <StatusMessage type={status.type} message={status.message} />
              </div>
            )}

            <p className="text-xs text-amber-400/80 mt-4 leading-relaxed">
              <span className="font-semibold">Note:</span> Connecting to WiFi will stop the ClawBox-Setup hotspot.
              You will lose this connection and need to join your home WiFi to continue setup at{" "}
              <span className="font-semibold">http://clawbox.local</span>.
            </p>

            <div className="flex items-center gap-3 mt-3">
              <button
                type="button"
                onClick={connectWifi}
                disabled={connecting || !activeSsid}
                className="px-7 py-3 btn-gradient text-white rounded-lg text-sm font-semibold transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] disabled:opacity-50 disabled:hover:scale-100 cursor-pointer"
              >
                {connecting ? "Connecting..." : "Connect"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedNetwork(null);
                  setManualMode(false);
                  setStatus(null);
                  setPassword("");
                }}
                className="bg-transparent border-none text-[#fb923c] text-sm underline cursor-pointer p-1"
              >
                Back
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
