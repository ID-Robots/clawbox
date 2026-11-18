// First run: the vault makes its own GnuPG keyring and its own pass store, so a
// fresh box needs nothing set up by hand. Both live in the vault's folder and
// are never the user's ~/.gnupg or ~/.password-store.
//
// The key has no passphrase: the service has to decrypt an entry for a fill
// while nobody is at the keyboard. What guards the entries is the folder (mode
// 700, the box user's), the vault PIN in front of the desktop app, and the
// rule that no route hands a password to the agent.
//
// Nothing here is fatal to the service. A box without pass or gpg still serves
// the desktop app, which then says what is missing; the next request tries
// again.
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface StoreStatus {
  ready: boolean;
  /** Why the store is not usable, in words for the desktop app. Never a secret. */
  error?: string;
}

export interface StoreSetupOptions {
  passBin: string;
  storeDir: string;
  gnupgHome: string;
  /** Environment for pass/gpg/git on top of the process environment. */
  env: Record<string, string>;
  log?: (line: string) => void;
  now?: () => number;
  /** Seconds between attempts after a failure. */
  retryAfterMs?: number;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  missing: boolean;
}

const KEY_PARAMS = [
  "%no-protection",
  "Key-Type: eddsa",
  "Key-Curve: ed25519",
  "Key-Usage: sign",
  "Subkey-Type: ecdh",
  "Subkey-Curve: cv25519",
  "Subkey-Usage: encrypt",
  "Name-Real: ClawBox Vault",
  "Name-Email: vault@clawbox.invalid",
  "Expire-Date: 0",
  "%commit",
  "",
].join("\n");

/** The fingerprint of the first secret key in `gpg --with-colons` output. */
export function firstSecretFingerprint(colons: string): string | null {
  let inSecret = false;
  for (const line of colons.split("\n")) {
    const f = line.split(":");
    if (f[0] === "sec") inSecret = true;
    else if (f[0] === "fpr" && inSecret && /^[0-9A-F]{40}$/.test(f[9] ?? "")) return f[9]!;
  }
  return null;
}

export class StoreSetup {
  private status: StoreStatus = { ready: false };
  private inflight: Promise<StoreStatus> | null = null;
  private lastFailure = 0;
  private readonly now: () => number;
  private readonly retryAfterMs: number;

  constructor(private readonly opts: StoreSetupOptions) {
    this.now = opts.now ?? Date.now;
    this.retryAfterMs = opts.retryAfterMs ?? 15_000;
  }

  current(): StoreStatus {
    return { ...this.status };
  }

  /** Make the keyring and the store if they are not there. Safe to call on every request. */
  async ensure(): Promise<StoreStatus> {
    if (this.status.ready) return this.current();
    if (this.inflight) return this.inflight;
    if (this.lastFailure && this.now() - this.lastFailure < this.retryAfterMs) return this.current();
    this.inflight = this.setup()
      .then(
        (): StoreStatus => ({ ready: true }),
        (err): StoreStatus => ({ ready: false, error: err instanceof Error ? err.message : "the password store could not be prepared" }),
      )
      .then((status) => {
        this.status = status;
        this.lastFailure = status.ready ? 0 : this.now();
        this.inflight = null;
        this.opts.log?.(status.ready ? "password store ready" : `password store not ready: ${status.error}`);
        return this.current();
      });
    return this.inflight;
  }

  private env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, this.opts.env);
    env.GNUPGHOME = this.opts.gnupgHome;
    env.PASSWORD_STORE_DIR = this.opts.storeDir;
    env.PASSWORD_STORE_ENABLE_EXTENSIONS = "false";
    return env;
  }

  private async run(cmd: string[], stdin?: string): Promise<RunResult> {
    let proc;
    try {
      proc = Bun.spawn(cmd, { env: this.env(), stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
    } catch {
      return { code: 127, stdout: "", stderr: "", missing: true };
    }
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      await proc.stdin.end();
    }
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr, missing: false };
  }

  private fail(what: string, r: RunResult): never {
    // gpg and pass write no secret to stderr here (no entry is read or written
    // yet); the tail goes to the service log, a plain sentence to the caller.
    this.opts.log?.(`${what} failed (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`);
    throw new Error(`${what} failed`);
  }

  private async setup(): Promise<void> {
    const { gnupgHome, storeDir, passBin } = this.opts;
    mkdirSync(gnupgHome, { recursive: true, mode: 0o700 });
    chmodSync(gnupgHome, 0o700);

    let listed = await this.run(["gpg", "--batch", "--with-colons", "--list-secret-keys"]);
    if (listed.missing) throw new Error("gpg is not installed on this box");
    if (listed.code !== 0) this.fail("reading the vault keyring", listed);
    let fingerprint = firstSecretFingerprint(listed.stdout);

    const gpgId = join(storeDir, ".gpg-id");
    if (!fingerprint) {
      // A store with no key to read it is somebody's data: never paper over it
      // with a new key that cannot decrypt a single entry.
      if (existsSync(gpgId)) throw new Error("the password store is there but its key is missing from the vault keyring");
      const made = await this.run(["gpg", "--batch", "--quiet", "--generate-key"], KEY_PARAMS);
      if (made.code !== 0) this.fail("creating the vault key", made);
      listed = await this.run(["gpg", "--batch", "--with-colons", "--list-secret-keys"]);
      fingerprint = firstSecretFingerprint(listed.stdout);
      if (!fingerprint) throw new Error("creating the vault key failed");
      this.opts.log?.("created the vault key");
    }

    if (!existsSync(gpgId)) {
      const init = await this.run([passBin, "init", fingerprint]);
      if (init.missing) throw new Error("pass is not installed on this box");
      if (init.code !== 0) this.fail("creating the password store", init);
      this.opts.log?.("created the password store");
    } else {
      const want = readFileSync(gpgId, "utf8").split("\n")[0]!.trim();
      const known = await this.run(["gpg", "--batch", "--with-colons", "--list-secret-keys", "--", want]);
      if (known.code !== 0) throw new Error("the password store is there but its key is missing from the vault keyring");
    }

    if (!existsSync(join(storeDir, ".git"))) {
      const git = await this.run([passBin, "git", "init"]);
      if (git.missing) throw new Error("pass is not installed on this box");
      if (git.code !== 0) this.fail("starting the store's history", git);
    }
    chmodSync(storeDir, 0o700);
  }
}
