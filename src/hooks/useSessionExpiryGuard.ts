"use client";

import { useEffect } from "react";
import { confirmSessionStillValid, installSessionExpiryGuard } from "@/lib/session-expiry";

/**
 * Take this page to /login the moment its session is over (src/lib/session-expiry.ts):
 * on the session gate's 401 to any `fetch` the page makes, and — for a page that
 * makes none while it sits in the background — when it is shown again.
 *
 * For the pages a signed-in person works in: the desktop and the standalone app
 * pages. Never the wizard or /login itself, which run before there is a session.
 */
export function useSessionExpiryGuard(): void {
  useEffect(() => {
    const restoreFetch = installSessionExpiryGuard();
    const onVisible = () => {
      if (document.visibilityState === "visible") void confirmSessionStillValid();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      restoreFetch();
    };
  }, []);
}
