// A throwaway GnuPG home with a fresh key and a throwaway git-tracked pass
// store under the system temp dir. Tests never touch ~/.password-store or the
// user's keyring: every pass/gpg call gets PASSWORD_STORE_DIR and GNUPGHOME
// pointing here.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const PASS_BIN = (() => {
  const local = join(homedir(), ".local/bin/pass");
  return Bun.which("pass") ?? local;
})();

export interface TempStore {
  root: string;
  gnupgHome: string;
  storeDir: string;
  configDir: string;
  /** Environment for pass/gpg/git child processes. */
  env: Record<string, string>;
  cleanup(): void;
}

function run(cmd: string[], env: Record<string, string>, stdin?: string): string {
  const r = Bun.spawnSync(cmd, { env, stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr.toString().slice(0, 400)}`);
  return r.stdout.toString();
}

export function createTempStore(): TempStore {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cbv-")));
  const gnupgHome = join(root, "gnupg");
  const storeDir = join(root, "store");
  const configDir = join(root, "config");
  const real = join(homedir(), ".password-store");
  if (storeDir.startsWith(real) || !storeDir.startsWith(realpathSync(tmpdir()))) {
    throw new Error("refusing to use a store outside the temp dir");
  }
  run(["mkdir", "-m", "700", gnupgHome], { PATH: process.env.PATH ?? "" });

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    GNUPGHOME: gnupgHome,
    PASSWORD_STORE_DIR: storeDir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Vault Test",
    GIT_AUTHOR_EMAIL: "vault-test@example.invalid",
    GIT_COMMITTER_NAME: "Vault Test",
    GIT_COMMITTER_EMAIL: "vault-test@example.invalid",
  };

  const params = join(root, "keyparams");
  writeFileSync(
    params,
    [
      "%no-protection",
      "Key-Type: eddsa",
      "Key-Curve: ed25519",
      "Key-Usage: sign",
      "Subkey-Type: ecdh",
      "Subkey-Curve: cv25519",
      "Subkey-Usage: encrypt",
      "Name-Real: Vault Test",
      "Name-Email: vault-test@example.invalid",
      "Expire-Date: 0",
      "%commit",
      "",
    ].join("\n"),
  );
  run(["gpg", "--batch", "--quiet", "--gen-key", params], env);
  const colons = run(["gpg", "--batch", "--with-colons", "--list-keys", "vault-test@example.invalid"], env);
  const fpr = /^fpr:+([0-9A-F]{40}):/m.exec(colons)?.[1];
  if (!fpr) throw new Error("no fingerprint for the test key");

  run([PASS_BIN, "init", fpr], env);
  run([PASS_BIN, "git", "init"], env);

  return {
    root,
    gnupgHome,
    storeDir,
    configDir,
    env,
    cleanup() {
      Bun.spawnSync(["gpgconf", "--kill", "gpg-agent"], { env, stdout: "ignore", stderr: "ignore" });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Exit code of `pass show <name>` in the temp store; output is discarded. */
export function passShowExitCode(store: TempStore, name: string): number {
  return Bun.spawnSync([PASS_BIN, "show", "--", name], { env: store.env, stdout: "ignore", stderr: "ignore" }).exitCode;
}

export function passShow(store: TempStore, name: string): string {
  return run([PASS_BIN, "show", "--", name], store.env);
}

export function gitLog(store: TempStore): string {
  return run(["git", "-C", store.storeDir, "log", "--format=%s"], store.env);
}
