/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Delegates to instrumentation-node.ts which is loaded via require()
 * to avoid Edge Runtime static analysis warnings.
 */
export async function onRequestError() {
  // required export — no-op
}

/**
 * The boot-time repairs of openclaw.json, one after the other.
 *
 * WHY IN SEQUENCE. Each repair is its own read-modify-write of the same file
 * through the same `.tmp` path. Run together they each read the original,
 * each write their own change, and whichever renames last wins — the other
 * repair is silently undone until the next boot, and two writers on one temp
 * path can rename a half-written file into place. Awaiting the first before
 * starting the second is the whole fix; nothing here is on the request path,
 * so the extra few milliseconds cost nobody anything.
 *
 * Each repair keeps its own error handling: one that fails must not stop the
 * other, and neither may stop the box booting. The gateway restarts once if
 * either of them wrote anything. A separate function, with the repairs handed
 * in, so the sequencing can be pinned by a test without `require()`-ing the
 * real config module into it.
 */
export async function repairOpenclawConfig(repairs: {
  ensureLocalAiProxyUrls: () => Promise<boolean>
  ensureMicrosoftTtsExcluded: () => Promise<boolean>
  /** Seeds `tts.auto` for the spoken-replies switch on a box that predates it. */
  ensureVoiceAutoReplyMode?: () => Promise<boolean>
  restartGateway: () => Promise<void>
}): Promise<void> {
  const steps: Array<[label: string, run: () => Promise<boolean>]> = [
    ['migrate Local AI proxy URLs', repairs.ensureLocalAiProxyUrls],
    ['exclude Microsoft TTS', repairs.ensureMicrosoftTtsExcluded],
  ]
  if (repairs.ensureVoiceAutoReplyMode) steps.push(['seed the spoken-replies mode', repairs.ensureVoiceAutoReplyMode])
  let changed = false
  for (const [label, run] of steps) {
    try {
      if (await run()) changed = true
    } catch (err) {
      console.error(`[instrumentation] Failed to ${label}:`, err instanceof Error ? err.message : err)
    }
  }
  if (!changed) return
  try {
    await repairs.restartGateway()
  } catch (err) {
    console.error('[instrumentation] Gateway restart after config repair failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Ask the updater, once the boot rush has passed, whether an update is waiting
 * for its second half.
 *
 * WHY. An update reboots the box halfway through: the system fixups, the
 * Hermes re-provisioning and the build-identity check run AFTER the restart,
 * and `checkContinuation()` is what starts them. Its only caller was the
 * update status route, so the second half waited for somebody to open the
 * Update page — both test boxes sat at "running" for six and a half hours and
 * then bounced the gateway and the dashboard the moment a page was opened
 * (2026-09-01). Nothing an update does should depend on being watched.
 *
 * The status route keeps its call as the fallback. The two never collide: the
 * check is single-flight, so a poll that lands on the boot hook's read joins
 * it and gets the same answer instead of resuming a second time.
 *
 * Waits for the boot-time config repair first. That repair restarts the
 * gateway when it changed something, and the resumed update's first act is to
 * mask and stop the gateway for post_update: started together, the restart
 * either fails against the mask (a spurious boot error) or the stop lands on
 * the gateway's pre-start halfway through. Whether the repair succeeded or
 * not is beside the point — only that it is over.
 *
 * Never awaited and never allowed to throw: clawbox-setup.service is
 * Restart=always, so an unhandled rejection here is a crash loop, not a
 * missed step. Unref'd, so an exiting server does not wait on it. A plain
 * function with the check handed in, so a test can drive it with fake timers
 * without `require()`-ing the real updater.
 */
export function armUpdateContinuation(
  checkContinuation: () => Promise<boolean>,
  options: { afterConfigRepair?: Promise<unknown>; delayMs?: number } = {},
): NodeJS.Timeout {
  const { afterConfigRepair = Promise.resolve(), delayMs = 5_000 } = options
  const timer = setTimeout(async () => {
    try {
      await afterConfigRepair.catch(() => undefined)
      if (await checkContinuation()) console.log('[Updater] continuation resumed at boot')
    } catch (err) {
      console.error('[Updater] continuation at boot failed:', err instanceof Error ? err.message : err)
    }
  }, delayMs)
  timer.unref()
  return timer
}

/**
 * Warm the memory-status cache once the boot rush has passed — unless an
 * update owns the box.
 *
 * WHY THE GATE. The probe boots a whole OpenClaw process against the v2
 * SQLite store, and the resumed second half of an update (armed above) runs
 * post_update against that same store with the gateway masked and stopped
 * precisely so it has ONE writer. With the continuation resumed at boot the
 * probe would land inside that window on every first boot after an update:
 * "database is locked", and post_update's fixups — non-fatal by design —
 * silently skipped. An update in flight means no warm; the first reader pays
 * the probe instead, as it always did. A gate that cannot be read is treated
 * the same way: better one slow Settings open than a second writer.
 */
export function armMemoryStatusWarm(deps: {
  warm: () => Promise<void>
  updateInFlight: () => Promise<boolean>
  delayMs?: number
}): NodeJS.Timeout {
  const { warm, updateInFlight, delayMs = 45_000 } = deps
  const timer = setTimeout(async () => {
    try {
      if (await updateInFlight()) return
      await warm()
    } catch {
      /* the first reader retries */
    }
  }, delayMs)
  timer.unref()
  return timer
}

/**
 * Next.js calls this once per server start, in both runtimes. Everything
 * below is Node-only and loaded through `require()` so the Edge bundle never
 * sees it; each hook fails on its own and none of them may stop the boot.
 */
export async function register() {
  if (typeof process === 'undefined' || process.env.NEXT_RUNTIME === 'edge') return

  // Dynamic require avoids Next.js Edge Runtime static analysis of Node.js APIs
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { startTerminalServer } = require('./instrumentation-node')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ensureLocalAiProxyUrls, ensureMicrosoftTtsExcluded, restartGateway } = require('./lib/openclaw-config')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ensureVoiceAutoReplyMode } = require('./lib/voice-reply')
  startTerminalServer()
  // One-time repairs of openclaw.json, in sequence — see repairOpenclawConfig
  // for why they must not run together. Never awaited: boot goes on. Never
  // rejects: every step inside catches for itself.
  const configRepaired = repairOpenclawConfig({ ensureLocalAiProxyUrls, ensureMicrosoftTtsExcluded, ensureVoiceAutoReplyMode, restartGateway })
  try {
    // An update that rebooted the box still has its second half to run. Ask
    // here, so it starts whether or not anyone opens the Update page — see
    // armUpdateContinuation, including why it waits for the repair above.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { checkContinuation } = require('./lib/updater')
    armUpdateContinuation(checkContinuation, { afterConfigRepair: configRepaired })
  } catch (err) {
    console.error('[instrumentation] Could not arm the update continuation:', err instanceof Error ? err.message : err)
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const clawkeepScheduler = require('./lib/clawkeep-scheduler')
    void clawkeepScheduler.start().catch((err: unknown) => {
      console.error('[instrumentation] ClawKeep scheduler boot failed:', err instanceof Error ? err.message : err)
    })
  } catch (err) {
    // The scheduler is opt-in — if its module fails to load (missing deps,
    // syntax error in dev), the rest of the app must still boot.
    console.error('[instrumentation] Could not load ClawKeep scheduler:', err instanceof Error ? err.message : err)
  }
  try {
    // Old chat transcripts. Age is the only thing left to bound here -- the
    // per-conversation caps already decide how big any ONE of them gets, so
    // what accumulates is stale ones. Boot is the right moment because these
    // are the customer's own words: the sweep should run even on a box nobody
    // has opened the chat on since the last update.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sweepTranscripts } = require('./lib/harness/transcript-store')
    void sweepTranscripts()
      .then((removed: number) => {
        if (removed > 0) console.log(`[instrumentation] Swept ${removed} stale chat transcript(s)`)
      })
      .catch((err: unknown) => {
        console.error('[instrumentation] Chat transcript sweep failed:', err instanceof Error ? err.message : err)
      })
  } catch (err) {
    console.error('[instrumentation] Could not load the chat transcript sweep:', err instanceof Error ? err.message : err)
  }
  try {
    // Coding runs the previous web server was still babysitting died with it
    // (systemd kills the whole cgroup on restart). Settle them now so the
    // agent's next status question is not answered with "still running".
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const codingAgent = require('./lib/coding-agent')
    const stale: number = codingAgent.reconcileAfterRestart()
    if (stale > 0) console.log(`[instrumentation] ${stale} coding run(s) left running by the previous server were marked failed`)
    // Pull requests left pending by the restart. Same reason the approval
    // poller is restarted below: nothing else polls them, so without this a run
    // shows "waiting for checks" forever and is never merged. The watcher takes
    // everything it decides on — the review verdict included — from the run
    // record, so what it resumes with is what the previous server knew.
    codingAgent.resumePullRequestWatches()
  } catch (err) {
    console.error('[instrumentation] Could not reconcile coding runs:', err instanceof Error ? err.message : err)
  }
  try {
    // A question asked in chat outlives the process that asked it: the button
    // is still sitting in the owner's Telegram. Nothing listens for the answer
    // unless something starts listening, so a box that reboots with an
    // approval outstanding has to pick the poll back up here or the owner taps
    // into silence. Starts nothing when the feature is off or nothing is
    // waiting -- see startApprovalPoller.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const emailApproval = require('./lib/email-approval')
    emailApproval.startApprovalPoller()
  } catch (err) {
    console.error('[instrumentation] Could not resume email chat approvals:', err instanceof Error ? err.message : err)
  }
  try {
    // The memory-status probe boots a whole OpenClaw process (~8 s on a
    // Jetson). Pay it once, after the boot rush (gateway restart, schedulers,
    // Next's own warm-up) has passed, so the first Settings → Local AI open
    // answers from the cache. Not on Hermes: there is no openclaw to probe.
    // Not under an update either — see armMemoryStatusWarm.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { openclawIsAbsent } = require('./lib/openclaw-config')
    if (!openclawIsAbsent()) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { warmMemoryStatusCache } = require('./lib/clawkeep-memory')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { updateInFlight } = require('./lib/updater')
      armMemoryStatusWarm({ warm: warmMemoryStatusCache, updateInFlight })
    }
  } catch (err) {
    console.error('[instrumentation] Could not warm the memory status cache:', err instanceof Error ? err.message : err)
  }
  try {
    // The chat's capability facts on a Hermes box cost three Python starts on
    // a cold cache, and `use-harness-adapter` asks for them on every chat
    // mount. Pay them once here, after the boot rush, so the first chat open
    // after a restart answers from the memos. Same delay as the memory probe
    // above, on purpose: a probe that times out under boot load is held as a
    // 60 s backoff, which would hide the attach button for exactly the chat
    // open this is meant to speed up.
    //
    // Only on a Hermes box, and decided at fire time rather than now: an
    // OpenClaw box can have a `hermes` checkout and a config.yaml on disk, and
    // an ungated probe would start Python at boot for facts no OpenClaw
    // capability reads.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getActiveHarness } = require('./lib/harness')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { warmHermesFeatureMemos } = require('./lib/harness/hermes-features')
    setTimeout(() => {
      void getActiveHarness()
        .then((harness: string) => (harness === 'hermes' ? warmHermesFeatureMemos() : undefined))
        .catch(() => { /* the first chat open asks for itself */ })
    }, 45_000).unref()
  } catch (err) {
    console.error('[instrumentation] Could not warm the hermes chat capability memos:', err instanceof Error ? err.message : err)
  }
  try {
    // Memory indexing is armed the same way, from its own persisted schedule.
    // Rebuilding the timer at every boot is what makes the schedule survive a
    // reboot and an update without a crontab entry to duplicate or orphan.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const memoryScheduler = require('./lib/clawkeep-memory-scheduler')
    void memoryScheduler.start().catch((err: unknown) => {
      console.error('[instrumentation] Memory index scheduler boot failed:', err instanceof Error ? err.message : err)
    })
  } catch (err) {
    console.error('[instrumentation] Could not load memory index scheduler:', err instanceof Error ? err.message : err)
  }
}
