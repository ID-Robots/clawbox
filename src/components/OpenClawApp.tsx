"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useT } from "@/lib/i18n";

export default function OpenClawApp() {
  const { t } = useT();
  const [status, setStatus] = useState<"checking" | "running" | "not-running">("checking");
  const [wsConfig, setWsConfig] = useState<{ wsUrl: string; token: string } | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkGateway = useCallback(async (auto = false) => {
    if (!auto) retryRef.current = 0;
    setStatus("checking");
    try {
      const res = await fetch("/setup-api/gateway/health", { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      if (data.available) {
        // Fetch WS config for token + URL to pass to the SPA
        try {
          const cfgRes = await fetch("/setup-api/gateway/ws-config", { signal: AbortSignal.timeout(3000) });
          const cfg = await cfgRes.json();
          if (cfg.wsUrl) setWsConfig(cfg);
        } catch { /* token injection via HTML will be the fallback */ }
        setStatus("running");
        retryRef.current = 0;
        return;
      }
    } catch { /* fall through */ }

    // Auto-retry up to 15 times (covers ~45s gateway startup)
    if (retryRef.current < 15) {
      retryRef.current++;
      timerRef.current = setTimeout(() => checkGateway(true), 3000);
    } else {
      setStatus("not-running");
    }
  }, []);

  useEffect(() => {
    checkGateway();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [checkGateway]);

  if (status === "checking") {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 bg-[#0a0f1a]">
        <div className="w-8 h-8 rounded-full border-2 border-[var(--coral-bright)] border-t-transparent animate-spin" />
        <span className="text-sm text-white/50">{t("openclaw.connecting")}</span>
      </div>
    );
  }

  if (status === "not-running") {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-6 p-8 bg-[#0a0f1a]">
        <h2 className="text-xl font-semibold text-white">{t("openclaw.offline")}</h2>
        <p className="text-white/50 text-sm">{t("openclaw.notRunning")}</p>
        <button
          onClick={() => checkGateway()}
          className="px-5 py-2 rounded-lg text-sm font-medium bg-[var(--coral-bright)] text-white hover:opacity-90 transition-opacity cursor-pointer"
        >
          {t("openclaw.retry")}
        </button>
      </div>
    );
  }

  // Pass gatewayUrl + token via URL so the SPA picks them up directly,
  // avoiding sessionStorage key mismatches between port 80 and 18789.
  const iframeSrc = wsConfig
    ? `/chat?gatewayUrl=${encodeURIComponent(wsConfig.wsUrl)}#token=${encodeURIComponent(wsConfig.token)}`
    : "/chat";

  return (
    <iframe
      src={iframeSrc}
      className="w-full h-full border-0"
      title={t("openclaw.iframeTitle")}
    />
  );
}
