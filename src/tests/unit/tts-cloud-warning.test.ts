import { describe, expect, it } from 'vitest'
import { buildCloudTtsWarning } from '@/lib/tts-cloud-warning'

const states = [
  { id: 'tts-local-cli', label: 'Local CLI', configured: true },
  { id: 'microsoft', label: 'Microsoft', configured: true },
  { id: 'openai', label: 'OpenAI', configured: true },
]

describe('buildCloudTtsWarning', () => {
  it('warns when local TTS can fall back to a configured cloud provider', () => {
    expect(buildCloudTtsWarning({
      enabled: true,
      provider: 'tts-local-cli',
      fallbackProviders: ['microsoft'],
      providerStates: states,
    })).toBe(
      'Privacy notice: If local speech is unavailable, voice may use Microsoft cloud TTS. Text sent for speech may leave this ClawBox.',
    )
  })

  it('warns directly when the selected provider is cloud TTS', () => {
    expect(buildCloudTtsWarning({
      enabled: true,
      provider: 'openai',
      fallbackProviders: ['microsoft'],
      providerStates: states,
    })).toBe(
      'Privacy notice: Voice uses OpenAI and Microsoft cloud TTS. Text sent for speech leaves this ClawBox.',
    )
  })

  it('does not claim an unconfigured cloud preference is active', () => {
    expect(buildCloudTtsWarning({
      enabled: true,
      provider: 'openai',
      fallbackProviders: ['microsoft'],
      providerStates: states.map(state => (
        state.id === 'openai' ? { ...state, configured: false } : state
      )),
    })).toBe(
      'Privacy notice: If the selected voice provider is unavailable, voice may use Microsoft cloud TTS. Text sent for speech may leave this ClawBox.',
    )
  })

  it('does not warn when automatic TTS is disabled', () => {
    expect(buildCloudTtsWarning({
      enabled: false,
      provider: 'tts-local-cli',
      fallbackProviders: ['microsoft'],
      providerStates: states,
    })).toBeNull()
  })

  it('does not warn for an entirely local provider chain', () => {
    expect(buildCloudTtsWarning({
      enabled: true,
      provider: 'tts-local-cli',
      fallbackProviders: ['custom-piper-local'],
      providerStates: states,
    })).toBeNull()
  })

  it('handles malformed status payloads without inventing a warning', () => {
    expect(buildCloudTtsWarning({ enabled: true, provider: null, fallbackProviders: 'microsoft' })).toBeNull()
    expect(buildCloudTtsWarning(null)).toBeNull()
  })
})
