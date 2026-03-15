"use client";

import { useState, useEffect, useCallback } from "react";

const GATEWAY_PORT = 18789;

export default function OpenClawApp() {
  const [status, setStatus] = useState<"checking" | "running" | "not-running">("checking");

  const checkGateway = useCallback(async () => {
    setStatus("checking");
    try {
      const res = await fetch("/setup-api/gateway/health");
      const data = await res.json();
      setStatus(data.available ? "running" : "not-running");
    } catch {
      setStatus("not-running");
    }
  }, []);

  useEffect(() => {
    checkGateway();
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
        <p className="text-white/50 text-sm">The gateway service is not running on port {GATEWAY_PORT}.</p>
        <button
          onClick={checkGateway}
          className="px-5 py-2 rounded-lg text-sm font-medium bg-[var(--coral-bright)] text-white hover:opacity-90 transition-opacity cursor-pointer"
        >
          Retry
        </button>
      </div>
    );
  }

  const hostname = typeof window !== "undefined" ? window.location.hostname : "localhost";

  return (
    <iframe
      src={`http://${hostname}:${GATEWAY_PORT}`}
      className="w-full h-full border-0"
      title="OpenClaw Control"
    />
  );
}
