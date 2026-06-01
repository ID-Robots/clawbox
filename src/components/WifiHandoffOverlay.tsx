"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import ReconnectStage from "./ReconnectStage";

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

    function probe(attempt: number): Promise<boolean> {
      return new Promise((resolve) => {
        const img = document.createElement("img");
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          img.onload = null;
          img.onerror = null;
          resolve(ok);
        };
        img.onload = () => finish(true);
        img.onerror = () => finish(false);
        // Cache-busted so a previously-failed probe isn't served from cache.
        img.src = `${targetUrl}/clawbox-icon.png?probe=${attempt}`;
        setTimeout(() => finish(false), 4000);
      });
    }

    const graceTimer = setTimeout(() => {
      if (cancelled) return;
      setPhase("waiting");
      let attempt = 0;
      const loop = async () => {
        if (cancelled) return;
        attempt += 1;
        const reachable = await probe(attempt);
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
  const phaseIndex = phase === "switching" ? 0 : phase === "waiting" ? 1 : 2;

  return (
    <ReconnectStage
      steps={[
        t("wifi.handoffJoining", { ssid }),
        t("wifi.handoffReconnect", { ssid }),
        t("settings.backOnline"),
      ]}
      phaseIndex={phaseIndex}
      completed={completed}
      title={completed ? t("settings.backOnline") : t("wifi.handoffTitle")}
      description={completed ? t("ai.almostReady") : t("wifi.switching", { ssid })}
      instruction={completed ? undefined : t("wifi.connectedMessage", { url: targetUrl })}
      action={completed ? undefined : { label: t("wifi.openUrl", { url: targetUrl }), href: `${targetUrl}/setup` }}
    />
  );
}
