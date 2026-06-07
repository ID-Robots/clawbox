"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import ReconnectStage from "./ReconnectStage";
import { imgProbe } from "@/lib/handoff-probe";

interface WifiHandoffOverlayProps {
  /** The network the box is joining — shown in the copy. */
  ssid: string;
  /** Home-network address the box reappears at (e.g. http://clawbox.local). */
  targetUrl: string;
  /** Grace period before we start probing the new address. */
  graceMs?: number;
}

type Phase = "switching" | "waiting" | "found";

/**
 * Full-screen overlay for the WiFi network-switch handoff (setup Step 1→2).
 *
 * The single-radio box tears down its setup hotspot to join the home network,
 * so it becomes unreachable from the user's current connection (the now-dead
 * AP). We can't auto-refresh the same origin. Instead we keep the user in an
 * animated loop, tell them to move THIS device onto the home network, and
 * best-effort probe the box's new address (an <img> load survives cross-origin
 * where fetch is blocked by CORS). When the box answers, we auto-redirect to
 * its setup page on the home network; a manual button covers the rest.
 */
export default function WifiHandoffOverlay({ ssid, targetUrl, graceMs = 4000 }: WifiHandoffOverlayProps) {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>("switching");

  useEffect(() => {
    let cancelled = false;
    let loopTimer: ReturnType<typeof setTimeout> | null = null;

    const graceTimer = setTimeout(() => {
      if (cancelled) return;
      setPhase("waiting");
      let attempt = 0;
      const loop = async () => {
        if (cancelled) return;
        attempt += 1;
        const reachable = await imgProbe(targetUrl, attempt);
        if (cancelled) return;
        if (reachable) {
          setPhase("found");
          setTimeout(() => {
            if (!cancelled) window.location.href = `${targetUrl}/setup`;
          }, 1500);
          return;
        }
        loopTimer = setTimeout(loop, 2500);
      };
      loop();
    }, graceMs);

    return () => {
      cancelled = true;
      clearTimeout(graceTimer);
      if (loopTimer) clearTimeout(loopTimer);
    };
  }, [targetUrl, graceMs]);

  const completed = phase === "found";
  const phaseIndex = completed ? 1 : 0;

  return (
    <ReconnectStage
      steps={[
        t("wifi.handoffJoining", { ssid }),
        t("settings.backOnline"),
      ]}
      phaseIndex={phaseIndex}
      completed={completed}
      title={completed ? t("settings.backOnline") : t("wifi.handoffTitle")}
      description={completed ? t("ai.almostReady") : t("wifi.switching", { ssid })}
      instruction={completed ? undefined : t("wifi.connectedMessage", { url: targetUrl })}
      // Once we're actively waiting for the box to reappear, surface the
      // wrong-password recovery path: if the box couldn't join, it reopens the
      // ClawBox-Setup hotspot, so the user must reconnect THIS device to it to
      // get back into the wizard (and see the error).
      secondaryInstruction={phase === "waiting" ? t("wifi.handoffRecover", { ap: "ClawBox-Setup" }) : undefined}
    />
  );
}
