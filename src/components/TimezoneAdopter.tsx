"use client";

import { useEffect } from "react";

/**
 * Tell the box which timezone it lives in, from the only source that knows: the
 * owner's browser.
 *
 * A ClawBox image ships as `Etc/UTC` and the wizard never asked, so the agent —
 * which runs ON the box — answered "10:11 AM UTC" while the desktop clock a few
 * centimetres away, rendered from this same browser, read "01:11 PM" (TASK-514).
 * The server cannot work the zone out for itself: what it would read is the
 * box's own OS zone, which is the UTC being fixed.
 *
 * Mounted on the DESKTOP, and only there. The wizard was tried and does not
 * work: `/setup-api/*` answers 401 until the credentials step has run
 * (`src/lib/setup-api-gate.ts`), and this effect fires once on mount, so on a
 * real first boot it would 401 and never ask again — while `CLAWBOX_TEST_MODE`
 * would make it pass in e2e. The wizard hands off to `/` when it finishes, and
 * the desktop is where the box learns its zone.
 *
 * ADOPTION, not synchronisation, and the SERVER owns the rule: a zone a person
 * chose explicitly is never overwritten by whoever opens the dashboard next.
 * An adopted one does follow the owner's browser, deliberately — "the first
 * browser to open the desktop wins for ever" would strand a box QA'd in one
 * country and used in another, and self-correcting beats permanently wrong.
 *
 * Renders nothing and never reports a failure to the owner: an offline load,
 * or one where the harness write did not land, simply asks again next time —
 * which is the point of reading `applied` rather than "a zone is recorded".
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
      // A browser reporting UTC tells a box already in UTC nothing, and
      // adopting it would stamp "answered" over one that still needs the
      // question.
      if (!tz || tz === "UTC" || tz === "Etc/UTC") return;

      try {
        const res = await fetch("/setup-api/system/timezone");
        if (!res.ok || cancelled) return;
        const current = (await res.json()) as {
          timezone?: string | null;
          applied?: boolean;
          acceptsAdoption?: boolean;
        };
        if (cancelled) return;
        // The owner chose one — leave it alone.
        if (current.acceptsAdoption === false) return;
        // Already this zone AND actually applied. `applied` is the load-bearing
        // half: a box whose harness write failed has the zone recorded and the
        // agent still in UTC, and that is precisely the box that must be asked
        // again.
        if (current.timezone === tz && current.applied) return;

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
