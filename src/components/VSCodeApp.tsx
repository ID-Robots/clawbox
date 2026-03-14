"use client";

/**
 * VSCodeApp — Embeds code-server (VS Code in the browser) via iframe.
 * Uses server-side health check, then loads code-server directly.
 */

import { useState, useEffect, useCallback } from "react";

export default function VSCodeApp() {
  const [status, setStatus] = useState<"checking" | "running" | "not-running">("checking");
  const [port, setPort] = useState(8080);

  const checkServer = useCallback(async () => {
    setStatus("checking");
    try {
      const res = await fetch("/setup-api/code-server");
      const data = await res.json();
      if (data.available) {
        setPort(data.port || 8080);
        setStatus("running");
      } else {
        setStatus("not-running");
      }
    } catch {
      setStatus("not-running");
    }
  }, []);

  useEffect(() => {
    checkServer();
  }, [checkServer]);

  if (status === "checking") {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3" style={{ background: "#1e1e1e" }}>
        <div
          className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin"
          style={{ borderColor: "#007acc", borderTopColor: "transparent" }}
        />
        <span className="text-sm" style={{ color: "#808080" }}>
          Connecting to code-server...
        </span>
      </div>
    );
  }

  if (status === "not-running") {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-6 p-8 overflow-y-auto" style={{ background: "#1e1e1e" }}>
        <div className="flex items-center gap-3">
          <svg viewBox="0 0 100 100" className="w-16 h-16">
            <path d="M97.2 25.3L76.7 4.8c-2.3-2.3-5.6-3.2-8.8-2.5L31.4 37.6 13.2 23.9c-2.1-1.6-5-1.4-6.9.3l-4.5 4.5c-2.3 2.3-2.3 6 0 8.3L17.7 50 1.8 63c-2.3 2.3-2.3 6 0 8.3l4.5 4.5c1.9 1.8 4.8 1.9 6.9.3l18.2-13.7 36.5 35.3c2.1 2.1 5 3 7.9 2.5l1-.2c2.4-.5 4.4-2.1 5.4-4.3l20-48.8V25.3zM71.2 75.7L41.1 50l30.1-25.7v51.4z" fill="#007acc"/>
          </svg>
          <h2 className="text-xl font-semibold text-white">VS Code</h2>
        </div>

        <div className="max-w-md text-center space-y-3">
          <p className="text-white/60 text-sm">
            code-server is not running on port {port}.
          </p>
          <p className="text-white/40 text-xs">
            Install and start code-server to use VS Code in the browser.
          </p>
        </div>

        <div className="w-full max-w-lg space-y-2">
          <p className="text-xs text-white/50 font-medium">Install code-server:</p>
          <pre className="bg-black/40 rounded-lg p-3 text-xs text-green-400 font-mono overflow-x-auto border border-white/10">
{`curl -fsSL https://code-server.dev/install.sh | sh`}
          </pre>

          <p className="text-xs text-white/50 font-medium mt-3">Configure (no auth for local use):</p>
          <pre className="bg-black/40 rounded-lg p-3 text-xs text-green-400 font-mono overflow-x-auto border border-white/10">
{`# ~/.config/code-server/config.yaml
bind-addr: 0.0.0.0:${port}
auth: none
cert: false`}
          </pre>

          <p className="text-xs text-white/50 font-medium mt-3">Start code-server:</p>
          <pre className="bg-black/40 rounded-lg p-3 text-xs text-green-400 font-mono overflow-x-auto border border-white/10">
{`code-server --bind-addr 0.0.0.0:${port} --auth none`}
          </pre>

          <p className="text-xs text-white/50 font-medium mt-3">Or run as a service:</p>
          <pre className="bg-black/40 rounded-lg p-3 text-xs text-green-400 font-mono overflow-x-auto border border-white/10">
{`sudo systemctl enable --now code-server@$USER`}
          </pre>
        </div>

        <div className="flex items-center gap-3 mt-2">
          <button
            onClick={checkServer}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer"
            style={{ background: "#007acc", color: "#fff" }}
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  // Load code-server directly — cross-origin iframe works since
  // code-server doesn't set X-Frame-Options or frame-ancestors
  const hostname = typeof window !== "undefined" ? window.location.hostname : "localhost";

  return (
    <iframe
      src={`http://${hostname}:${port}?folder=/home`}
      className="w-full h-full border-0"
      title="VS Code"
      allow="clipboard-read; clipboard-write"
    />
  );
}
