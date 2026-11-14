// Password generator: crypto.getRandomValues with rejection sampling, so every
// character is uniformly chosen. At least one character of every enabled class.

export interface GeneratorOptions {
  length?: number;
  symbols?: boolean;
  digits?: boolean;
  upper?: boolean;
  lower?: boolean;
}

export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;
export const DEFAULT_LENGTH = 24;

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
// No quotes, backslash, space or angle brackets: they break naive forms and shells.
const SYMBOLS = "!#$%&*+-.:=?@^_~";

export function clampLength(length: unknown): number {
  const n = typeof length === "number" && Number.isFinite(length) ? Math.round(length) : DEFAULT_LENGTH;
  return Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, n));
}

function classesFor(opts: GeneratorOptions): string[] {
  const classes: string[] = [];
  if (opts.lower !== false) classes.push(LOWER);
  if (opts.upper !== false) classes.push(UPPER);
  if (opts.digits !== false) classes.push(DIGITS);
  if (opts.symbols !== false) classes.push(SYMBOLS);
  if (classes.length === 0) classes.push(LOWER);
  return classes;
}

function randomIndex(max: number): number {
  // Rejection sampling over 32-bit values to avoid modulo bias.
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % max;
  }
}

export function generatePassword(options: GeneratorOptions = {}): string {
  const length = clampLength(options.length);
  const classes = classesFor(options);
  const alphabet = classes.join("");
  for (;;) {
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[randomIndex(alphabet.length)];
    if (classes.every((c) => [...out].some((ch) => c.includes(ch)))) return out;
  }
}

export function entropyBits(options: GeneratorOptions = {}): number {
  const size = classesFor(options).join("").length;
  return Math.floor(clampLength(options.length) * Math.log2(size));
}
