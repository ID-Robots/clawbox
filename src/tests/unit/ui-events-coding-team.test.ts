// @vitest-environment jsdom
/**
 * The team hand-off trio and the team-changed signal (src/lib/ui-events.ts,
 * the 2026-10-30 redesign's step 3): the same shape as the run trio — a
 * `window` slot for a cold open, an event for an app already up, a take-once
 * read — and an app opened in a NORMAL window, never maximized.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CODING_TEAM_CHANGED_EVENT,
  dispatchOpenCodingTeam,
  handoffCodingTeam,
  notifyCodingTeamChanged,
  onCodingTeamChanged,
  OPEN_APP_EVENT,
  OPEN_CODING_TEAM_EVENT,
  takePendingCodingRun,
  takePendingCodingTeam,
  type OpenAppDetail,
} from "@/lib/ui-events";

describe("dispatchOpenCodingTeam", () => {
  it("parks the team id, fires the team event and opens the Coding Agent in a plain window", () => {
    const opens: OpenAppDetail[] = [];
    const teams: unknown[] = [];
    const onOpen = (e: Event) => opens.push((e as CustomEvent<OpenAppDetail>).detail);
    const onTeam = (e: Event) => teams.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_APP_EVENT, onOpen);
    window.addEventListener(OPEN_CODING_TEAM_EVENT, onTeam);
    try {
      dispatchOpenCodingTeam("team-k3x9q2ab");
    } finally {
      window.removeEventListener(OPEN_APP_EVENT, onOpen);
      window.removeEventListener(OPEN_CODING_TEAM_EVENT, onTeam);
    }
    // `toEqual` on the whole detail: a `maximize` key would be a different
    // contract from no key, and the desktop reads the key's presence.
    expect(opens).toEqual([{ appId: "coding" }]);
    expect(teams).toEqual([{ teamId: "team-k3x9q2ab" }]);
    expect(takePendingCodingTeam()).toBe("team-k3x9q2ab");
    expect(takePendingCodingTeam()).toBeNull();
    // Its own slot: a team hand-off leaves the run's untouched.
    expect(takePendingCodingRun()).toBeNull();
  });

  it("handoffCodingTeam parks and fires without opening the app — for a desktop that opens it itself", () => {
    const opens: unknown[] = [];
    const onOpen = (e: Event) => opens.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_APP_EVENT, onOpen);
    try {
      handoffCodingTeam("team-abcdefgh");
    } finally {
      window.removeEventListener(OPEN_APP_EVENT, onOpen);
    }
    expect(opens).toEqual([]);
    expect(takePendingCodingTeam()).toBe("team-abcdefgh");
  });
});

describe("the team-changed signal", () => {
  it("reaches a subscriber as a bare event and the unsubscribe stops it", () => {
    const listener = vi.fn();
    const off = onCodingTeamChanged(listener);
    notifyCodingTeamChanged();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    notifyCodingTeamChanged();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(CODING_TEAM_CHANGED_EVENT).toBe("clawbox:coding-team-changed");
  });
});
