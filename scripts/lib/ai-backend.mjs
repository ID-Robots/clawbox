// Shared Claude backend for the ClawBox CI bots (pr-review + issue-triage).
// One place for the two transports so a change to either stays in sync:
//   - CLAUDE_CODE_OAUTH_TOKEN set -> Claude Code CLI (`claude -p`), the
//     official Pro/Max subscription path (same runtime as claude-code-action)
//   - else -> the Anthropic SDK (API key)
// The SDK is imported lazily so the OAuth-only install (CLI, no SDK) doesn't
// crash at module load.
import { execFileSync } from "node:child_process";

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

async function viaSdk({ system, schema, userContent, model, maxTokens }) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const resp = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: userContent }],
  });
  const text = resp.content.find((b) => b.type === "text")?.text;
  // Throw rather than default to "{}" — an empty object downstream would create
  // and apply labels literally named "undefined". Callers' outer catch exits 0.
  if (!text) throw new Error("no text block in model response");
  return JSON.parse(text);
}

// Run one structured-output call and return the validated JSON object.
// OAuth transport preferred; API-key SDK is the fallback.
export function callClaude(opts) {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return viaClaudeCli(opts);
  return viaSdk(opts);
}
