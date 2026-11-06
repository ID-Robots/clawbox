/**
 * The sentences the Coding Agent app hands to the chat for a project
 * (2026-10-30: the app carries no inputs — the chat composes, the app shows).
 * Pure: no React, no fs, so a test can read the words.
 */

// The file the notes live in, as src/lib/coding-run-notes.ts keeps it (that
// module reads the disk, so a client component cannot import it).
const RUN_NOTES_DIR = ".clawbox";
const RUN_NOTES_FILE = "run-notes.md";

export interface ProjectPromptScope {
  /** The project's name as the app shows it. */
  name: string;
  /** Its folder on the box. */
  directory: string;
}

/**
 * "Ask to change" under a project's run notes: the assistant reads the file
 * every run of the project is given, asks what to change, and edits it with
 * its own file tools — there is no tool for it and none is needed.
 */
export function buildRunNotesPrompt({ name, directory }: ProjectPromptScope): string {
  const file = `${directory}/${RUN_NOTES_DIR}/${RUN_NOTES_FILE}`;
  return [
    `I want to change the run notes of my coding project "${name}".`,
    `They are in ${file} — every coding run in that project reads them before it starts, and runs add lessons there themselves.`,
    "Show me what the notes say now and ask me what to change. Then edit that file as I say: keep it short, keep it in Markdown, and never put a credential or a secret in it.",
  ].join(" ");
}
