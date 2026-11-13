/**
 * The local-only AI lock, the half every side can import (TASK-2501).
 *
 * WHAT IT IS. One switch, `ai_cloud_lock` in the device store, that keeps
 * every piece of AI content on the box or on the owner's own network: the
 * chat, its summaries, pictures, speech both ways, Memory Shard's embeddings,
 * Prime Radiant, the coding agent and web search answer from an on-box engine
 * (llama.cpp, Ollama, the on-device voice and Whisper) or from the owner's
 * External engine (`clawext`, a workstation on the LAN) — never from the
 * ClawBox AI proxy, OpenAI or Anthropic. The box stays LINKED while locked:
 * the portal heartbeat, the plan badge, the tunnel and ClawKeep keep using the
 * ClawBox credential, because none of them carries AI content — they read it
 * from the store themselves, and the usage meter, the Store, sign-out and the
 * edition swap through `resolveClawaiEntitlementToken` — while every AI use of
 * that credential reads `resolveClawaiToken`, which answers null under the lock.
 *
 * WHAT IT DOES TODAY. Every place the box itself would START a cloud AI path
 * asks first: a cloud chat model, a cloud provider sign-in, the cloud voice
 * or transcription engine, the cloud embedder, ClawBox AI's pictures, vision,
 * Prime Radiant and the coding agent are refused (409 `cloud_ai_locked`) or
 * answer from the box. What an owner configured BEFORE the lock went on — a
 * cloud primary or fallback in openclaw.json, Hermes' provider, a cloud voice
 * the gateway speaks with — is not rewritten here; that is the switch's work.
 *
 * Pure: no `fs`, no Next. The server half is src/lib/ai-cloud-lock.ts and the
 * browser half src/lib/ai-cloud-lock-client.ts.
 */

/** The switch in data/config.json. */
export const AI_CLOUD_LOCK_KEY = "ai_cloud_lock";

/** The `code` every refused cloud AI call answers with. */
export const CLOUD_AI_LOCKED_CODE = "cloud_ai_locked";

/** The sentence a refused cloud AI call shows, when the caller has none of its own. */
export const CLOUD_AI_LOCKED_MESSAGE =
  "Local-only AI is on: this box sends nothing to a cloud AI model. Use a local engine, or turn the lock off in Settings → Local AI.";

/**
 * The stored value. `true` is locked; `"pinned"` is locked AND pinned — only an
 * organisation box may pin, and a pinned lock is not turned off by a plain
 * "off" (the owner unpins it first, deliberately). Anything else — absent,
 * `false`, a string — is unlocked, the state every box ships in. (A store that
 * cannot be read at all is another matter: `readCloudAiLock` fails closed.)
 */
export type StoredCloudAiLock = true | "pinned" | false | undefined;

export interface CloudAiLockState {
  locked: boolean;
  pinned: boolean;
}

/** Read the stored value the one way every reader reads it. */
export function cloudAiLockFrom(value: unknown): CloudAiLockState {
  if (value === "pinned") return { locked: true, pinned: true };
  if (value === true) return { locked: true, pinned: false };
  return { locked: false, pinned: false };
}

/** What to store for a state. Unlocked is the key's absence. */
export function storedCloudAiLock(state: CloudAiLockState): StoredCloudAiLock {
  if (!state.locked) return undefined;
  return state.pinned ? "pinned" : true;
}

/**
 * Model providers whose inference never leaves the box or the owner's network:
 * llama.cpp and Ollama on the box, Hermes's own slug for the on-device model,
 * and the External engine (`clawext`), which is the owner's machine on the LAN.
 */
export const LOCAL_AI_PROVIDER_IDS: readonly string[] = ["llamacpp", "ollama", "clawlocal", "clawext"];

/** A `provider/model` reference served on the box or by the owner's External engine. */
export function isLocalAiModelRef(ref: unknown): ref is string {
  if (typeof ref !== "string") return false;
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return false;
  return LOCAL_AI_PROVIDER_IDS.includes(trimmed.slice(0, slash));
}

/** The local subset of a fallback chain, in order. Not an array → []. */
export function localOnlyFallbacks(fallbacks: unknown): string[] {
  return Array.isArray(fallbacks) ? fallbacks.filter(isLocalAiModelRef).map((ref) => ref.trim()) : [];
}

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * Is this endpoint on the box or on the owner's own network? Loopback, the
 * private and link-local ranges, CGNAT (a tailnet), `.local` / `.lan` /
 * `.internal` names and bare host names. A URL that cannot be parsed is NOT
 * local: the lock fails closed.
 */
export function isLocalAiBaseUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url.trim()) return false;
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) {
    // IPv6: loopback, link-local (fe80::/10) and unique-local (fc00::/7).
    return host === "::1" || /^fe[89ab][0-9a-f]:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host);
  }
  if (isPrivateIpv4(host)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  if (/\.(local|lan|internal|home\.arpa)$/.test(host)) return true;
  // A single-label name ("workstation") resolves on the LAN, never on the internet.
  return /^[a-z0-9-]+$/.test(host);
}

/** Where one AI capability of the box answers from right now. */
export type AiCapabilityTarget = "local" | "cloud" | "off";

export const AI_CAPABILITIES = [
  "chat",
  "compaction",
  "toolSearch",
  "vision",
  "tts",
  "stt",
  "embeddings",
  "primeRadiant",
  "codingAgent",
  "imageGeneration",
  "webSearch",
] as const;

export type AiCapability = (typeof AI_CAPABILITIES)[number];

export interface AiCapabilityAudit {
  capability: AiCapability;
  points: AiCapabilityTarget;
  /** What it points at, for the owner: a model ref, a provider id or an engine name. Never a secret. */
  target: string | null;
  /** Under the lock, the cloud route this capability had is refused. */
  blockedByLock: boolean;
}

/** The answer of `GET /setup-api/local-ai/lock`. */
export interface CloudAiLockReport {
  cloud_ai_locked: boolean;
  pinned: boolean;
  /** Only an organisation box may pin the lock. */
  canPin: boolean;
  edition: "openclaw" | "hermes";
  /** The box is still linked to its ClawBox account (heartbeat, plan, tunnel, ClawKeep). */
  linked: boolean;
  capabilities: AiCapabilityAudit[];
  /** Capabilities still pointing at a cloud model — empty on a correctly locked box. */
  leaks: AiCapability[];
}
