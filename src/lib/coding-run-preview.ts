/**
 * The command a terminal runs to follow a coding run.
 *
 * Live: `scripts/coding-run-preview <transcript>` tails the run's stream-json
 * transcript as it is written. Settled with a session: `claude-ds --resume`
 * in the run's folder, on the run's own provider, so the owner continues the
 * conversation. Settled with
 * only a transcript: the tail again, which prints what happened and stops.
 * Null when the run has none of that yet (a run that has not written its
 * first line).
 *
 * Client-safe: strings only, and the root comes from the build-time inlined
 * NEXT_PUBLIC_CLAWBOX_ROOT — this runs in the browser, where a runtime
 * process.env read is not available. The run page embeds a terminal on it, and
 * the "Open in Terminal" buttons hand it to a Terminal window.
 */
const CLAWBOX_ROOT = process.env.NEXT_PUBLIC_CLAWBOX_ROOT || "/home/clawbox/clawbox";

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
  /** The run's own provider, from its record. Absent reads as ClawBox AI. */
  provider?: string | null;
}): string | null {
  if (run.live && run.transcriptPath) {
    return `${CLAWBOX_ROOT}/scripts/coding-run-preview ${quoted(run.transcriptPath)}`;
  }
  if (run.sessionId && run.directory && SESSION_ID.test(run.sessionId)) {
    // An Anthropic run's session lives in Claude Code's default ~/.claude, and
    // the wrapper only looks there — and bills that account — when told to:
    // left to its default it opens ~/.claude-ds and finds no such session.
    // A fixed literal, never the field itself, since this is typed into a shell.
    const provider = run.provider === "anthropic" ? "CLAUDE_DS_PROVIDER=anthropic " : "";
    // Quoted like the paths: the id is run metadata typed into a shell.
    return `cd ${quoted(run.directory)} && ${provider}claude-ds --resume ${quoted(run.sessionId)}`;
  }
  if (run.transcriptPath) {
    return `${CLAWBOX_ROOT}/scripts/coding-run-preview ${quoted(run.transcriptPath)}`;
  }
  return null;
}
