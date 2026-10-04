/**
 * Credential redaction applied to EVERY text a tool returns to the agent.
 *
 * WHY. A customer security report showed a diagnostic inspection returning an
 * Anthropic OAuth access token (`sk-ant-oat…`) and its refresh token unmasked
 * in a tool result. The older scrubber (`redact()` in errors.ts) only knew
 * labels such as `api_key` / `access_token` followed directly by `:`/`=`, plus
 * long pure-hex blobs. An auth-profile record stores OAuth credentials under
 * the bare keys `access` and `refresh` (`"access": "sk-ant-oat01-…"`), the
 * values contain `-` and `_` so they are not hex, and a JSON blob read out of a
 * SQLite row is escaped (`\"refresh\":\"…\"`) — none of which it matched. And
 * most tools (bash output, job output, file reads) did not go through it at
 * all.
 *
 * WHAT. Two independent passes, so that either alone is enough:
 *  1. KEY-BASED: a value under a credential-shaped key (access, refresh,
 *     token, secret, apiKey, password, …) in JSON, escaped JSON, YAML or
 *     `KEY=value` form is replaced, whatever it looks like.
 *  2. VALUE-BASED: a value that looks like a credential is replaced wherever
 *     it appears — `sk-ant-…`, other `sk-…` keys, JWTs, GitHub/Slack/Google
 *     style tokens.
 *
 * The replacement keeps nothing of the secret (no prefix/suffix "hints").
 */

export const REDACTED = "[REDACTED]";

/**
 * Keys whose value is a credential. Matched case-insensitively against the
 * whole key, with `_`/`-` separators optional.
 */
const SECRET_KEY_SOURCE = [
  "access",
  "refresh",
  "(?:access|refresh|id|auth|bearer|session|oauth|api|bot|app|client)[_-]?tokens?",
  // Any other <name>_token / <name>-token key, e.g. the box's own ClawBox AI
  // credential `clawai_token` in data/config.json, `github_token`, `portal_token`.
  "[a-z0-9]+(?:[_-][a-z0-9]+)*[_-]tokens?",
  "tokens?",
  "api[_-]?keys?",
  "secret[_-]?keys?",
  "private[_-]?keys?",
  "client[_-]?secrets?",
  "secrets?",
  "passwords?",
  "passwd",
  "authorization",
  "credentials?",
  "cookie",
].join("|");

// "key": "value"  and  \"key\":\"value\"  (escaped JSON inside a SQLite text/blob dump)
const JSON_KEY_RE = new RegExp(
  String.raw`((\\?)["'](?:${SECRET_KEY_SOURCE})\2["']\s*:\s*\\?["'])((?:\\.|[^"'\\\n])+?)(\\?["'])`,
  "gi",
);
// key: value  /  KEY=value  (YAML, env, shell, log fields). Requires a value of
// 8+ non-space chars so prose such as "token: none" or "refresh: true" is left.
const ASSIGN_KEY_RE = new RegExp(
  String.raw`(^|[\s,{;(]|[A-Za-z0-9][_-])((?:${SECRET_KEY_SOURCE})\s*[:=]\s*)(["']?)([^\s"',;}]{8,})\3`,
  "gim",
);

// `Authorization: Bearer <token>` / `Basic <b64>` (curl -v, HTTP logs, scripts).
// The key pass above sees only the scheme word as the value, so the token itself
// needs its own rule.
const AUTH_SCHEME_RE = /\b(bearer|basic|token)(\s+)([A-Za-z0-9._~+/-]{8,}=*)/gi;
// Credentials in a URL's userinfo: https://user:secret@host
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)([^\s/@]{4,})@/gi;
// A CLI flag carrying a secret: --token X, --api-key X, --password=X
const FLAG_RE = new RegExp(
  String.raw`(--(?:${SECRET_KEY_SOURCE})(?:\s+|=))(["']?)([^\s"']{8,})\2`,
  "gi",
);

const VALUE_PATTERNS: RegExp[] = [
  // Anthropic: API keys (sk-ant-api…), OAuth access (sk-ant-oat…) and refresh (sk-ant-ort…).
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  // OpenAI and other `sk-` keys (sk-proj-…, sk-live-…, sk-or-…).
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // JWTs (OpenAI/Codex OAuth access + id tokens).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // GitHub, Slack, Google, HF, Telegram bot tokens.
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /\b1\/\/0[A-Za-z0-9_-]{20,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  // ClawBox AI portal tokens.
  /\bclaw_[A-Za-z0-9]{24,}/g,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g,
];

/** Replace anything that looks like a credential with `[REDACTED]`. */
export function redactCredentials(text: string): string {
  if (!text) return text;
  let out = text
    .replace(JSON_KEY_RE, (m, open: string, _esc: string, value: string, close: string) =>
      value === REDACTED || value.length < 4 ? m : `${open}${REDACTED}${close}`,
    )
    .replace(ASSIGN_KEY_RE, (m, lead: string, label: string, q: string, value: string) =>
      value === REDACTED ? m : `${lead}${label}${q}${REDACTED}${q}`,
    );
  out = out
    .replace(AUTH_SCHEME_RE, (m, scheme: string, sp: string, value: string) =>
      value === REDACTED || !/\d/.test(value) ? m : `${scheme}${sp}${REDACTED}`,
    )
    .replace(URL_USERINFO_RE, (_m, head: string) => `${head}${REDACTED}@`)
    .replace(FLAG_RE, (m, flag: string, q: string, value: string) => (value === REDACTED ? m : `${flag}${q}${REDACTED}${q}`));
  for (const re of VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}
