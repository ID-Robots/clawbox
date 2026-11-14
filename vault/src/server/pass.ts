// Adapter over the `pass` CLI. Reads go through `pass show`, deletes through
// `pass rm`, renames through `pass mv`. Saves encrypt exactly as
// `pass insert -m -f` does (same recipients, gpg options and commit message)
// but publish the ciphertext atomically: see insert(). Every write is a git
// commit in the store, so history stays. Listing walks the store directory.
// Plaintext only ever travels over stdin/stdout pipes.
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { validateName } from "../shared/entry";

export class PassError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "exists" | "failed",
  ) {
    super(message);
    this.name = "PassError";
  }
}

export interface PassOptions {
  bin: string;
  storeDir: string;
  env?: Record<string, string>;
  /** Receives non-secret diagnostics (command, exit code, gpg/pass stderr). */
  log?: (line: string) => void;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class PassStore {
  constructor(private readonly opts: PassOptions) {}

  get storeDir(): string {
    return this.opts.storeDir;
  }

  private env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, this.opts.env ?? {});
    env.PASSWORD_STORE_DIR = this.opts.storeDir;
    // Store extensions are user scripts; the vault never needs them.
    env.PASSWORD_STORE_ENABLE_EXTENSIONS = "false";
    return env;
  }

  private run(args: string[], stdin?: string): Promise<RunResult> {
    return this.exec([this.opts.bin, ...args], this.env(), stdin);
  }

  private async exec(cmd: string[], env: Record<string, string>, stdin?: string): Promise<RunResult> {
    const proc = Bun.spawn(cmd, {
      env,
      stdin: stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      await proc.stdin.end();
    }
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  private fail(op: string, name: string, r: RunResult): never {
    // stderr from pass/gpg never contains plaintext (secrets go over stdin/stdout),
    // but keep it short and on the service log only.
    const reason = r.stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 300);
    this.opts.log?.(`pass ${op} ${name} failed (exit ${r.code}): ${reason}`);
    throw new PassError(`pass ${op} failed (exit ${r.code})`, "failed");
  }

  fileFor(name: string): string {
    return join(this.opts.storeDir, `${validateName(name)}.gpg`);
  }

  async exists(name: string): Promise<boolean> {
    try {
      return (await stat(this.fileFor(name))).isFile();
    } catch {
      return false;
    }
  }

  private async isFolder(name: string): Promise<boolean> {
    try {
      return (await stat(join(this.opts.storeDir, validateName(name)))).isDirectory();
    } catch {
      return false;
    }
  }

  async mtime(name: string): Promise<Date> {
    return (await stat(this.fileFor(name))).mtime;
  }

  /** Decrypted entry text. The caller must never log or echo it. */
  async show(name: string): Promise<string> {
    const n = validateName(name);
    if (!(await this.exists(n))) throw new PassError("entry not found", "not_found");
    const r = await this.run(["show", "--", n]);
    if (r.code !== 0) this.fail("show", n, r);
    return r.stdout;
  }

  /**
   * Create or overwrite an entry with the full multi-line content.
   *
   * `pass insert` lets gpg write straight into the entry file, so a reader
   * running beside it could decrypt half a file and an interrupted overwrite
   * would leave the entry unreadable. Here gpg writes a hidden temp file in the
   * entry's own folder with the recipients and options `pass insert` would use;
   * only after encryption succeeded is it synced and renamed over the entry,
   * then committed with pass's own message. A reader sees the old ciphertext or
   * the new one. A failed save, including a failed commit, leaves the previous
   * entry (or no entry), nothing staged, and no temp file.
   */
  async insert(name: string, content: string): Promise<void> {
    const n = validateName(name);
    const body = content.endsWith("\n") ? content : `${content}\n`;
    const env = this.env();
    // Absolute: git -C <dir> reads a relative pathspec against <dir>.
    const file = resolve(this.fileFor(n));
    const dir = dirname(file);
    const mask = umaskOf(env);
    const gpg = gpgCommand(env);
    const recipients = await this.recipients(n, env, gpg.bin);
    await mkdir(dir, { recursive: true, mode: 0o777 & ~mask });
    const id = randomUUID();
    const tmp = join(dir, `.${basename(file)}.${id}.tmp`);
    const old = join(dir, `.${basename(file)}.${id}.old`);
    let kept = false;
    let published = false;
    try {
      const args = [gpg.bin, "-e", ...recipients.flatMap((r) => ["-r", r]), "-o", tmp, ...gpg.opts];
      const r = await this.exec(args, env, body);
      if (r.code !== 0) this.fail("insert", n, r);
      await chmod(tmp, 0o666 & ~mask);
      await syncPath(tmp);
      try {
        await copyFile(file, old, fsConstants.COPYFILE_EXCL);
        kept = true;
        // On disk before anything is published: a rollback renames it back.
        await syncPath(old);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      await rename(tmp, file);
      published = true;
      await syncPath(dir).catch(() => undefined);
      await this.commit(n, file, `Add given password for ${n} to store.`, env);
    } catch (err) {
      if (published) {
        // The store must not show a save its history lacks: put the previous
        // ciphertext back (or take the new entry away) and unstage it.
        try {
          if (kept) await rename(old, file);
          else await rm(file, { force: true });
          kept = false;
          // rename and unlink are atomic, not durable: the folder is synced so
          // a power cut cannot bring the refused save back.
          await syncPath(dir).catch(() => undefined);
          const { git, genv } = gitEnv(env, this.opts.storeDir);
          await this.exec([git, "-C", dir, "reset", "-q", "--", file], genv);
        } catch {
          this.opts.log?.(`pass insert ${n}: the previous entry could not be put back; it is kept beside it as ${basename(old)}`);
          kept = false;
        }
      }
      throw err;
    } finally {
      await rm(tmp, { force: true });
      if (kept) await rm(old, { force: true });
    }
  }

  /** Recipients the way pass picks them: PASSWORD_STORE_KEY, else the nearest .gpg-id. */
  private async recipients(name: string, env: Record<string, string>, gpgBin: string): Promise<string[]> {
    const fromEnv = words(env.PASSWORD_STORE_KEY);
    if (fromEnv.length > 0) return fromEnv;
    const root = resolve(this.opts.storeDir);
    let dir = dirname(resolve(root, name));
    for (;;) {
      const idFile = join(dir, ".gpg-id");
      if (await isFile(idFile)) {
        await this.verifyIdFile(name, idFile, env, gpgBin);
        const ids = (await readFile(idFile, "utf8"))
          .split("\n")
          .map((line) => line.replace(/#.*$/, "").trim())
          .filter(Boolean);
        if (ids.length > 0) return ids;
        break;
      }
      if (dir === root || !dir.startsWith(root + sep)) break;
      dir = dirname(dir);
    }
    this.opts.log?.(`pass insert ${name} failed: no gpg id for this entry (pass init)`);
    throw new PassError("pass insert failed: the store has no gpg id", "failed");
  }

  /** pass's verify_file: with PASSWORD_STORE_SIGNING_KEY set, a .gpg-id needs a valid signature. */
  private async verifyIdFile(name: string, idFile: string, env: Record<string, string>, gpgBin: string): Promise<void> {
    if (!env.PASSWORD_STORE_SIGNING_KEY?.trim()) return;
    const wanted = words(env.PASSWORD_STORE_SIGNING_KEY).filter((f) => /^[A-F0-9]{40}$/.test(f));
    let valid: string[] = [];
    if (await isFile(`${idFile}.sig`)) {
      const args = [gpgBin, ...words(env.PASSWORD_STORE_GPG_OPTS), "--verify", "--status-fd=1", `${idFile}.sig`, idFile];
      const r = await this.exec(args, env);
      valid = [...r.stdout.matchAll(/^\[GNUPG:\] VALIDSIG ([A-F0-9]{40}) .* ([A-F0-9]{40})$/gm)].flatMap((m) => [m[1] ?? "", m[2] ?? ""]);
    }
    if (!wanted.some((f) => valid.includes(f))) {
      this.opts.log?.(`pass insert ${name} failed: the signature of its .gpg-id is missing or invalid`);
      throw new PassError("pass insert failed: .gpg-id signature", "failed");
    }
  }

  /** pass's git_add_file: stage the entry and commit it when the store is a git work tree. */
  private async commit(name: string, file: string, message: string, env: Record<string, string>): Promise<void> {
    const { git, genv } = gitEnv(env, this.opts.storeDir);
    const dir = dirname(file);
    const inside = await this.exec([git, "-C", dir, "rev-parse", "--is-inside-work-tree"], genv);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") return;
    const add = await this.exec([git, "-C", dir, "add", "--", file], genv);
    if (add.code !== 0) this.fail("insert (git add)", name, add);
    const status = await this.exec([git, "-C", dir, "status", "--porcelain", "--", file], genv);
    if (!status.stdout.trim()) return;
    const sign = (await this.exec([git, "-C", dir, "config", "--bool", "--get", "pass.signcommits"], genv)).stdout.trim() === "true";
    const done = await this.exec([git, "-C", dir, "commit", ...(sign ? ["-S"] : []), "-m", message], genv);
    if (done.code !== 0) this.fail("insert (git commit)", name, done);
  }

  async remove(name: string): Promise<void> {
    const n = validateName(name);
    if (!(await this.exists(n))) throw new PassError("entry not found", "not_found");
    const r = await this.run(["rm", "-f", "--", n]);
    if (r.code !== 0) this.fail("rm", n, r);
  }

  async move(from: string, to: string): Promise<void> {
    const a = validateName(from);
    const b = validateName(to);
    if (!(await this.exists(a))) throw new PassError("entry not found", "not_found");
    if (await this.exists(b)) throw new PassError("target entry exists", "exists");
    // `pass mv a b` with a folder b moves a INTO it (and can replace b/a.gpg):
    // a name that is a folder is no free target.
    if (await this.isFolder(b)) throw new PassError("target is a folder", "exists");
    const r = await this.run(["mv", "--", a, b]);
    if (r.code !== 0) this.fail("mv", `${a} -> ${b}`, r);
  }

  /**
   * Entry names from the store directory (no decryption). `under` walks only
   * that top-level folder; `skip` leaves top-level folders (and same-named
   * entries) out.
   */
  async list(opts: { under?: string; skip?: string[] } = {}): Promise<string[]> {
    const out: string[] = [];
    const skip = new Set(opts.skip ?? []);
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let items;
      try {
        items = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (item.name.startsWith(".")) continue; // .git, .gpg-id, .extensions
        if (!prefix && (skip.has(item.name) || skip.has(item.name.replace(/\.gpg$/, "")))) continue;
        const rel = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory()) await walk(join(dir, item.name), rel);
        else if (item.isFile() && item.name.endsWith(".gpg")) out.push(rel.slice(0, -4));
      }
    };
    if (opts.under) await walk(join(this.opts.storeDir, validateName(opts.under)), validateName(opts.under));
    else await walk(this.opts.storeDir, "");
    return out.sort((a, b) => a.localeCompare(b));
  }
}

/** git as pass runs it: no inherited repo overrides, never above the store's parent. */
function gitEnv(env: Record<string, string>, storeDir: string): { git: string; genv: Record<string, string> } {
  const genv = { ...env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_NAMESPACE", "GIT_INDEX_FILE", "GIT_INDEX_VERSION", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) {
    delete genv[k];
  }
  // pass exports "$PREFIX/.." unresolved, so git follows a symlinked store to
  // its real parent; only make it absolute (git ignores relative ceilings).
  genv.GIT_CEILING_DIRECTORIES = `${resolve(storeDir)}/..`;
  return { git: Bun.which("git", { PATH: genv.PATH ?? "" }) ?? "git", genv };
}

/** Whitespace-separated words, as pass splits its unquoted env settings. */
function words(value: string | undefined): string[] {
  return (value ?? "").split(/\s+/).filter(Boolean);
}

/** pass runs under `umask ${PASSWORD_STORE_UMASK:-077}`. */
function umaskOf(env: Record<string, string>): number {
  const m = Number.parseInt(env.PASSWORD_STORE_UMASK ?? "", 8);
  return Number.isInteger(m) && m >= 0 && m <= 0o777 ? m : 0o077;
}

/** pass's gpg choice and options; --batch always, the vault never has a terminal. */
function gpgCommand(env: Record<string, string>): { bin: string; opts: string[] } {
  const PATH = env.PATH ?? "";
  const gpg2 = Bun.which("gpg2", { PATH });
  const bin = gpg2 ?? Bun.which("gpg", { PATH }) ?? "gpg";
  const opts = [...words(env.PASSWORD_STORE_GPG_OPTS), "--quiet", "--yes", "--compress-algo=none", "--no-encrypt-to", "--batch"];
  if (env.GPG_AGENT_INFO || gpg2) opts.push("--use-agent");
  return { bin, opts };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function syncPath(path: string): Promise<void> {
  const fh = await open(path, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}
