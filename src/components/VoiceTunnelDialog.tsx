"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";
import { fetchTunnelDestination, type TunnelDestination } from "@/lib/voice-tunnel";

/**
 * The popup behind the chat microphone on an insecure origin (TASK-470).
 *
 * On http://<ip>/ the browser removes the capture API before anyone can be
 * asked for permission, so the mic can never work THERE — but it works on the
 * box's Remote Access tunnel, which is https. Yanko's decision (2026-08-22
 * 19:34): clicking the mic on the LAN explains that and offers a real,
 * one-click route to this box's OWN tunnel address, read live from tunnel
 * state at the moment the popup opens — never hardcoded, never cached,
 * because Quick Tunnel hostnames change on every restart. When the tunnel is
 * not running, the popup says so and points at the setting that starts it;
 * offering a dead link would be worse than the message it replaces.
 */
export default function VoiceTunnelDialog({
  open,
  onClose,
  navigate = (url: string) => { window.location.assign(url); },
}: {
  open: boolean;
  onClose: () => void;
  /** Injection point for tests; production always navigates the page. */
  navigate?: (url: string) => void;
}) {
  const { t } = useT();
  const [destination, setDestination] = useState<TunnelDestination | null>(null);

  useEffect(() => {
    if (!open) { setDestination(null); return; }
    let alive = true;
    fetchTunnelDestination().then((d) => { if (alive) setDestination(d); });
    return () => { alive = false; };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const settingsName = t("remoteControl.title");
  const body =
    destination === null ? t("chat.voice.tunnel.checking")
    : destination.kind === "ready" ? t("chat.voice.tunnel.ready")
    : destination.kind === "off" ? t("chat.voice.tunnel.off", { settings: settingsName })
    : t("chat.voice.tunnel.failed", { settings: settingsName });

  return createPortal(
    <div
      onClick={onClose}
      data-testid="voice-tunnel-overlay"
      style={{
        position: "fixed", inset: 0, zIndex: 10020,
        background: "rgba(0,0,0,0.6)", backdropFilter: "blur(2px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.voice.tunnel.title")}
        data-testid="voice-tunnel-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(420px, 100%)", borderRadius: 14,
          background: "#1c1c22", border: "1px solid rgba(255,255,255,0.1)",
          boxShadow: "0 8px 40px rgba(0,0,0,0.6)", padding: "18px 20px",
          color: "rgba(255,255,255,0.9)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <span className="material-symbols-rounded" aria-hidden style={{ fontSize: 22, color: "#f97316" }}>mic</span>
          <span style={{ fontSize: 14.5, fontWeight: 600 }}>{t("chat.voice.tunnel.title")}</span>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "rgba(255,255,255,0.7)" }}>
          {body}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button
            type="button"
            onClick={onClose}
            data-testid="voice-tunnel-close"
            style={{
              padding: "7px 14px", borderRadius: 9, fontSize: 12.5, cursor: "pointer",
              background: "rgba(255,255,255,0.08)", border: "none", color: "rgba(255,255,255,0.75)",
            }}
          >
            {t("chat.voice.tunnel.close")}
          </button>
          {destination?.kind === "ready" && (
            <button
              type="button"
              onClick={() => navigate(destination.url)}
              data-testid="voice-tunnel-go"
              style={{
                padding: "7px 14px", borderRadius: 9, fontSize: 12.5, cursor: "pointer",
                background: "#f97316", border: "none", color: "#1c1207", fontWeight: 600,
              }}
            >
              {t("chat.voice.tunnel.open")}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
