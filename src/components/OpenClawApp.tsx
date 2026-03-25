"use client";

import { useState, useEffect, useCallback, useRef } from "react";

export default function OpenClawApp() {
  const [status, setStatus] = useState<"checking" | "running" | "not-running">("checking");
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkGateway = useCallback(async (auto = false) => {
    if (!auto) retryRef.current = 0;
    setStatus("checking");
    try {
      const res = await fetch("/setup-api/gateway/health", { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      if (data.available) {
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
        <span className="text-sm text-white/50">Connecting to OpenClaw gateway...</span>
      </div>
    );
  }

  if (status === "not-running") {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-6 p-8 bg-[#0a0f1a]">
        <h2 className="text-xl font-semibold text-white">OpenClaw Gateway Offline</h2>
        <p className="text-white/50 text-sm">The gateway service is not running.</p>
        <button
          onClick={() => checkGateway()}
          className="px-5 py-2 rounded-lg text-sm font-medium bg-[var(--coral-bright)] text-white hover:opacity-90 transition-opacity cursor-pointer"
        >
          Retry
        </button>
      </div>
    );
  }

  // Load through the Next.js proxy (same origin, port 80) so the gateway HTML
  // gets the ClawBox bar and auth token injection. The catch-all route at
  // /[...gateway] serves the gateway SPA with credentials pre-filled.
  return (
    <iframe
      src="/chat"
      className="w-full h-full border-0"
      title="OpenClaw Control"
    />
  );
}
