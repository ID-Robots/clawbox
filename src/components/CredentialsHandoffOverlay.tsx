"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import ReconnectStage from "./ReconnectStage";
import { imgProbe } from "@/lib/handoff-probe";

interface CredentialsHandoffOverlayProps {
  /** Full setup URL (…/setup) to probe and, when the address changed, redirect to. */
  targetUrl: string;
  /**
   * True when the box reappears at the SAME mDNS origin (hostname unchanged) —
   * we fetch-probe and continue in place. False when the device name changed
   * (clawbox.local → newname.local): a cross-origin <img> probe, then redirect.
   */
  sameOrigin: boolean;
  /**
   * The (new) hotspot name when the setup AP actually restarted — shown so the
   * user knows which network to rejoin with their new password. Null when no
   * rejoin is needed (e.g. only the device name changed over Ethernet).
   */
  hotspotSsid: string | null;
  /** Advance to the next step once the box is reachable again (same-origin only). */
  onContinue: () => void;
  /** Grace period before probing — the AP needs a moment to actually drop. */
  graceMs?: number;
}

type Phase = "applying" | "waiting" | "done";

/**
 * Full-screen overlay for the Step 3 → 4 handoff. Saving new credentials can
 * restart the setup hotspot (and optionally rename the device), which drops
 * anyone reaching the wizard through that AP. Everything stays on clawbox.local:
 * once the box answers again (the user rejoins the renamed hotspot, or their
 * Ethernet/home link never really dropped) we continue automatically. For an
 * Ethernet user the probe succeeds almost immediately, so they barely see this.
 */
export default function CredentialsHandoffOverlay({
  targetUrl,
  sameOrigin,
  hotspotSsid,
  onContinue,
  graceMs = 4000,
}: CredentialsHandoffOverlayProps) {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>("applying");

  // onContinue is typically an inline arrow from the parent, so its identity
  // changes each render — keep it in a ref so the probe loop isn't restarted.
  const onContinueRef = useRef(onContinue);
  useEffect(() => {
    onContinueRef.current = onContinue;
  }, [onContinue]);

  useEffect(() => {
    let cancelled = false;
    let loopTimer: ReturnType<typeof setTimeout> | null = null;

    // Same origin → fetch HEAD works. A 405 (method not allowed) still proves
    // the server is up, so treat any response as reachable.
    async function fetchProbe(): Promise<boolean> {
      try {
        const res = await fetch(targetUrl, {
          method: "HEAD",
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        });
        return res.ok || (res.status >= 200 && res.status < 500);
      } catch {
        return false;
      }
    }

    const graceTimer = setTimeout(() => {
      if (cancelled) return;
      setPhase("waiting");
      let attempt = 0;
      const loop = async () => {
        if (cancelled) return;
        attempt += 1;
        const reachable = sameOrigin
          ? await fetchProbe()
          : await imgProbe(targetUrl.replace(/\/setup\/?$/, ""), attempt);
        if (cancelled) return;
        if (reachable) {
          setPhase("done");
          setTimeout(() => {
            if (cancelled) return;
            if (sameOrigin) onContinueRef.current();
            else window.location.replace(targetUrl);
          }, 1600);
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
  }, [targetUrl, sameOrigin, graceMs]);

  const completed = phase === "done";
  const phaseIndex = phase === "applying" ? 0 : phase === "waiting" ? 1 : 2;

  let prettyUrl = targetUrl;
  try {
    prettyUrl = new URL(targetUrl).host;
  } catch {
    /* keep raw */
  }

  const rejoinLabel = hotspotSsid ? t("credentials.handoffRejoin", { ssid: hotspotSsid }) : t("settings.waitingOnline");

  return (
    <ReconnectStage
      steps={[t("credentials.handoffApplying"), rejoinLabel, t("settings.backOnline")]}
      phaseIndex={phaseIndex}
      completed={completed}
      title={completed ? t("settings.backOnline") : t("credentials.handoffTitle")}
      description={completed ? t("ai.almostReady") : t("credentials.handoffDesc")}
      instruction={completed || !hotspotSsid ? undefined : rejoinLabel}
      action={completed ? undefined : { label: t("wifi.openUrl", { url: prettyUrl }), href: targetUrl }}
    />
  );
}
