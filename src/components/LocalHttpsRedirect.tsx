"use client";

import { useEffect } from "react";

import { PROBE_FAILED_KEY, fetchHint, mayMove, movedUrl, probeLocalHttps } from "@/lib/local-https-client";

/**
 * Moves a top-level page on http://<IP> to the box's Local HTTPS address once
 * this browser has reached it (src/lib/local-https-client.ts says why the
 * browser decides). Renders nothing. Mounted once, in the root layout, so the
 * login page moves BEFORE sign-in and the owner signs in once, on the secure
 * origin.
 */
export default function LocalHttpsRedirect() {
  useEffect(() => {
    // A framed page (a web app, the portal's embed) is not the owner's tab to move.
    if (window.top !== window) return;
    if (!mayMove(window.location)) return;
    try {
      if (window.sessionStorage.getItem(PROBE_FAILED_KEY)) return;
    } catch {
      // Storage refused (private mode): probe anyway, it is one request.
    }
    let cancelled = false;
    void (async () => {
      const target = await fetchHint();
      if (!target || cancelled) return;
      if (await probeLocalHttps(target)) {
        if (!cancelled) window.location.replace(movedUrl(target, window.location));
        return;
      }
      try {
        window.sessionStorage.setItem(PROBE_FAILED_KEY, "1");
      } catch {
        // Nothing to remember it in.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
