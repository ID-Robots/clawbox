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
 * The alphabet a Hugging Face reference may use. The brief's charset, with
 * three exclusions the charset alone does not cover:
 *
 *  - a `..` segment, because the file name becomes a path under the model
 *    directory and the repo becomes a path under the Hub's own cache;
 *  - a leading `-`, because the value is passed to `hf download` as a
 *    positional argument and a leading dash is an option, not a name;
 *  - an empty string.
 *
 * A repo is `owner/name` exactly — one slash — and a file is a path with no
 * leading or trailing slash. Both are REBUILT from nothing by the caller: the
 * route passes the validated string to `execFile` as one argv element, never
 * through a shell.
 */
const HF_CHARSET = /^[A-Za-z0-9._/-]+$/;

function hfShapeOk(value: string): boolean {
  if (!value || value.length > 200) return false;
  if (!HF_CHARSET.test(value)) return false;
  if (value.startsWith("-")) return false;
  return !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/** `owner/name` — the form `hf download` takes as its repo id. */
export function isHfRepo(value: unknown): value is string {
  if (typeof value !== "string" || !hfShapeOk(value)) return false;
  return value.split("/").length === 2;
}

/**
 * A file inside that repo. It must end in `.gguf`: this library is the
 * llama.cpp model directory, `start-llamacpp.sh` passes its entries to
 * `llama-server --model`, and a repo's README or tokenizer downloaded into it
 * is a file the owner has to notice and delete by hand.
 */
export function isHfGgufFile(value: unknown): value is string {
  if (typeof value !== "string" || !hfShapeOk(value)) return false;
  return /\.gguf$/i.test(value);
}

/**
 * A GGUF already on the box, named the way `DELETE` takes it: the plain file
 * name `hf download --local-dir` left behind, with no directory part at all.
 * Kept separate from `isHfGgufFile` — that one may carry the repo's own
 * sub-directory, this one addresses something already on disk.
 */
export function isLocalGgufName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 200
    && /^[A-Za-z0-9._-]+\.gguf$/i.test(value)
    && !value.startsWith("-")
    && value !== "."
    && value !== "..";
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
