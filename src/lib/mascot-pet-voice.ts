// ── What a pet says ──
//
// Pets talk exactly like the crab does: same ten locale packs, same generated
// lines, same language gate. That is the whole point — the personality is
// ClawBox's, the body is Hermes'.
//
// Only one category needed touching. An audit of the packs found the mascot's
// crab-literal lines are almost entirely confined to `power` (the shout while
// perched on the box): "🦀👑 KING CRAB!", "🔥 SUPER CLAW!", "💎 DIAMOND CLAWS
// ACTIVATED!" in `en`, four more in `fr`, and nothing anywhere else. A penguin
// yelling KING CRAB reads as a bug.
//
// The fix is this file, not ten new packs. The language-free `neutral` pack
// already satisfies the category contract, so a pet's `power` lines come from
// there — minus the one crab emoji it carries. No new strings, no new
// translations, and nothing for the i18n parity test to fail on.
//
// Explicitly NOT done: per-species voices. Sixteen pets x nine categories x ten
// locales is 1440 strings, all of which the parity test would then demand.

import { NEUTRAL_PACK } from "@/lib/mascot-packs";

const CRAB = /🦀/u;

/**
 * The `power` lines a pet may shout: the neutral pack's, with the crab-literal
 * entries dropped. Language-free, so it is safe in every locale.
 */
export const PET_POWER_LINES: readonly string[] = (() => {
  const kept = NEUTRAL_PACK.power.filter((line) => !CRAB.test(line));
  // A pack that somehow left nothing is still better served by the unfiltered
  // list than by silence — an empty category makes `say()` bail every time.
  return kept.length > 0 ? kept : NEUTRAL_PACK.power;
})();
