const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 300_000;

/** Large migrated agent databases can take over 90 seconds to inspect. */
export function memoryStatusTimeoutMs(configured: string | undefined): number {
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed >= DEFAULT_TIMEOUT_MS && parsed <= MAX_TIMEOUT_MS
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}
