"use client";

import { useEffect, useState } from "react";
import { I18nProvider } from "@/lib/i18n";
import { useTr } from "@/lib/i18n-floor";
import { useFollowSessionSwitch } from "@/lib/session-switch";
import { useSessionExpiryGuard } from "@/hooks/useSessionExpiryGuard";
import {
  canResume,
  runHeadline,
  runStatus,
  UpdateRunView,
  useUpdateRun,
  type RunNotice,
  type VersionInfo,
} from "@/components/UpdateRunView";

/**
 * The screen the owner sees while an update owns the box.
 *
 * The middleware sends every desktop navigation here for as long as the update
 * lock is set (src/lib/update-lock.ts), so this is a lock and not a courtesy
 * banner: `updateClawBoxAndReboot` runs `git reset --hard` and `git clean -fd`
 * over the project, and an app left open on the desktop can write through
 * /setup-api into the tree being rewritten underneath it.
 *
 * It is drawn with the System Update app's own run view (UpdateRunView) and
 * follows the run with the same hook. It used to be a separate wait screen,
 * and the owner who started an update in Settings watched the run view for a
 * few seconds before the desktop's notice poll and the middleware moved them
 * here, onto the other screen, for the rest of the update (TASK-2111). One
 * screen, from the click to the desktop coming back. The app no longer draws a
 * live run at all: the click shows a short full-screen loader on this page's
 * ground and comes straight here (UpdateHandover, TASK-2146).
 *
 * Four things it must get right, in order of how badly each one bites:
 *
 *  1. FAIL CLOSED. Partway through, do_rebuild stops the web server and the box
 *     serves nothing for minutes. A poll failing is the NORMAL course of an
 *     update, not evidence it ended — so a failed poll must never take this
 *     screen down. It is the exact inverse of the usual rule. The first answer
 *     after such an outage reloads the page onto the build the box now serves
 *     (an "idle" answer does not: see the hook).
 *  2. NEVER TRAP THE OWNER. If the update dies, "no answer" would hold this
 *     screen for ever with no way back to Settings. After the rebuild's own
 *     budget plus a margin, it says so — and names the escape that actually
 *     works, which is a restart: at boot the updater finds no update to resume
 *     and releases the lock (resumeContinuation in src/lib/updater.ts). It does
 *     NOT offer a link to the desktop, because the middleware would redirect
 *     such a navigation straight back here. The same hint replaces "returning
 *     to the desktop" on a finished run whose lock is never released, and the
 *     clock starts again for a run the owner resumes from here. A run that
 *     stops says so with its step and reason, Resume where the box can resume
 *     it, and Dismiss, which clears the verdict and goes back to the desktop —
 *     or, when the box does not take it, keeps the verdict and says why.
 *  3. LEAVE WHEN THE LOCK DOES. The lock is the middleware's to release, and
 *     the middleware marks every /setup-api answer while it is set
 *     (UPDATE_LOCK_HEADER). A finished run — or none — on an answer without
 *     that mark is the desktop open again: "Update complete" for a moment,
 *     then the desktop. While the mark is there the screen stays, so it never
 *     bounces between here and a desktop the middleware sends straight back.
 *  4. SAY WHAT IS TRUE. While the box answers, it names the step the server
 *     reports and the line that step last logged. While it does not, it says
 *     the device is restarting — and claims nothing about progress, because
 *     nothing is reporting.
 *
 * Beside the steps — after them on a phone — the "What's new" panel shows the
 * highlights of the version being installed (TASK-1205). It is secondary in
 * every sense: asked for on its own timer rather than inside the status poll,
 * held in memory across the outage once it has arrived, asked again of the
 * server that comes back, and never empty when it could not be read (see
 * `updateWhatsNewPanel`).
 *
 * The page is a client component, so the server renders the view's first
 * state — "System Update · Updating your device · Connecting…" and "Don't
 * power off" — in English. The owner arrives here by a redirect at about the
 * moment the update stops the web server, and a chunk request that loses that
 * race still leaves them those words rather than a blank page.
 */

/** The rebuild's own budget (REBUILD_TAKEOVER_TIMEOUT_MS) plus room to reboot. */
const STUCK_AFTER_MS = 25 * 60 * 1000;
/** How long "Update complete" stays up before the desktop replaces it. */
const RETURN_AFTER_COMPLETE_MS = 3_000;

function UpdatingScreen() {
  // Translated when the catalogue is there, English when it is not — never the
  // raw key. I18nProvider loads translations in an effect, through a dynamic
  // import, and this is the ONE screen guaranteed to be open while the box is
  // offline: i18n.tsx says so itself — "a chunk load can fail ... the device is
  // offline mid-update". Raw keys for the length of an outage is not an
  // acceptable answer here.
  const tr = useTr();
  const run = useUpdateRun({ hold: true });
  const [versions, setVersions] = useState<VersionInfo | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  // The run this page is timing: bumped when the owner starts one from here
  // (Resume, or "Back up and update anyway"), so a verdict that sat on screen
  // for half an hour does not greet the run after it with "restart it".
  const [runEpoch, setRunEpoch] = useState(0);
  const [stuckEpoch, setStuckEpoch] = useState<number | null>(null);
  const stuck = stuckEpoch === runEpoch;

  // Not Date.now() arithmetic across a reboot — this only ever measures how
  // long THIS page has been open (or this run been going), in one process, on
  // the viewer's device.
  useEffect(() => {
    const id = window.setTimeout(() => setStuckEpoch(runEpoch), STUCK_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [runEpoch]);
  const startRun = (allowDowngrade = false) => {
    setRunEpoch((n) => n + 1);
    void run.trigger(allowDowngrade);
  };

  // The version row: what the box runs, what it is going to, and the channel.
  // Asked once, and again after an outage only if the first ask got nothing;
  // what arrived is kept, like the What's new panel, because the server that
  // comes back reports the build it now runs.
  const haveVersions = versions !== null;
  useEffect(() => {
    if (haveVersions) return;
    let stop = false;
    void (async () => {
      const read = async <T,>(url: string): Promise<T | null> => {
        try {
          const res = await fetch(url, { cache: "no-store" });
          return res.ok ? ((await res.json()) as T) : null;
        } catch {
          return null;
        }
      };
      const [v, b] = await Promise.all([
        read<VersionInfo>("/setup-api/update/versions"),
        read<{ branch?: unknown; effective?: { branch?: unknown } | null }>("/setup-api/system/update-branch"),
      ]);
      if (stop) return;
      if (v?.clawbox) setVersions(v);
      const followed = typeof b?.effective?.branch === "string" ? b.effective.branch : b?.branch;
      if (typeof followed === "string" && followed) setChannel(followed);
    })();
    return () => { stop = true; };
  }, [haveVersions, run.reconnects]);

  const status = runStatus(run.state, run.error);

  // Leave when the lock does (3, above). "completed" stays up a moment so the
  // owner sees how the run ended; "idle" is a run that is not this screen's
  // to show, and goes at once.
  const answer = run.answer;
  const leave = answer && !answer.locked && (answer.phase === "completed" || answer.phase === "idle")
    ? answer.phase
    : null;
  useEffect(() => {
    if (!leave) return;
    const id = window.setTimeout(
      () => window.location.replace("/"),
      leave === "completed" ? RETURN_AFTER_COMPLETE_MS : 0,
    );
    return () => window.clearTimeout(id);
  }, [leave]);

  // The line across the bottom: the one thing the owner may need to ACT on.
  // A finished run says it is going back to the desktop — unless its lock is
  // still held past the budget, when that promise is the one thing not
  // happening and the restart hint takes its place.
  const notice: RunNotice | undefined = status === "failed"
    ? undefined
    : status === "completed" && (leave === "completed" || !stuck)
      ? { icon: "task_alt", title: tr("update.returningToDesktop", "Update complete. Returning to the desktop…") }
      : stuck
        ? {
            icon: "warning",
            tone: "warn",
            title: tr(
              "update.stuckHint",
              "This is taking longer than an update usually does. Nothing has been lost. "
                + "If the device does not come back on its own, restart it — the desktop "
                + "unlocks by itself on the next start.",
            ),
          }
        : run.offline
          ? {
              icon: "power_settings_new",
              title: tr("update.heroUpdatingSub", "Don't power off until this finishes."),
              note: tr(
                "update.offlineHint",
                "ClawBox is restarting and is not answering yet. This screen will return "
                  + "to the desktop on its own.",
              ),
            }
          : undefined;

  const { headline, subhead } = runHeadline(status, run.state, tr);

  // On a computer's screen a live or finished run fills it, top to bottom
  // (TASK-2137): `data-update-screen` (the run's status) and the frame's `us-*`
  // marks are what the run view's own CSS lays out (UPDATE_SCREEN_CSS). A
  // phone scrolls the stacked view, and a stopped run keeps the window's layout.
  return (
    <div className="h-dvh w-full overflow-y-auto bg-[var(--ground,#0a0f1a)] text-gray-200" data-testid="updating-screen" data-update-screen={status}>
      <main className="us-page min-h-full w-full flex items-start justify-center p-6 pt-8 bg-[var(--bg-deep,#111827)]">
        <div className="us-frame w-full max-w-[1200px]">
          <UpdateRunView
            fill
            status={status}
            state={run.state}
            error={run.error}
            versions={versions}
            channel={channel}
            heading="h1"
            headline={headline}
            lede={subhead}
            offline={run.offline}
            reconnects={run.reconnects}
            notice={notice}
            dismissError={run.dismissError}
            // Dismiss clears the verdict on the server and goes back to the
            // desktop; a click the server did not take stays, and says so.
            onDismiss={() => {
              void run.dismiss().then((outcome) => {
                if (outcome === "dismissed") window.location.replace("/");
              });
            }}
            // Resume starts the fresh run that continues an interrupted one,
            // and this screen follows it like the first.
            onResume={canResume(run.state) ? () => startRun() : undefined}
            onOverrideDowngrade={() => startRun(true)}
          />
        </div>
      </main>
    </div>
  );
}

/**
 * The provider is mounted HERE, not inherited.
 *
 * The root layout is a server component and mounts no I18nProvider, and
 * `useT()` without one returns a fallback that renders the KEY — the view's
 * English floor would have been all the owner ever saw, in any language.
 * /login and /app/[id] each mount their own for exactly this reason; this is
 * the third.
 */
export default function UpdatingPage() {
  // Signed-in page like the desktop: a sign-in or sign-out in another tab
  // reopens it on the session that now holds (TASK-1247).
  useFollowSessionSwitch();
  // And to /login when the session runs out (src/lib/session-expiry.ts). The
  // status poll reads any failure as the rebuild having stopped the server, so
  // a session that ran out during a long update held this screen for ever. A
  // stopped server is no sign-out: only the session gate's marked 401,
  // confirmed by a probe, leaves.
  useSessionExpiryGuard();
  return (
    <I18nProvider>
      <UpdatingScreen />
    </I18nProvider>
  );
}
