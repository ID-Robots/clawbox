/**
 * Whether a text file is machine output rather than something a person
 * wrote: a log, a table export, an encoded blob, a settings or data dump.
 * Read, such a file costs a model call and at best yields a page about
 * tooling; a home folder holds plenty of them (`build.log`, `export.txt`,
 * `keys.txt`, `config.txt`).
 *
 * The heuristic is cheap and looks at the first {@link MACHINE_TEXT_SAMPLE_CHARS}
 * characters only, before anything is sent to a model:
 *
 * 1. Clean: control characters out (a UTF-16 file read as UTF-8 keeps its
 *    letters), line ends folded, a markdown front-matter block dropped, and
 *    the last line dropped when the sample cut it short. Leading space goes,
 *    trailing tabs stay (a TSV row's empty last columns are columns).
 * 2. Classify each non-blank line:
 *    - **log**: a timestamp at the start (with seconds, an ISO `T`, a syslog,
 *      ctime or web-server stamp, epoch seconds, a dmesg uptime — behind a
 *      `docker compose` service prefix too) followed by a level word (INFO,
 *      ERROR …), a `prog[pid]:` source, or a remainder that is not prose; a
 *      line that starts with a level word; a line that starts with an IP
 *      address (an access log). A stamp a program wrote — a date with the
 *      time to the second, a fraction of a second, epoch seconds — makes a
 *      log line even when the message reads like prose ("Server listening
 *      on port 3000"); a journal's date or minute, and a transcript's
 *      elapsed `00:01:02`, do not. A stamped line whose remainder reads
 *      `Name: words` is a chat message, not a log line.
 *    - **table**: a delimited row — the file's most common count of commas,
 *      semicolons (2 or more) or tabs (1 or more) shared by at least 60 % of
 *      its lines, with short fields — or a row of bare numbers.
 *    - **encoded**: a run of 32+ characters with no space that is hex or
 *      base64, a hex-dump row, a PEM armour line.
 *    - **keyvalue**: `KEY=value`, an INI `[section]`, a JSON property, a
 *      JSON line, a line of bare brackets.
 *    - **prose**: four or more words, mostly letters.
 *    - anything else (a heading, a short list item, code inside a markdown
 *      fence) is neither.
 * 3. Machine text when machine lines are at least 60 % of the lines AND prose
 *    lines at most 25 %. Fewer than {@link MIN_LINES} lines is too little to
 *    judge by lines: the file is kept — unless it is a blob, at least
 *    {@link MIN_BLOB_CHARS} characters of base64/hex runs making up
 *    {@link BLOB_SHARE} of what it shows with no line of words (a base64
 *    dump or a data URI on one line, maybe under a line naming it).
 *
 * When unsure the file is KEPT: a person's note with a pasted log in a fence,
 * a recipe, a chat export, a markdown table, a journal with dated entries all
 * read as documents. The tests carry real-looking samples of each.
 *
 * Pure.
 */

/** How much of a file the heuristic looks at. */
export const MACHINE_TEXT_SAMPLE_CHARS = 8 * 1024;
/** Lines below which a file is too short to judge (and is kept). */
export const MIN_LINES = 6;
/** The share of machine lines at or above which a file is machine text. */
export const MACHINE_SHARE = 0.6;
/** The share of prose lines above which a file is kept whatever else it holds. */
export const PROSE_CEILING = 0.25;

export type MachineKind = "log" | "table" | "encoded" | "keyvalue";

export interface MachineVerdict {
  machine: boolean;
  /** The most common machine kind among the lines (null when there were none). */
  kind: MachineKind | null;
  /** Non-blank lines judged. */
  lines: number;
  machineShare: number;
  proseShare: number;
}

// ── log lines ──

const STAMP_PARTS = [
  // Wed Oct 15 10:01:02.123456 2026 (ctime: Apache's error log, Python's asctime)
  String.raw`[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]?\d \d{2}:\d{2}:\d{2}(?:[.,]\d+)? \d{4}`,
  // 2026-10-15T10:01 / 2026-10-15T10:01:02.123Z
  String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?`,
  // 2026-10-15 10:01:02,123 / 2026/10/15 10:01:02
  String.raw`\d{4}[-/.]\d{2}[-/.]\d{2}[ ,]+\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?`,
  // 15/10/2026, 10:01:02 / 10.15.26 10:01:02
  String.raw`\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}[ ,]+\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?`,
  // 15/Oct/2026:10:01:02 +0000 (web server)
  String.raw`\d{2}/[A-Z][a-z]{2}/\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?`,
  // Oct 15 10:01:02 (syslog)
  String.raw`[A-Z][a-z]{2} [ \d]?\d \d{2}:\d{2}:\d{2}`,
  // 10:01:02.123
  String.raw`\d{2}:\d{2}:\d{2}(?:[.,]\d+)?`,
  // epoch seconds with a fraction (a bare ten-digit number may be a phone number)
  String.raw`1\d{9}\.\d+`,
];
const STAMP_RE = new RegExp(
  String.raw`^(?:<\d{1,3}>)?(?:\[\s*\d+\.\d{3,}\]|\[1\d{9}(?:\d{3})?(?:\.\d+)?\]|[\[(]?(?:${STAMP_PARTS.join("|")})[\])]?)(?=[\s,:|\]-]|$)[\s,:|\]-]*`,
);
const LEVELS = "TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|CRIT|CRITICAL|FATAL|SEVERE|PANIC";
const LEADING_LEVEL_RE = new RegExp(String.raw`^[\[(]?(?:${LEVELS})[\])]?(?:[\s:|-]|$)`);
/** A level word in capitals, or a bracketed lower-case one, or `level=`, near the start. */
const LEVEL_UPPER_RE = new RegExp(String.raw`^.{0,40}?\b(?:${LEVELS})\b`);
const LEVEL_NEAR_RE = /^.{0,40}?(?:\[(?:trace|debug|info|notice|warn|warning|error|crit|fatal)\]|\blevel=\w)/i;
const SOURCE_PID_RE = /^.{0,60}?[\w./-]+\[\d+\]:/;
const IP_START_RE = /^\d{1,3}(?:\.\d{1,3}){3}\s/;
const CHAT_RE = /^[-–]?\s*[^\s:[\]{}=][^:[\]{}=]{0,40}:\s+\S/;
/** `docker compose logs`: the service name and a bar before each stamped line. */
const COMPOSE_PREFIX_RE = /^[\w.-]{1,40}\s+\|\s+/;
const STAMP_SECONDS_RE = /\d{1,2}:\d{2}:\d{2}/;
const STAMP_FRACTION_RE = /\d{2}:\d{2}:\d{2}[.,]\d/;
/** A year, a month name or a day/month/year — what makes a stamp a date and not an elapsed time. */
const STAMP_DATE_RE = /\d{4}|[A-Z][a-z]{2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2}/;

/**
 * A stamp a program wrote: a date with the time to the second, a time with a
 * fraction of a second, epoch seconds or a kernel uptime. A person dating a
 * journal entry or a note stops at the day or the minute; a transcript's
 * `00:01:02` is an elapsed time and has no date.
 */
function machineStamp(stamp: string): boolean {
  if (/^(?:<\d{1,3}>)?[[(]?\s*(?:1\d{9}|\d+\.\d{3,}\])/.test(stamp)) return true;
  if (STAMP_FRACTION_RE.test(stamp)) return true;
  return STAMP_SECONDS_RE.test(stamp) && STAMP_DATE_RE.test(stamp.replace(STAMP_SECONDS_RE, ""));
}

// ── encoded lines ──

const HEX_RE = /^[0-9a-fA-F]{32,}$/;
const BASE64_RE = /^[A-Za-z0-9+/]{32,}={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]{32,}$/;
const HEXDUMP_RE = /^[0-9a-fA-F]{4,8}:?(?:\s+[0-9a-fA-F]{2,4}){4,}/;
const PEM_RE = /^-----(?:BEGIN|END) [A-Z0-9 ]+-----$/;

// ── key/value and data lines ──

const KV_RE = /^(?:export\s+)?[A-Za-z_][\w.[\]-]{0,63}\s*=\s*\S/;
const KV_EMPTY_RE = /^(?:export\s+)?[A-Za-z_][\w.[\]-]{0,63}=$/;
const INI_SECTION_RE = /^\[[^[\]\s][^[\]]{0,63}\]$/;
const JSON_PROP_RE = /^"[^"]{1,80}"\s*:\s*/;
const JSON_LINE_RE = /^[{[].*[}\]],?$/;
const BRACKETS_RE = /^[{}[\](),;]+$/;

// ── tables ──

const NUMERIC_ROW_RE = /^[-+]?\d[\d.,:]*(?:[\s;|]+[-+]?\d[\d.,:eE+-]*)+$/;

const WORD_RE = /\p{L}{2,}/gu;
const LETTER_RE = /\p{L}/gu;

function words(s: string): number {
  return s.match(WORD_RE)?.length ?? 0;
}

function letterShare(s: string): number {
  const visible = s.replace(/\s+/g, "");
  if (visible.length === 0) return 0;
  return (visible.match(LETTER_RE)?.length ?? 0) / visible.length;
}

function proseLike(s: string): boolean {
  return words(s) >= 4 && letterShare(s) >= 0.55;
}

function logLine(raw: string): boolean {
  const prefix = COMPOSE_PREFIX_RE.exec(raw);
  const line = prefix && STAMP_RE.test(raw.slice(prefix[0].length)) ? raw.slice(prefix[0].length) : raw;
  if (LEADING_LEVEL_RE.test(line) || IP_START_RE.test(line)) return true;
  const stamp = STAMP_RE.exec(line);
  if (!stamp) return false;
  const rest = line.slice(stamp[0].length);
  if (rest === "") return true;
  if (LEVEL_UPPER_RE.test(rest) || LEVEL_NEAR_RE.test(rest) || SOURCE_PID_RE.test(rest)) return true;
  // "[15/10/2026, 21:15:42] Ana: see you" is a chat export, a person's words.
  if (CHAT_RE.test(rest)) return false;
  // "2026-10-15T10:01:02.123Z Server listening on port 3000": a server's
  // message reads like prose, but no person stamps a line to the second.
  if (machineStamp(stamp[0])) return true;
  return !proseLike(rest);
}

function encodedLine(line: string): boolean {
  if (PEM_RE.test(line) || HEXDUMP_RE.test(line)) return true;
  if (/\s/.test(line)) return false;
  if (HEX_RE.test(line)) return true;
  // A long word of letters alone is not base64; real base64 mixes in digits.
  const encoded = BASE64_RE.test(line) || BASE64URL_RE.test(line);
  return encoded && (/\d/.test(line) || line.length >= 60);
}

function keyValueLine(line: string): boolean {
  return (
    KV_RE.test(line) || KV_EMPTY_RE.test(line) || INI_SECTION_RE.test(line) || JSON_PROP_RE.test(line) ||
    JSON_LINE_RE.test(line) || BRACKETS_RE.test(line)
  );
}

/**
 * The lines that are rows of one delimited table: the delimiter whose most
 * common per-line count is shared by at least 60 % of the lines.
 */
function tableRows(lines: readonly string[]): Set<number> {
  const best = new Set<number>();
  for (const [delim, min] of [[",", 2], [";", 2], ["\t", 1]] as const) {
    const counts = lines.map((l) => l.split(delim).length - 1);
    const freq = new Map<number, number>();
    for (const c of counts) if (c >= min) freq.set(c, (freq.get(c) ?? 0) + 1);
    let mode = -1;
    let modeCount = 0;
    for (const [c, f] of freq) if (f > modeCount) [mode, modeCount] = [c, f];
    if (mode < 0 || modeCount < lines.length * MACHINE_SHARE) continue;
    const rows = counts.flatMap((c, i) => (c === mode ? [i] : []));
    if (delim !== "\t") {
      // Prose has commas too; a table's fields are short.
      const fields = rows.flatMap((i) => lines[i].split(delim));
      const wordsPerField = fields.reduce((n, f) => n + f.trim().split(/\s+/).filter(Boolean).length, 0) / fields.length;
      if (wordsPerField > 4) continue;
    }
    if (rows.length > best.size) {
      best.clear();
      for (const i of rows) best.add(i);
    }
  }
  return best;
}

/** The sample the heuristic judges: cleaned, front matter out, a cut last line dropped. */
function sampleLines(text: string): string[] {
  const cut = text.length > MACHINE_TEXT_SAMPLE_CHARS;
  let sample = text
    .slice(0, MACHINE_TEXT_SAMPLE_CHARS)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
  if (cut && sample.includes("\n")) sample = sample.slice(0, sample.lastIndexOf("\n"));
  sample = sample.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "");
  const out: string[] = [];
  let fenced = false;
  for (const raw of sample.split("\n")) {
    // Leading space out; trailing TABS kept — a TSV row's empty last columns
    // are still columns, and trimming them would leave rows of unequal width.
    const line = raw.replace(/^\s+/, "").replace(/ +$/, "");
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      out.push("");
      continue;
    }
    // Inside a markdown fence: a person quoting something, judged as neither.
    out.push(fenced ? "\u0000fenced" : line);
  }
  return out.filter((l) => l.trim() !== "");
}

/** A run of base64/hex with no space in it, long enough that no word is one. */
const BLOB_RUN_RE = /[A-Za-z0-9+/=_-]{64,}/g;
/** Characters of encoded runs a file too short to judge by its lines must hold to be a blob. */
export const MIN_BLOB_CHARS = 1_024;
/** The share of a short file's visible characters that encoded runs must make up. */
export const BLOB_SHARE = 0.9;

/**
 * A file of a few very long lines judged by its characters: a base64 blob or
 * a data URI on one line, maybe under a line that names it. Never a file with
 * a line of prose in it (a note with an inline image keeps its words).
 */
function encodedBlob(lines: readonly string[]): boolean {
  // Words between spaces: a blob's letters run together, so `proseLike` alone would call it prose.
  const realWords = (l: string) => l.split(/\s+/).filter((w) => /^\p{L}[\p{L}'’-]*[.,;:!?]?$/u.test(w)).length;
  if (lines.some((l) => realWords(l) >= 4)) return false;
  let visible = 0;
  let encoded = 0;
  for (const line of lines) {
    visible += line.replace(/\s+/g, "").length;
    for (const run of line.match(BLOB_RUN_RE) ?? []) if (/\d/.test(run) && /[A-Za-z]/.test(run)) encoded += run.length;
  }
  return encoded >= MIN_BLOB_CHARS && encoded >= visible * BLOB_SHARE;
}

/** The verdict on a text file's opening {@link MACHINE_TEXT_SAMPLE_CHARS} characters. */
export function judgeMachineText(text: string): MachineVerdict {
  const cells = sampleLines(text);
  const lines = cells.map((l) => l.trimEnd());
  const verdict: MachineVerdict = { machine: false, kind: null, lines: lines.length, machineShare: 0, proseShare: 0 };
  if (lines.length < MIN_LINES) {
    if (lines.length > 0 && encodedBlob(lines)) {
      return { ...verdict, machine: true, kind: "encoded", machineShare: 1 };
    }
    return verdict;
  }
  const table = tableRows(cells.map((l) => (l === "\u0000fenced" ? "" : l)));
  const tally: Record<MachineKind, number> = { log: 0, table: 0, encoded: 0, keyvalue: 0 };
  let prose = 0;
  lines.forEach((line, i) => {
    if (line === "\u0000fenced") return;
    if (logLine(line)) tally.log += 1;
    else if (encodedLine(line)) tally.encoded += 1;
    // Before tables: a JSON line's commas would read as a delimited row.
    else if (keyValueLine(line)) tally.keyvalue += 1;
    else if (table.has(i) || NUMERIC_ROW_RE.test(line)) tally.table += 1;
    else if (proseLike(line)) prose += 1;
  });
  const machine = tally.log + tally.table + tally.encoded + tally.keyvalue;
  verdict.machineShare = machine / lines.length;
  verdict.proseShare = prose / lines.length;
  if (machine > 0) {
    verdict.kind = (Object.keys(tally) as MachineKind[]).reduce((a, b) => (tally[b] > tally[a] ? b : a));
  }
  verdict.machine = verdict.machineShare >= MACHINE_SHARE && verdict.proseShare <= PROSE_CEILING;
  return verdict;
}

/** Whether a text file reads as machine output (see {@link judgeMachineText}). */
export function isMachineText(text: string): boolean {
  return judgeMachineText(text).machine;
}
