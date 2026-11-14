/**
 * ONE `models.list` answer from the pinned gateway, and what the pinned CLI prints for it.
 *
 * OpenClaw 2026.11.3. `GATEWAY_ANSWER` is shaped by that version's own protocol
 * schema (`packages/gateway-protocol`: `ModelsListResultSchema` and
 * `ModelChoiceSchema`, both closed objects; the only change since 2026.10.9 is
 * the ready outcome's optional `unlistedConfiguredModelIds`, which this answer
 * carries). Its rows are based on the
 * anthropic rows of the plugin manifest the package bundles (one without
 * `input`, one without context windows), with fields the CLI drops left in
 * (reasoning, context windows, fast mode, recommended, unavailableReason).
 *
 * The CLI side is NOT derived from ClawBox's projection. `CLI_STDOUT` and
 * `CLI_STDERR` are what that version's own `toCliModelRow`, `printModelTable`
 * (`--json`) and stderr loop (`src/commands/models/list.list-command.ts`, with
 * the catalog warnings of `src/commands/models/catalog-warnings.ts` it prints
 * first) wrote for this answer, run from the package. The 2026.10.9 answer
 * (this one without `unlistedConfiguredModelIds`) still prints exactly what
 * 2026.10.9 printed for it. `CLI_STDERR_OUTCOMES_REVERSED` is the
 * same answer with `providerOutcomes` in the opposite order. The gateway's order
 * is not fixed (it follows the catalogue's discovery and account-selection
 * history), and the CLI prints the outcomes as sent.
 *
 * A pin bump regenerates the CLI side (src/tests/unit/harness-pins.test.ts says when):
 * in a throwaway HOME, OPENCLAW_HOME and OPENCLAW_STATE_DIR, evaluate that
 * version's `toCliModelRow`, `printModelTable` (`opts.json`) and the stderr loop
 * of `modelsListCommand`, taken from the package's `dist/list.list-command-*.mjs`,
 * over `GATEWAY_ANSWER`, with `modelKey` and `sanitizeTerminalText` imported as
 * that file imports them.
 */

export const GATEWAY_ANSWER = {
  models: [
    {
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      provider: "anthropic",
      alias: "opus",
      tags: [
        "default"
      ],
      available: true,
      contextWindow: 1000000,
      contextTokens: 200000,
      local: false,
      contextWindows: [
        {
          id: "200k",
          label: "200K",
          contextWindow: 200000
        },
        {
          id: "1m",
          label: "1M",
          contextWindow: 1000000
        }
      ],
      contextWindowDefault: "1m",
      reasoning: true,
      effectiveFastMode: false,
      supportsTools: true,
      input: [
        "text",
        "image"
      ],
      recommended: true
    },
    {
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      provider: "anthropic",
      alias: "sonnet",
      tags: [
        "alias:sonnet"
      ],
      available: true,
      contextWindow: 1000000,
      local: false,
      reasoning: true,
      supportsTools: true,
      input: [
        "text",
        "image"
      ],
      recommended: true
    },
    {
      id: "claude-haiku-5-5",
      name: "Claude Haiku 5.5",
      provider: "anthropic",
      available: false,
      unavailableReason: "missing-auth",
      contextWindow: 1000000,
      local: false,
      reasoning: true
    }
  ],
  refreshFailed: true,
  providerOutcomes: [
    {
      provider: "litellm",
      status: "unavailable"
    },
    {
      provider: "openai",
      profileId: "openai:default",
      status: "auth-rejected"
    },
    {
      provider: "anthropic",
      profileId: "anthropic:default",
      status: "ready",
      unlistedConfiguredModelIds: [
        "claude-opus-4-7"
      ]
    }
  ]
};

export const CLI_STDOUT = {
  count: 3,
  models: [
    {
      key: "anthropic/claude-opus-5-5",
      name: "Claude Opus 5.5",
      input: "text+image",
      contextWindow: 1000000,
      contextTokens: 200000,
      local: false,
      available: true,
      tags: [
        "default",
        "alias:opus"
      ]
    },
    {
      key: "anthropic/claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      input: "text+image",
      contextWindow: 1000000,
      local: false,
      available: true,
      tags: [
        "alias:sonnet"
      ]
    },
    {
      key: "anthropic/claude-haiku-5-5",
      name: "Claude Haiku 5.5",
      input: "-",
      contextWindow: 1000000,
      local: false,
      available: false,
      tags: []
    }
  ],
  providerOutcomes: [
    {
      provider: "litellm",
      status: "unavailable"
    },
    {
      provider: "openai",
      profileId: "openai:default",
      status: "auth-rejected"
    },
    {
      provider: "anthropic",
      profileId: "anthropic:default",
      status: "ready",
      unlistedConfiguredModelIds: [
        "claude-opus-4-7"
      ]
    }
  ]
};

export const CLI_STDERR = [
  "Configured model \"anthropic/claude-opus-4-7\" is not present in the provider's last successful server catalog (profile anthropic:default). Pull or download it on that server, or fix the configured model name; then run openclaw models list --refresh. The model remains selectable.",
  "Model discovery could not refresh all providers. Showing the available published model list.",
  "Model discovery is unavailable for litellm. Retry with --refresh; if it still fails, check the provider in Models in the Control UI.",
  "Model discovery authentication was rejected for openai (profile openai:default). Open Models in the Control UI to check sign-in and catalog access, then retry with --refresh."
];

export const CLI_STDERR_OUTCOMES_REVERSED = [
  "Configured model \"anthropic/claude-opus-4-7\" is not present in the provider's last successful server catalog (profile anthropic:default). Pull or download it on that server, or fix the configured model name; then run openclaw models list --refresh. The model remains selectable.",
  "Model discovery could not refresh all providers. Showing the available published model list.",
  "Model discovery authentication was rejected for openai (profile openai:default). Open Models in the Control UI to check sign-in and catalog access, then retry with --refresh.",
  "Model discovery is unavailable for litellm. Retry with --refresh; if it still fails, check the provider in Models in the Control UI."
];
