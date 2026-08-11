// Compact labels for the chat header's selector pills.
//
// WHY this exists: the chat header is a single non-wrapping row of dropdown
// pills (provider → model → reasoning effort). At the docked default panel
// width of 400px the row is 262px wide, and each pill spends ~30px on its own
// padding + chevron, so the three LABELS share roughly 142px of text. Measured
// on the device, the un-shortened labels needed 242px and every one of them
// truncated — the provider pill rendered "Cla…", the reasoning pill "Thinki…".
//
// The fix is to stop printing the same word twice. The provider pill already
// names the vendor, so the model pill drops any leading or trailing token that
// merely repeats it:
//
//   "Claude"  +  "claude-fable-5"      →  "fable-5"
//   "Claude"  +  "Claude Sonnet 4.6"   →  "Sonnet 4.6"
//   "Codex"   +  "gpt-5.4-codex"       →  "gpt-5.4"
//   "Gemma 4" +  "gemma4-e2b-it-q4_0"  →  "e2b-it-q4_0"
//
// Nothing is lost: the dropdown popover still lists the full, unabbreviated
// model id/label, and it is the popover — not the pill — that the user reads
// when choosing. The pill only has to identify the current choice at a glance.

/** Strip characters that differ only cosmetically between a provider label and
 *  a model token ("Gemma 4" vs "gemma4", "z.ai / GLM" vs "glm"). */
function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Last path segment of a model id. Hermes model ids are `vendor/model` slugs
 * and OpenRouter's are `org/model`; the vendor half is what the provider pill
 * to the left is for. Bare ids (ClawBox AI serves those) pass through.
 */
export function lastModelSegment(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/**
 * The model pill's text: `modelLabel` with the vendor noise the provider pill
 * already carries removed.
 *
 * Deliberately conservative — it only ever removes a WHOLE leading or trailing
 * token that normalizes to exactly the provider pill's text, and never removes
 * the final token, so the pill can't be reduced to nothing (provider "Claude"
 * with model "claude" stays "claude").
 */
export function shortModelPillLabel(
  modelLabel: string | null | undefined,
  providerPillLabel: string | null | undefined,
): string {
  const base = lastModelSegment((modelLabel ?? "").trim());
  const key = normalizeToken(providerPillLabel ?? "");
  if (!base || !key) return base;

  // Split KEEPING the separators, so whatever survives re-joins byte-for-byte
  // as the author wrote it ("Sonnet 4.6" keeps its space, "e2b-it-q4_0" its
  // dashes and underscore).
  const parts = base.split(/([\s\-_]+)/);
  let start = 0;
  let end = parts.length - 1;
  const tokenAt = (i: number) => normalizeToken(parts[i] ?? "");

  // `end - start >= 2` = "there is more than one token left", which is what
  // stops the strip from emptying the pill.
  if (end - start >= 2 && tokenAt(start) === key) start += 2;
  if (end - start >= 2 && tokenAt(end) === key) end -= 2;

  return parts.slice(start, end + 1).join("") || base;
}

/**
 * Material Symbols ligature for the reasoning-effort pill.
 *
 * The pill used to read "Thinking: Medium" and lost over half of that to
 * truncation ("Thinki…") — the word that was legible was the one that carried
 * no information, and the level, which is the whole point of the control, was
 * the part cut off. A 13px brain glyph says "this is the thinking dial" in the
 * width of two characters, which is what buys the level word enough room to
 * render in full. It is also locale-independent: "Thinking:" was hardcoded
 * English in all ten locales, so a Bulgarian user was reading English filler.
 */
export const REASONING_PILL_ICON = "neurology";
