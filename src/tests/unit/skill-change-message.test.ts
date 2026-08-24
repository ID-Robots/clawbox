import { describe, expect, it } from "vitest";
import { buildSkillChangeMessage } from "@/lib/skill-change-message";

/**
 * The wording is the whole product here: after a skill change the owner sees
 * this line as their own chat bubble, and the agent's reply to it is the only
 * confirmation the desktop gives that the change took.
 *
 * The claim these tests exist to prevent coming back is "your session was
 * refreshed". The old copy said it on every branch, and it was false the
 * moment the gateway stopped restarting on install — which is exactly what
 * left the chat frozen (TASK-508). Nothing restarts; the message must not
 * pretend otherwise.
 */
describe("buildSkillChangeMessage", () => {
  it("names the installed skill and asks the agent to confirm it", () => {
    const msg = buildSkillChangeMessage({ action: "install", name: "Weather Forecast" });
    expect(msg).toContain('"Weather Forecast"');
    expect(msg).toMatch(/confirm/i);
  });

  it.each([
    ["uninstall", /removed/i],
    ["enable", /enabled/i],
    ["disable", /disabled/i],
  ])("describes a %s by id", (action, expected) => {
    const msg = buildSkillChangeMessage({ action, id: "weather-forecast" });
    expect(msg).toContain('"weather-forecast"');
    expect(msg).toMatch(expected);
  });

  it("never claims the session was refreshed or restarted", () => {
    for (const evt of [
      { action: "install", name: "A" },
      { action: "uninstall", id: "b" },
      { action: "enable", id: "c" },
      { action: "disable", id: "d" },
      { action: "install" },
      null,
    ]) {
      expect(buildSkillChangeMessage(evt)).not.toMatch(/refresh|restart/i);
    }
  });

  it("asks an open question rather than inventing a name it was not given", () => {
    // An install event with no name still has to say something useful; naming
    // a skill we cannot identify would be worse than asking.
    expect(buildSkillChangeMessage({ action: "install" })).toBe(
      "My skills were just updated. What skills do you have available now?",
    );
    expect(buildSkillChangeMessage(undefined)).toMatch(/what skills do you have/i);
  });

  it("carries no hidden [System: ...] preamble", () => {
    // The old message smuggled a bracketed system note in front of the text and
    // stripped it before display, so the bubble and the wire disagreed. What
    // the owner reads is now exactly what the agent is asked.
    expect(buildSkillChangeMessage({ action: "install", name: "X" })).not.toContain("[System:");
  });
});
