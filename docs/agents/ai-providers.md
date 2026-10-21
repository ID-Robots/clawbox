# AI providers and models

Provider configuration and OAuth sign-ins, the per-provider switch, the ClawBox AI login poll and the Ollama backend. Read it when you touch `ai-models/*`, `providers/*`, `ollama/*`, `oauth-*.ts` or a model picker.

## Setup API Routes (`src/app/setup-api/`)

- **AI Models**: `ai-models/configure`, `ai-models/status`, `ai-models/oauth/*` — API key config with OAuth flows (device auth + authorization code). `providers/status` lists every provider (cloud and on-device) with its connection state, whether it is the default, and `enabled`; `providers/enabled` (owner-only) is the per-provider switch — a switched-off provider keeps its credential but is never offered to the chat or written as a fallback, and the current default can never be switched off. Connecting a provider through `configure` switches it back on.
- **Ollama** (chat-provider backend, no UI): `ollama/status`, `ollama/pull`, `ollama/search`, `ollama/delete` — local model management. `search` offers only sizes under the ollama.service memory cap (`OLLAMA_MAX_MODEL_PARAM_B` in `resource-limits.ts`, answered as `maxParamBillions`); `pull` follows the client's abort so a cancelled download stops. The runtime's idle standby (`systemctl stop`, never `disable`, ten minutes after the last proxied use) still applies through `local-ai-runtime.ts`.

## Server Libraries (`src/lib/`)

- **`oauth-config.ts`** / **`oauth-utils.ts`** / **`google-project.ts`** — OAuth provider configuration and flows.
- **`provider-enablement.ts`** — the per-provider switch (`ai_disabled_providers` in the config store): read by `provider-status.ts`, the chat model options, `providers/default` and the fallback writer; refuses to switch off the current default.
- **`use-clawbox-login.ts`** — `useClawboxLogin(intervalMs = 30 s, enabled)`: whether the device is signed in to a ClawBox AI account, the account's tier and the portal's allowed models, from `/setup-api/ai-models/status`. However many hooks are mounted — the desktop's and `TierUpgradeCelebration`'s on every idle desktop, plus Settings, the full-page chat and the paid-plan gates — the box is asked by ONE shared poll at the SHORTEST interval any of them asked for; each used to run its own chain, so the most expensive handler the desktop polls answered the same question two to four times a period, a millisecond apart. What each hook sees is unchanged: a mount starts in `loading` and is answered by an ask made for it — a fresh one, or one started together with it (`JOIN_IN_FLIGHT_MS`, 250 ms on `monotonicNow()`: only the page's and `TierUpgradeCelebration`'s mount-asks, in one commit, are the duplicate worth saving, while a hook mounting later asks afresh, because the route is slowest right after a sign-in or a plan change and an ask started seconds before one answered the Coding Agent's paid gate or the Providers pitch card with the old tier until the next poll) — and never by an older ask that lands after it mounted (`Subscriber.fromSeq`, the first ask a hook takes answers from); each hook reduces every answer over its OWN previous state so a failed poll keeps what it had, and the last hook to leave stops the timer and disowns what is in flight. A tick that falls due while the page is hidden is asked on the visible edge — on the box's own screen too, with no exemption: the shield, the paid gates and the tier badge are drawn on the desktop itself and act on nothing while it is away.

## Frontend (`src/components/`)

### Built-in Apps

- **`OllamaModelPanel.tsx`** — local model pull, search, delete; the setup wizard's `AIModelsStep` is its only host now that Settings → Local AI is the inventory alone

### Hooks

- **`useOllamaModels.ts`** — Ollama model management
