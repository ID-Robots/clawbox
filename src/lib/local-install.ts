/**
 * What Settings → Local AI may install on a click, and what a caller has to
 * say to ask for it.
 *
 * PURE and client-safe on purpose — the `coding-permission-rules` precedent.
 * The panel refuses a bad size or a malformed GGUF reference before it posts,
 * and the route refuses the same one again on its own side; sharing the rule
 * is what stops the two answers from drifting, and it is what lets a component
 * test assert the refusal the route would have given.
 *
 * The owner's decision of 2026-09-14 is that everything beyond the blessed set
 * install.sh ships (Gemma 4, the Qwen embedder, Kokoro, Whisper `base`) arrives
 * only when the owner clicks. So every entry here is something the box does NOT
 * have until somebody asks for it.
 */

/** One speech-to-text size the box can be switched to. */
export interface WhisperSize {
  id: string;
  /**
   * What the download costs, so the disk check can be made BEFORE a byte is
   * fetched. Systran's faster-whisper CTranslate2 conversions, measured from
   * the published artefact sizes; generous rather than exact, because the
   * number's whole job is to refuse an install that would not fit.
   */
  bytes: number;
}

/**
 * The sizes `scripts/whisper-server.py` can actually load. `large-v3` is
 * deliberately absent: it is a ~3 GB download that does not fit beside the
 * agent model on an 8 GB board, and offering it would mean offering an install
 * that finishes and then cannot run.
 */
export const WHISPER_SIZES: readonly WhisperSize[] = [
  { id: "tiny", bytes: 78 * 1024 * 1024 },
  { id: "base", bytes: 150 * 1024 * 1024 },
  { id: "small", bytes: 500 * 1024 * 1024 },
  { id: "medium", bytes: 1600 * 1024 * 1024 },
] as const;

export const WHISPER_SIZE_IDS: readonly string[] = WHISPER_SIZES.map((s) => s.id);

export function isWhisperSize(value: unknown): value is string {
  return typeof value === "string" && WHISPER_SIZE_IDS.includes(value);
}

export function whisperSize(id: string): WhisperSize | null {
  return WHISPER_SIZES.find((s) => s.id === id) ?? null;
}

/** The two models the setup wizard offers; named here so both pickers agree. */
export const OLLAMA_PRESET_MODELS: readonly { id: string; label: string }[] = [
  { id: "llama3.2:3b", label: "Llama 3.2 3B" },
  { id: "qwen2.5:3b-instruct-q4_K_M", label: "Qwen2.5 3B" },
] as const;

/**
 * The alphabets these references may be made of, and the rule about the shape
 * they have to take.
 *
 * REBUILT, never tested and passed through. Every one of these values ends up
 * in a filesystem path or in the path of a request this box makes, and the
 * repo's rule for that is `safeAppId`'s (src/lib/webapp-icon.ts): the value
 * that reaches `path.join` or `fetch` is assembled here one character at a
 * time out of a constant alphabet, so whatever the caller sent, what is used
 * downstream is made of these characters and no more than this many of them.
 * The rule is exactly a regex test; it is written this way because the data
 * flow itself has to show the cut — a `.test()` guard leaves the caller's
 * string in play, and a static analyser rightly keeps flagging every path and
 * every URL built from it.
 *
 * The charset is the brief's `^[A-Za-z0-9._/-]+$`, with three exclusions it
 * does not cover on its own:
 *
 *  - a `..` (or empty, or `.`) segment, because a file name becomes a path
 *    under the model directory and a repo id becomes a path under the Hub's;
 *  - a leading `-`, because the value is passed to `hf download` as a
 *    positional argument and a leading dash is an option, not a name;
 *  - an empty string.
 */
const HF_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-/";
/** The same, without the separator: a file already on this box has no directory part. */
const LOCAL_NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-";
const MAX_HF_REF_CHARS = 200;

function rebuild(value: unknown, alphabet: string, maxChars: number): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > maxChars) return null;
  let safe = "";
  for (const ch of value) {
    const at = alphabet.indexOf(ch);
    if (at < 0) return null;
    safe += alphabet[at];
  }
  return safe;
}

function shapeOk(value: string): boolean {
  if (value.startsWith("-")) return false;
  return !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/** `owner/name` — the form `hf download` takes as its repo id, rebuilt. */
export function safeHfRepo(value: unknown): string | null {
  const safe = rebuild(value, HF_ALPHABET, MAX_HF_REF_CHARS);
  if (safe === null || !shapeOk(safe)) return null;
  return safe.split("/").length === 2 ? safe : null;
}

/**
 * A file inside that repo, rebuilt. It must end in `.gguf`: this library is the
 * llama.cpp model directory, `start-llamacpp.sh` passes its entries to
 * `llama-server --model`, and a repo's README or tokenizer downloaded into it
 * is a file the owner has to notice and delete by hand.
 */
export function safeHfGgufFile(value: unknown): string | null {
  const safe = rebuild(value, HF_ALPHABET, MAX_HF_REF_CHARS);
  if (safe === null || !shapeOk(safe)) return null;
  return /\.gguf$/i.test(safe) ? safe : null;
}

/**
 * A GGUF already on the box, named the way `DELETE` takes it: the plain file
 * name `hf download --local-dir` left behind, with no directory part at all.
 * Kept separate from `safeHfGgufFile` — that one may carry the repo's own
 * sub-directory, this one addresses something already on disk.
 */
export function safeLocalGgufName(value: unknown): string | null {
  const safe = rebuild(value, LOCAL_NAME_ALPHABET, MAX_HF_REF_CHARS);
  if (safe === null || safe.startsWith("-") || safe === "." || safe === "..") return null;
  return /\.gguf$/i.test(safe) ? safe : null;
}

/**
 * The offered size this value names — the CATALOGUE's own string, not the
 * caller's. `whisperCacheDir` builds a path from it, so the same rule applies:
 * what reaches `path.join` is one of four literals defined in this file.
 */
export function safeWhisperSize(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return WHISPER_SIZES.find((size) => size.id === value)?.id ?? null;
}

/** The predicates the panel validates with; the `safe*` builders are what a path or a URL is made from. */
export function isHfRepo(value: unknown): value is string {
  return safeHfRepo(value) !== null;
}

export function isHfGgufFile(value: unknown): value is string {
  return safeHfGgufFile(value) !== null;
}

export function isLocalGgufName(value: unknown): value is string {
  return safeLocalGgufName(value) !== null;
}

export interface DiskVerdict {
  ok: boolean;
  requiredBytes: number;
  /** Null when the disk would not say; the install then goes ahead. */
  freeBytes: number | null;
  reserveBytes: number;
  /** How much more room the disk would need, 0 when it fits. */
  shortfallBytes: number;
}

/**
 * Does this download fit?
 *
 * The reserve is the box-wide one (src/lib/disk-reserve.ts): a model download
 * is exactly the unbounded write that reserve exists for, and an install that
 * filled the disk would take the next in-app update's build with it.
 *
 * A disk that will not answer is NOT a refusal. `statfs` failing is a fault in
 * the measurement, not a full disk, and refusing every install on a box whose
 * filesystem does not report is the worse outcome — the same judgement the
 * upload route makes.
 */
export function diskVerdict(requiredBytes: number, freeBytes: number | null, reserveBytes: number): DiskVerdict {
  if (freeBytes === null) {
    return { ok: true, requiredBytes, freeBytes, reserveBytes, shortfallBytes: 0 };
  }
  const usable = freeBytes - reserveBytes;
  const shortfall = Math.max(0, requiredBytes - usable);
  return { ok: shortfall === 0, requiredBytes, freeBytes, reserveBytes, shortfallBytes: shortfall };
}
