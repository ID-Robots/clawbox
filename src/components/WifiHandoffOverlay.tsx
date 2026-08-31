"use client";

import { useT } from "@/lib/i18n";
import ReconnectStage from "./ReconnectStage";
import { imgProbe } from "@/lib/handoff-probe";
import { useReconnect } from "@/hooks/useReconnect";

interface WifiHandoffOverlayProps {
  /** The network the box is joining — shown in the copy. */
  ssid: string;
  /** Home-network address the box reappears at (e.g. http://clawbox.local). */
  targetUrl: string;
  /** Grace period before we start probing the new address. */
  graceMs?: number;
}

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

  // Cross-origin <img> probe (the box reappears at a new address a fetch can't
  // reach), then redirect to its setup page on the home network.
  const phase = useReconnect({
    probe: (attempt) => imgProbe(targetUrl, attempt),
    onReady: () => {
      window.location.href = `${targetUrl}/setup`;
    },
    graceMs,
    readyDelayMs: 1500,
  });

  const completed = phase === "ready";
  const phaseIndex = completed ? 1 : 0;
  const setupUrl = `${targetUrl.replace(/\/+$/, "")}/setup`;
  let prettyUrl = targetUrl;
  try {
    prettyUrl = new URL(targetUrl).host;
  } catch {
    /* keep raw */
  }

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
      instruction={completed ? undefined : t("wifi.handoffInstruction", { url: targetUrl })}
      // Once we're actively waiting for the box to reappear, surface the
      // wrong-password recovery path: if the box couldn't join, it reopens the
      // ClawBox-Setup hotspot, so the user must reconnect THIS device to it to
      // get back into the wizard (and see the error).
      secondaryInstruction={!completed ? t("wifi.handoffRecover", { ap: "ClawBox-Setup" }) : undefined}
      action={completed ? undefined : { label: t("wifi.openUrl", { url: prettyUrl }), href: setupUrl }}
    />
  );
}
