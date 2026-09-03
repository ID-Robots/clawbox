/**
 * Node.js-only instrumentation logic.
 * Auto-starts the WebSocket terminal server (node-pty) as a child process,
 * and re-establishes the Cloudflare Quick Tunnel if remote access was on
 * before the last shutdown.
 * Loaded via require() from instrumentation.ts to avoid Edge Runtime warnings.
 */
import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import { CONFIG_ROOT } from './lib/config-store'

/**
 * How long a child that keeps dying is left alone between attempts: its own
 * floor for the first restart, doubling to a minute.
 *
 * The terminal server used to be a flat 2 s with no cap, so a child that could
 * not start AT ALL — which is what a box whose npx cache had no `tsx` had —
 * was re-spawned every two seconds for the life of the process. The causes
 * that remain (a node-pty ABI mismatch after a kernel bump, a model file
 * llama.cpp cannot download) fail exactly the same way, so both children here
 * share the ceiling.
 */
const CHILD_RESTART_MAX_MS = 60_000
const TERMINAL_RESTART_MIN_MS = 2_000
const LLAMACPP_RESTART_MIN_MS = 5_000

/**
 * What scripts/terminal-server.mjs answers on GET /. The "is it already up?"
 * probe matches on it so that only OUR server counts; the two copies of the
 * string are pinned together by src/tests/unit/instrumentation-terminal-server.test.ts.
 */
const TERMINAL_SERVER_BANNER = 'ClawBox Terminal WebSocket Server'

/**
 * Milliseconds from a monotonic source, for measuring how long a child stayed
 * up. Never `Date.now()`: these boxes boot with no RTC and step the clock the
 * moment NTP first reaches the internet — which is the very window this
 * backoff exists for, and a backwards step would freeze it at the ceiling
 * while a forwards one would reset it mid-crash-loop.
 */
function uptimeClockMs(): number {
  return performance.now()
}

let terminalChild: ChildProcess | null = null
let terminalStopping = false
/**
 * Which call to startTerminalServer() owns the supervision loop. A second call
 * (a dev hot-reload) kills the previous child, whose `close` would otherwise
 * schedule a restart from the OLD closure — two chains, each with its own
 * backoff, racing for :3006 while `terminalChild` tracks only one of them.
 */
let terminalGeneration = 0
let llamaCppChild: ChildProcess | null = null
let llamaCppStopping = false
let llamaCppRestartDelayMs = LLAMACPP_RESTART_MIN_MS
let llamaCppStartPromise: Promise<LlamaCppStartStatus> | null = null
let cleanupRegistered = false

function cleanupChildren() {
  terminalStopping = true
  if (terminalChild) {
    try { terminalChild.kill('SIGTERM') } catch {}
    terminalChild = null
  }
  llamaCppStopping = true
  if (llamaCppChild) {
    try { llamaCppChild.kill('SIGTERM') } catch {}
    llamaCppChild = null
  }
}

function registerCleanupHandlers() {
  if (cleanupRegistered) return
  cleanupRegistered = true
  process.on('exit', cleanupChildren)
  process.on('SIGTERM', cleanupChildren)
  process.on('SIGINT', cleanupChildren)
}

export function startTerminalServer() {
  registerCleanupHandlers()
  const PORT = process.env.TERMINAL_WS_PORT || '3006'
  // The checkout, reached the way every other server module reaches it — NOT
  // the cwd. In production the cwd is `.next/standalone` (the Next standalone
  // server chdirs there), and the copy of this script that lands in that tree
  // is a build artefact that only refreshes on a full rebuild.
  const serverPath = path.join(CONFIG_ROOT, 'scripts', 'terminal-server.mjs')
  const generation = ++terminalGeneration
  let restartDelayMs = TERMINAL_RESTART_MIN_MS
  terminalStopping = false

  // Kill any leftover child from previous hot-reload
  if (terminalChild) {
    try { terminalChild.kill('SIGTERM') } catch {}
    terminalChild = null
  }

  // Is it already up? Only OUR server counts: :3006 is loopback, but anything
  // answering 200 there — a leftover from a half-killed process tree, another
  // dev server — used to be accepted as the terminal, and the Terminal app
  // then talked to it. The banner is what scripts/terminal-server.mjs writes
  // for exactly this handshake.
  fetch(`http://127.0.0.1:${PORT}`)
    .then(async (res) => {
      if (res.ok && (await res.text()).includes(TERMINAL_SERVER_BANNER)) {
        console.log(`[instrumentation] Terminal server already running on port ${PORT}`)
        return
      }
      startServer()
    })
    .catch(() => {
      // Not running — start it
      startServer()
    })

  function scheduleRestart(reason: string, ranForMs: number) {
    // A child that ran for a while and then died is not a crash loop: the next
    // failure starts over at the floor.
    if (ranForMs >= CHILD_RESTART_MAX_MS) restartDelayMs = TERMINAL_RESTART_MIN_MS
    const delayMs = restartDelayMs
    restartDelayMs = Math.min(restartDelayMs * 2, CHILD_RESTART_MAX_MS)
    console.log(`[instrumentation] Terminal server ${reason}, restarting in ${delayMs / 1000}s...`)
    setTimeout(startServer, delayMs)
  }

  function startServer() {
    if (terminalStopping || generation !== terminalGeneration) return

    // Checked on every attempt, not once at boot: a box that rebooted while an
    // update was between `git reset --hard` and its rebuild has the file back
    // as soon as the sync lands, and a permanent absence then costs one line a
    // minute instead of a fork storm.
    if (!fs.existsSync(serverPath)) {
      console.error(`[instrumentation] Terminal server not started: ${serverPath} does not exist, so the Terminal app will not work. Restore it with 'sudo bash install.sh --step git_pull'; retrying meanwhile.`)
      restartDelayMs = CHILD_RESTART_MAX_MS
      setTimeout(startServer, CHILD_RESTART_MAX_MS)
      return
    }

    const startedAt = uptimeClockMs()
    // This same Node, running plain JS: nothing to resolve, download or
    // transpile, so a box with no internet starts its terminal like any other.
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, TERMINAL_WS_PORT: PORT },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })
    terminalChild = child

    child.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) console.log(msg)
    })

    child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) console.error(msg)
    })

    child.on('error', (err) => {
      console.error('[instrumentation] Failed to start terminal server:', err.message)
    })

    // 'close', not 'exit'. A child that could never be created — fork(2)
    // answering EAGAIN/ENOMEM on a Jetson that is booting llama.cpp and the
    // desktop at the same time — emits 'error' and 'close' and NEVER 'exit',
    // so an exit-only handler left the Terminal dead for the lifetime of the
    // web server with a single log line. 'close' fires for both endings, and
    // exactly once, so it needs no double-schedule guard.
    child.on('close', (code) => {
      if (terminalStopping || generation !== terminalGeneration) return
      scheduleRestart(`exited (code=${code})`, uptimeClockMs() - startedAt)
    })

    console.log(`[instrumentation] Terminal server starting on port ${PORT} (pid=${child.pid})`)
  }
}

/**
 * What a {@link startLlamaCppServer} call actually did.
 *
 * The `skipped-*` outcomes exist because a silent no-op here used to be
 * indistinguishable from a successful start: the caller went straight on to
 * poll for a server that was never going to appear, and only found out 20
 * minutes later. Callers that *asked* for the runtime (the on-demand proxy)
 * treat any `skipped-*` as an immediate, explainable failure.
 */
export type LlamaCppStartStatus =
  | 'started'
  | 'skipped-disabled'
  | 'skipped-not-configured'

/**
 * Start llama.cpp, or report why it wasn't started.
 *
 * `alias` is the caller's explicit "I want this model, now" — used by the
 * on-demand proxy. A request that arrived through the llama.cpp proxy is
 * itself the authorization to start, so it does not get re-litigated against
 * OpenClaw's config file (see bootLlamaCppServer for why that check cannot
 * work on every SKU). Called with no alias — the boot-time auto-start — the
 * model is derived from configuration instead.
 */
export async function startLlamaCppServer(alias?: string): Promise<LlamaCppStartStatus> {
  llamaCppStopping = false
  registerCleanupHandlers()
  if (llamaCppStartPromise) return await llamaCppStartPromise

  llamaCppStartPromise = bootLlamaCppServer(alias).finally(() => {
    llamaCppStartPromise = null
  })
  return await llamaCppStartPromise
}

async function bootLlamaCppServer(requestedAlias?: string): Promise<LlamaCppStartStatus> {
  const [{ getAll }, { readConfig }, llamaCpp] = await Promise.all([
    import('./lib/config-store'),
    import('./lib/openclaw-config'),
    import('./lib/llamacpp-server'),
  ])

  const [config, state] = await Promise.all([readConfig(), getAll().catch(() => ({} as Record<string, unknown>))])
  const hasExplicitLocalAiFlag = Object.prototype.hasOwnProperty.call(state, 'local_ai_configured')
  if (hasExplicitLocalAiFlag && state['local_ai_configured'] === false) {
    const primaryModel = config.agents?.defaults?.model?.primary?.trim()
    if (!primaryModel || !primaryModel.startsWith('llamacpp/')) {
      console.log('[instrumentation] llama.cpp auto-start skipped (Local AI explicitly disabled)')
      return 'skipped-disabled'
    }
  }

  // An explicit alias is the caller saying "start this one" — honour it.
  // Otherwise resolve it the same way the wake path does, so the two can never
  // disagree about which model this device is supposed to run.
  const alias = requestedAlias?.trim()
    || llamaCpp.getConfiguredLlamaCppModelAlias(config)
    || llamaCpp.getLocalAiConfigStoreAlias(state)
  if (!alias) {
    console.log('[instrumentation] llama.cpp auto-start skipped (no llama.cpp primary or local fallback configured)')
    return 'skipped-not-configured'
  }

  const spec = llamaCpp.getLlamaCppLaunchSpec(alias)
  const runningModels = await llamaCpp.queryLlamaCppModels(spec.baseUrl)
  if (runningModels.includes(alias)) {
    console.log(`[instrumentation] llama.cpp already running for ${alias}`)
    return 'started'
  }

  const existingPid = await llamaCpp.readLlamaCppPid(spec.pidPath)
  if (existingPid && llamaCpp.isLlamaCppPidRunning(existingPid)) {
    console.log(`[instrumentation] llama.cpp already starting for ${alias} (pid=${existingPid})`)
    return 'started'
  }
  if (existingPid) {
    await llamaCpp.clearLlamaCppPid(spec.pidPath)
  }

  await llamaCpp.ensureLlamaCppRuntimeDir()

  const child = spawn(
    'bash',
    [
      spec.scriptPath,
      spec.modelDir,
      spec.hfRepo,
      spec.hfFile,
      alias,
      spec.host,
      `${spec.port}`,
      spec.logPath,
      spec.binPath,
      spec.hfBinPath,
      `${spec.contextWindow}`,
    ],
    {
      cwd: process.env.CLAWBOX_HOME_DIR || process.env.HOME || '/home/clawbox',
      detached: false,
      stdio: 'ignore',
      env: {
        ...process.env,
        HOME: process.env.CLAWBOX_HOME_DIR || process.env.HOME || '/home/clawbox',
        LLAMACPP_PID_PATH: spec.pidPath,
      },
    },
  )

  // Attached BEFORE the pid check below, because a spawn that failed emits
  // 'error' asynchronously and an 'error' event with no listener is an uncaught
  // exception: a child that merely could not be created (fork(2) answering
  // EAGAIN while the box boots) took the whole web server down with it. The
  // failure itself is still reported to the caller, by the pid check.
  child.on('error', (err) => {
    console.error('[instrumentation] llama.cpp failed to start:', err instanceof Error ? err.message : err)
  })

  if (!child.pid) {
    throw new Error('Failed to start llama.cpp')
  }

  llamaCppChild = child
  const startedAt = uptimeClockMs()
  await llamaCpp.writeLlamaCppPid(child.pid, spec.pidPath)
  console.log(`[instrumentation] llama.cpp auto-starting ${alias} (pid=${child.pid})`)

  // 'exit', not 'close' — the opposite of the terminal server above, because
  // the two children are supervised for different reasons. The terminal server
  // has nobody to report to, so it must also recover a child that never
  // spawned, and only 'close' is delivered for that. This one is demand-started
  // by ensureLocalAiReady, which awaits it: a spawn that failed is reported to
  // that caller by the pid check above, so there is no supervision to restore
  // and a retry behind the caller's back would be new behaviour. Past that
  // check the child really exists, and 'exit' is guaranteed for it — one
  // listener, one retry per death, no double-schedule guard needed.
  child.on('exit', (code) => {
    void (async () => {
      try {
        if (llamaCppChild === child) {
          llamaCppChild = null
        }
        await llamaCpp.clearLlamaCppPid(spec.pidPath)
        if (llamaCppStopping) return

        // Same backoff as the terminal server, and for the same reason: this
        // retry was flat 5 s with no cap, so a start script that can never
        // succeed — no internet to fetch the GGUF on a freshly flashed box, a
        // model file deleted, a full disk — re-forked bash and a download every
        // five seconds for ever.
        if (uptimeClockMs() - startedAt >= CHILD_RESTART_MAX_MS) llamaCppRestartDelayMs = LLAMACPP_RESTART_MIN_MS
        const delayMs = llamaCppRestartDelayMs
        llamaCppRestartDelayMs = Math.min(llamaCppRestartDelayMs * 2, CHILD_RESTART_MAX_MS)
        console.log(`[instrumentation] llama.cpp exited (code=${code}), retrying in ${delayMs / 1000}s...`)
        setTimeout(() => {
          // Restart the SAME alias. Re-deriving it would send the crash-restart
          // back through the configuration gate, which on a Hermes device is a
          // different question from "what was just running".
          void startLlamaCppServer(alias).catch((err) => {
            console.error('[instrumentation] Failed to restart llama.cpp:', err instanceof Error ? err.message : err)
          })
        }, delayMs)
      } catch (err) {
        console.error('[instrumentation] llama.cpp exit handling failed:', err instanceof Error ? err.message : err)
      }
    })()
  })

  return 'started'
}

export async function stopLlamaCppServer() {
  llamaCppStopping = true

  const llamaCpp = await import('./lib/llamacpp-server')
  const spec = llamaCpp.getLlamaCppLaunchSpec()
  const knownPid = llamaCppChild?.pid
  const pid = knownPid ?? await llamaCpp.readLlamaCppPid(spec.pidPath)

  if (!pid) {
    llamaCppChild = null
    await llamaCpp.clearLlamaCppPid(spec.pidPath)
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch {}

  await new Promise((resolve) => setTimeout(resolve, 1500))

  try {
    process.kill(pid, 0)
    process.kill(pid, 'SIGKILL')
  } catch {}

  if (llamaCppChild?.pid === pid) {
    llamaCppChild = null
  }

  await llamaCpp.clearLlamaCppPid(spec.pidPath)
}
