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
