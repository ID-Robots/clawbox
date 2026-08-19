import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@/tests/helpers/test-utils'
import { CloudTtsWarning } from '@/components/CloudTtsWarning'

describe('CloudTtsWarning', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the live gateway TTS chain and shows the privacy notice', async () => {
    const request = vi.fn().mockResolvedValue({
      enabled: true,
      provider: 'tts-local-cli',
      fallbackProviders: ['microsoft'],
      providerStates: [
        { id: 'tts-local-cli', label: 'Local CLI', configured: true },
        { id: 'microsoft', label: 'Microsoft', configured: true },
      ],
    })

    const { getByRole } = render(<CloudTtsWarning connected request={request} />)

    await waitFor(() => {
      expect(getByRole('alert')).toHaveTextContent(
        'If local speech is unavailable, voice may use Microsoft cloud TTS',
      )
    })
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('tts.status', {})
  })

  it('does not query the gateway before chat connects', () => {
    const request = vi.fn()
    const { queryByRole } = render(<CloudTtsWarning connected={false} request={request} />)

    expect(request).not.toHaveBeenCalled()
    expect(queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps chat usable when an older gateway has no tts.status method', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Method not found'))
    const { queryByRole } = render(<CloudTtsWarning connected request={request} />)

    await waitFor(() => expect(request).toHaveBeenCalledOnce())
    expect(queryByRole('alert')).not.toBeInTheDocument()
  })

  it('refreshes the warning when TTS configuration hot-reloads', async () => {
    vi.useFakeTimers()
    const request = vi.fn()
      .mockResolvedValueOnce({
        enabled: true,
        provider: 'tts-local-cli',
        fallbackProviders: [],
        providerStates: [
          { id: 'tts-local-cli', label: 'Local CLI', configured: true },
        ],
      })
      .mockResolvedValueOnce({
        enabled: true,
        provider: 'tts-local-cli',
        fallbackProviders: ['openai'],
        providerStates: [
          { id: 'tts-local-cli', label: 'Local CLI', configured: true },
          { id: 'openai', label: 'OpenAI', configured: true },
        ],
      })

    const { queryByRole, getByRole } = render(
      <CloudTtsWarning connected request={request} />,
    )

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(queryByRole('alert')).not.toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(60_000)

    await vi.waitFor(() => {
      expect(getByRole('alert')).toHaveTextContent(
        'voice may use OpenAI cloud TTS',
      )
    })
    expect(request).toHaveBeenCalledTimes(2)
  })
})
