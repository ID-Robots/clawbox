// Lean mode for the on-device model, as an OpenClaw plugin.
//
// WHAT IT IS FOR. When a turn runs on the llama.cpp model on the box (Gemma 4
// E2B, ~2B parameters), it gets a short system prompt — who it is, answer in the
// language of the user's last message, act instead of asking, keep it short —
// and six tools instead of OpenClaw's full prompt and catalog. Every other turn,
// on any cloud model, is untouched, so switching back to a cloud model restores
// the full prompt and tool set with no config change. See local-lean.mjs.
//
// HARNESS FIRST. The pinned core has no per-model prompt setting: the prompt
// mode is chosen per run and is not user-facing config. Its documented seam for
// "replace or narrow the prompt and tools of one turn" is the typed
// `before_prompt_build` hook, which may return `systemPrompt` and `toolsAllow`
// (docs/plugins/hooks/prompt-and-session.md), and whose context names the
// attempt's own provider (`modelProviderId`) — the same hook the user-language
// and Prime Radiant core plugins ride. `tools.byProvider` could narrow the tools
// alone, but the prompt names the exact tools it teaches, so both come from one
// place. OpenClaw's Tool Search stays as it is: it is global, and turning it off
// for the local model would turn it off for every cloud model too.
//
// A non-bundled plugin's `before_prompt_build` needs
// `plugins.entries.<id>.hooks.allowConversationAccess: true`; gateway-pre-start.sh
// writes it when it installs this plugin. The handler reads the current message
// only to tell which language it is in.

import { promptBuild } from "./local-lean.mjs";

/** The plugin id, which must match `openclaw.plugin.json` and the config key. */
const PLUGIN_ID = "clawbox-local-lean";

/** The config in force now — the runtime snapshot, which follows a config reload — or the one registration saw. */
function currentConfig(api) {
  try {
    return api?.runtime?.config?.current?.() ?? api?.config ?? null;
  } catch {
    return api?.config ?? null;
  }
}

const clawboxLocalLeanPlugin = {
  id: PLUGIN_ID,
  name: "ClawBox local lean mode",
  description: "Gives turns on the on-device llama.cpp model a short system prompt and a small tool set.",
  register(api) {
    // Total: a fault here costs the turn its lean prompt (it runs with
    // OpenClaw's full one), never the turn.
    api.on("before_prompt_build", (event, ctx) => {
      try {
        return promptBuild(event, ctx, currentConfig(api));
      } catch {
        return undefined;
      }
    });
  },
};

// The loader follows only the `default` and `module` export keys, and its one
// hard requirement is that `register` is a function.
export default clawboxLocalLeanPlugin;
