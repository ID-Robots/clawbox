/**
 * Kokoro's memory guard, read from the box's own voice script's words.
 *
 * `scripts/openclaw/clawbox-tts.sh` refuses a Kokoro cold start when less than
 * CLAWBOX_TTS_MIN_FREE_MB (3000 MB unless set, TASK-382) is free, and states it
 * on stderr as `- kokoro: skipped, <available>MB available and the CUDA path
 * peaks at ~2.6GB (need >=<needed>MB)`. That line reaches ClawBox two ways:
 * as the script's own stderr when the box speaks by itself
 * (voice-speak.ts `speakLocally`), and inside Hermes' answer when Hermes runs
 * the script as its `clawbox-local` command (hermes-tts.ts `speakWithHermes`,
 * TASK-2649). Both read it here, so the two cannot drift apart.
 *
 * No `^` anchor and no `s` flag: Hermes wraps the stderr in sentences of its
 * own, and `.` stops at a line end, so a match stays on the guard's own line.
 */
const MEMORY_GUARD = /kokoro: skipped, (\d+)MB available .*need >=(\d+)MB/;

/** The guard's numbers, said as gigabytes the way the owner reads them ("2.6", "3"). */
export interface KokoroMemoryShortfall {
  available: string;
  needed: string;
}

/** Megabytes as the script counts them, said as gigabytes: 2412 → "2.4", 3000 → "3". */
export function gigabytes(mb: number): string {
  return (mb / 1000).toFixed(1).replace(/\.0$/, "");
}

/** The memory guard's numbers when `text` carries its line, else null. */
export function kokoroMemoryShortfall(text: string): KokoroMemoryShortfall | null {
  const match = MEMORY_GUARD.exec(text);
  if (!match) return null;
  return { available: gigabytes(Number(match[1])), needed: gigabytes(Number(match[2])) };
}
