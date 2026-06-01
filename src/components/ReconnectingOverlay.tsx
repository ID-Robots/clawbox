"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import ReconnectStage from "./ReconnectStage";

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

type Phase = "restarting" | "reconnecting" | "done";

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
  const [phase, setPhase] = useState<Phase>("restarting");

  useEffect(() => {
    let cancelled = false;
    let pollId: ReturnType<typeof setInterval> | null = null;

    const graceTimer = setTimeout(() => {
      if (cancelled) return;
      setPhase("reconnecting");
      pollId = setInterval(async () => {
        try {
          const res = await fetch(healthUrl, {
            cache: "no-store",
            signal: AbortSignal.timeout(3000),
          });
          if (cancelled || !res.ok) return;
          if (pollId) clearInterval(pollId);
          setPhase("done");
          setTimeout(() => {
            if (cancelled) return;
            if (redirectTo) window.location.replace(redirectTo);
            else window.location.reload();
          }, 1600);
        } catch {
          /* device still offline — keep looping */
        }
      }, 2500);
    }, graceMs);

    return () => {
      cancelled = true;
      clearTimeout(graceTimer);
      if (pollId) clearInterval(pollId);
    };
  }, [healthUrl, redirectTo, graceMs]);

  const completed = phase === "done";
  const phaseIndex = phase === "restarting" ? 0 : phase === "reconnecting" ? 1 : 2;

  return (
    <ReconnectStage
      steps={[t("wizard.restarting"), t("settings.waitingOnline"), t("settings.backOnline")]}
      phaseIndex={phaseIndex}
      completed={completed}
      title={
        completed
          ? t("settings.backOnline")
          : phase === "reconnecting"
            ? t("settings.reconnecting")
            : t("wizard.restarting")
      }
      description={completed ? t("ai.almostReady") : t("ai.pleaseDontClose")}
    />
  );
}
