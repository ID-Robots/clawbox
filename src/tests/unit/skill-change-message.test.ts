import { describe, expect, it } from "vitest";
import {
  buildSkillChangeMessage,
  installedAppKind,
  installedAppRemovedDetail,
} from "@/lib/skill-change-message";

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

/**
 * TASK-544 — every branch said "skill", and the desktop's uninstall path sends
 * this event for anything with a tile on it, including a WEBAPP.
 *
 * On Hermes that made it wrong every time: `isInstalledAppVisible` hides every
 * non-webapp there, so a webapp is the only installed app an owner can remove,
 * while "skill" is a live separate concept with its own store and its own
 * `skill_uninstall`. The agent was asked to confirm a skill was gone, looked in
 * the skill list, and answered about the wrong thing — or, on an id collision,
 * confirmed the removal of a skill that is still installed.
 */
describe("buildSkillChangeMessage — what was removed decides what it is called", () => {
  it("calls a removed webapp an app, and points at the desktop", () => {
    const msg = buildSkillChangeMessage({ action: "uninstall", name: "Pomodoro", kind: "app" });

    expect(msg).toContain('"Pomodoro"');
    expect(msg).toMatch(/app/);
    expect(msg).not.toMatch(/skill/);
    // `ui_list_apps` is where the agent can actually check.
    expect(msg).toMatch(/desktop/i);
  });

  it("still calls a removed skill a skill", () => {
    const msg = buildSkillChangeMessage({ action: "uninstall", name: "PDF Tools", kind: "skill" });

    expect(msg).toContain("skill");
    expect(msg).not.toMatch(/\bapp\b/);
  });

  it("reads an event with no kind as a skill, the way every sender meant it before", () => {
    // An older tab left open across an update still emits the two-field shape.
    expect(buildSkillChangeMessage({ action: "uninstall", id: "pdf-tools" })).toContain("skill");
  });

  it.each(["install", "enable", "disable"])("names an app an app on %s too", (action) => {
    const msg = buildSkillChangeMessage({ action, name: "Pomodoro", kind: "app" });

    expect(msg).toMatch(/\bapp\b/);
    expect(msg).not.toMatch(/skill/);
  });

  it("never claims the session was refreshed on the app branches either", () => {
    for (const action of ["install", "uninstall", "enable", "disable"]) {
      expect(buildSkillChangeMessage({ action, name: "X", kind: "app" })).not.toMatch(/refresh|restart/i);
    }
  });
});

describe("what the desktop sends when it removes an installed app", () => {
  it("calls a webapp an app", () => {
    expect(installedAppKind({ webappUrl: "/webapps/pomodoro/index.html" })).toBe("app");
  });

  it("calls everything else a skill — including an app whose meta the desktop lost", () => {
    expect(installedAppKind({})).toBe("skill");
    expect(installedAppKind(undefined)).toBe("skill");
  });

  it("sends the name off the tile the owner clicked, not the slug", () => {
    const detail = installedAppRemovedDetail("pomodoro-timer", {
      name: "Pomodoro",
      webappUrl: "/webapps/pomodoro/index.html",
    });

    expect(detail).toEqual({ action: "uninstall", id: "pomodoro-timer", name: "Pomodoro", kind: "app" });
    expect(buildSkillChangeMessage(detail)).toContain('"Pomodoro"');
  });

  it("falls back to the id when there is no meta to read a name from", () => {
    const detail = installedAppRemovedDetail("pdf-tools", undefined);

    expect(detail).toEqual({ action: "uninstall", id: "pdf-tools", kind: "skill" });
    expect(buildSkillChangeMessage(detail)).toContain('"pdf-tools"');
  });
});
