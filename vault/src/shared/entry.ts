// The pass entry format, kept exactly as existing scripts read it:
//
//   <password>
//   login: <login>
//   url: <url>
//   2fa: <otp secret or otpauth:// URI>
//   note: <note>
//
// Line 1 is the password; the known fields follow as "key: value" lines.
// Any other lines are preserved untouched, in order, when an entry is updated.

export interface EntryFields {
  password: string;
  login: string;
  url: string;
  twofa: string;
  note: string;
}

export interface ParsedEntry extends EntryFields {
  /** Lines after line 1 that are not one of the known fields, kept verbatim. */
  extra: string[];
}

/** Non-secret view of an entry: what lists, matches and the agent may see. */
export interface EntryMeta {
  name: string;
  login: string;
  url: string;
  updated: string;
}

const FIELD_KEYS: Record<string, keyof EntryFields> = {
  login: "login",
  url: "url",
  "2fa": "twofa",
  note: "note",
};

export function parseEntry(text: string): ParsedEntry {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const entry: ParsedEntry = { password: lines[0] ?? "", login: "", url: "", twofa: "", note: "", extra: [] };
  for (const line of lines.slice(1)) {
    const m = /^([A-Za-z0-9]+):\s?(.*)$/.exec(line);
    const key = m ? FIELD_KEYS[m[1]!.toLowerCase()] : undefined;
    if (m && key && key !== "password" && entry[key] === "") {
      entry[key] = m[2]!.trim();
    } else {
      entry.extra.push(line);
    }
  }
  return entry;
}

export function serializeEntry(entry: ParsedEntry): string {
  const lines = [entry.password];
  if (entry.login) lines.push(`login: ${entry.login}`);
  if (entry.url) lines.push(`url: ${entry.url}`);
  if (entry.twofa) lines.push(`2fa: ${entry.twofa}`);
  if (entry.note) lines.push(`note: ${entry.note}`);
  lines.push(...entry.extra);
  return lines.join("\n") + "\n";
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const MAX_NAME = 200;

/**
 * Entry names are pass paths like "<site>/<account>". No traversal, no hidden
 * segments (.git, .gpg-id), no option-looking segments, no control characters.
 */
export function validateName(name: unknown): string {
  if (typeof name !== "string") throw new ValidationError("name is required");
  const n = name.trim();
  if (!n) throw new ValidationError("name is required");
  if (n.length > MAX_NAME) throw new ValidationError("name is too long");
  if (/[\u0000-\u001f\u007f\\]/.test(n)) throw new ValidationError("name contains invalid characters");
  if (n.endsWith(".gpg")) throw new ValidationError("name must not end in .gpg");
  const segments = n.split("/");
  for (const s of segments) {
    if (!s || s.trim() !== s) throw new ValidationError("name has an empty or padded path segment");
    if (s.startsWith(".") || s.startsWith("-")) throw new ValidationError("name segments must not start with '.' or '-'");
  }
  return n;
}

/** Single-line field values: no newlines (they would break the line format). */
export function validateLine(value: unknown, field: string, { max = 2000, trim = true } = {}): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`);
  const v = trim ? value.trim() : value;
  if (/[\r\n\u0000]/.test(v)) throw new ValidationError(`${field} must be a single line`);
  if (v.length > max) throw new ValidationError(`${field} is too long`);
  return v;
}

/** Passwords keep their exact characters but must be a single, non-empty line. */
export function validatePassword(value: unknown): string {
  const v = validateLine(value, "password", { max: 1024, trim: false });
  if (!v) throw new ValidationError("password must not be empty");
  return v;
}

export function metaOf(name: string, entry: Pick<EntryFields, "login" | "url">, updated: Date): EntryMeta {
  return { name, login: entry.login, url: entry.url, updated: updated.toISOString() };
}
