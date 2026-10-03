/**
 * Plain-data equality: primitives, arrays and plain objects, compared by value.
 *
 * What lets a re-read that answers the SAME thing keep the identity of what is
 * already on screen. A history reconcile rebuilds every message object from
 * the gateway's answer even when only the newest one is new, a status poll
 * hands back a freshly parsed object every time, and React compares by
 * identity — so without this every such read re-renders, and re-parses, what
 * did not change.
 *
 * Anything that is not plain data (a Date, a Map, a class instance) compares by
 * identity, and a difference anywhere — an added key, an `undefined` where
 * there was nothing — answers "changed": the safe direction is always a render.
 *
 * Shared by the two chats' transcript rows (ChatMessageRow, ChatApp) and the
 * chat's coding-run poll (use-coding-agent-activity), so the rule for "the
 * same" is written once.
 */
export function samePlainData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!samePlainData(a[i], b[i])) return false
    return true
  }
  const protoA = Object.getPrototypeOf(a)
  const protoB = Object.getPrototypeOf(b)
  if ((protoA !== Object.prototype && protoA !== null) || (protoB !== Object.prototype && protoB !== null)) return false
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!samePlainData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  }
  return true
}
