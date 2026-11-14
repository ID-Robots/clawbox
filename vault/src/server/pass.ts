// Adapter over the `pass` CLI. Writes go through `pass insert -m -f` (stdin),
// reads through `pass show`, deletes through `pass rm`, renames through
// `pass mv`; every write is a pass git commit, so history stays. Listing walks
// the store directory. Plaintext only ever travels over stdin/stdout pipes.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
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

  private async run(args: string[], stdin?: string): Promise<RunResult> {
    const proc = Bun.spawn([this.opts.bin, ...args], {
      env: this.env(),
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

  /** Create or overwrite an entry with the full multi-line content. */
  async insert(name: string, content: string): Promise<void> {
    const n = validateName(name);
    const body = content.endsWith("\n") ? content : `${content}\n`;
    const r = await this.run(["insert", "-m", "-f", "--", n], body);
    if (r.code !== 0) this.fail("insert", n, r);
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
