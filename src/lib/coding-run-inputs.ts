/**
 * ── The files a coding-agent run is GIVEN to work from ───────────────────────
 *
 * WHAT THIS IS FOR. The assistant draws a picture or speaks a clip into its own
 * state directory — `~/.openclaw/media/...` on the OpenClaw edition, a tree
 * beside the rest of the app's data on Hermes (see `chatMediaRoot`). When those
 * assets are the INPUT to a coding task, the run cannot reach them: the
 * OpenClaw home is a credential store this box denies to every run, wholesale
 * (`PROTECTED_HOME_DIRS` → `fileDenyRules`), and a deny rule outranks any allow
 * rule in Claude Code, so there is no permission the owner could grant that
 * would open it. Reported from a live run: "Confirmed, the media folder is
 * denied by permission settings for all routes — Bash cp and Read both
 * refused." The run then drew the four pictures again.
 *
 * WHY A COPY RATHER THAN A HOLE IN THE DENY LIST. Opening one child of the
 * harness's home means denying its siblings ENTRY BY ENTRY, and those entries
 * are enumerated once, at spawn: a `.env.bak-…` or a fresh `credentials` file
 * written into that folder while a forty-minute run is going would land outside
 * the snapshot and be readable. That is the exact trade the SOFT/HARD split in
 * @/lib/coding-permission-rules refuses for a credential store, and the media
 * tree is not worth reopening it for. So the box copies the NAMED assets out
 * instead, into a folder every run may read: nothing is reachable that was not
 * deliberately staged, the same mechanism works on the Hermes SKU (whose media
 * lives somewhere else entirely), and it is equally the answer for a file the
 * owner drops in by hand through the Files app.
 *
 * WHERE. `data/coding-agent-inputs/` — a public data subtree
 * (`CODING_AGENT_INPUTS_SUBTREE`), so file-guard leaves it out of the entry-by-
 * entry data/ denials and the Files app can browse it. One folder per run, plus
 * a `shared/` folder that is not any run's: that is the one the owner is told
 * to drop files into, and it is a legal SOURCE here too, so "put it in shared
 * and hand the path over" works without the assistant having to generate
 * anything.
 *
 * WHAT MAY BE COPIED, AND FROM WHERE. Only a regular file (never a symlink)
 * whose real path is inside one of `inputSourceRoots()`. That root list IS the
 * gate — `isProtectedFilePath` cannot be it, because the whole point is to copy
 * out of `~/.openclaw`, which that guard rightly refuses. The web server runs
 * as the box's own user, so without a root list an agent naming
 * `~/.ssh/id_ed25519` would have had the box stage its own private key into a
 * folder every run can read.
 *
 * SERVER ONLY (fs, and the absolute paths of the box's own directories).
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "@/lib/runtime-path";
import { DATA_DIR } from "@/lib/config-store";
import { CODING_AGENT_INPUTS_SUBTREE } from "@/lib/file-guard";

/** How many files one run may be handed. A task with more is a folder, not inputs. */
export const MAX_RUN_INPUTS = 20;

/** The largest single asset the box will copy. A generated picture is ~1.5 MB. */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

/** The longest destination name. Matches the artifacts store's own bound. */
const MAX_NAME_CHARS = 100;

/**
 * The folder inside the inputs tree that belongs to no run — where the owner
 * drops files by hand, and where a caller may point at something already
 * staged. A name no run id can collide with: a run id is `run-<8>`.
 */
export const SHARED_INPUTS_DIR_NAME = "shared";

/** A run id, as the artifacts store spells it. Restated rather than imported so
 *  this module stays a leaf beside file-guard; both are pinned by the tests. */
const RUN_ID_RE = /^run-[a-z0-9]{8}$/;

/** One file the box staged for a run. No path: the folder is reported once. */
export interface RunInputFile {
  name: string;
  bytes: number;
}

/**
 * Why one named asset was not staged. A stable code beside the fact, the shape
 * every refusal in this subtree has, so a caller can tell a typo from a denied
 * location and each locale words it in the owner's language.
 *
 * A runtime list and not only a type, because a code TRAVELS: it is stored on
 * the run record and read back by a later build, which has to be able to judge
 * what is on disk rather than trust it.
 *
 *   not_absolute  — not an absolute path; a run's inputs are named by where they are
 *   outside_roots — outside every location this box will copy from (`inputSourceRoots`)
 *   not_a_file    — not there, not a regular file, or a symlink (which may lead anywhere)
 *   too_large     — bigger than MAX_INPUT_BYTES
 *   too_many      — MAX_RUN_INPUTS already staged for this run
 *   copy_failed   — the copy itself failed: a full disk, a source that vanished
 */
export const INPUT_REFUSAL_CODES = [
  "not_absolute",
  "outside_roots",
  "not_a_file",
  "too_large",
  "too_many",
  "copy_failed",
] as const;

export type InputRefusalCode = (typeof INPUT_REFUSAL_CODES)[number];

/** True when `code` is one this build knows — the guard for a code read back
 *  off a run record rather than produced by the staging just now. */
export function isInputRefusalCode(code: unknown): code is InputRefusalCode {
  return typeof code === "string" && (INPUT_REFUSAL_CODES as readonly string[]).includes(code);
}

export interface RefusedInput {
  /** The path as the caller named it. */
  path: string;
  code: InputRefusalCode;
}

export interface StageResult {
  /** Where the staged files landed. Always answered, even when none did. */
  dir: string;
  staged: RunInputFile[];
  refused: RefusedInput[];
}

/**
 * OpenClaw's home, resolved by the SAME expression `openclaw-config` uses.
 *
 * Not imported from there on purpose: that module pulls the gateway's session
 * store, the model patcher and the llama.cpp proxy in behind it, and this one
 * is a leaf the runner imports. The expression is three environment reads with
 * a documented fallback, and the inputs suite pins this answer against
 * `OPENCLAW_HOME` itself so the two spellings cannot drift.
 */
function openclawHome(): string {
  return process.env.CLAWBOX_OPENCLAW_HOME
    || process.env.OPENCLAW_HOME
    || path.join(process.env.HOME || "/home/clawbox", ".openclaw");
}

/**
 * Where the assistant's own generated media lives, in BOTH spellings.
 *
 * Both, rather than the active harness's one, because this is a source
 * allow-list and not a place to write: resolving it would mean an async harness
 * probe on a path the runner takes synchronously, a `dual` box genuinely has
 * both, and a tree the box does not have is simply a root nothing is ever
 * inside. Kept in step with `chatMediaRoot()` in @/lib/harness/media-root,
 * which is what actually writes into them.
 */
export function assistantMediaRoots(): string[] {
  return [path.join(openclawHome(), "media"), path.join(DATA_DIR, "chat-media")];
}

/** The inputs tree: one folder per run, plus `shared/`. */
export function inputsRoot(): string {
  return path.join(DATA_DIR, CODING_AGENT_INPUTS_SUBTREE);
}

/** The folder the owner drops files into for any run to read. */
export function sharedInputsDir(): string {
  return path.join(inputsRoot(), SHARED_INPUTS_DIR_NAME);
}

/** One run's inputs folder. Throws on a malformed id — callers validate first. */
export function runInputsDir(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`not a run id: ${runId}`);
  return path.join(inputsRoot(), runId);
}

/**
 * Everywhere the box will copy an asset FROM.
 *
 * The assistant's media trees, and the inputs tree itself — the second so a
 * file already in `shared/` (or in another run's folder) can be handed to a run
 * by its path, which is what makes the Files-app route work without a second
 * mechanism. Nothing else: the web server runs as the box's own user and would
 * otherwise copy a credential out on the agent's word.
 */
export function inputSourceRoots(): string[] {
  return [...assistantMediaRoots(), inputsRoot()];
}

/** The inputs tree, and the shared folder inside it. Best effort by design:
 *  failing to make a folder for files nobody handed over must not fail a run. */
export function ensureInputsDirs(runId: string): string {
  const dir = runInputsDir(runId);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sharedInputsDir(), { recursive: true, mode: 0o700 });
  } catch (err) {
    console.warn(`[coding-agent] could not make the inputs folder of ${runId}:`, err instanceof Error ? err.message : err);
  }
  return dir;
}

/**
 * The destination name for a source file: its own base name, rebuilt from a
 * fixed alphabet rather than tested and passed through.
 *
 * Rebuilt because this name becomes a path — the `safeAppId` rule this codebase
 * applies everywhere an id reaches the filesystem. A leading dot is dropped so
 * a staged file can never be a dotfile (listings skip those), and an empty
 * result falls back to a fixed name rather than to the separator.
 */
export function safeInputName(source: string): string {
  const base = path.basename(source).replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "");
  const cut = base.slice(0, MAX_NAME_CHARS);
  return cut.trim() || "input";
}

/** `notes.png` → `notes-2.png` while the name is taken. */
function uniqueName(dir: string, wanted: string): string {
  const ext = path.extname(wanted);
  const stem = wanted.slice(0, wanted.length - ext.length) || "input";
  let name = wanted;
  for (let n = 2; n < 100 && fs.existsSync(path.join(dir, name)); n++) {
    name = `${stem}-${n}${ext}`;
  }
  return name;
}

/** The real path of a root, or null when the box does not have that tree. */
async function realRoot(root: string): Promise<string | null> {
  try {
    return await fsp.realpath(root);
  } catch {
    return null;
  }
}

/**
 * Copy the named assets into a run's inputs folder.
 *
 * Every path is judged on its own and every refusal carries its own code: one
 * bad path must not lose the other three, and a caller told only "some inputs
 * were refused" cannot fix the one that was.
 *
 * Containment is two checks, the pattern `coding-agent-media.ts` uses in the
 * other direction: `lstat` refuses a symlink outright, and the file's REAL path
 * must sit inside the real path of one of `inputSourceRoots()` — so neither a
 * link inside the media tree nor a link standing in for one of its parents can
 * carry the read out of it.
 *
 * Never throws: an input that could not be staged is a fact the run is told,
 * not a reason to refuse the whole task.
 */
export async function stageRunInputs(runId: string, paths: readonly string[]): Promise<StageResult> {
  const dir = runInputsDir(runId);
  const staged: RunInputFile[] = [];
  const refused: RefusedInput[] = [];
  if (paths.length === 0) return { dir, staged, refused };

  const roots = (await Promise.all(inputSourceRoots().map(realRoot))).filter((r): r is string => r !== null);
  let made = false;

  for (const candidate of paths) {
    const named = typeof candidate === "string" ? candidate.trim() : "";
    if (!named || !path.isAbsolute(named)) {
      refused.push({ path: String(candidate), code: "not_absolute" });
      continue;
    }
    if (staged.length >= MAX_RUN_INPUTS) {
      refused.push({ path: named, code: "too_many" });
      continue;
    }
    const resolved = path.resolve(named);
    let stat: fs.Stats;
    let real: string;
    try {
      // lstat, never stat: a symlink may lead anywhere, and following one here
      // would make every containment check below a check of the wrong file.
      stat = await fsp.lstat(resolved);
      real = await fsp.realpath(resolved);
    } catch {
      refused.push({ path: named, code: "not_a_file" });
      continue;
    }
    if (!stat.isFile()) {
      refused.push({ path: named, code: "not_a_file" });
      continue;
    }
    if (!roots.some((root) => real === root || real.startsWith(root + path.sep))) {
      refused.push({ path: named, code: "outside_roots" });
      continue;
    }
    if (stat.size > MAX_INPUT_BYTES) {
      refused.push({ path: named, code: "too_large" });
      continue;
    }
    try {
      if (!made) {
        ensureInputsDirs(runId);
        made = true;
      }
      const name = uniqueName(dir, safeInputName(real));
      const target = path.join(dir, name);
      // Already where it was asked to go — a caller naming a file in this run's
      // own folder. Counted as staged, never copied onto itself.
      if (real === target) {
        staged.push({ name, bytes: stat.size });
        continue;
      }
      await fsp.copyFile(real, target);
      await fsp.chmod(target, 0o600).catch(() => {});
      staged.push({ name, bytes: stat.size });
    } catch (err) {
      console.warn(`[coding-agent] could not stage an input for ${runId}:`, err instanceof Error ? err.message : err);
      refused.push({ path: named, code: "copy_failed" });
    }
  }
  return { dir, staged, refused };
}

/** What is in a run's inputs folder now, oldest first. Missing folder is []. */
export function listRunInputs(runId: string): RunInputFile[] {
  let dir: string;
  let names: string[];
  try {
    dir = runInputsDir(runId);
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: { file: RunInputFile; at: number }[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({ file: { name, bytes: stat.size }, at: stat.mtimeMs });
  }
  out.sort((a, b) => a.at - b.at || a.file.name.localeCompare(b.file.name));
  return out.slice(0, MAX_RUN_INPUTS).map((e) => e.file);
}

/** Delete a dropped run's inputs. Never throws — cleanup must not break its caller. */
export function removeRunInputs(runId: string): void {
  if (!RUN_ID_RE.test(runId)) return;
  try {
    fs.rmSync(runInputsDir(runId), { recursive: true, force: true });
  } catch (err) {
    console.error(`[coding-agent] could not remove the inputs of ${runId}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * The caller's `inputs` argument, read defensively.
 *
 * Absolute paths only, capped at MAX_RUN_INPUTS, duplicates dropped: the list
 * arrives from a route body or an MCP tool, and the staging below answers a
 * refusal per entry rather than throwing, so what this has to do is stop an
 * unbounded body from becoming an unbounded loop.
 */
export function readInputPaths(raw: unknown): string[] {
  const list = typeof raw === "string"
    ? raw.split(",")
    : Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const p = entry.trim();
    if (!p || out.includes(p)) continue;
    out.push(p);
    if (out.length >= MAX_RUN_INPUTS) break;
  }
  return out;
}
