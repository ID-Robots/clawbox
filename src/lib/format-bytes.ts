/**
 * Deliberately the same arithmetic and the same rounding rule as ClawKeep's
 * formatBytes: two panels can end up quoting the same number (the memory
 * index, the embedding model) and must not disagree about it. Returns null
 * rather than "0 B" so an unknown figure is omitted instead of asserted.
 */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
