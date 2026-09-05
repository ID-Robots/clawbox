/**
 * The ClawBox AI portal credential, recognised by its format.
 *
 * One definition, because the question "is this credential OURS?" is asked on
 * both editions and in three different registers — the provider strip, the
 * voice config view, and the Hermes link path deciding whether an
 * OpenAI-compatible slot is ours to write. A second copy of the prefix is how
 * one of those surfaces ends up disagreeing with the others about whose key is
 * in a slot, and on the voice path that disagreement overwrites an owner's own
 * credential.
 *
 * Its own module rather than an export from a bigger one: `hermes-tts.ts` reads
 * this on the Hermes chat turn and deliberately keeps `openclaw-config` — which
 * spawns a CLI that does not exist on that edition — out of its module graph.
 */

/** The `claw_` prefix is the ClawBox AI portal token format (see clawkeep.ts). */
export function isClawboxAiToken(value: string): boolean {
  return value.trim().startsWith("claw_");
}
