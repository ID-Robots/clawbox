'use client'

import React, { useEffect, useState } from 'react'
import { buildCloudTtsWarning } from '@/lib/tts-cloud-warning'

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

    void request('tts.status', {})
      .then((payload) => {
        if (!cancelled) setWarning(buildCloudTtsWarning(payload))
      })
      .catch(() => {
        // Older gateways may not expose tts.status. Chat must remain usable;
        // the next successful reconnect will try again after an update.
        if (!cancelled) setWarning(null)
      })

    return () => { cancelled = true }
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
