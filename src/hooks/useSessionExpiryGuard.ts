"use client";

import { useLayoutEffect } from "react";
import { confirmSessionStillValid, installSessionExpiryGuard } from "@/lib/session-expiry";

/**
 * Take this page to /login the moment its session is over (src/lib/session-expiry.ts):
 * on the session gate's 401 to any `fetch` the page makes, and — for a page that
 * makes none while it sits in the background — when it is shown again.
 *
 * "Shown again" is three events, not one (TASK-2131). A phone that wakes fires
 * `visibilitychange` before its Wi-Fi is back, so that probe cannot reach the
 * box — which counts as "still signed in" — and the chat page, whose socket
 * died with the network, then sat on its error with nothing left to ask:
 * `online` asks once the network returns. A page the browser restores from its
 * back/forward cache fires `pageshow` with `persisted`, and no visibility
 * change at all.
 *
 * For the pages a signed-in person works in: the desktop and the standalone app
 * pages. Never the wizard or /login itself, which run before there is a session.
 */
export function useSessionExpiryGuard(): void {
  // A LAYOUT effect. A page's children run their passive effects before the
  // page runs its own — the apps' first reads on mount, the update screen's
  // first status poll — so a plain effect here wrapped `fetch` only after
  // those first requests had already gone out past it. Every layout effect in
  // the tree runs before any passive one. (React 19 skips layout effects on
  // the server without a warning.)
  useLayoutEffect(() => {
    const restoreFetch = installSessionExpiryGuard();
    const onVisible = () => {
      if (document.visibilityState === "visible") void confirmSessionStillValid();
    };
    const onOnline = () => {
      void confirmSessionStillValid();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void confirmSessionStillValid();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pageshow", onPageShow);
      restoreFetch();
    };
  }, []);
}
