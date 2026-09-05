"use client";

import { useEffect } from "react";

/**
 * Tell the box which timezone it lives in, once, from the only source that
 * knows: the owner's browser.
 *
 * A ClawBox image ships as `Etc/UTC` and the wizard never asked, so the agent —
 * which runs ON the box — answered "10:11 AM UTC" while the desktop clock a few
 * centimetres away, rendered from this same browser, read "01:11 PM" (TASK-514).
 * The server cannot work the zone out for itself: its own
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` reads the box's OS zone,
 * which is the UTC being fixed.
 *
 * Mounted on the desktop as well as the wizard on purpose. A wizard-only answer
 * would fix the next install and leave every box already in the field — and
 * both dev boxes — in UTC for ever.
 *
 * ADOPTION, not synchronisation. It asks first and offers a zone only to a box
 * that has never been told one, so a support engineer opening the dashboard
 * from another country cannot retarget the owner's box; the server enforces the
 * same rule again with `adopt: true`. Changing the zone later is an explicit
 * act, not a side effect of who happens to be looking.
 *
 * Renders nothing and never reports a failure to the owner: an offline or
 * unauthenticated load simply asks again next time.
 */
export default function TimezoneAdopter() {
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let tz = "";
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      } catch {
        return;
      }
      // A browser that reports UTC tells us nothing a box already in UTC does
      // not know, and adopting it would stamp "answered" over a box that still
      // needs the question.
      if (!tz || tz === "UTC" || tz === "Etc/UTC") return;

      try {
        const res = await fetch("/setup-api/system/timezone");
        if (!res.ok || cancelled) return;
        const current = (await res.json()) as { adopted?: boolean };
        if (current.adopted || cancelled) return;

        await fetch("/setup-api/system/timezone", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ timezone: tz, adopt: true }),
        });
      } catch {
        // Offline, or not signed in yet. The next load asks again.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
