/**
 * The command a terminal runs to follow a coding run.
 *
 * Live: `scripts/coding-run-preview <transcript>` tails the run's stream-json
 * transcript as it is written. Settled with a session: `claude-ds --resume`
 * in the run's folder, so the owner continues the conversation. Settled with
 * only a transcript: the tail again, which prints what happened and stops.
 * Null when the run has none of that yet (a run that has not written its
 * first line).
 *
 * Client-safe: strings only. The run page embeds a terminal on it, and the
 * "Open in Terminal" buttons hand it to a Terminal window.
 */
const CLAWBOX_ROOT = "/home/clawbox/clawbox";

function quoted(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A Claude Code session id: what the harness records, and nothing a shell would read otherwise. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function livePreviewCommand(run: {
  transcriptPath: string | null;
  sessionId: string | null;
  directory: string | null;
  live: boolean;
}): string | null {
  if (run.live && run.transcriptPath) {
    return `${CLAWBOX_ROOT}/scripts/coding-run-preview ${quoted(run.transcriptPath)}`;
  }
  if (run.sessionId && run.directory && SESSION_ID.test(run.sessionId)) {
    // Quoted like the paths: the id is run metadata typed into a shell.
    return `cd ${quoted(run.directory)} && claude-ds --resume ${quoted(run.sessionId)}`;
  }
  if (run.transcriptPath) {
    return `${CLAWBOX_ROOT}/scripts/coding-run-preview ${quoted(run.transcriptPath)}`;
  }
  return null;
}
