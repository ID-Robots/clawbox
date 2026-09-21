export interface TtsProviderState {
  id?: unknown
  label?: unknown
  configured?: unknown
}

export interface TtsStatusPayload {
  enabled?: unknown
  provider?: unknown
  fallbackProviders?: unknown
  providerStates?: unknown
}

const LOCAL_PROVIDER_IDS = new Set([
  'tts-local-cli',
])

function asProviderId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim().toLowerCase()
  return id || null
}

function isLocalProvider(id: string): boolean {
  if (LOCAL_PROVIDER_IDS.has(id)) return true

  // Third-party local providers are allowed. Treat an explicitly local/CLI
  // provider as local even when it was registered after this ClawBox build;
  // everything else is conservatively remote because the privacy-safe error
  // is to warn about an unknown provider, not to silently call it local.
  return /(?:^|[-_.])(local|cli|piper|kokoro)(?:$|[-_.])/.test(id)
}

interface ProviderIndex {
  labels: Map<string, string>
  configured: Set<string>
  hasStates: boolean
}

function providerIndex(payload: TtsStatusPayload): ProviderIndex {
  const labels = new Map<string, string>()
  const configured = new Set<string>()
  if (!Array.isArray(payload.providerStates)) {
    return { labels, configured, hasStates: false }
  }

  for (const raw of payload.providerStates as TtsProviderState[]) {
    if (!raw || typeof raw !== 'object') continue
    const id = asProviderId(raw.id)
    if (!id) continue
    const label = typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.trim()
      : id
    labels.set(id, label)
    if (raw.configured === true) configured.add(id)
  }
  return { labels, configured, hasStates: true }
}

function readableList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? ''
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`
}

/**
 * The fact behind the privacy notice, before it is worded: whether the cloud
 * speaks first or only when the local voice cannot, and which cloud providers
 * are in the chain (by label). No screen renders it today — the owner had the
 * chat's yellow banner removed and Settings → Voice never carried one — but
 * /setup-api/tts still answers it beside the English sentence
 * `buildCloudTtsWarning` makes of it, so a surface that is asked for the
 * notice can say it in the owner's language instead of working out the chain
 * a second time.
 */
export interface CloudTtsDisclosure {
  kind: 'uses-cloud' | 'may-use-cloud'
  providers: string[]
  /** Whether the primary the owner selected is a local engine. */
  primaryIsLocal: boolean
}

export function cloudTtsDisclosure(rawPayload: unknown): CloudTtsDisclosure | null {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return null
  const payload = rawPayload as TtsStatusPayload
  if (payload.enabled !== true) return null

  const primary = asProviderId(payload.provider)
  const index = providerIndex(payload)
  const fallbacks = Array.isArray(payload.fallbackProviders)
    ? payload.fallbackProviders
        .map(asProviderId)
        .filter((id): id is string => Boolean(id))
    : []

  // `provider` is the selected preference even when it is unavailable. Do not
  // say an unconfigured cloud primary "uses" the cloud; in that case only the
  // configured fallbackProviders are candidates. Older gateways without
  // providerStates keep the conservative warning.
  const effectivePrimary = primary && (!index.hasStates || index.configured.has(primary))
    ? primary
    : null
  const providerChain = [effectivePrimary, ...fallbacks]
    .filter((id): id is string => Boolean(id))
  const remoteProviders = [...new Set(providerChain.filter(id => !isLocalProvider(id)))]

  if (remoteProviders.length === 0) return null

  const primaryIsRemote = effectivePrimary ? remoteProviders.includes(effectivePrimary) : false
  return {
    kind: primaryIsRemote ? 'uses-cloud' : 'may-use-cloud',
    providers: remoteProviders.map(id => index.labels.get(id) ?? id),
    primaryIsLocal: Boolean(primary && isLocalProvider(primary)),
  }
}

/**
 * Build the privacy notice shown in ClawBox chat from OpenClaw's live
 * `tts.status` response.
 *
 * The status call already filters fallbackProviders to providers that are
 * configured. We deliberately do not infer from static ClawBox config: the
 * warning must follow the gateway's current runtime chain after upgrades and
 * plugin-registry refreshes.
 */
export function buildCloudTtsWarning(rawPayload: unknown): string | null {
  const disclosure = cloudTtsDisclosure(rawPayload)
  if (!disclosure) return null

  const providerNames = readableList(disclosure.providers)
  if (disclosure.kind === 'uses-cloud') {
    return `Privacy notice: Voice uses ${providerNames} cloud TTS. Text sent for speech leaves this ClawBox.`
  }

  const unavailableProvider = disclosure.primaryIsLocal
    ? 'local speech'
    : 'the selected voice provider'
  return `Privacy notice: If ${unavailableProvider} is unavailable, voice may use ${providerNames} cloud TTS. Text sent for speech may leave this ClawBox.`
}
