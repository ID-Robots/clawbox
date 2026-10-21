// Which turns get the Prime Radiant core block, and the block itself, read
// from the file ClawBox keeps current (src/lib/prime-radiant/core-context-file.ts).
//
// Everything here decides "no block" whenever it cannot prove "block": the
// block is the owner's company wiki, and the cost of a missing one is a search
// the agent can still make.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** The file's shape version (core-context-file.ts `CORE_CONTEXT_FORMAT`). */
export const CORE_CONTEXT_FORMAT = 1;

/**
 * The longest block taken: settings.ts `MAX_CONTEXT_MAX_CHARS` (60,000) with
 * room to spare. A longer one is not one ClawBox wrote, and is left out.
 */
export const MAX_BLOCK_CHARS = 64_000;
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Where ClawBox writes the block: src/lib/prime-radiant/paths.ts
 * `coreContextPath()`, `<ClawBox root>/data/prime-radiant/core-context.json`
 * (`PRIME_RADIANT_DIR` overriding the folder). The gateway does not run with
 * `CLAWBOX_ROOT` set, so the root falls back exactly as
 * scripts/gateway-pre-start.sh resolves it: `$CLAWBOX_HOME_DIR/clawbox`, the
 * home directory when that is unset.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [home]
 */
export function coreContextFile(env = process.env, home = os.homedir()) {
  const override = env.PRIME_RADIANT_DIR;
  if (override && path.isAbsolute(override)) return path.join(path.resolve(override), "core-context.json");
  const root = env.CLAWBOX_ROOT || path.join(env.CLAWBOX_HOME_DIR || home, "clawbox");
  return path.join(root, "data", "prime-radiant", "core-context.json");
}

/**
 * A ClawBox user's own chat: `agent:<id>:clawbox-user-<name>` and
 * `agent:<id>:clawbox-utab-<hex>-<name>` (src/lib/chat-scope.ts, which
 * src/tests/unit/chat-scope.test.ts holds this to). Matched by the prefix
 * alone, wider than chat-scope's full pattern on purpose: no owner key starts
 * like this, and a key that merely looks like a user's gets no block.
 */
const USER_KEY_RE = /^agent:[^:]+:clawbox-u(?:ser|tab)-/;

export function isUserChatKey(key) {
  return typeof key === "string" && USER_KEY_RE.test(key.trim().toLowerCase());
}

/** The agent a session key belongs to (`agent:<id>:…`), `main` for a bare key — chat-scope.ts `agentIdOfKey`. */
export function agentIdOfKey(key) {
  const m = /^agent:([^:]+):/.exec(key.trim().toLowerCase());
  return m ? m[1] : "main";
}

/** The gateway's default agent: the `agents.entries` entry marked `default`, else the core's implicit `main`. */
export function mainAgentId(cfg) {
  const entries = cfg?.agents?.entries;
  if (entries && typeof entries === "object" && !Array.isArray(entries)) {
    for (const [id, entry] of Object.entries(entries)) {
      if (entry && typeof entry === "object" && entry.default === true) return id.toLowerCase();
    }
  }
  return "main";
}

/** The agent's primary model, `provider/model`: its own, else the defaults'. Null when none is set. */
export function primaryModel(cfg, agentId) {
  const own = cfg?.agents?.entries?.[agentId]?.model;
  const model = own ?? cfg?.agents?.defaults?.model;
  if (typeof model === "string") return model.trim() || null;
  return typeof model?.primary === "string" && model.primary.trim() ? model.primary.trim() : null;
}

/**
 * True when the model runs on this device — or is not known, which is
 * treated the same. src/lib/local-model-profile.ts `isSmallLocalModel` holds
 * that everything this hardware can host is small (its 8B line is above what
 * an 8 GB Jetson serves, and an unreadable id counts as small), so on the
 * on-device providers (provider-status.ts `LOCAL_PROVIDER_IDS`, spelled as
 * `normalizeProviderId` folds them) the answer is "small" without parsing the
 * id: a ~7.5k-token block would take half of a 16k window every turn.
 */
export function runsOnDevice(model) {
  if (typeof model !== "string" || !model.includes("/")) return true;
  const provider = model.split("/")[0].trim().toLowerCase();
  return provider.startsWith("llamacpp") || provider.startsWith("ollama");
}

/**
 * The block's text, read again only when the file changed (its inode, size
 * and time): ClawBox replaces it atomically after a nightly merge, so the
 * next prompt build sees the new one, with no restart. Null when there is no
 * file or it is not a block ClawBox wrote.
 */
export function createBlockReader(file) {
  let cached = null;
  return async function readBlock() {
    let st;
    try {
      st = await fs.stat(file);
    } catch {
      cached = null;
      return null;
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    if (cached?.key === key) return cached.text;
    let text = null;
    try {
      const o = JSON.parse(await fs.readFile(file, "utf8"));
      if (o && o.format === CORE_CONTEXT_FORMAT && typeof o.text === "string" && o.text.trim() !== "" && o.text.length <= MAX_BLOCK_CHARS) {
        text = o.text;
      }
    } catch {
      text = null;
    }
    cached = { key, text };
    return text;
  };
}

/**
 * The `before_prompt_build` answer for one turn: the block as system context
 * for the owner's main agent, nothing for anything else.
 *
 * `appendSystemContext`, not `prependContext`: the core captures prompt-hook
 * prepend/append context on the turn's own transcript record and replays it
 * (docs/reference/prompt-caching.md in the pinned core), so a block returned
 * as `prependContext` would sit in the history once per turn. System context
 * is rebuilt with the system prompt on every turn: the session carries the
 * block once, and the newest one.
 */
export async function promptContext(ctx, cfg, readBlock) {
  const key = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
  if (!key || isUserChatKey(key)) return undefined;
  const main = mainAgentId(cfg);
  if (agentIdOfKey(key) !== main) return undefined;
  if (typeof ctx?.agentId === "string" && ctx.agentId && ctx.agentId.toLowerCase() !== main) return undefined;
  if (runsOnDevice(primaryModel(cfg, main))) return undefined;
  const text = await readBlock();
  return text ? { appendSystemContext: text } : undefined;
}
