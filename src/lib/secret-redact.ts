/**
 * Keeping an injected secret out of a run's own output.
 *
 * WHY. A run that is handed `VERCEL_TOKEN` in its environment will sooner or
 * later print it: `env | grep VERCEL`, a curl with `-v`, a build tool that
 * echoes its configuration, a stack trace from a client that puts the token in
 * the request it is complaining about. Every one of those lines reaches the
 * runner's stream parser and becomes a progress line, a summary, or the text of
 * an error — and all three are PERSISTED in `data/coding-agent-runs.json` and
 * answered by `/setup-api/coding-agent/runs`, which middleware admits the MCP
 * bearer to. So without this, switching injection on would quietly make the
 * owner's deploy token readable by the agent and by anything that ever reads
 * the run history.
 *
 * WHAT IT DOES. Every value a run was given is replaced, wherever it appears,
 * with `<secret:NAME>` — which is more useful than a row of asterisks: the
 * owner reading the timeline can see that the token was there and which one it
 * was, and the agent reading the same line learns a name it is allowed to know
 * (it can already list the names) and nothing else.
 *
 * IN MEMORY ONLY, and keyed by run. The values live in a module-level Map for
 * the life of the run and are dropped when it settles. Nothing here is
 * persisted: a redaction table on disk would be a second copy of exactly the
 * thing the store exists to encrypt.
 *
 * WHAT IT DOES NOT COVER, stated plainly because a half-understood guarantee is
 * worse than none:
 *
 *  - THE HARNESS'S OWN TRANSCRIPT. Claude Code writes its own JSONL under the
 *    owner's home; ClawBox does not author it and does not rewrite it, so
 *    `scripts/coding-run-preview` — which tails that file in the owner's own
 *    terminal — shows what the harness wrote. That terminal already runs as the
 *    account that owns both the store and its key, so this is not a widening;
 *    it is the reason the guarantee is scoped to what the web server writes.
 *  - A TRANSFORMED VALUE. A token the run base64-encodes, splits over two lines
 *    or prints one character per line is not the same bytes and is not matched.
 *    Redaction is a hygiene measure over accidental echoes, never a containment
 *    boundary against a run that is trying to exfiltrate what it was given —
 *    the containment for that is the owner's switch and the per-entry tick, in
 *    src/lib/project-secrets.ts.
 *  - A VALUE SHORTER THAN `MIN_REDACT_CHARS`. See that constant.
 *  - A RESTART. The table is in memory, so a run whose record survives a web
 *    server restart is settled as lost (`coding-agent.ts`) and nothing more is
 *    written to it; there is no path where output is recorded with the table
 *    gone.
 */

/**
 * The shortest value worth replacing.
 *
 * A secret of three characters is not a secret, and matching one would turn
 * every `abc` in every progress line into `<secret:X>` — an unreadable timeline,
 * and one that tells an attentive reader the value by showing which substrings
 * vanish. Eight is comfortably below any real credential (the shortest thing
 * anybody stores here is a PIN-like test key) and comfortably above the length
 * at which substring collisions are routine.
 */
export const MIN_REDACT_CHARS = 8;

export interface RunSecret {
  name: string;
  value: string;
}

/**
 * Replace every occurrence of every value with `<secret:NAME>`.
 *
 * LONGEST FIRST, which is the one ordering rule that matters: when one stored
 * value contains another (a URL that embeds a token, a token and the same token
 * with a prefix), replacing the short one first leaves the long one's remains
 * in the line looking like ordinary text. Sorting by length descending means
 * the most specific match is always taken first.
 *
 * `split`/`join` rather than a RegExp: a secret is arbitrary text and may hold
 * every metacharacter there is, and escaping it into a pattern is a step that
 * can be got wrong. This cannot match anything but the literal bytes.
 */
export function redactSecrets(text: string, secrets: readonly RunSecret[]): string {
  if (!text || secrets.length === 0) return text;
  let out = text;
  const ordered = [...secrets]
    .filter((s) => s.value.length >= MIN_REDACT_CHARS)
    .sort((a, b) => b.value.length - a.value.length);
  for (const secret of ordered) {
    if (!out.includes(secret.value)) continue;
    out = out.split(secret.value).join(`<secret:${secret.name}>`);
  }
  return out;
}

/**
 * What each live run was given. In memory for the life of the run, and holding
 * the only plaintext copy outside the child's own environment.
 */
const byRun = new Map<string, RunSecret[]>();

/**
 * Remember what this run was handed, so everything it says can be scrubbed.
 *
 * Called at spawn, before the child exists. An empty list REPLACES a previous
 * one rather than being ignored: a resumed run whose owner has since un-ticked
 * an entry is not given it again, and the table must say the same thing the
 * environment does.
 */
export function registerRunSecrets(runId: string, secrets: readonly RunSecret[]): void {
  if (secrets.length === 0) byRun.delete(runId);
  else byRun.set(runId, secrets.map((s) => ({ name: s.name, value: s.value })));
}

/** Drop a settled run's values. Called from the one cleanup path. */
export function forgetRunSecrets(runId: string): void {
  byRun.delete(runId);
}

/**
 * One line of a run's output, with anything it was given taken out.
 *
 * The identity function for a run with no secrets, which is every run on a box
 * that has not switched injection on — this sits on the hot path of the stream
 * parser and must cost nothing there.
 */
export function redactForRun(runId: string, text: string): string {
  const secrets = byRun.get(runId);
  if (!secrets || !text) return text;
  return redactSecrets(text, secrets);
}

/** Test seam. */
export function _resetRunSecretsForTests(): void {
  byRun.clear();
}
