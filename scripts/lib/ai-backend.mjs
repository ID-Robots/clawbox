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
// Anthropic's JSON-schema subset for structured outputs lists every numeric,
// string, array and object CONSTRAINT as unsupported, plus string `format`,
// and only the SDK's `.parse()` helper strips them — a schema handed to
// `messages.create()` goes to the API as written and a 400 comes back. Both
// bots' outer catch exits 0, so that 400 would be an untriaged issue under a
// green run page whenever the OAuth token is absent and this transport is
// the one that runs. The whole documented set is listed, not just the two
// keywords the bots use today, because the next cap someone adds to a schema
// must not be a 400 that no test here can reach. The two caps the bots use
// (`maxLength`, `maxItems`) stay in the caller's schema and are enforced
// locally by `assertMatchesSchema` on both transports; every OTHER keyword in
// this set is one that validator refuses to see at all, so a schema that grew
// a `pattern` fails loudly instead of shipping a constraint nothing applies.
// `additionalProperties: false` is NOT in this set — it is the one constraint
// the API does enforce, and the bots rely on it.
const API_UNSUPPORTED_KEYWORDS = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern",
  "minItems", "maxItems", "uniqueItems",
  "minProperties", "maxProperties",
  "format",
]);

// Where a schema node holds OTHER schema nodes. Everything else at a node —
// `type`, `enum`, `required`, `description`, `additionalProperties` — is a
// value, copied as it is: a property NAMED `maxLength` lives under
// `properties`, where the keys are names and never keywords, so a walk that
// stripped keywords at every depth would delete the field itself.
const ONE_SCHEMA_KEYS = new Set(["items", "not"]);
const SCHEMA_LIST_KEYS = new Set(["anyOf", "oneOf", "allOf"]);
const SCHEMA_MAP_KEYS = new Set(["properties", "$defs", "definitions"]);

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A copy of `schema` for the API: the locally-enforced caps taken out, everything else kept. */
export function apiSchema(schema) {
  if (!isPlainObject(schema)) return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (API_UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (SCHEMA_MAP_KEYS.has(key) && isPlainObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, apiSchema(sub)]));
    } else if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
      out[key] = value.map(apiSchema);
    } else if (ONE_SCHEMA_KEYS.has(key)) {
      // Draft-4 tuple `items` is an array of schemas; the bots never write one,
      // but a walk that met it must not hand the API a cap inside it.
      out[key] = Array.isArray(value) ? value.map(apiSchema) : apiSchema(value);
    } else {
      out[key] = value;
    }
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
