/**
 * The slash commands the chat composer offers, and where they come from.
 *
 * HARNESS-FIRST, and both harnesses turned out to publish a catalogue, so
 * nothing here is a hand-written list of commands:
 *
 *   - OpenClaw: the gateway RPC `commands.list`, which the core has carried
 *     since 2026.7 (`src/gateway/server-methods/commands.ts`, params and result
 *     validated by `packages/gateway-protocol/src/schema/commands.js`). It
 *     answers native, skill and plugin commands for the connected agent, and it
 *     is the same call the core's own Control UI palette makes. Captured live on
 *     the owner's box: 73 entries, 46 `native` + 27 `skill`.
 *   - Hermes: the dashboard RPC `commands.catalog` on `/api/ws` — the socket
 *     `hermes-dashboard-rpc.ts` already dials — whose own contract calls it
 *     "categorized slash metadata (registry, quick, plugin, skill) for
 *     COMPLETION MENUS". It is derived from `hermes_cli/commands.py`'s
 *     `COMMAND_REGISTRY`, which that module's docstring names as the one source
 *     every consumer derives from, autocomplete included.
 *
 * So the only judgement in this file is SHAPE — turning two different wire
 * formats into the one row the popover renders — plus honouring each harness's
 * own statement about which of its commands belong in a chat composer. Neither
 * harness's list is edited, reordered by taste, or supplemented.
 */

/** One row of the composer's popover. */
export interface SlashCommand {
  /**
   * Exactly what accepting the row puts in the composer, leading slash
   * included: `/status`. The canonical name, never an alias, because that is
   * what the harness will be asked to execute.
   */
  readonly id: string;
  /**
   * The row's title: `id`, plus the harness's own argument hint when it
   * published one (`/model <model>`). Display only — `id` is what is inserted,
   * so a hint can never end up on the wire.
   */
  readonly usage: string;
  /** The harness's one-line description, as the harness worded it. */
  readonly description: string;
  /**
   * Whether this command TAKES arguments — the harness's own answer, not an
   * inference from whether a hint could be built.
   *
   * It decides the one thing accepting a row does to the text: a command that
   * takes arguments is inserted with a trailing space, so the caret lands where
   * the owner types next; one that does not is inserted bare, so Enter sends it.
   *
   * Read from `acceptsArgs` on OpenClaw and from `argument_mode != null` on
   * Hermes, because both publish it and inferring it instead was wrong for 36
   * of the 73 commands on the owner's own box — `/btw`, `/steer`, `/goal` and
   * the rest declare `acceptsArgs: true` while publishing no `args` metadata,
   * so a hint-based guess made every one of them look argument-less and left
   * `/btw` one keystroke from being sent with no question attached.
   */
  readonly acceptsArgs: boolean;
  /**
   * Who answers for this command. `'harness'` for everything either catalogue
   * publishes; `'clawbox'` is reserved for a command ClawBox would handle in
   * the browser. There are none today — deliberately, because a command the
   * harness does not know about would be a command the harness cannot explain
   * when it is wrong.
   */
  readonly source: "harness" | "clawbox";
}

/** How many rows the popover will render at once. */
export const SLASH_MENU_MAX_ROWS = 8;

/**
 * A row off the wire, re-validated rather than trusted.
 *
 * The Hermes half arrives as JSON from a route and is about to be rendered and
 * — once accepted — put on the wire as a command. A row whose `id` were a
 * number or an empty string would render as a blank, insertable line.
 */
export function isSlashCommand(value: unknown): value is SlashCommand {
  const row = value as Partial<SlashCommand> | null;
  return (
    !!row &&
    typeof row === "object" &&
    typeof row.id === "string" &&
    row.id.startsWith("/") &&
    row.id.length > 1 &&
    typeof row.usage === "string" &&
    typeof row.description === "string" &&
    typeof row.acceptsArgs === "boolean" &&
    (row.source === "harness" || row.source === "clawbox")
  );
}

/** Trailing `(usage: /cmd <arg>)` — how Hermes publishes an argument hint. */
const HERMES_USAGE_SUFFIX = /\s*\(usage:\s*(\/[^)]+)\)\s*$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `name` → `/name`, and `/name` unchanged. Never produces a bare `/`. */
function toCommandId(raw: unknown): string {
  const name = cleanText(raw).replace(/^\/+/, "");
  // A name with whitespace in it is not a command the composer can insert as
  // one token, and neither catalogue is supposed to contain one.
  return name && !/\s/.test(name) ? `/${name}` : "";
}

/** Drop repeats, keeping the first (the catalogues list aliases separately). */
function dedupe(commands: readonly SlashCommand[]): SlashCommand[] {
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  for (const command of commands) {
    if (seen.has(command.id)) continue;
    seen.add(command.id);
    out.push(command);
  }
  return out;
}

/**
 * Rows from an OpenClaw `commands.list` result.
 *
 * `scope` is the harness's own answer to "may this be typed as text?" — a
 * `'native'`-only command is one that exists solely as a platform-native
 * command on a channel like Discord, and typing it into a chat would do
 * nothing. The gateway already filters on the `scope` parameter the adapter
 * sends; this repeats the check because a core that ignored the parameter
 * would otherwise put dead rows in front of the owner.
 *
 * The argument hint is built from `args` (asked for with `includeArgs`), and a
 * required argument is shown in angle brackets exactly as the core's own help
 * renders it.
 *
 * `clientPresentation` is read and deliberately NOT honoured. The core
 * publishes it on plugin entries as `{ when: "no-arguments", action: { kind:
 * "device-pairing" } }` — a client with a pairing surface is asked to open it
 * instead of sending the bare command. This composer has no such surface, and
 * inventing one here would be ClawBox deciding what a pairing flow looks like
 * for a plugin it does not own. The command still goes out as text, which is
 * what the core does with it when no client honours the hint, and the row says
 * what the harness said about it. If a pairing surface is ever built, this is
 * the field it reads.
 */
export function commandsFromOpenClawList(payload: unknown): SlashCommand[] {
  const entries = asRecord(payload)?.commands;
  if (!Array.isArray(entries)) return [];
  const out: SlashCommand[] = [];
  for (const raw of entries) {
    const entry = asRecord(raw);
    if (!entry) continue;
    if (entry.scope === "native") continue;
    const id = toCommandId(entry.name);
    if (!id) continue;
    const args = Array.isArray(entry.args) ? entry.args : [];
    const hint = args
      .map((argRaw) => {
        const arg = asRecord(argRaw);
        const name = cleanText(arg?.name);
        if (!name) return "";
        return arg?.required ? `<${name}>` : `[${name}]`;
      })
      .filter(Boolean)
      .join(" ");
    out.push({
      id,
      usage: hint ? `${id} ${hint}` : id,
      description: cleanText(entry.description),
      // The core's own required field. Most commands that take arguments
      // publish no `args` at all, so the hint above says nothing about this.
      acceptsArgs: entry.acceptsArgs === true,
      source: "harness",
    });
  }
  return dedupe(out);
}

/**
 * Rows from a Hermes `commands.catalog` result.
 *
 * `categories` is walked rather than `pairs` so the popover inherits the
 * registry's own ordering, and `pairs` is the fallback for a catalogue that
 * answered without categories.
 *
 * The `desktop` field on each `commands` entry is Hermes telling us which of
 * its commands belong in a NON-TERMINAL composer: `null`/absent means offered,
 * `"hidden"` means it still runs but does not belong in the popover, and any
 * other string is the reason it does not (`"terminal"`, `"messaging"`,
 * `"settings"`, `"advanced"`, `"composer-voice"`). Honouring it is reading
 * Hermes' answer, not imposing ours — its own desktop app filters on the same
 * field. A command the catalogue does not describe at all is offered, because
 * "not described" is not "excluded".
 */
export function commandsFromHermesCatalog(payload: unknown): SlashCommand[] {
  const catalog = asRecord(payload);
  if (!catalog) return [];
  const dispositions = asRecord(catalog.commands) ?? {};
  const pairs: unknown[] = [];
  const categories = catalog.categories;
  if (Array.isArray(categories)) {
    for (const categoryRaw of categories) {
      const rows = asRecord(categoryRaw)?.pairs;
      if (Array.isArray(rows)) pairs.push(...rows);
    }
  }
  if (pairs.length === 0 && Array.isArray(catalog.pairs)) pairs.push(...catalog.pairs);

  const out: SlashCommand[] = [];
  for (const pairRaw of pairs) {
    if (!Array.isArray(pairRaw)) continue;
    const id = toCommandId(pairRaw[0]);
    if (!id) continue;
    // `toCommandId` deliberately accepts `name` and `/name`, so the lookup has
    // to as well: a catalogue that keyed `commands` WITHOUT the slash would
    // otherwise miss every row silently, and both fields this map answers —
    // the `desktop` filter and the argument flag — would become no-ops that
    // look like a working catalogue.
    const disposition = asRecord(dispositions[id] ?? dispositions[id.slice(1)]);
    // Present and non-null means Hermes has named a surface this command is
    // not for; the popover is one of them.
    if (disposition && disposition.desktop != null) continue;
    const published = cleanText(pairRaw[1]);
    const usageMatch = HERMES_USAGE_SUFFIX.exec(published);
    out.push({
      id,
      usage: usageMatch ? cleanText(usageMatch[1]) : id,
      description: usageMatch ? published.replace(HERMES_USAGE_SUFFIX, "").trim() : published,
      // Hermes' own `argument_mode` — `options`, `text` or `mixed` for a
      // command that takes something, null for one that does not.
      //
      // The two halves of this catalogue can disagree: `usage` above needs
      // nothing but the `pairs` row, while `argument_mode` lives only in
      // `commands`. A row present in `pairs` and absent from `commands` used to
      // render as `/undo [n]` — visibly promising an argument — while going in
      // BARE with the caret at the end, so the next Enter sent `/undo` with no
      // argument. That is exactly the `/btw` failure the note on `acceptsArgs`
      // says this field exists to prevent. With no disposition to read, the
      // published hint is the only thing Hermes said about arguments, so it is
      // what the row is inserted by.
      acceptsArgs: disposition ? disposition.argument_mode != null : Boolean(usageMatch),
      source: "harness",
    });
  }
  return dedupe(out);
}

/**
 * Is this message a command the harness should EXECUTE rather than answer?
 *
 * Narrow on purpose. The first token must be command-SHAPED — a slash, a
 * letter, then word characters or dashes — so a message that merely opens with
 * a path (`/home/clawbox/notes.md is the one I mean`) is still a message, and
 * so is a bare `/`. The token carries no second slash for the same reason.
 *
 * It does NOT check the token against the catalogue. Whether `/frobnicate`
 * exists is the harness's question, and a client that answered it would be a
 * second opinion that goes stale the moment a skill is installed — and would
 * word the refusal itself, instead of showing the harness's.
 */
export function isSlashCommandMessage(text: string): boolean {
  const first = text.trim().split(/\s+/, 1)[0] ?? "";
  return /^\/[A-Za-z][\w-]*$/.test(first);
}

/**
 * The command the owner is typing, or null when the popover has no business
 * being open.
 *
 * The query is the WHOLE draft, and the draft has to be one unbroken token
 * starting with `/`. Three rules, and each of them is a bug that was found:
 *
 *  - **whitespace anywhere closes it**, not merely whitespace before the caret.
 *    `/model gemma-4` with the caret clicked back to position 1 used to yield a
 *    query of `"/"`, which opened the entire catalogue over a finished draft —
 *    and the Enter the owner meant as "send this line" then accepted the top
 *    row and rewrote the draft as `/statusmodel gemma-4`.
 *  - **the caret must be past the slash.** At position 0 the query was `""`,
 *    which is "everything matches" — a menu over a draft nobody was completing.
 *  - **the query is the whole token, not the part before the caret.** Returning
 *    the head meant accepting a row kept whatever followed the caret:
 *    `/status` with the caret at 4 became `/statustus`. The token is what is
 *    being completed, wherever inside it the caret happens to sit.
 *
 * The caret still matters — it is what tells "the owner is editing this token"
 * from "the caret is somewhere else entirely" — it just no longer decides where
 * the token ENDS.
 */
export function slashQueryAt(text: string, caret: number): string | null {
  if (!text.startsWith("/")) return null;
  // Whitespace anywhere — a space, a tab, a newline in a pasted block — means
  // this is a message that begins with a command word, not a command being
  // completed.
  if (/\s/.test(text)) return null;
  // A caret before or on the slash is not inside the token. `caret < 0` is the
  // caller's way of saying it does not know where the caret is (a draft
  // restored from somewhere other than the composer's own onChange), and "we
  // do not know" must never open a menu.
  if (caret < 1 || caret > text.length) return null;
  return text;
}

/**
 * The rows that match `query` (`/mo`), best first, capped for rendering.
 *
 * Prefix matches come before contained ones so `/me` puts `/memory` above
 * `/timestamps`, and within each group the harness's own order is kept — that
 * order is the harness's opinion about importance and is not ours to restate.
 * A bare `/` matches everything.
 */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
  limit = SLASH_MENU_MAX_ROWS,
): SlashCommand[] {
  const needle = query.replace(/^\/+/, "").toLowerCase();
  if (!needle) return commands.slice(0, limit);
  const prefix: SlashCommand[] = [];
  const contained: SlashCommand[] = [];
  for (const command of commands) {
    const name = command.id.slice(1).toLowerCase();
    if (name.startsWith(needle)) prefix.push(command);
    else if (name.includes(needle)) contained.push(command);
  }
  return [...prefix, ...contained].slice(0, limit);
}

/**
 * What the composer holds after a row is accepted.
 *
 * The command plus ONE space when it takes arguments, so the caret lands where
 * the owner has to type next; bare otherwise, so Enter sends it immediately.
 *
 * The query IS the whole draft — `slashQueryAt` answers the entire text or
 * null — so the command replaces all of it and there is nothing after the token
 * to preserve. That is an INVARIANT of the pair, not a case handled below: the
 * slice is written out so the two cannot drift apart if the query ever becomes
 * narrower than the draft again.
 */
export function applySlashCommand(
  text: string,
  caret: number,
  command: SlashCommand,
): { text: string; caret: number } {
  const query = slashQueryAt(text, caret);
  // No token to replace — nothing the menu could be completing. A no-op rather
  // than a rewrite: the caller only reaches this through an open popover, so
  // this is unreachable today, and the one thing it must never do if it ever
  // becomes reachable is throw the owner's draft away.
  if (query === null) return { text, caret };
  // Empty today, by the invariant above; a slice rather than a literal `""` so
  // a narrower `slashQueryAt` would keep the owner's trailing text instead of
  // deleting it.
  const tail = text.slice(query.length);
  const inserted = command.acceptsArgs ? `${command.id} ` : command.id;
  return { text: `${inserted}${tail}`, caret: inserted.length };
}
