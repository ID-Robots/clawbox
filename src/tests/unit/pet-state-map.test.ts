// The pet sprite taxonomy is a MIRROR of upstream Hermes, not our own design.
// If these drift, a ClawBox desktop shows a different frame from the same box's
// TUI and Electron app for the same activity — the exact split-brain the
// "config.yaml is the source of truth" decision exists to prevent.

import { describe, expect, it } from "vitest";
import {
  CODEX_STATE_ROWS,
  CRAB_TO_PET,
  LEGACY_STATE_ROWS,
  petFrameFor,
  roamWalkRow,
  stateRowIndex,
  stateRowsForGrid,
  type MascotStateName,
  type PetState,
} from "@/lib/pet-state-map";

const ALL_MASCOT_STATES: MascotStateName[] = [
  "waddle", "idle", "jump", "celebrate", "sleep",
  "sass", "look", "dance", "facepalm", "frenzy",
];

describe("stateRowsForGrid", () => {
  it("takes the Codex taxonomy at nine rows or more", () => {
    expect(stateRowsForGrid(9)).toBe(CODEX_STATE_ROWS);
    // The curated "sprite-v2" sheets are 8x11. Upstream's state_rows_for_grid
    // only branches on >= 9, so the two extra rows are simply never indexed —
    // reproduce that rather than inventing an 11-row taxonomy.
    expect(stateRowsForGrid(11)).toBe(CODEX_STATE_ROWS);
  });

  it("falls back to the legacy taxonomy for smaller sheets", () => {
    expect(stateRowsForGrid(8)).toBe(LEGACY_STATE_ROWS);
    expect(stateRowsForGrid(0)).toBe(LEGACY_STATE_ROWS);
    expect(stateRowsForGrid(null)).toBe(LEGACY_STATE_ROWS);
  });
});

describe("stateRowIndex", () => {
  it("resolves every activity on both sheet shapes", () => {
    const states: PetState[] = ["idle", "wave", "run", "failed", "review", "jump", "waiting"];
    for (const state of states) {
      expect(stateRowIndex(state, CODEX_STATE_ROWS), `${state} on a Codex sheet`).toBeGreaterThanOrEqual(0);
      expect(stateRowIndex(state, LEGACY_STATE_ROWS), `${state} on a legacy sheet`).toBeGreaterThanOrEqual(0);
    }
  });

  it("resolves the aliased names Petdex actually ships", () => {
    // `wave`/`jump`/`run` are Hermes' internal names; the sheets say
    // `waving`/`jumping`/`running`.
    expect(CODEX_STATE_ROWS[stateRowIndex("wave", CODEX_STATE_ROWS)]).toBe("waving");
    expect(CODEX_STATE_ROWS[stateRowIndex("jump", CODEX_STATE_ROWS)]).toBe("jumping");
    expect(CODEX_STATE_ROWS[stateRowIndex("run", CODEX_STATE_ROWS)]).toBe("running");
  });

  it("falls back to the idle row for a state the sheet has no row for", () => {
    // A legacy sheet has no `waiting` row at all.
    expect(stateRowIndex("waiting", LEGACY_STATE_ROWS)).toBe(0);
  });
});

describe("roamWalkRow", () => {
  it("uses the dedicated directional rows unmirrored", () => {
    expect(roamWalkRow(1, CODEX_STATE_ROWS)).toEqual({ mirror: false, row: "running-right" });
    expect(roamWalkRow(-1, CODEX_STATE_ROWS)).toEqual({ mirror: false, row: "running-left" });
  });

  it("mirrors the generic running row, which faces left by convention", () => {
    expect(roamWalkRow(1, LEGACY_STATE_ROWS)).toEqual({ mirror: true });
    expect(roamWalkRow(-1, LEGACY_STATE_ROWS)).toEqual({ mirror: false });
  });

  it("mirrors the one directional row a half-equipped sheet has", () => {
    const onlyLeft = ["idle", "running-left"];
    expect(roamWalkRow(1, onlyLeft)).toEqual({ mirror: true, row: "running-left" });
    const onlyRight = ["idle", "running-right"];
    expect(roamWalkRow(-1, onlyRight)).toEqual({ mirror: true, row: "running-right" });
  });

  it("stands still for no direction", () => {
    expect(roamWalkRow(0, CODEX_STATE_ROWS)).toEqual({ mirror: false });
  });
});

describe("petFrameFor", () => {
  it("maps every crab mood to a row that exists on both sheet shapes", () => {
    for (const state of ALL_MASCOT_STATES) {
      for (const rows of [9, 8]) {
        const frame = petFrameFor({ state, facing: "right" }, rows);
        expect(frame.rowIndex, `${state} on a ${rows}-row sheet`).toBeGreaterThanOrEqual(0);
        expect(frame.rowIndex).toBeLessThan(rows);
      }
    }
  });

  it("covers the whole MascotState union", () => {
    for (const state of ALL_MASCOT_STATES) {
      expect(CRAB_TO_PET[state], `${state} has no pet mapping`).toBeTruthy();
    }
  });

  it("walks with the directional row and no mirror on a Codex sheet", () => {
    expect(petFrameFor({ state: "waddle", facing: "right" }, 9)).toEqual({
      rowIndex: CODEX_STATE_ROWS.indexOf("running-right"),
      mirror: false,
    });
    expect(petFrameFor({ state: "waddle", facing: "left" }, 9)).toEqual({
      rowIndex: CODEX_STATE_ROWS.indexOf("running-left"),
      mirror: false,
    });
  });

  it("treats frenzy as a walk too", () => {
    expect(petFrameFor({ state: "frenzy", facing: "right" }, 9).rowIndex).toBe(
      CODEX_STATE_ROWS.indexOf("running-right"),
    );
  });

  it("lets thinking override the mood, as the crab's wobble does", () => {
    expect(petFrameFor({ state: "dance", thinking: true, facing: "right" }, 9)).toEqual({
      rowIndex: CODEX_STATE_ROWS.indexOf("review"),
      mirror: false,
    });
  });

  it("shows the calm pose while asleep and the failure pose on a facepalm", () => {
    expect(CODEX_STATE_ROWS[petFrameFor({ state: "sleep", facing: "right" }, 9).rowIndex]).toBe("waiting");
    expect(CODEX_STATE_ROWS[petFrameFor({ state: "facepalm", facing: "right" }, 9).rowIndex]).toBe("failed");
  });
});
