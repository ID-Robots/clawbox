"use client";

import { useT } from "@/lib/i18n";
import ReconnectStage from "./ReconnectStage";
import { useReconnect } from "@/hooks/useReconnect";

interface ReconnectingOverlayProps {
  /**
   * Endpoint polled until it responds OK, signalling the device's web server
   * is back after a service/hardware restart. Defaults to the setup status
   * route, which is always reachable while the wizard is up.
   */
  healthUrl?: string;
  /**
   * Where to send the browser once the device is back. When omitted the page
   * is reloaded in place (the setup status route resumes the right step).
   */
  redirectTo?: string;
  /**
   * Grace period before polling begins. The device needs a moment to actually
   * go down — polling immediately would get a stale "still up" response.
   */
  graceMs?: number;
}

/**
 * Full-screen overlay shown while the device restarts and the browser's
 * connection drops on the SAME network (manual restart, or the reboot inside a
 * version update). Keeps the customer in a friendly animated loop, polls until
 * the web server answers again, then reloads/redirects.
 *
 * For the WiFi network-switch case (box leaves the AP for the home network),
 * use WifiHandoffOverlay instead — the box reappears at a different address the
 * browser can only reach after the user moves their own device.
 */
export default function ReconnectingOverlay({
  healthUrl = "/setup-api/setup/status",
  redirectTo,
  graceMs = 4000,
}: ReconnectingOverlayProps) {
  const { t } = useT();

  // Same-network restart → poll the health endpoint until it answers OK, then
  // reload in place (or redirect). A thrown fetch / non-OK just keeps looping.
  const phase = useReconnect({
    probe: async () => {
      try {
        const res = await fetch(healthUrl, {
          cache: "no-store",
          signal: AbortSignal.timeout(3000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    onReady: () => {
      if (redirectTo) window.location.replace(redirectTo);
      else window.location.reload();
    },
    graceMs,
    readyDelayMs: 1600,
  });

  const completed = phase === "ready";
  const phaseIndex = phase === "grace" ? 0 : phase === "probing" ? 1 : 2;

  return (
    <ReconnectStage
      steps={[t("wizard.restarting"), t("settings.waitingOnline"), t("settings.backOnline")]}
      phaseIndex={phaseIndex}
      completed={completed}
      title={
        completed
          ? t("settings.backOnline")
          : phase === "probing"
            ? t("settings.reconnecting")
            : t("wizard.restarting")
      }
      description={completed ? t("ai.almostReady") : t("ai.pleaseDontClose")}
    />
  );
}
