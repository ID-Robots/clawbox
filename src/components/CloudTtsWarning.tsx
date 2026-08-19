'use client'

import React, { useEffect, useState } from 'react'
import { buildCloudTtsWarning } from '@/lib/tts-cloud-warning'

const TTS_STATUS_REFRESH_MS = 60_000

interface CloudTtsWarningProps {
  connected: boolean
  request: (method: string, params: unknown) => Promise<unknown>
}

/**
 * A live privacy notice for the gateway's actual TTS provider chain.
 *
 * This is intentionally a chat banner, not a persisted transcript message:
 * it describes runtime configuration, can change after a gateway restart,
 * and must not be copied into the agent's conversation context. Both ClawBox
 * chat surfaces use this component so the compact popup cannot hide a warning
 * that the full chat shows (or vice versa).
 */
export function CloudTtsWarning({ connected, request }: CloudTtsWarningProps) {
  const [warning, setWarning] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    if (!connected) {
      return () => { cancelled = true }
    }

    let refreshTimer: number | null = null
    const refreshWarning = async () => {
      try {
        const payload = await request('tts.status', {})
        if (!cancelled) setWarning(buildCloudTtsWarning(payload))
      } catch {
        // Older gateways may not expose tts.status. Chat must remain usable;
        // a later refresh or reconnect can recover after an update or a
        // transient gateway error.
        if (!cancelled) setWarning(null)
      } finally {
        // Schedule only after the previous request settles. The gateway can be
        // busy with an agent turn for longer than the refresh interval, so a
        // fixed interval would accumulate overlapping status calls.
        if (!cancelled) {
          refreshTimer = window.setTimeout(refreshWarning, TTS_STATUS_REFRESH_MS)
        }
      }
    }

    void refreshWarning()
    // messages.tts preferences can hot-reload without dropping the chat WebSocket.
    // Refresh periodically so a newly enabled cloud provider cannot leave a stale
    // local-only state on screen until the user reconnects.
    return () => {
      cancelled = true
      if (refreshTimer !== null) window.clearTimeout(refreshTimer)
    }
  }, [connected, request])

  if (!connected || !warning) return null

  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        padding: '8px 12px',
        borderRadius: 10,
        background: 'rgba(245,158,11,0.12)',
        border: '1px solid rgba(245,158,11,0.35)',
        color: '#fbbf24',
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      ⚠️ {warning}
    </div>
  )
}
