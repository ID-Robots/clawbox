"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useT } from "@/lib/i18n";
import { formatBytesApart } from "@/lib/format-bytes";
import CrabWaitMark from "./CrabWaitMark";

/**
 * What `/setup-api/gateway/health` says about the agents' databases when they
 * are not on the schema the installed core expects (see
 * src/lib/openclaw-migration-status.ts). A gateway can listen with every agent
 * degraded; this is what keeps that from looking like a healthy one.
 */
interface GatewayMigration {
  state: "degraded" | "blocked";
  reason: string;
  requiredBytes: number | null;
  freeBytes: number | null;
}

function readMigration(value: unknown): GatewayMigration | null {
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  if ((m.state !== "degraded" && m.state !== "blocked") || typeof m.reason !== "string") return null;
  const bytes = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  return { state: m.state, reason: m.reason, requiredBytes: bytes(m.requiredBytes), freeBytes: bytes(m.freeBytes) };
}

function MigrationNotice({ migration }: { migration: GatewayMigration }) {
  const { t, locale } = useT();
  let body: string;
  if (migration.reason === "insufficient-disk" && migration.requiredBytes !== null && migration.freeBytes !== null) {
    const [required, free] = formatBytesApart(migration.requiredBytes, migration.freeBytes, locale);
    body = t("openclaw.migrationInsufficientDisk", { required, free });
  } else if (migration.reason === "migration-incomplete") {
    body = t("openclaw.migrationIncomplete");
  } else if (migration.reason === "schema-newer") {
    body = t("openclaw.migrationSchemaNewer");
  } else {
    body = t("openclaw.migrationSchemaBehind");
  }
  return (
    <div
      role="status"
      data-testid="openclaw-migration-notice"
      className="shrink-0 border-b border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
    >
      <p className="font-semibold">{t("openclaw.migrationTitle")}</p>
      <p className="mt-1 text-amber-100/80">{body}</p>
    </div>
  );
}

export default function OpenClawApp() {
  const { t } = useT();
  const [status, setStatus] = useState<"checking" | "running" | "not-running">("checking");
  const [migration, setMigration] = useState<GatewayMigration | null>(null);
  const [wsConfig, setWsConfig] = useState<{ wsUrl: string; token: string } | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkGateway = useCallback(async function runCheckGateway(auto = false) {
    if (!auto) retryRef.current = 0;
    setStatus("checking");
    try {
      const res = await fetch("/setup-api/gateway/health", { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      setMigration(readMigration(data?.migration));
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
      timerRef.current = setTimeout(() => {
        void runCheckGateway(true);
      }, 3000);
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
      <div className="h-full flex flex-col items-center justify-center gap-4 bg-[var(--bg-deep)]">
        {/* The device's own wait mark rather than a generic ring. This wait is
            the same KIND as the full-screen ones — the box's gateway is not
            answering yet — so it should look like them; ReconnectStage itself
            cannot be used here because it portals full-screen and would black
            out the desktop behind this window. */}
        <CrabWaitMark size={88} />
        <span className="text-sm text-white/50">{t("openclaw.connecting")}</span>
      </div>
    );
  }

  if (status === "not-running") {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-6 p-8 bg-[var(--bg-deep)]">
        <h2 className="text-xl font-semibold text-white">{t("openclaw.offline")}</h2>
        <p className="text-white/50 text-sm">{t("openclaw.notRunning")}</p>
        {migration && (
          <div className="max-w-lg overflow-hidden rounded-lg">
            <MigrationNotice migration={migration} />
          </div>
        )}
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
    <div className="h-full w-full flex flex-col">
      {migration && <MigrationNotice migration={migration} />}
      <iframe
        src={iframeSrc}
        className="w-full flex-1 min-h-0 border-0"
        title={t("openclaw.iframeTitle")}
      />
    </div>
  );
}
