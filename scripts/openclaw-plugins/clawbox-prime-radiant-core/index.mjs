// The Prime Radiant core block, in the owner's main agent's sessions, as an
// OpenClaw plugin.
//
// WHAT IT IS FOR. The pages of the owner's company wiki with the most links,
// one line each (title and summary), so the agent starts every session with
// the core of the wiki instead of searching for it. ClawBox builds the block
// and keeps it current (src/lib/prime-radiant/core-context.ts and
// core-context-file.ts: after every nightly merge, verification and revert,
// and when the owner changes the setting); this plugin only hands it over.
// The Prime Radiant setting `context.enabled` is off by default, and with it
// off there is no file and this plugin adds nothing.
//
// HARNESS FIRST. The pinned core's seam for "add context to a turn" is the
// typed `before_prompt_build` hook (docs/plugins/hooks.md, "Choose a hook";
// docs/plugins/hooks/prompt-and-session.md). It runs on every prompt build, so
// a block ClawBox rewrote after a nightly merge reaches the next turn with no
// gateway restart. The core's other route — a workspace bootstrap file, or the
// bundled `bootstrap-extra-files` hook — is cut at `bootstrapMaxChars` (20,000
// by default, below the block's 30,000) and is the AGENTS.md / MEMORY.md /
// USER.md / SOUL.md family that ClawBox's identity sync and the owner own; it
// is not used, and neither is `agents.defaults.systemPromptSuffix`, which
// gateway-pre-start.sh removes on every boot.
//
// A non-bundled plugin's `before_prompt_build` needs
// `plugins.entries.<id>.hooks.allowConversationAccess: true`; gateway-pre-start.sh
// writes it when it installs this plugin. The handler never reads the
// conversation: it looks at the session key, the agent and the turn's model,
// and a file.
//
// WHO GETS IT. The gateway's default agent only, never a ClawBox user's own
// chat (src/lib/chat-scope.ts), and never a turn that runs on a model on the
// device — the one the core names in the hook context, so a `/model` switch
// or a fallback counts, else the configured primary (a small local model
// would pay ~7.5k tokens a turn out of a 16k window). See prime-radiant-core.mjs.

import { coreContextFile, createBlockReader, promptContext } from "./prime-radiant-core.mjs";

/** The plugin id, which must match `openclaw.plugin.json` and the config key. */
const PLUGIN_ID = "clawbox-prime-radiant-core";

/** The config in force now — the runtime snapshot, which follows a config reload — or the one registration saw. */
function currentConfig(api) {
  try {
    return api?.runtime?.config?.current?.() ?? api?.config ?? null;
  } catch {
    return api?.config ?? null;
  }
}

const clawboxPrimeRadiantCorePlugin = {
  id: PLUGIN_ID,
  name: "ClawBox Prime Radiant core",
  description: "Adds the most-linked pages of the owner's Prime Radiant wiki to the owner's main agent's system context.",
  register(api) {
    const readBlock = createBlockReader(coreContextFile());
    // Total: a fault here costs this turn its block, never the turn.
    api.on("before_prompt_build", async (_event, ctx) => {
      try {
        return await promptContext(ctx, currentConfig(api), readBlock);
      } catch {
        return undefined;
      }
    });
  },
};

// The loader follows only the `default` and `module` export keys, and its one
// hard requirement is that `register` is a function — a named export would be
// ignored, so this default is the plugin's entire contract with the core.
export default clawboxPrimeRadiantCorePlugin;
