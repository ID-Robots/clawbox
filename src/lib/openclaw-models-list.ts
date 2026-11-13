/**
 * The gateway's `models.list` answer, as `openclaw models list --json` prints it.
 *
 * With a gateway running, the pinned CLI's `models list --provider <p> --all
 * --json` sends that gateway ONE `models.list` (`view: "all"`, the provider,
 * `includeDetails: true`) and prints its rows through `toCliModelRow` and
 * `modelKey`. The catalogue now sends the same request over the gateway socket
 * itself, and this turns the answer into the very JSON the CLI would have
 * printed, so the route reads it with the parser it already has for the CLI's
 * stdout and nothing downstream can tell the two transports apart.
 *
 * Copied from the OpenClaw version in `MODELS_LIST_CHECKED_AT` (its
 * `src/commands/models/list.list-command.ts`: the request, `toCliModelRow`,
 * the stderr warnings; `list.table.ts`: `printModelTable`; `src/shared/model-key.ts`:
 * `modelKey`). `src/tests/unit/harness-pins.test.ts` fails when the pin moves
 * past that version, so a bump re-checks all of it against the new CLI. A
 * payload whose shape the CLI could not print throws here exactly where the
 * CLI would crash, so a changed shape marks the provider stale (and its next
 * attempt takes the CLI); it never publishes wrong rows.
 *
 * Pure, and its own module rather than an export of the route, so a suite can
 * test it without loading the route behind it.
 */

/** The OpenClaw version every copy in this module was checked against. */
export const MODELS_LIST_CHECKED_AT = "2026.11.3";

/**
 * What `openclaw models list --provider <p> --all --json [--refresh]` sends a
 * running gateway: the params, the CLI's deadline for them (`callGateway`'s
 * default, `MODEL_CATALOG_REFRESH_TIMEOUT_MS` with `--refresh`) and the
 * capability it requires of the gateway first
 * (`GATEWAY_SERVER_CAPS.PUBLISHED_MODEL_CATALOG`). No field is ClawBox's own.
 */
export function modelsListRequest(provider: string, refresh: boolean): {
  params: Record<string, unknown>;
  timeoutMs: number;
  requiredCapabilities: string[];
} {
  return {
    params: { view: "all", provider, includeDetails: true, ...(refresh ? { refresh: true } : {}) },
    timeoutMs: refresh ? 210_000 : 10_000,
    requiredCapabilities: ["published-model-catalog"],
  };
}

export interface CliModelRow {
  key: string;
  name: unknown;
  input: string;
  contextWindow: unknown;
  contextTokens?: unknown;
  local: unknown;
  available: unknown;
  tags: unknown[];
}

export interface CliModelsListJson {
  count: number;
  models: CliModelRow[];
  providerOutcomes?: Array<{ provider: unknown; profileId?: unknown; status: unknown; unlistedConfiguredModelIds?: unknown[] }>;
}

/** The core's `modelKey`: trimmed parts, an id that already names its provider kept as it is. */
function modelKey(provider: string, model: string): string {
  const providerId = provider.trim();
  const modelId = model.trim();
  if (!providerId) return modelId;
  if (!modelId) return providerId;
  return modelId.toLowerCase().startsWith(`${providerId.toLowerCase()}/`) ? modelId : `${providerId}/${modelId}`;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`models.list answered ${what} that is not an object`);
  return value as Record<string, unknown>;
}

function toCliModelRow(value: unknown): CliModelRow {
  const model = asRecord(value, "a row");
  const { provider, id, input, tags, alias } = model;
  // The core's `.trim()` throws on these; so does this.
  if (typeof provider !== "string" || typeof id !== "string") {
    throw new Error("models.list answered a row without a string provider and id");
  }
  if (input != null && !Array.isArray(input)) throw new Error("models.list answered a row whose input is not a list");
  return {
    key: modelKey(provider, id),
    name: model.name,
    input: (input as unknown[] | null | undefined)?.join("+") || "-",
    contextWindow: model.contextWindow ?? null,
    ...(model.contextTokens !== undefined ? { contextTokens: model.contextTokens } : {}),
    local: model.local ?? null,
    available: model.available ?? null,
    // Spread as the core spreads it: a `tags` that is not iterable throws there too.
    tags: [...new Set([...((tags ?? []) as Iterable<unknown>), ...(alias ? [`alias:${String(alias)}`] : [])])],
  };
}

function outcomesOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  const outcomes = payload.providerOutcomes;
  if (outcomes == null) return [];
  if (!Array.isArray(outcomes)) throw new Error("models.list answered providerOutcomes that is not a list");
  return outcomes.map((outcome) => asRecord(outcome, "a provider outcome"));
}

/** What `openclaw models list --json` prints on stdout for this answer. */
export function cliJsonFromModelsList(payload: Record<string, unknown>): CliModelsListJson {
  if (!Array.isArray(payload.models)) throw new Error("models.list answered no model list");
  const outcomes = outcomesOf(payload);
  const models = payload.models.map(toCliModelRow);
  return {
    count: models.length,
    models,
    ...(outcomes.length
      ? {
        providerOutcomes: outcomes.map(({ provider, profileId, status, unlistedConfiguredModelIds }) => {
          const unlisted = unlistedConfiguredModelIds as unknown[] | null | undefined;
          return {
            provider,
            ...(profileId ? { profileId } : {}),
            status,
            ...(status === "ready" && unlisted?.length ? { unlistedConfiguredModelIds: unlisted } : {}),
          };
        }),
      }
      : {}),
  };
}

/**
 * The ids a ready provider's outcome names as configured but missing from its
 * last successful listing (2026.11.3, `getModelCatalogWarnings`). The core
 * reads the field as `?? []` and maps it, so anything else that is not a list
 * would crash the CLI: it throws here too.
 */
function unlistedIdsOf(outcome: Record<string, unknown>): unknown[] {
  const ids = outcome.unlistedConfiguredModelIds;
  if (ids == null) return [];
  if (!Array.isArray(ids)) throw new Error("models.list answered unlistedConfiguredModelIds that is not a list");
  return ids;
}

/**
 * Control characters out, as the core's `sanitizeTerminalText` takes them out
 * of the label. The core strips ANSI sequences before that; a provider or
 * profile id carries none, and only the catalogue's log line reads this.
 */
function terminalSafe(value: unknown): string {
  return String(value).replace(/\p{Cc}/gu, (control) => (control === "\n" ? "\\n" : control === "\r" ? "\\r" : control === "\t" ? "\\t" : ""));
}

/**
 * What the CLI writes to stderr for the same answer: one advisory per
 * configured model a ready provider did not list (from 2026.11.3), the
 * refresh warning and one sentence per provider whose discovery is not ready.
 * "" when there is none. Only the catalogue's log line reads it, as it read
 * the CLI's stderr.
 */
export function cliDiagnosticFromModelsList(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const outcome of outcomesOf(payload)) {
    if (outcome.status !== "ready") continue;
    for (const modelId of unlistedIdsOf(outcome)) {
      lines.push(`Configured model "${terminalSafe(`${String(outcome.provider)}/${String(modelId)}`)}" is not present in the provider's last successful server catalog${outcome.profileId ? ` (profile ${terminalSafe(outcome.profileId)})` : ""}.`
        + " Pull or download it on that server, or fix the configured model name; then run openclaw models list --refresh. The model remains selectable.");
    }
  }
  if (payload.refreshFailed) {
    lines.push("Model discovery could not refresh all providers. Showing the available published model list.");
  }
  for (const outcome of outcomesOf(payload)) {
    if (outcome.status === "ready") continue;
    const label = `${terminalSafe(outcome.provider)}${outcome.profileId ? ` (profile ${terminalSafe(outcome.profileId)})` : ""}`;
    lines.push(outcome.status === "auth-rejected"
      ? `Model discovery authentication was rejected for ${label}. Open Models in the Control UI to check sign-in and catalog access, then retry with --refresh.`
      : `Model discovery is unavailable for ${label}. Retry with --refresh; if it still fails, check the provider in Models in the Control UI.`);
  }
  return lines.join("\n");
}
