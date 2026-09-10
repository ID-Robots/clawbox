/** The root bootstrap replaces only the old dashboard, then hands the full
 * upgrade to the new updater. This is NOT the normal post-rebuild tail. */
export function classifyUpdaterHandover(
  marker: unknown,
  currentBuildId: string,
  bootstrapState: string | null,
): "wait" | "ready" | "failed" {
  if (!marker || typeof marker !== "object") return "failed";
  const value = marker as { version?: unknown; previousBuildId?: unknown };
  if (value.version !== 1 || typeof value.previousBuildId !== "string" || !value.previousBuildId) return "failed";
  // A still-running root bootstrap may be installing the new launcher. Never
  // overlap it, and an unreadable state cannot prove it finished.
  if (!bootstrapState || ["activating", "active", "deactivating", "reloading"].includes(bootstrapState)) return "wait";
  if (bootstrapState !== "inactive" || !currentBuildId || currentBuildId === value.previousBuildId) return "failed";
  return "ready";
}
