/**
 * Node.js-only instrumentation logic.
 * Auto-starts the WebSocket terminal server (node-pty) as a child process.
 * Loaded via require() from instrumentation.ts to avoid Edge Runtime warnings.
 */
import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'

let terminalChild: ChildProcess | null = null
let terminalStopping = false

export function startTerminalServer() {
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

    const cleanup = () => {
      terminalStopping = true
      if (terminalChild) {
        try { terminalChild.kill('SIGTERM') } catch {}
        terminalChild = null
      }
    }
    process.on('exit', cleanup)
    process.on('SIGTERM', cleanup)
    process.on('SIGINT', cleanup)

    startServer()
  }
}
