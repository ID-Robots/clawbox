/**
 * The line the chat asks the agent after the owner changes a skill or an app.
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

/**
 * What was actually changed.
 *
 * TASK-544: every branch below said "skill", and the desktop's uninstall path
 * sends this event for anything with a tile on it — including a **webapp**,
 * which is not a skill on either harness. On Hermes that made it wrong every
 * time: `isInstalledAppVisible` hides every non-webapp there, so a webapp is
 * the only installed app an owner can remove, while "skill" is a live separate
 * concept with its own store and its own `skill_uninstall`. The agent was
 * asked to confirm a skill was gone, looked in the skill list, and answered
 * about the wrong thing — or worse, about a real skill that happened to share
 * the id.
 */
export type SkillChangeKind = "skill" | "app";

/**
 * The one name for the event. It says "skill-installed" and it is dispatched
 * for installs, removals, enables and disables of both skills and apps — kept
 * as it is because an older tab left open across an update still listens for
 * this string, and renaming it would drop the confirmation the desktop owes
 * the owner. The constant exists so the next sender cannot invent a variant.
 */
export const SKILL_CHANGE_EVENT = "clawbox-skill-installed";

export type SkillChangeEvent = {
  action?: string;
  /** Display name — preferred over the id wherever the sender has one. */
  name?: string;
  /** Skill or app id — what the uninstall/enable/disable paths carry. */
  id?: string;
  /**
   * Absent means "skill": that is what every sender meant before this field
   * existed, and an older tab left open across an update still emits it.
   */
  kind?: SkillChangeKind;
};

/**
 * Which of the two an installed desktop app is.
 *
 * The webapp URL is the whole rule, and it is the same on both harnesses: a
 * webapp is a page the desktop frames, a skill is something the agent gained.
 * Deriving it here rather than from the edition also fixes the OpenClaw box,
 * where removing a `webapp_create` tile claimed a skill had been removed too.
 */
export function installedAppKind(meta: { webappUrl?: unknown } | undefined | null): SkillChangeKind {
  return meta?.webappUrl ? "app" : "skill";
}

/** The event detail the desktop emits when it removes an installed app. */
export function installedAppRemovedDetail(
  appId: string,
  meta: { name?: string; webappUrl?: unknown } | undefined | null,
): SkillChangeEvent {
  return {
    action: "uninstall",
    id: appId,
    // The id is a slug; the owner clicked a tile with a name on it.
    ...(meta?.name ? { name: meta.name } : {}),
    kind: installedAppKind(meta),
  };
}

/** Tell the chat what just changed. Browser only — it is a window event. */
export function announceSkillChange(detail: SkillChangeEvent): void {
  window.dispatchEvent(new CustomEvent(SKILL_CHANGE_EVENT, { detail }));
}

const NOUN: Record<SkillChangeKind, string> = { skill: "skill", app: "app" };

export function buildSkillChangeMessage(evt: SkillChangeEvent | null | undefined): string {
  const label = evt?.name || evt?.id;
  const noun = NOUN[evt?.kind ?? "skill"];
  // No label means we cannot name the thing without inventing one, so ask the
  // open question instead of asserting something we do not know.
  if (!label) return "My skills were just updated. What skills do you have available now?";
  switch (evt?.action) {
    case "install":
      return `I just installed the "${label}" ${noun}. Can you confirm you have it and briefly tell me what it does?`;
    case "uninstall":
      // An app is gone from the DESKTOP, which is where the agent can check
      // for it (`ui_list_apps`) — asking it to confirm a skill is gone sends
      // it to a list the app was never in.
      return evt.kind === "app"
        ? `I just removed the "${label}" app from the desktop. Can you confirm it is gone?`
        : `I just removed the "${label}" skill. Can you confirm it is gone?`;
    case "enable":
      return `I just enabled the "${label}" ${noun}. Can you confirm you have it?`;
    case "disable":
      return `I just disabled the "${label}" ${noun}. Can you confirm it is no longer active?`;
    default:
      return "My skills were just updated. What skills do you have available now?";
  }
}
