/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Delegates to instrumentation-node.ts which is loaded via require()
 * to avoid Edge Runtime static analysis warnings.
 */
export async function onRequestError() {
  // required export — no-op
}

export async function register() {
  if (typeof process === 'undefined' || process.env.NEXT_RUNTIME === 'edge') return

  // Dynamic require avoids Next.js Edge Runtime static analysis of Node.js APIs
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { startTerminalServer } = require('./instrumentation-node')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ensureLocalAiProxyUrls, ensureMicrosoftTtsExcluded, restartGateway } = require('./lib/openclaw-config')
  startTerminalServer()
  // Both are one-time repairs of openclaw.json; the gateway restarts once if
  // either of them wrote anything.
  void Promise.all([
    ensureLocalAiProxyUrls().catch((err: unknown) => {
      console.error('[instrumentation] Failed to migrate Local AI proxy URLs:', err instanceof Error ? err.message : err)
      return false
    }),
    ensureMicrosoftTtsExcluded().catch((err: unknown) => {
      console.error('[instrumentation] Failed to exclude Microsoft TTS:', err instanceof Error ? err.message : err)
      return false
    }),
  ])
    .then((changed: boolean[]) => {
      if (!changed.some(Boolean)) return
      return restartGateway()
    })
    .catch((err: unknown) => {
      console.error('[instrumentation] Gateway restart after config repair failed:', err instanceof Error ? err.message : err)
    })
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
