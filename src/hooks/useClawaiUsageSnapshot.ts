"use client";

import { useEffect, useState } from "react";
import type { ClawaiUsage } from "@/lib/clawai-usage";

/** How often the chat re-reads the allowances. The server caches the portal's answer for 30 s. */
const POLL_MS = 120_000;

export interface ClawaiUsageSnapshot {
  usage: ClawaiUsage | null;
  timeZone: string | null;
}

/**
 * The box's ClawBox AI usage, as the chat keeps it at hand for one purpose:
 * when a turn dies on a bare rate limit, saying whether a spent allowance is
 * why and when it frees up (TASK-1602). Read from the same route the usage
 * card draws; any failure leaves the last snapshot (or nothing) in place.
 */
export function useClawaiUsageSnapshot(): ClawaiUsageSnapshot {
  const [snapshot, setSnapshot] = useState<ClawaiUsageSnapshot>({ usage: null, timeZone: null });
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/setup-api/ai-models/usage", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { available?: boolean; usage?: ClawaiUsage; timeZone?: string } | null) => {
          if (cancelled || !body) return;
          setSnapshot(body.available && body.usage
            ? { usage: body.usage, timeZone: typeof body.timeZone === "string" ? body.timeZone : null }
            : { usage: null, timeZone: null });
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return snapshot;
}
