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
  const { startTerminalServer, startLlamaCppServer } = require('./instrumentation-node')
  startTerminalServer()
  void startLlamaCppServer()
}
