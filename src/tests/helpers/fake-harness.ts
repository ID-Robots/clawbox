/**
 * How a FAKE claude-ds has to read its stdin, now that a run can be told
 * something while it works.
 *
 * The runner spawns Claude Code with `--input-format stream-json` whenever
 * this box's harness takes it (src/lib/coding-run-messages.ts): the task goes
 * down the pipe as ONE JSON line and the pipe stays OPEN, so a message the
 * owner sends at minute three can be written as the next user turn. A fake
 * wrapper that did `cat > file` would therefore wait for an EOF that only
 * arrives once it has emitted its result — a deadlock of the test's own
 * making, and a shape no real harness has.
 *
 * So the fakes read a bounded number of lines and get on with it, and the
 * assertions read what the harness was TOLD rather than the bytes it was sent.
 */

/**
 * Read the first turn off stdin into `target` and carry on.
 *
 * `head -n 1` rather than `cat`: it returns as soon as the line is there,
 * which is what the real CLI does. The runner's later writes then land on a
 * closed pipe and are reported as EPIPE, which the runner already handles.
 */
export function readFirstTurn(target = "/dev/null"): string {
  return `head -n 1 > ${JSON.stringify(target)}`;
}

/**
 * Read up to `lines` turns into `target`, so a test can see a message that was
 * delivered mid-run as well as the task.
 *
 * The reader must not outlive the wrapper's own work, so it runs FIRST and
 * for a bounded number of lines: `head -n <lines>` blocks until it has them or
 * the pipe closes, which is why a test that uses this sends exactly that many.
 */
export function readTurns(target: string, lines: number): string {
  return `head -n ${lines} > ${JSON.stringify(target)}`;
}

/**
 * What the harness was actually told, whichever shape it arrived in.
 *
 * A streaming spawn writes one `{"type":"user",…}` line per turn; a plain one
 * writes the text itself and closes the pipe. Both are decoded to the same
 * thing — the words — so an assertion about what a run was told does not have
 * to know which mode this box is in.
 */
export function decodeHarnessTurns(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as {
        type?: unknown;
        message?: { content?: unknown };
      };
      if (parsed.type !== "user" || !Array.isArray(parsed.message?.content)) continue;
      const text = (parsed.message.content as { type?: unknown; text?: unknown }[])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
      out.push(text);
    } catch {
      // Not a turn; the plain-text branch below answers for it.
    }
  }
  // Nothing decoded means this was a plain spawn: the bytes ARE the turn.
  return out.length ? out : (raw ? [raw] : []);
}

/** The turns joined, for an assertion that only cares what was said. */
export function decodeHarnessStdin(raw: string): string {
  return decodeHarnessTurns(raw).join("\n");
}
