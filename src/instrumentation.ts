/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Auto-starts the WebSocket terminal server (node-pty) as a child process.
 * Restarts automatically if the child process dies.
 */
export async function onRequestError() {
  // required export — no-op
}

let terminalChild: import('child_process').ChildProcess | null = null
let terminalStopping = false

export async function register() {
  if (typeof process === 'undefined' || process.env.NEXT_RUNTIME === 'edge') return

  const { spawn } = await import('child_process')
  const path = await import('path')

  const PORT = process.env.TERMINAL_WS_PORT || '3006'
  const serverPath = path.join(process.cwd(), 'scripts', 'terminal-server.ts')
  terminalStopping = false

  // Kill any leftover child from previous hot-reload
  if (terminalChild) {
    try { terminalChild.kill('SIGTERM') } catch {}
    terminalChild = null
  }

  // Check if already running externally
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}`)
    if (res.ok) {
      console.log(`[instrumentation] Terminal server already running on port ${PORT}`)
      return
    }
  } catch {
    // Not running — start it
  }

  function startServer() {
    if (terminalStopping) return

    const child = spawn('npx', ['tsx', serverPath], {
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

  const cleanup = () => {
    terminalStopping = true
    if (terminalChild) {
      try { terminalChild.kill('SIGTERM') } catch {}
      terminalChild = null
    }
  }
  process.removeAllListeners('exit')
  process.on('exit', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)

  startServer()
}
