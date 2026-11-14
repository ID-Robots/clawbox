import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface VaultConfig {
  host: string;
  port: number;
  /** Base path the ClawBox desktop serves the app under, with trailing slash. */
  basePath: string;
  /** The vault's own folder (mode 700): store, keyring, state and the built extension. */
  homeDir: string;
  /** pass store directory (PASSWORD_STORE_DIR). */
  storeDir: string;
  /** The vault's own GnuPG home (GNUPGHOME); never the user's keyring. */
  gnupgHome: string;
  /** pass binary. */
  passBin: string;
  /** Holds state.json, agent-token and audit.jsonl (mode 700). */
  configDir: string;
  /** Where the service builds the extension the box's browser loads. */
  extensionDir: string;
  /** Environment for pass/gpg/git: the vault's keyring and a commit identity. */
  passEnv: Record<string, string>;
  /** Root of the vault sources (this folder's parent's parent). */
  repoDir: string;
  /** Payment cards: off unless CLAWBOX_VAULT_CARDS=1. Off means no card route, tool or screen. */
  cards: boolean;
  /** How long an agent fill waits for the extension, in ms. */
  fillTimeoutMs: number;
  /** How long an agent card fill waits for the human to confirm it in the browser, in ms. */
  cardConfirmMs: number;
  /** Long-poll hold time for the extension, in ms. */
  pollWaitMs: number;
  /** Extra Host header names accepted besides loopback and LAN-style names. */
  allowedHosts: string[];
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export const REPO_DIR = resolve(import.meta.dir, "../..");

/** The identity pass uses for the store's git history. Nobody's address. */
export const STORE_GIT_IDENTITY = { name: "ClawBox Vault", email: "vault@clawbox.invalid" } as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): VaultConfig {
  const host = env.CLAWBOX_VAULT_HOST || "127.0.0.1";
  if (!LOOPBACK.has(host)) {
    throw new Error(`CLAWBOX_VAULT_HOST must be a loopback address, got ${host}`);
  }
  const port = Number(env.CLAWBOX_VAULT_PORT || env.PORT || 4796);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CLAWBOX_VAULT_PORT is invalid");
  let basePath = env.CLAWBOX_VAULT_BASE || "/apps/clawbox-vault/";
  if (!basePath.startsWith("/")) basePath = `/${basePath}`;
  if (!basePath.endsWith("/")) basePath = `${basePath}/`;
  const homeDir = env.CLAWBOX_VAULT_HOME || join(env.HOME || homedir(), ".clawbox-vault");
  const gnupgHome = env.CLAWBOX_VAULT_GNUPGHOME || join(homeDir, "gnupg");
  return {
    host,
    port,
    basePath,
    homeDir,
    storeDir: env.CLAWBOX_VAULT_STORE_DIR || join(homeDir, "store"),
    gnupgHome,
    passBin: env.CLAWBOX_VAULT_PASS_BIN || "pass",
    configDir: env.CLAWBOX_VAULT_CONFIG_DIR || homeDir,
    extensionDir: env.CLAWBOX_VAULT_EXTENSION_DIR || join(homeDir, "extension"),
    passEnv: {
      GNUPGHOME: gnupgHome,
      GIT_AUTHOR_NAME: STORE_GIT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: STORE_GIT_IDENTITY.email,
      GIT_COMMITTER_NAME: STORE_GIT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: STORE_GIT_IDENTITY.email,
    },
    repoDir: REPO_DIR,
    cards: env.CLAWBOX_VAULT_CARDS === "1",
    fillTimeoutMs: Number(env.CLAWBOX_VAULT_FILL_TIMEOUT_MS || 20_000),
    // Stays below the server's 120 s idle timeout together with the fill timeout.
    cardConfirmMs: Math.min(90_000, Math.max(5_000, Number(env.CLAWBOX_VAULT_CARD_CONFIRM_MS) || 60_000)),
    pollWaitMs: Number(env.CLAWBOX_VAULT_POLL_WAIT_MS || 25_000),
    allowedHosts: (env.CLAWBOX_VAULT_ALLOWED_HOSTS || "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  };
}
