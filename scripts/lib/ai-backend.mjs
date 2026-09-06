// Shared Claude backend for the ClawBox CI bots (pr-review + issue-triage).
// One place for the two transports so a change to either stays in sync:
//   - CLAUDE_CODE_OAUTH_TOKEN set -> Claude Code CLI (`claude -p`), the
//     official Pro/Max subscription path (same runtime as claude-code-action)
//   - else -> the Anthropic SDK (API key)
// The SDK is imported lazily so the OAuth-only install (CLI, no SDK) doesn't
// crash at module load.
import { execFileSync } from "node:child_process";
import { assertMatchesSchema } from "./triage-output.mjs";

// Extract a JSON object from possibly-fenced/wrapped model text.
export function parseModelJson(text) {
  const stripped = text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  const m = stripped.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON object in model response");
  return JSON.parse(m[0]);
}

function viaClaudeCli({ system, schema, userContent, model, timeoutMs, maxBuffer }) {
  const prompt = [
    system,
    "\nRespond with ONLY a JSON object matching this schema (no prose, no fences):",
    JSON.stringify(schema),
    "\n---\n",
    userContent,
  ].join("\n");
  const out = execFileSync("claude", ["-p", "--model", model, "--output-format", "json"], {
    encoding: "utf8",
    input: prompt,
    stdio: ["pipe", "pipe", "inherit"],
    timeout: timeoutMs,
    maxBuffer,
  });
  const wrapper = JSON.parse(out);
  if (wrapper.is_error) throw new Error(`claude cli error: ${String(wrapper.result).slice(0, 200)}`);
  return parseModelJson(String(wrapper.result));
}

// The keywords the API's structured outputs do not accept in a RAW schema.
// Anthropic's JSON-schema subset lists string constraints (`maxLength`) and
// array constraints (`maxItems`) as unsupported, and only the SDK's `.parse()`
// helper strips them — a schema handed to `messages.create()` goes to the API
// as written and a 400 comes back. Both bots' outer catch exits 0, so that 400
// would be an untriaged issue under a green run page whenever the OAuth token
// is absent and this transport is the one that runs. The caps stay: they are
// enforced locally by `assertMatchesSchema`, on both transports.
const API_UNSUPPORTED_KEYWORDS = new Set(["maxLength", "maxItems"]);

/** A copy of `schema` for the API: the locally-enforced caps taken out, everything else kept. */
export function apiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(apiSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (API_UNSUPPORTED_KEYWORDS.has(key)) continue;
    out[key] = apiSchema(value);
  }
  return out;
}

async function viaSdk({ system, schema, userContent, model, maxTokens }) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const resp = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    output_config: { format: { type: "json_schema", schema: apiSchema(schema) } },
    messages: [{ role: "user", content: userContent }],
  });
  const text = resp.content.find((b) => b.type === "text")?.text;
  // Throw rather than default to "{}" — an empty object downstream would create
  // and apply labels literally named "undefined". Callers' outer catch exits 0.
  if (!text) throw new Error("no text block in model response");
  // Tolerant parse (same as the CLI path) in case the model fences the JSON.
  return parseModelJson(text);
}

// Run one structured-output call and return the validated JSON object.
// OAuth transport preferred; API-key SDK is the fallback.
//
// Validated HERE, on both transports, not in the callers: the CLI path only
// pastes the schema into the prompt, and the SDK path enforces the enums
// server-side but never the caps (see `apiSchema`). A reply that is not what
// the schema asked for throws — and says so with `::error::`, because both
// bots' outer catch exits 0 and a guard that refused quietly would leave
// issues untriaged with a green run page. Unknown keys and over-long text are
// conformed, not refused (see triage-output.mjs), so a stray key never costs
// a triage.
export async function callClaude(opts) {
  const raw = process.env.CLAUDE_CODE_OAUTH_TOKEN ? viaClaudeCli(opts) : await viaSdk(opts);
  try {
    return assertMatchesSchema(opts.schema, raw);
  } catch (err) {
    console.error(`::error::${err?.message ?? err}`);
    throw err;
  }
}
