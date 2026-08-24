/**
 * The line the chat asks the agent after the owner changes a skill.
 *
 * Installing, removing, enabling or disabling a skill does not restart
 * anything (see the note in `openclaw-config.ts`): OpenClaw watches its skill
 * roots and the running session picks the change up on its next turn. So the
 * only thing the desktop still owes the owner is confirmation that it worked,
 * and the cheapest honest confirmation is the agent saying so itself.
 *
 * It lives here, away from the component, because it is the one part of that
 * flow worth pinning down in a test: the wording is what the owner reads, and
 * it must never again claim a session was refreshed when nothing was.
 */
export type SkillChangeEvent = {
  action?: string;
  /** Display name — present on install, which is the only case that has one. */
  name?: string;
  /** Skill id — what the uninstall/enable/disable paths carry. */
  id?: string;
};

export function buildSkillChangeMessage(evt: SkillChangeEvent | null | undefined): string {
  const label = evt?.name || evt?.id;
  // No label means we cannot name the skill without inventing one, so ask the
  // open question instead of asserting something we do not know.
  if (!label) return "My skills were just updated. What skills do you have available now?";
  switch (evt?.action) {
    case "install":
      return `I just installed the "${label}" skill. Can you confirm you have it and briefly tell me what it does?`;
    case "uninstall":
      return `I just removed the "${label}" skill. Can you confirm it is gone?`;
    case "enable":
      return `I just enabled the "${label}" skill. Can you confirm you have it?`;
    case "disable":
      return `I just disabled the "${label}" skill. Can you confirm it is no longer active?`;
    default:
      return "My skills were just updated. What skills do you have available now?";
  }
}
