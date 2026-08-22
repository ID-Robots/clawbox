// ── Hermes pet sprite taxonomy, mirrored for the browser ──
//
// The Hermes pet feature vendors Petdex (https://petdex.dev) sprite sheets: one
// atlas of 192x208 px cells, one animation state per ROW, six stepped frames
// per state. This module is the ClawBox-side mirror of the upstream row
// taxonomy so the desktop mascot picks exactly the same frame the Hermes CLI,
// TUI and Electron app would pick for the same activity.
//
// Upstream sources this mirrors (hermes-agent v0.20.5):
//   agent/pet/constants.py            — FRAME_W/H, FRAMES_PER_STATE, LOOP_MS,
//                                       LEGACY_STATE_ROWS, CODEX_STATE_ROWS,
//                                       STATE_ALIASES, state_rows_for_grid,
//                                       state_row_index
//   apps/desktop/src/components/pet/pet-sprite.tsx — roamWalkRow
//
// Deliberately free of Node imports: the mascot renders this in the browser.

/** Native cell geometry of a Petdex atlas. */
export const FRAME_W = 192;
export const FRAME_H = 208;
/** Frames consumed per state. A sheet may have more columns; we step the first 6. */
export const FRAMES_PER_STATE = 6;
/** One full state loop, milliseconds (Petdex default). */
export const LOOP_MS = 1100;

/** Hermes' own activity-state names (agent/pet/constants.py PetState). */
export type PetState = "idle" | "wave" | "run" | "failed" | "review" | "jump" | "waiting";

/** Older 8-row / 9-column atlases. */
export const LEGACY_STATE_ROWS: readonly string[] = [
  "idle",
  "wave",
  "run",
  "failed",
  "review",
  "jump",
  "extra1",
  "extra2",
];

/** Current Petdex atlases: 8 columns x 9 rows (1536x1872). */
export const CODEX_STATE_ROWS: readonly string[] = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
];

/** Activity name -> accepted sheet row names, in descending preference. */
const STATE_ALIASES: Readonly<Record<PetState, readonly string[]>> = {
  idle: ["idle"],
  wave: ["wave", "waving"],
  jump: ["jump", "jumping"],
  run: ["run", "running"],
  failed: ["failed"],
  review: ["review"],
  waiting: ["waiting"],
};

/**
 * Row taxonomy for a sheet with `rowCount` rows.
 *
 * Mirrors `state_rows_for_grid`: nine-or-more rows means the current Codex
 * taxonomy, anything smaller means the legacy one. Curated Petdex sheets are
 * sometimes 8x11 ("sprite-v2"); those take the Codex branch and the two extra
 * rows are simply never indexed — the same behaviour upstream has.
 */
export function stateRowsForGrid(rowCount: number | null | undefined): readonly string[] {
  const rows = Number.isFinite(rowCount) ? Math.trunc(rowCount as number) : 0;
  return rows >= CODEX_STATE_ROWS.length ? CODEX_STATE_ROWS : LEGACY_STATE_ROWS;
}

/** Row index for `state`, clamped to the idle row — mirrors `state_row_index`. */
export function stateRowIndex(state: PetState, rows: readonly string[]): number {
  for (const alias of STATE_ALIASES[state] ?? [state]) {
    const i = rows.indexOf(alias);
    if (i >= 0) return i;
  }
  return 0;
}

/**
 * Pick the running row + mirror for a horizontal travel direction.
 *
 * Verbatim port of upstream `roamWalkRow`. Codex sheets ship dedicated
 * `running-left` / `running-right` rows that already face their way, so no
 * flip. A sheet with only the in-place `running`/`run` row faces LEFT by
 * convention, so rightward travel is mirrored; that case returns no `row` and
 * the caller resolves `run` through the aliases.
 */
export function roamWalkRow(
  dir: -1 | 0 | 1,
  rows: readonly string[],
): { row?: string; mirror: boolean } {
  if (dir === 0) return { mirror: false };
  const hasLeft = rows.includes("running-left");
  const hasRight = rows.includes("running-right");
  if (dir > 0) {
    if (hasRight) return { mirror: false, row: "running-right" };
    if (hasLeft) return { mirror: true, row: "running-left" };
    return { mirror: true };
  }
  if (hasLeft) return { mirror: false, row: "running-left" };
  if (hasRight) return { mirror: true, row: "running-right" };
  return { mirror: false };
}

/**
 * ClawBox mascot state -> Petdex activity state.
 *
 * The crab has ten moods; a pet sheet has seven states. The mapping keeps the
 * READ of each mood rather than its literal name: `sleep`/`sass` become the
 * calmest non-idle pose (`waiting`), `look` becomes `review` (the "inspecting"
 * pose), `dance` becomes `wave` (the only performing row), `facepalm` becomes
 * `failed`, and both travelling states become `run`.
 *
 * Note the keys are ClawBox's own `MascotState` union; it is duplicated as a
 * string union here rather than imported so this module stays free of the
 * 1300-line component.
 */
export type MascotStateName =
  | "waddle"
  | "idle"
  | "jump"
  | "celebrate"
  | "sleep"
  | "sass"
  | "look"
  | "dance"
  | "facepalm"
  | "frenzy";

export const CRAB_TO_PET: Readonly<Record<MascotStateName, PetState>> = {
  waddle: "run",
  idle: "idle",
  jump: "jump",
  celebrate: "jump",
  sleep: "waiting",
  sass: "waiting",
  look: "review",
  dance: "wave",
  facepalm: "failed",
  frenzy: "run",
};

/** The two mascot states that travel across the desktop. */
const WALKING: ReadonlySet<MascotStateName> = new Set<MascotStateName>(["waddle", "frenzy"]);

export interface PetFrame {
  /** Row index into the sheet. */
  rowIndex: number;
  /** True when the sprite has to be flipped horizontally to face `facing`. */
  mirror: boolean;
}

/**
 * Resolve the sheet row + mirror for the mascot's current mood.
 *
 * `thinking` wins over everything, matching the crab (whose thinking wobble
 * overrides its per-state keyframe) and upstream's `derive_pet_state`, where
 * reasoning outranks idle.
 */
export function petFrameFor(
  opts: {
    state: MascotStateName;
    thinking?: boolean;
    facing: "left" | "right";
  },
  rowCount: number,
): PetFrame {
  const rows = stateRowsForGrid(rowCount);
  if (opts.thinking) {
    return { rowIndex: stateRowIndex("review", rows), mirror: false };
  }
  if (WALKING.has(opts.state)) {
    const walk = roamWalkRow(opts.facing === "right" ? 1 : -1, rows);
    const idx = walk.row ? rows.indexOf(walk.row) : stateRowIndex("run", rows);
    return { rowIndex: idx >= 0 ? idx : 0, mirror: walk.mirror };
  }
  return { rowIndex: stateRowIndex(CRAB_TO_PET[opts.state] ?? "idle", rows), mirror: false };
}
