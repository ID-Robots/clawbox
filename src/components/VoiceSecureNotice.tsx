"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { fetchTunnelDestination, tunnelPageUrl, type TunnelDestination } from "@/lib/voice-tunnel";

/**
 * The line a chat on an insecure origin carries about voice input (TASK-2058).
 *
 * On http://<ip>/ the browser removes the capture API, so the microphone can
 * never open THERE. That used to surface only once the owner had clicked the
 * mic, as a red error line — a fault on a box that has none. This says it
 * beforehand, in the composer's quiet voice, together with the one thing that
 * helps: this very page on the box's Remote Access tunnel when that is
 * running, and where to turn it on when it is not. The popup a mic click
 * opens (VoiceTunnelDialog, TASK-470) stays; this is its passive half.
 *
 * Same live read as the popup, at the moment the line appears: Quick Tunnel
 * hostnames change on every restart, so nothing is cached or guessed, and a
 * read that failed says so instead of claiming the tunnel is off.
 */
export default function VoiceSecureNotice({
  onDismiss,
  onOpenRemoteAccess,
  navigate = (url: string) => { window.location.assign(url); },
}: {
  onDismiss: () => void;
  /** Opens Settings → Remote Control. */
  onOpenRemoteAccess: () => void;
  /** Injection point for tests; production always navigates the page. */
  navigate?: (url: string) => void;
}) {
  const { t } = useT();
  const [destination, setDestination] = useState<TunnelDestination | null>(null);

  useEffect(() => {
    let alive = true;
    fetchTunnelDestination().then((d) => { if (alive) setDestination(d); });
    return () => { alive = false; };
  }, []);

  const settings = t("remoteControl.title");
  const text =
    destination === null ? t("chat.voice.secureNotice.checking")
    : destination.kind === "ready" ? t("chat.voice.secureNotice.ready")
    : destination.kind === "off" ? t("chat.voice.secureNotice.off", { settings })
    : t("chat.voice.secureNotice.failed", { settings });
  const linkStyle = {
    background: "none", border: "none", padding: 0, cursor: "pointer",
    color: "rgba(255,255,255,0.85)", textDecoration: "underline", fontSize: 11.5, flexShrink: 0,
  } as const;

  return (
    <div
      data-testid="voice-secure-notice"
      data-tunnel={destination?.kind ?? "checking"}
      role="note"
      style={{
        padding: "6px 14px", display: "flex", alignItems: "center", gap: 8,
        background: "rgba(0,0,0,0.2)", fontSize: 11.5, color: "rgba(255,255,255,0.6)",
      }}
    >
      <span className="material-symbols-rounded" aria-hidden style={{ fontSize: 15, flexShrink: 0 }}>info</span>
      <span style={{ flex: 1, whiteSpace: "normal" }}>{text}</span>
      {destination?.kind === "ready" && (
        <button
          type="button"
          data-testid="voice-secure-notice-go"
          onClick={() => navigate(tunnelPageUrl(destination.url, window.location))}
          style={linkStyle}
        >
          {t("chat.voice.tunnel.open")}
        </button>
      )}
      {(destination?.kind === "off" || destination?.kind === "failed") && (
        <button
          type="button"
          data-testid="voice-secure-notice-settings"
          onClick={onOpenRemoteAccess}
          style={linkStyle}
        >
          {t("chat.voice.secureNotice.openSettings", { settings })}
        </button>
      )}
      <button
        type="button"
        data-testid="voice-secure-notice-dismiss"
        onClick={onDismiss}
        aria-label={t("chat.voice.dismiss")}
        title={t("chat.voice.dismiss")}
        style={{ ...linkStyle, textDecoration: "none", display: "flex", color: "rgba(255,255,255,0.5)" }}
      >
        <span className="material-symbols-rounded" aria-hidden style={{ fontSize: 15 }}>close</span>
      </button>
    </div>
  );
}
