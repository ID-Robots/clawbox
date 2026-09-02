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
  restartGateway: () => Promise<void>
}): Promise<void> {
  const steps: Array<[label: string, run: () => Promise<boolean>]> = [
    ['migrate Local AI proxy URLs', repairs.ensureLocalAiProxyUrls],
    ['exclude Microsoft TTS', repairs.ensureMicrosoftTtsExcluded],
  ]
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
 * check consumes the persisted flag synchronously before any real I/O, so
 * whichever asks first resumes and the other finds nothing to do.
 *
 * Never awaited and never allowed to throw: clawbox-setup.service is
 * Restart=always, so an unhandled rejection here is a crash loop, not a
 * missed step. Unref'd, so an exiting server does not wait on it. A plain
 * function with the check handed in, so a test can drive it with fake timers
 * without `require()`-ing the real updater.
 */
export function armUpdateContinuation(
  checkContinuation: () => Promise<boolean>,
  delayMs = 5_000,
): NodeJS.Timeout {
  const timer = setTimeout(() => {
    void Promise.resolve()
      .then(() => checkContinuation())
      .then((resumed) => {
        if (resumed) console.log('[Updater] continuation resumed at boot')
      })
      .catch((err: unknown) => {
        console.error('[instrumentation] Update continuation at boot failed:', err instanceof Error ? err.message : err)
      })
  }, delayMs)
  timer.unref()
  return timer
}

export async function register() {
  if (typeof process === 'undefined' || process.env.NEXT_RUNTIME === 'edge') return

  // Dynamic require avoids Next.js Edge Runtime static analysis of Node.js APIs
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { startTerminalServer } = require('./instrumentation-node')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ensureLocalAiProxyUrls, ensureMicrosoftTtsExcluded, restartGateway } = require('./lib/openclaw-config')
  startTerminalServer()
  // One-time repairs of openclaw.json, in sequence — see repairOpenclawConfig
  // for why they must not run together. Never awaited: boot goes on.
  void repairOpenclawConfig({ ensureLocalAiProxyUrls, ensureMicrosoftTtsExcluded, restartGateway })
  try {
    // An update that rebooted the box still has its second half to run. Ask
    // here, so it starts whether or not anyone opens the Update page — see
    // armUpdateContinuation.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { checkContinuation } = require('./lib/updater')
    armUpdateContinuation(checkContinuation)
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { openclawIsAbsent } = require('./lib/openclaw-config')
    if (!openclawIsAbsent()) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { warmMemoryStatusCache } = require('./lib/clawkeep-memory')
      setTimeout(() => {
        void warmMemoryStatusCache().catch(() => { /* the first reader retries */ })
      }, 45_000).unref()
    }
  } catch (err) {
    console.error('[instrumentation] Could not warm the memory status cache:', err instanceof Error ? err.message : err)
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
