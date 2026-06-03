"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import SignalBars from "./SignalBars";
import StatusMessage from "./StatusMessage";
import WifiHandoffOverlay from "./WifiHandoffOverlay";
import type { WifiNetwork } from "@/lib/wifi-utils";
import { signalToLevel } from "@/lib/wifi-utils";
import { useT, LANGUAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import { useLocalUrl } from "@/hooks/useLocalUrl";

interface WifiStepProps {
  onNext: () => void;
}

export default function WifiStep({ onNext }: WifiStepProps) {
  const { locale, setLocale, t } = useT();
  const localUrl = useLocalUrl();
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
  // When set, the single-radio handoff is underway: show the full-screen
  // animated overlay that guides the user onto the home network and auto-
  // redirects to the box's new address once it's reachable there.
  const [handoffSsid, setHandoffSsid] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);
  // null = first probe in flight ("detecting…"); otherwise the live cable/connection state.
  const [eth, setEth] = useState<{ connected: boolean; cable: boolean } | null>(null);
  // True once a cable has been plugged in but hasn't gained internet for a while
  // (bad cable / dead port / no DHCP) — lets us nudge to Wi-Fi instead of
  // spinning on "Connecting…" forever with the recommended button disabled.
  const [cableStuck, setCableStuck] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  // Language picker state
  const [langOpen, setLangOpen] = useState(false);
  const langDropdownRef = useRef<HTMLDivElement>(null);

  // Abort any in-flight WiFi connect/poll when the step unmounts. (Kept separate
  // from the ethernet poll so the eth effect re-running never aborts a connect.)
  useEffect(() => () => { controllerRef.current?.abort(); }, []);

  // On mount, check whether a previous connect attempt failed. This is the
  // recovery path for a wrong password: the box couldn't join the home network,
  // reopened the ClawBox-Setup hotspot, and the user reconnected to it — landing
  // back here on a fresh page load. Surface the failure (with the SSID prefilled
  // for a quick retry) instead of silently restarting at the choice screen.
  useEffect(() => {
    let cancelled = false;
    fetch("/setup-api/wifi/connect-status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (cancelled || !s || s.phase !== "failed" || !s.ssid) return;
        // Only act on a recent failure so a stale verdict from a much earlier
        // session doesn't hijack a fresh setup attempt.
        if (typeof s.at === "number" && Date.now() - s.at > 10 * 60_000) return;
        setManualMode(true);
        setSsid(s.ssid);
        setStatus({
          type: "error",
          message: s.reason === "wrong-password"
            ? t("wifi.wrongPassword")
            : t("wifi.lostConnection", { url: localUrl }),
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // Run once on mount; t/localUrl are stable enough that re-running would only
    // risk clobbering user edits to the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll ethernet so plugging a cable in is detected live — but ONLY on the
  // initial choice screen and while not mid-WiFi-connect, so we don't spawn
  // nmcli on the bus during the single-radio handoff or refresh hidden UI.
  const onInitialScreen = !selectedNetwork && !manualMode && !showWifiList;
  useEffect(() => {
    if (!onInitialScreen || connecting) return;
    let cancelled = false;
    const pollEth = () => {
      fetch("/setup-api/wifi/ethernet", { cache: "no-store" })
        .then((r) => r.json())
        .then((data) => {
          if (!cancelled) setEth({ connected: data.connected === true, cable: data.cable === true });
        })
        .catch(() => {
          // A transport error says nothing about the cable — keep last-known-good
          // instead of de-gating the button on a transient hiccup.
          if (!cancelled) setEth((prev) => prev ?? { connected: false, cable: false });
        });
    };
    pollEth();
    const id = setInterval(pollEth, 3500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [onInitialScreen, connecting]);

  // Cable present but no internet for ~15s → surface a nudge (see cableStuck).
  useEffect(() => {
    if (eth?.cable && !eth.connected) {
      const id = setTimeout(() => setCableStuck(true), 15000);
      return () => clearTimeout(id);
    }
    setCableStuck(false);
  }, [eth?.cable, eth?.connected]);

  // Close language dropdown on outside click
  useEffect(() => {
    if (!langOpen) return;
    const handler = (e: MouseEvent) => {
      if (langDropdownRef.current && !langDropdownRef.current.contains(e.target as Node)) {
        setLangOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [langOpen]);

  const currentLang = LANGUAGES.find((l) => l.code === locale) ?? LANGUAGES[0];

  const [hasScanned, setHasScanned] = useState(false);

  const fetchNetworks = async () => {
    setLoadingNetworks(true);
    try {
      const res = await fetch("/setup-api/wifi/scan");
      if (res.ok) {
        const data = await res.json();
        if (data?.networks?.length > 0) {
          setNetworks(data.networks);
          setHasScanned(true);
        } else {
          // No cached results — trigger a live scan
          setNetworks(null);
          try {
            const liveRes = await fetch("/setup-api/wifi/scan?live=1", { method: "POST" });
            if (liveRes.ok) {
              const liveData = await liveRes.json();
              setNetworks(liveData?.networks?.length > 0 ? liveData.networks : []);
            } else {
              setNetworks([]);
            }
          } catch {
            setNetworks([]);
          }
          setHasScanned(true);
        }
      } else {
        setNetworks([]);
        setHasScanned(true);
      }
    } catch {
      setNetworks([]);
      setHasScanned(true);
    } finally {
      setLoadingNetworks(false);
    }
  };

  const rescan = async () => {
    setRescanning(true);
    try {
      const res = await fetch("/setup-api/wifi/scan?live=1", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.networks?.length > 0) setNetworks(data.networks);
      }
    } catch {}
    setRescanning(false);
  };

  const activeSsid = selectedNetwork?.ssid ?? ssid.trim();

  const connectWifi = async () => {
    if (!activeSsid) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setConnecting(true);
    // The radio is single-band: joining the home network tears down the setup
    // hotspot, so this connect can't return its result synchronously (we lose
    // the box mid-switch). Kick it off, then poll /wifi/connect-status, which
    // survives the outage and tells us "wrong password" / "connected".
    setStatus({ type: "info", message: t("wifi.switching", { ssid: activeSsid }) });

    try {
      const res = await fetch("/setup-api/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: activeSsid, password }),
        signal: controller.signal,
      });
      // A 4xx is a validation error (bad SSID etc.) — surface it immediately.
      if (res.status >= 400 && res.status < 500) {
        const errData = await res.json().catch(() => ({}));
        setConnecting(false);
        setStatus({ type: "error", message: errData.error || `Connection failed (${res.status})` });
        return;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // The hotspot may already be dropping — expected; fall through to polling.
    }
    if (controller.signal.aborted) return;

    // The switch is underway and the hotspot is dropping — surface the
    // full-screen handoff overlay so the user gets an animated "joining…,
    // reconnect this device, we'll auto-continue" loop instead of a frozen
    // form. We keep polling connect-status underneath: if the box restores the
    // AP and reports a failure (e.g. wrong password), we dismiss the overlay
    // and show the error; otherwise the overlay carries the success path
    // (probe the home-network address, then redirect there).
    setHandoffSsid(activeSsid);

    // Poll for the outcome, tolerating the hotspot outage during the switch.
    // The failure path is connect-attempt + AP-restore, so give it generous
    // headroom — otherwise a slow restore would trip the deadline and we'd
    // mis-report a wrong password as success. The window is long because on a
    // wrong password the box reopens ClawBox-Setup and the user must manually
    // reconnect THIS device to it before our poll can reach the box again;
    // give them ample time to do so rather than silently assuming success.
    const deadline = Date.now() + 300_000;
    const poll = async () => {
      if (controller.signal.aborted) return;
      if (Date.now() > deadline) {
        // Never got a terminal status: almost always SUCCESS — the box joined
        // the home network and the hotspot is gone, so we can't reach it from
        // here. Leave the overlay up; it guides the user to the home network
        // and redirects to the box's new address once reachable.
        return;
      }
      try {
        const r = await fetch("/setup-api/wifi/connect-status", { cache: "no-store", signal: controller.signal });
        const s = await r.json();
        if (s.phase === "failed") {
          setHandoffSsid(null);
          setConnecting(false);
          setStatus(
            s.reason === "wrong-password"
              ? { type: "error", message: t("wifi.wrongPassword") }
              : { type: "error", message: t("wifi.lostConnection", { url: localUrl }) }
          );
          return;
        }
        if (s.phase === "connected") {
          // Box joined the home network — leave the overlay up to detect the
          // new address and redirect there (resumes at Step 2). No onNext():
          // advancing this page is pointless once we've lost the box here.
          return;
        }
      } catch {
        // Hotspot down mid-switch — expected; keep polling until it returns.
      }
      if (!controller.signal.aborted) setTimeout(poll, 2500);
    };
    setTimeout(poll, 3000);
  };

  const skipEthernet = () => {
    fetch("/setup-api/wifi/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skip: true }),
    }).catch(() => {});
    onNext();
  };

  const showForm = selectedNetwork || manualMode;

  return (
    <div className="w-full max-w-[520px]" data-testid="setup-step-wifi">
      {handoffSsid && <WifiHandoffOverlay ssid={handoffSsid} targetUrl={localUrl} />}
      <div className="card-surface rounded-2xl p-5 sm:p-8">
        <div className="flex flex-col items-center gap-2 mb-5 sm:mb-6">
          <Image
            src="/clawbox-crab.png"
            alt="ClawBox"
            width={120}
            height={120}
            className="w-20 h-20 sm:w-[120px] sm:h-[120px] object-contain animate-welcome-powerup"
            priority
          />
          <h1 className="text-xl sm:text-2xl font-bold font-display text-center">
            {t("wifi.welcome")}
          </h1>
          <p className="text-xs text-[var(--text-muted)] text-center">
            {t("wifi.subtitle")}
          </p>
        </div>

        {/* Language selector — shown on initial choice screen */}
        {!showForm && !showWifiList && (
          <>
            <div ref={langDropdownRef} className="relative mb-5">
              <label className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
                {t("wifi.language")}
              </label>
              <button
                type="button"
                onClick={() => setLangOpen((v) => !v)}
                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-left cursor-pointer hover:border-[var(--coral-bright)] transition-colors"
              >
                <span className="text-base leading-none">{currentLang.flag}</span>
                <span className="flex-1 text-gray-200">{currentLang.label}</span>
                <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 18 }}>
                  {langOpen ? "expand_less" : "expand_more"}
                </span>
              </button>

              {langOpen && (
                <div className="absolute z-20 left-0 right-0 mt-1 bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-lg shadow-xl overflow-hidden">
                  <div className="max-h-[240px] overflow-y-auto">
                    {LANGUAGES.map((lang) => (
                      <button
                        key={lang.code}
                        type="button"
                        onClick={() => {
                          setLocale(lang.code as Locale);
                          setLangOpen(false);
                        }}
                        className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left border-none cursor-pointer transition-colors text-sm ${
                          locale === lang.code ? "bg-orange-500/10 text-gray-200" : "bg-transparent text-gray-300 hover:bg-[var(--bg-deep)]"
                        }`}
                      >
                        <span className="text-base leading-none">{lang.flag}</span>
                        <span className="flex-1">{lang.label}</span>
                        {locale === lang.code && (
                          <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 16 }}>check</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Ethernet status — recommended path, polled live so plugging a
                cable in updates instantly. connected → ready; cable-only →
                getting internet; no cable → recommend a cable or use Wi-Fi. */}
            <div className="mb-5">
              {eth?.connected ? (
                <div className="flex items-center gap-3 px-4 py-3 bg-[#00e5cc]/10 border border-[#00e5cc]/20 rounded-lg">
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[#00e5cc]/20 shrink-0">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#00e5cc] animate-pulse" />
                  </span>
                  <span className="text-sm text-[#00e5cc]">{t("wifi.ethConnected")}</span>
                </div>
              ) : eth?.cable ? (
                <div className="flex items-center gap-3 px-4 py-3 bg-amber-400/10 border border-amber-400/20 rounded-lg">
                  {cableStuck ? (
                    <span className="material-symbols-rounded text-amber-300 shrink-0" style={{ fontSize: 18 }}>warning</span>
                  ) : (
                    <div className="spinner !w-4 !h-4 !border-2 shrink-0" />
                  )}
                  <span className="text-sm text-amber-300">{cableStuck ? t("wifi.ethStuck") : t("wifi.ethConnecting")}</span>
                </div>
              ) : (
                <p className="text-xs text-amber-400/80 leading-relaxed px-1">
                  <span className="font-semibold">{t("recommended")}:</span> {t("wifi.ethNoCable")}
                </p>
              )}
            </div>
            {/* Stacked: Ethernet is the recommended primary action (full width so
                the label + badge stay on one line), Wi-Fi is the alternative. */}
            <div className="flex flex-col gap-3 mt-2 mb-2">
              <button
                type="button"
                onClick={skipEthernet}
                disabled={eth?.connected !== true}
                className="w-full py-3 px-4 btn-gradient text-white rounded-lg text-sm font-semibold transition transform hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed"
              >
                <span className="whitespace-nowrap">
                  {eth?.cable && !eth?.connected ? t("connecting") : t("wifi.proceedEthernet")}
                </span>
                <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide rounded bg-white/20 text-white leading-none">{t("recommended")}</span>
              </button>
              {/* Once ethernet is actually connected, the cable is all that's
                  needed to finish setup — hide the Wi-Fi alternative to keep
                  the choice clean. (While a cable is plugged but hasn't gained
                  internet yet, keep it visible as a fallback.) */}
              {eth?.connected !== true && (
                <button
                  type="button"
                  onClick={() => { setShowWifiList(true); fetchNetworks(); }}
                  className="w-full py-2.5 bg-transparent border border-[#fb923c]/40 text-[#fb923c] rounded-lg text-sm font-semibold cursor-pointer hover:border-[#fb923c] hover:bg-[#fb923c]/10 active:scale-[0.98] transition"
                >
                  {t("wifi.useWifiInstead")}
                </button>
              )}
            </div>
          </>
        )}

        {/* Network list (shown after clicking Connect to WiFi) */}
        {!showForm && showWifiList && !loadingNetworks && hasScanned && networks !== null && (
          <>
            {networks.length > 0 ? (
              <div className="border border-[var(--border-subtle)] rounded-lg overflow-hidden mb-3">
                <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border-subtle)]/30">
                  <span className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">
                    {t("wifi.availableNetworks")}
                  </span>
                  <button
                    type="button"
                    onClick={rescan}
                    disabled={rescanning}
                    aria-label={t("wifi.refresh")}
                    className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer p-1 disabled:opacity-50 transition-colors"
                  >
                    <span className={`material-symbols-rounded ${rescanning ? "animate-spin" : ""}`} style={{ fontSize: 16 }}>refresh</span>
                    {rescanning ? t("wifi.scanning") : t("wifi.refresh")}
                  </button>
                </div>
                <div className="max-h-[240px] overflow-y-auto">
                  {networks.map((net) => (
                    <button
                      key={net.ssid}
                      type="button"
                      onClick={() => { setSelectedNetwork(net); setSsid(net.ssid); setManualMode(false); setPassword(""); setStatus(null); }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left bg-transparent border-none cursor-pointer hover:bg-[var(--bg-surface)]/50 transition-colors border-b border-[var(--border-subtle)]/30 last:border-b-0"
                    >
                      <SignalBars level={signalToLevel(net.signal)} />
                      <span className="flex-1 text-sm text-[var(--text-primary)] truncate">{net.ssid}</span>
                      {net.security && net.security !== "" && net.security !== "--" && (
                        <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 16 }}>lock</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 mb-3 py-4">
                <p className="text-sm text-[var(--text-muted)]">{t("wifi.noNetworks")}</p>
                <button
                  type="button"
                  onClick={rescan}
                  disabled={rescanning}
                  className="flex items-center gap-2 px-5 py-2.5 btn-gradient text-white rounded-lg text-sm font-semibold cursor-pointer disabled:opacity-50 transition transform hover:scale-105 active:scale-[0.98] shadow-lg shadow-[rgba(249,115,22,0.25)]"
                >
                  <span className={`material-symbols-rounded ${rescanning ? "animate-spin" : ""}`} style={{ fontSize: 18 }}>refresh</span>
                  {rescanning ? t("wifi.scanning") : t("wifi.scanNow")}
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => { setManualMode(true); setSelectedNetwork(null); setSsid(""); setPassword(""); setStatus(null); }}
              className="w-full flex items-center gap-3 px-4 py-3 text-left bg-transparent border border-[var(--border-subtle)] rounded-lg cursor-pointer hover:bg-[var(--bg-surface)]/50 transition-colors"
            >
              <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 18 }}>edit</span>
              <span className="text-sm text-[var(--text-secondary)]">{t("wifi.otherNetwork")}</span>
            </button>

            <button
              type="button"
              onClick={() => { setShowWifiList(false); setNetworks(null); }}
              className="bg-transparent border-none text-[#fb923c] text-sm underline cursor-pointer p-1 mt-2"
            >
              {t("back")}
            </button>
          </>
        )}

        {/* Loading spinner */}
        {showWifiList && loadingNetworks && (
          <div className="flex items-center justify-center gap-2.5 py-6 text-[var(--text-secondary)] text-sm">
            <div className="spinner !w-5 !h-5 !border-2" /> {t("wifi.findingNetworks")}
          </div>
        )}

        {/* Password form */}
        {showForm && (
          <>
            <div className="flex flex-col gap-4">
              {manualMode && (
                <div>
                  <label htmlFor="wifi-ssid" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">{t("wifi.networkName")}</label>
                  <input
                    id="wifi-ssid" type="text" value={ssid}
                    onChange={(e) => setSsid(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") connectWifi(); }}
                    placeholder={t("wifi.enterNetworkName")} autoComplete="off" autoFocus
                    className="w-full px-3.5 py-2.5 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
                  />
                </div>
              )}
              {selectedNetwork && (
                <div className="flex items-center gap-3 px-4 py-3 bg-[var(--bg-surface)] rounded-lg">
                  <SignalBars level={signalToLevel(selectedNetwork.signal)} />
                  <span className="flex-1 text-sm font-medium text-[var(--text-primary)] truncate">{selectedNetwork.ssid}</span>
                  {selectedNetwork.security && selectedNetwork.security !== "" && selectedNetwork.security !== "--" && (
                    <span className="text-xs text-[var(--text-muted)]">{selectedNetwork.security}</span>
                  )}
                </div>
              )}
              <div>
                <label htmlFor="wifi-password" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">{t("wifi.password")}</label>
                <div className="relative">
                  <input
                    id="wifi-password" type={showPassword ? "text" : "password"} value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") connectWifi(); }}
                    placeholder={t("wifi.enterPassword")} autoComplete="off" autoFocus={!manualMode}
                    className="w-full px-3.5 py-2.5 pr-10 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
                  />
                  <button
                    type="button" onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer p-0.5"
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{showPassword ? "visibility_off" : "visibility"}</span>
                  </button>
                </div>
              </div>
            </div>

            {status && (
              <div className="mt-4"><StatusMessage type={status.type} message={status.message} /></div>
            )}

            <p className="text-xs text-amber-400/80 mt-4 leading-relaxed">
              <span className="font-semibold">{t("wifi.wifiNotePrefix")}</span> {t("wifi.wifiNote")}{" "}
              <span className="font-semibold">{localUrl}</span>.
            </p>

            <div className="flex items-center gap-3 mt-3">
              <button
                type="button" onClick={connectWifi} disabled={connecting || !activeSsid}
                className="px-7 py-3 btn-gradient text-white rounded-lg text-sm font-semibold transition transform hover:scale-105 active:scale-[0.98] shadow-lg shadow-[rgba(249,115,22,0.25)] disabled:opacity-50 disabled:hover:scale-100 cursor-pointer"
              >
                {connecting ? t("connecting") : t("wifi.connect")}
              </button>
              <button
                type="button"
                onClick={() => { setSelectedNetwork(null); setManualMode(false); setStatus(null); setPassword(""); }}
                className="bg-transparent border-none text-[#fb923c] text-sm underline cursor-pointer p-1"
              >
                {t("back")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
