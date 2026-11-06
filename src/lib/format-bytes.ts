/**
 * Deliberately the same arithmetic and the same rounding rule as ClawKeep's
 * formatBytes: two panels can end up quoting the same number (the memory
 * index, the embedding model) and must not disagree about it. Returns null
 * rather than "0 B" so an unknown figure is omitted instead of asserted.
 *
 * `locale` is the UI locale a component has from `useT()`: a German desktop
 * read "24.1 GB" beside German words (locale sweep DE-11, 2026-09-07). The
 * default is English rather than the browser's, because a lib or server
 * caller has no UI locale and its figure must not depend on where the
 * process runs. The fraction digits are pinned at both ends and grouping is
 * off, so the English figure is byte-for-byte what `toFixed` gave: `toFixed`
 * never grouped, and a grouped "1.010 B" on a German desktop reads as a
 * fraction of a byte.
 */
export function formatBytes(bytes: number | null, locale = "en"): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false })} ${units[unit]}`;
}

/**
 * Two sizes that one sentence sets against each other — "needs X but only Y
 * is free" — as figures that differ whenever the sizes do.
 *
 * Each is what `formatBytes` prints, unless both round to the SAME figure
 * while being different amounts: 1.24 GB against 1.21 GB read "needs 1.2 GB
 * but only 1.2 GB is free", which says the opposite of what happened. Both
 * then gain decimals, one at a time up to three, until they part ("1.24 GB",
 * "1.21 GB"). Amounts closer than that keep the shared figure rather than
 * fall back to a byte count. A size of zero or less is "0 B": a sentence
 * cannot leave a figure out the way a table cell can.
 */
export function formatBytesApart(a: number, b: number, locale = "en"): [string, string] {
  const first = formatBytes(a, locale) ?? "0 B";
  const second = formatBytes(b, locale) ?? "0 B";
  if (first !== second || Math.max(a, 0) === Math.max(b, 0)) return [first, second];
  // The same figure means the same unit, so one scale serves both.
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  let scale = 1;
  while (a / scale >= 1024 && unit < units.length - 1) {
    scale *= 1024;
    unit += 1;
  }
  for (let digits = 1; digits <= 3; digits += 1) {
    const precise = (n: number) =>
      `${(n / scale).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false })} ${units[unit]}`;
    const [x, y] = [precise(a), precise(b)];
    if (x !== y) return [x, y];
  }
  return [first, second];
}
