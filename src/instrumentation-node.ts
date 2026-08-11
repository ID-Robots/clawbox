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

let terminalChild: ChildProcess | null = null
let terminalStopping = false
let llamaCppChild: ChildProcess | null = null
let llamaCppStopping = false
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
  const serverPath = path.resolve('scripts', 'terminal-server.ts')
  terminalStopping = false

  // Kill any leftover child from previous hot-reload
  if (terminalChild) {
    try { terminalChild.kill('SIGTERM') } catch {}
    terminalChild = null
  }

  // Check if already running externally
  fetch(`http://127.0.0.1:${PORT}`)
    .then((res) => {
      if (res.ok) {
        console.log(`[instrumentation] Terminal server already running on port ${PORT}`)
        return
      }
      boot()
    })
    .catch(() => {
      // Not running — start it
      boot()
    })

  function findNpx(): string {
    const nodeDir = path.dirname(process.execPath)
    const candidates = [
      path.join(nodeDir, 'npx'),
      '/usr/local/bin/npx',
      '/usr/bin/npx',
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
    return 'npx'
  }

  function boot() {
    function startServer() {
      if (terminalStopping) return

      const npxPath = findNpx()
      const child = spawn(npxPath, ['tsx', serverPath], {
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

      child.on('exit', (code) => {
        if (terminalStopping) return
        console.log(`[instrumentation] Terminal server exited (code=${code}), restarting in 2s...`)
        setTimeout(startServer, 2000)
      })

      console.log(`[instrumentation] Terminal server starting on port ${PORT} (pid=${child.pid})`)
    }

    startServer()
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
      cwd: '/home/clawbox',
      detached: false,
      stdio: 'ignore',
      env: {
        ...process.env,
        HOME: '/home/clawbox',
        LLAMACPP_PID_PATH: spec.pidPath,
      },
    },
  )

  if (!child.pid) {
    throw new Error('Failed to start llama.cpp')
  }

  llamaCppChild = child
  await llamaCpp.writeLlamaCppPid(child.pid, spec.pidPath)
  console.log(`[instrumentation] llama.cpp auto-starting ${alias} (pid=${child.pid})`)

  child.on('exit', (code) => {
    void (async () => {
      try {
        if (llamaCppChild === child) {
          llamaCppChild = null
        }
        await llamaCpp.clearLlamaCppPid(spec.pidPath)
        if (llamaCppStopping) return

        console.log(`[instrumentation] llama.cpp exited (code=${code}), retrying in 5s...`)
        setTimeout(() => {
          // Restart the SAME alias. Re-deriving it would send the crash-restart
          // back through the configuration gate, which on a Hermes device is a
          // different question from "what was just running".
          void startLlamaCppServer(alias).catch((err) => {
            console.error('[instrumentation] Failed to restart llama.cpp:', err instanceof Error ? err.message : err)
          })
        }, 5000)
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
