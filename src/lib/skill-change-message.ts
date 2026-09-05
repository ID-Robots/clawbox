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
 * for installs, removals, enables and disables of both skills and apps. Kept as
 * it is because renaming a string four senders and two listeners agree on buys
 * nothing; the constant exists so the next sender cannot invent a variant.
 */
export const SKILL_CHANGE_EVENT = "clawbox-skill-installed";

export type SkillChangeEvent = {
  action?: string;
  /** Display name — preferred over the id wherever the sender has one. */
  name?: string;
  /** Skill or app id — what the uninstall/enable/disable paths carry. */
  id?: string;
  /**
   * Absent means "skill". Not a compatibility story — every sender ships in the
   * same bundle as the listener — but a sender that forgets it should get the
   * historical wording rather than `undefined` in the owner's own bubble.
   */
  kind?: SkillChangeKind;
  /**
   * One id can be BOTH: `webapp_create` replaces `installed_meta[<id>]` for any
   * id with no collision check, and the uninstall route then removes the webapp
   * and the store skill of that name and reports which in `skillRemoved`. Only
   * set where the route confirmed the skill half went too — the owner has just
   * lost a capability, and a line that mentions only the tile does not say so.
   */
  alsoSkill?: boolean;
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

/**
 * The event detail the desktop emits when it removes an installed app.
 *
 * @param skillRemoved the route's own `skillRemoved` field: true where it
 *        confirmed a store skill of the same id went as well, null where it
 *        could not look.
 */
export function installedAppRemovedDetail(
  appId: string,
  meta: { name?: string; webappUrl?: unknown } | undefined | null,
  skillRemoved?: boolean | null,
): SkillChangeEvent {
  const kind = installedAppKind(meta);
  return {
    action: "uninstall",
    id: appId,
    // The id is a slug; the owner clicked a tile with a name on it. Both
    // travel: the name is what the owner recognises, the id is what
    // `ui_list_apps` and `skill_uninstall` actually report.
    ...(meta?.name ? { name: meta.name } : {}),
    kind,
    ...(kind === "app" && skillRemoved === true ? { alsoSkill: true } : {}),
  };
}

/** Tell the chat what just changed. Browser only — it is a window event. */
export function announceSkillChange(detail: SkillChangeEvent): void {
  window.dispatchEvent(new CustomEvent(SKILL_CHANGE_EVENT, { detail }));
}

export function buildSkillChangeMessage(evt: SkillChangeEvent | null | undefined): string {
  const label = evt?.name || evt?.id;
  // Not an index into a record: `kind` arrives from an untyped
  // `CustomEvent.detail`, and every other unknown input to this function is
  // already defended. A stray value must not put `undefined` in the bubble.
  const noun = evt?.kind === "app" ? "app" : "skill";
  // The name is what the OWNER recognises; the id is what the agent's lists
  // report. `ui_list_apps` emits an installed app as `{ id: "installed-<id>",
  // name: <id> }` — the display name is never in it — and `skill_list` leads
  // with the lock id, so a sentence carrying only the name asks the agent to
  // verify against a string neither list contains.
  const qualifier = evt?.name && evt?.id && evt.name !== evt.id ? ` (id: ${evt.id})` : "";
  // No label means we cannot name the thing without inventing one, so ask the
  // open question instead of asserting something we do not know.
  if (!label) return "My skills were just updated. What skills do you have available now?";
  switch (evt?.action) {
    case "install":
      return noun === "app"
        ? `I just installed the "${label}" app${qualifier} on the desktop. Can you confirm you can see it?`
        : `I just installed the "${label}" skill${qualifier}. Can you confirm you have it and briefly tell me what it does?`;
    case "uninstall":
      // An app is gone from the DESKTOP, which is where the agent can check
      // for it (`ui_list_apps`) — asking it to confirm a skill is gone sends
      // it to a list the app was never in.
      if (noun !== "app") return `I just removed the "${label}" skill${qualifier}. Can you confirm it is gone?`;
      return evt?.alsoSkill
        ? `I just removed the "${label}" app${qualifier} from the desktop, and the skill of the same id went with it. Can you confirm both are gone?`
        : `I just removed the "${label}" app${qualifier} from the desktop. Can you confirm it is gone?`;
    case "enable":
      return `I just enabled the "${label}" ${noun}${qualifier}. Can you confirm you have it?`;
    case "disable":
      return `I just disabled the "${label}" ${noun}${qualifier}. Can you confirm it is no longer active?`;
    default:
      return "My skills were just updated. What skills do you have available now?";
  }
}
