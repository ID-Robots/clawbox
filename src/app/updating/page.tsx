"use client";

import { useEffect, useRef, useState } from "react";
import { I18nProvider, useT } from "@/lib/i18n";
import ReconnectStage from "@/components/ReconnectStage";

/**
 * The screen the owner sees while an update owns the box.
 *
 * The middleware sends every desktop navigation here for as long as the update
 * lock is set (src/lib/update-lock.ts), so this is a lock and not a courtesy
 * banner: `updateClawBoxAndReboot` runs `git reset --hard` and `git clean -fd`
 * over the project, and an app left open on the desktop can write through
 * /setup-api into the tree being rewritten underneath it.
 *
 * It is drawn with ReconnectStage — the same crab, pulse rings, orbiting dots
 * and step checklist the setup wizard uses for its own restart overlay — rather
 * than a bespoke spinner. That component already IS the device's wait screen;
 * a second one styled by hand would be a second answer to a settled question,
 * and it would drift.
 *
 * Three things it must get right, in order of how badly each one bites:
 *
 *  1. FAIL CLOSED. Partway through, do_rebuild stops the web server and the box
 *     serves nothing for minutes. A poll failing is the NORMAL course of an
 *     update, not evidence it ended — so a failed poll must never take this
 *     screen down. It is the exact inverse of the usual rule.
 *  2. NEVER TRAP THE OWNER. If the update dies, "no answer" would hold this
 *     screen for ever with no way back to Settings. After the rebuild's own
 *     budget plus a margin, it says so — and names the escape that actually
 *     works, which is a restart: at boot the updater finds no update to resume
 *     and releases the lock (resumeContinuation in src/lib/updater.ts). It does
 *     NOT offer a link to the desktop, because the middleware would redirect
 *     such a navigation straight back here.
 *  3. SAY WHAT IS TRUE. While the box answers, it names the step the server
 *     reports and the line that step last logged. While it does not, it says
 *     the device is restarting — and claims nothing about progress, because
 *     nothing is reporting.
 */

/** The rebuild's own budget (REBUILD_TAKEOVER_TIMEOUT_MS) plus room to reboot. */
const STUCK_AFTER_MS = 20 * 60 * 1000;
const POLL_MS = 2000;

interface Step { id: string; label: string; status: string }
interface UpdateStatus {
  phase?: string;
  steps?: Step[];
  currentStepIndex?: number;
  error?: string;
  /** The last line the running step logged, already redacted by the server. */
  log?: string;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function UpdatingScreen() {
  const { t } = useT();
  /**
   * Translated when the catalogue is there, English when it is not — never the
   * raw key.
   *
   * I18nProvider loads translations in an effect, through a dynamic import, so
   * the server always renders keys and the client fills them in. Every other
   * page can rely on that. This one cannot: it is the ONE screen guaranteed to
   * be open while the box is offline, and i18n.tsx says so itself — "a chunk
   * load can fail ... the device is offline mid-update ... keep whatever copy is
   * already in state (English, or the raw keys on a first load)". Raw keys for
   * the length of an outage is not an acceptable answer here.
   */
  const tr = (key: string, english: string) => {
    const value = t(key);
    return value === key ? english : value;
  };

  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [offline, setOffline] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // Not Date.now() arithmetic across a reboot — this clock only ever measures
  // how long THIS page has been open, in one process, on the viewer's device.
  const openedAt = useRef(Date.now());

  useEffect(() => {
    const tick = window.setInterval(() => setElapsed(Date.now() - openedAt.current), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch("/setup-api/update/status", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as UpdateStatus;
        if (stop) return;
        setOffline(false);
        setStatus(data);
        // The lock is the middleware's to release. Asking for the desktop again
        // is what tests it: while the flag is still set we are simply sent
        // back here, and the moment it clears the desktop loads.
        if (data.phase && data.phase !== "running") window.location.replace("/");
      } catch {
        // Expected, and for minutes at a time: the rebuild stops the server.
        // Hold the screen.
        if (!stop) setOffline(true);
      }
    };
    void poll();
    const id = window.setInterval(poll, POLL_MS);
    return () => { stop = true; window.clearInterval(id); };
  }, []);

  const steps = status?.steps ?? [];
  const labels = steps.map((s) => s.label);
  // The server's own index when it has one. It sets -1 the moment a run ends,
  // which must not be read as "step 0 is running".
  const reported = status?.currentStepIndex ?? -1;
  const running = steps.findIndex((s) => s.status === "running");
  const done = steps.filter((s) => s.status === "completed").length;
  const phaseIndex = running >= 0 ? running : (reported >= 0 ? reported : done);
  const stuck = elapsed > STUCK_AFTER_MS;

  // The amber callout: the one thing the owner may need to ACT on.
  const instruction = stuck
    ? tr(
        "update.stuckHint",
        "This is taking longer than an update usually does. Nothing has been lost. "
          + "If the device does not come back on its own, restart it — the desktop "
          + "unlocks by itself on the next start.",
      )
    : offline
      ? tr(
          "update.offlineHint",
          "The device is restarting and is not answering yet. This screen will return "
            + "to the desktop on its own.",
        )
      : undefined;

  // The muted callout underneath: what the running step is actually doing.
  // Absent while offline, because nothing is reporting and a stale line would
  // read as live.
  const detail = !offline && status?.log ? status.log : undefined;

  return (
    <>
      {/*
        A server-rendered floor, underneath the overlay.

        ReconnectStage draws through createPortal and returns null when there is
        no document, so on its own this page is BLANK until the client bundle
        runs. Every other page can live with that. This one cannot: the owner
        arrives here by a middleware redirect at the exact moment the update is
        about to stop the web server, and a chunk request that loses that race
        would leave them staring at nothing for the length of the outage — worse
        than the plain screen this styling replaced.
        So the same two sentences are emitted server-side, in the page's own
        ground, and the portal (z-index max, fixed inset-0) covers them the
        instant it mounts.
      */}
      <div
        className="fixed inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center"
        style={{ background: "var(--ground, #0a0f1a)" }}
        data-testid="updating-ssr-floor"
      >
        <h1 className="text-xl font-semibold text-[var(--text-primary,#fff)]">
          {tr("update.title", "System Update")}
        </h1>
        <p className="text-sm text-[var(--text-secondary,#9aa4b2)]">
          {tr("update.updatingDescription", "Updating your ClawBox with the latest software...")}
        </p>
      </div>

      <ReconnectStage
      steps={labels.length ? labels : [tr("update.preparingUpdate", "Preparing update...")]}
      phaseIndex={Math.max(0, phaseIndex)}
      completed={false}
      title={tr("update.title", "System Update")}
      description={tr("update.updatingDescription", "Updating your ClawBox with the latest software...")}
      instruction={instruction}
      secondaryInstruction={
        detail
          ? `${detail}${labels.length ? ` · ${done}/${labels.length} · ${clock(elapsed)}` : ""}`
          : labels.length
            ? `${done}/${labels.length} · ${clock(elapsed)}`
            : clock(elapsed)
      }
      />
    </>
  );
}

/**
 * The provider is mounted HERE, not inherited.
 *
 * The root layout is a server component and mounts no I18nProvider, and
 * `useT()` without one returns a fallback that renders the KEY — this screen
 * would have shown a literal "update.title" to the owner. /login and
 * /app/[id] each mount their own for exactly this reason; this is the third.
 */
export default function UpdatingPage() {
  return (
    <I18nProvider>
      <UpdatingScreen />
    </I18nProvider>
  );
}
