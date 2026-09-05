/**
 * The first line of a task, as a title: what a commit subject, a pull
 * request, a run's row and the MCP status all show for it.
 *
 * Tasks arrive as Markdown more often than not, and the first line is a
 * heading — bench cycle 1 (2026-09-05) committed "Coding agent: # Paginate
 * the inventory API", and the same `#` reached the PR title, the run's row
 * and the assistant's status text, each from its own copy of this function.
 * One helper, imported by every surface: the leading heading marks come
 * off, so do closing ones and the emphasis a heading often wears, the first
 * NON-empty line is the title (a task that opens with a blank line has one
 * too), and a line past `max` is cut with an ellipsis. Empty in, empty out —
 * each caller keeps its own fallback word.
 *
 * Kept free of imports: the MCP server (a separate stdio process) reads it
 * beside the browser bundle.
 */
export function taskTitle(text: string, max: number): string {
  const first = (text ?? "").split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const line = first
    .replace(/^#{1,6}(?:\s+|$)/, "")
    .replace(/\s+#+\s*$/, "")
    .replace(/^(\*\*|__)(.+)\1$/, "$2")
    .trim();
  if (max < 1) return "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
