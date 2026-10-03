// "Nothing changed" for the desktop's own state, answered before it is set.
//
// The desktop root is one component holding every window, the chat and the
// shelf, and a state setter handed a NEW array or Set with the same contents
// is a change to React — it re-renders all of it, for nothing on screen. These
// say when the value about to be set is the one already held, so the setter
// can keep the old one and React bails out.

/** A Telegram access request as the desktop's card draws it. */
export interface PairingRequestCard {
  code?: string;
  id?: string;
  name?: string;
}

/**
 * The same requests, in the same order, with everything the card draws — the
 * name, the id line and the code its buttons act on. The pairing poll answers
 * every 20 s, nearly always with what it answered last time (on a box with no
 * bot, an empty list every time).
 */
export function samePairingRequests(a: readonly PairingRequestCard[], b: readonly PairingRequestCard[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((r, i) => r.code === b[i].code && r.id === b[i].id && r.name === b[i].name);
}

/**
 * The same icons selected. A rubber-band selection is recomputed on every
 * pointer move, and almost every move selects what the last one did.
 */
export function sameSelection(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
