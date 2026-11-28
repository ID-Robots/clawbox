/**
 * Bytes as a person reads them beside a limit: "100 MB", "10 GB", "9.5 GB".
 * Binary units, like the Files app; whole numbers stay whole. Pure, for the
 * server's refusals (src/lib/user-limits.ts) and the owner's Settings card.
 */
export function formatLimitBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = value >= 100 || Number.isInteger(value) ? Math.round(value).toString() : value.toFixed(1);
  return `${shown} ${units[unit]}`;
}
