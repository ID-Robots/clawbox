// Each ClawBox user's own language, in their own chat, as an OpenClaw plugin.
//
// WHAT IT IS FOR. The box has one persona — SOUL.md and USER.md — and every
// chat and every cron or automation run reads it. It carries the box default,
// the OWNER's language (src/lib/language-persona.ts). A ClawBox user other
// than the owner picks a language of their own in Settings → Language, and
// ClawBox keeps it apart from the persona (src/lib/user-language.ts), so one
// person's pick never changes the agent's language for anyone else. This
// plugin is how that pick reaches the agent: in that user's chat, and nowhere
// else.
//
// HARNESS FIRST. The pinned core's seam for "add context to a turn" is the
// typed `before_prompt_build` hook (docs/plugins/hooks.md, "Choose a hook";
// docs/plugins/hooks/prompt-and-session.md) — the one the Prime Radiant core
// plugin rides. It runs on every prompt build, so a new pick reaches the next
// turn with no gateway restart. Not the persona files (shared by every chat
// and every cron run, which is the defect this replaces) and not
// `agents.defaults.systemPromptSuffix` (box-wide, and removed by
// gateway-pre-start.sh on every boot).
//
// A non-bundled plugin's `before_prompt_build` needs
// `plugins.entries.<id>.hooks.allowConversationAccess: true`; gateway-pre-start.sh
// writes it when it installs this plugin. The handler never reads the
// conversation: it looks at the session key and one key of the device store.

import { createLanguagesReader, deviceStoreFile, promptContext } from "./user-language.mjs";

/** The plugin id, which must match `openclaw.plugin.json` and the config key. */
const PLUGIN_ID = "clawbox-user-language";

const clawboxUserLanguagePlugin = {
  id: PLUGIN_ID,
  name: "ClawBox user language",
  description: "Tells the agent which language to answer in, in the own chat of each ClawBox user who picked one.",
  register(api) {
    const readLanguages = createLanguagesReader(deviceStoreFile());
    // Total: a fault here costs this turn its instruction, never the turn.
    api.on("before_prompt_build", async (_event, ctx) => {
      try {
        return await promptContext(ctx, readLanguages);
      } catch {
        return undefined;
      }
    });
  },
};

// The loader follows only the `default` and `module` export keys, and its one
// hard requirement is that `register` is a function — a named export would be
// ignored, so this default is the plugin's entire contract with the core.
export default clawboxUserLanguagePlugin;
