// The cycle's figures on disk: one JSON line per figure, appended as each
// lands — a run that never started included — so a later baseline reload
// sees exactly the cycle the report saw.
import fs from "node:fs";
import path from "node:path";

/** Append one figure to the cycle's file, creating the folder on the way. */
export function appendFigure(file, fig) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(fig) + "\n");
}

/** Every figure in the cycle's file, in order; null when there is no file. */
export function readFigures(file) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
