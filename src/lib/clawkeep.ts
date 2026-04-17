import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getAll } from "@/lib/config-store";

const exec = promisify(execFile);

const FILES_ROOT = path.resolve(process.env.FILES_ROOT ?? (process.env.HOME || "/home/clawbox"));
const CLAWKEEP_DIR = ".clawkeep";
const CONFIG_PATH = path.join(CLAWKEEP_DIR, "config.json");
const CLAWKEEP_CLOUD_SYNC_URL = process.env.CLAWKEEP_CLOUD_SYNC_URL?.trim() || "https://openclawhardware.dev/api/clawkeep/device-backups";
const DEFAULT_IGNORE = [
  "# ClawKeep ignore - patterns here are synced to .gitignore",
  "# Add anything you don't want versioned",
  "",
  "# Dependencies",
  "node_modules/",
  "vendor/",
  ".venv/",
  "__pycache__/",
  "*.pyc",
  "",
  "# Build output",
  "dist/",
  "build/",
  ".next/",
  "",
  "# Environment & secrets",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "",
  "# Logs & temp",
  "*.log",
  "tmp/",
  ".cache/",
  "",
  "# ClawKeep internals",
  ".clawkeep/config.json",
  ".clawkeep/ui.pid",
  ".clawkeep/ui.token",
  ".clawkeep/watch.pid",
  "",
].join("\n");
const GITIGNORE_MARKER_START = "# >>> clawkeep";
const GITIGNORE_MARKER_END = "# <<< clawkeep";

const MAGIC_CK01 = Buffer.from("CK01");
const MAGIC_CK02 = Buffer.from("CK02");
const SALT_LENGTH = 32;
const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;
const TAG_LENGTH = 16;
const ALGORITHM = "aes-256-gcm";
const CK01_HEADER_LENGTH = MAGIC_CK01.length + SALT_LENGTH + NONCE_LENGTH;
const CK02_HEADER_LENGTH = MAGIC_CK02.length + NONCE_LENGTH;
const CLAWBOX_AI_TOKEN_CONFIG_KEY = "clawai_token";

export interface ClawKeepLogEntry {
  hash: string;
  date: string;
  message: string;
}

export interface ClawKeepStatus {
  initialized: boolean;
  sourcePath: string;
  sourceAbsolutePath: string;
  sourceExists: boolean;
  backup: {
    mode: "local" | "cloud" | "both" | null;
    passwordSet: boolean;
    workspaceId: string | null;
    chunkCount: number;
    lastSync: string | null;
    lastSyncCommit: string | null;
    local: {
      enabled: boolean;
      path: string | null;
      lastSync: string | null;
      ready: boolean;
    };
    cloud: {
      enabled: boolean;
      connected: boolean;
      available: boolean;
      providerLabel: string;
      endpoint: string | null;
      lastSync: string | null;
    };
  };
  headCommit: string | null;
  trackedFiles: number;
  totalSnaps: number;
  dirtyFiles: number;
  clean: boolean;
  recent: ClawKeepLogEntry[];
}

interface BackupCloudConfig {
  enabled?: boolean;
  endpoint?: string | null;
  provider?: string | null;
  lastSync?: string | null;
}

interface BackupConfig {
  target?: string | null;
  local?: { path?: string | null } | null;
  cloud?: BackupCloudConfig | null;
  passwordHash?: string;
  wrappedKey?: string;
  workspaceId?: string | null;
  chunkCount?: number;
  lastSync?: string | null;
  lastSyncCommit?: string | null;
}

interface ClawKeepConfig {
  version: string;
  createdAt: string;
  remote: string | null;
  watchInterval: number;
  ignore: string[];
  backup?: BackupConfig;
}

interface ManifestChunk {
  id: string;
  type: "full" | "incremental";
  fromCommit: string | null;
  toCommit: string;
  commitCount: number;
  size: number;
  createdAt: string;
}

interface Manifest {
  version: number;
  workspaceId: string;
  createdAt: string;
  chunks: ManifestChunk[];
  lastSync: string | null;
  totalCommits: number;
  compactedAt: string | null;
}

interface ClawKeepSecrets {
  passwordHash?: string;
  encryptionKey?: string;
}

interface CloudAuthState {
  connected: boolean;
  token: string;
  providerLabel: string;
}

interface ConfigureTargetsInput {
  localPath?: string | null;
  cloudEnabled?: boolean;
  password?: string;
}

interface SyncOutcome {
  chunkCount: number;
  lastSync: string;
  lastSyncCommit: string;
}

function resolveManagedPath(relativePath: string): string {
  const normalized = relativePath.trim().replace(/^\/+/, "");
  const resolved = path.resolve(FILES_ROOT, normalized);
  if (resolved !== FILES_ROOT && !resolved.startsWith(FILES_ROOT + path.sep)) {
    throw new Error("Path must stay inside the device file area");
  }
  return resolved;
}

function toDisplayPath(relativePath: string): string {
  const normalized = relativePath.trim().replace(/^\/+/, "");
  return normalized ? path.join(FILES_ROOT, normalized) : FILES_ROOT;
}

function ensureDirectory(directory: string) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function configFilePath(sourceDir: string) {
  return path.join(sourceDir, CONFIG_PATH);
}

function ignoreFilePath(sourceDir: string) {
  return path.join(sourceDir, ".clawkeepignore");
}

function resolveGitDir(sourceDir: string) {
  const gitPath = path.join(sourceDir, ".git");
  if (fs.existsSync(gitPath) && fs.statSync(gitPath).isDirectory()) {
    return gitPath;
  }
  if (!fs.existsSync(gitPath)) {
    throw new Error("ClawKeep requires a git repository");
  }
  const contents = fs.readFileSync(gitPath, "utf8").trim();
  const prefix = "gitdir:";
  if (!contents.startsWith(prefix)) {
    throw new Error("Unable to resolve git directory for ClawKeep");
  }
  return path.resolve(sourceDir, contents.slice(prefix.length).trim());
}

function secretsFilePath(sourceDir: string) {
  return path.join(resolveGitDir(sourceDir), "clawkeep-secrets.json");
}

function sanitizeConfig(config: ClawKeepConfig): ClawKeepConfig {
  const next: ClawKeepConfig = {
    ...config,
    backup: config.backup ? {
      ...config.backup,
      local: config.backup.local ? { ...config.backup.local } : undefined,
      cloud: config.backup.cloud ? { ...config.backup.cloud } : undefined,
    } : undefined,
  };
  if (next.backup) {
    delete next.backup.passwordHash;
    delete next.backup.wrappedKey;
  }
  return next;
}

function loadConfig(sourceDir: string): ClawKeepConfig {
  const filePath = configFilePath(sourceDir);
  if (!fs.existsSync(filePath)) {
    throw new Error("ClawKeep is not initialized for this directory yet");
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as ClawKeepConfig;
}

function saveConfig(sourceDir: string, config: ClawKeepConfig) {
  ensureDirectory(path.join(sourceDir, CLAWKEEP_DIR));
  fs.writeFileSync(configFilePath(sourceDir), JSON.stringify(sanitizeConfig(config), null, 2));
}

function loadSecrets(sourceDir: string): ClawKeepSecrets | null {
  const filePath = secretsFilePath(sourceDir);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as ClawKeepSecrets;
}

function saveSecrets(sourceDir: string, secrets: ClawKeepSecrets) {
  const filePath = secretsFilePath(sourceDir);
  fs.writeFileSync(filePath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
}

async function runGit(sourceDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileSafe("git", args, sourceDir);
  return stdout;
}

async function execFileSafe(command: string, args: string[], cwd: string) {
  return await exec(command, args, {
    cwd,
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function isGitRepo(sourceDir: string): Promise<boolean> {
  try {
    const output = await runGit(sourceDir, ["rev-parse", "--is-inside-work-tree"]);
    return output.trim() === "true";
  } catch {
    return false;
  }
}

function syncIgnore(sourceDir: string) {
  const ignorePath = ignoreFilePath(sourceDir);
  if (!fs.existsSync(ignorePath)) {
    fs.writeFileSync(ignorePath, DEFAULT_IGNORE);
  }

  const desiredBlock = [
    GITIGNORE_MARKER_START,
    fs.readFileSync(ignorePath, "utf8").trimEnd(),
    GITIGNORE_MARKER_END,
    "",
  ].join("\n");
  const gitignorePath = path.join(sourceDir, ".gitignore");
  const current = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const markerPattern = new RegExp(`${GITIGNORE_MARKER_START}[\\s\\S]*?${GITIGNORE_MARKER_END}\\n?`, "g");
  const withoutManagedBlock = current.replace(markerPattern, "").trimEnd();
  const next = withoutManagedBlock ? `${withoutManagedBlock}\n\n${desiredBlock}` : desiredBlock;
  fs.writeFileSync(gitignorePath, next);
}

function parseStatus(output: string) {
  const lines = output.split("\n").filter(Boolean);
  return {
    dirtyFiles: lines.length,
    clean: lines.length === 0,
  };
}

async function getHeadCommit(sourceDir: string): Promise<string | null> {
  try {
    const output = await runGit(sourceDir, ["rev-parse", "HEAD"]);
    return output.trim() || null;
  } catch {
    return null;
  }
}

async function getTrackedFiles(sourceDir: string): Promise<number> {
  try {
    const output = await runGit(sourceDir, ["ls-files"]);
    return output.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function getTotalSnaps(sourceDir: string): Promise<number> {
  try {
    const output = await runGit(sourceDir, ["rev-list", "--count", "HEAD"]);
    return Number.parseInt(output.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function getRecentLog(sourceDir: string, limit = 8): Promise<ClawKeepLogEntry[]> {
  try {
    const output = await runGit(sourceDir, [
      "log",
      `--max-count=${limit}`,
      "--pretty=format:%H%x1f%aI%x1f%s",
    ]);
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, date, message] = line.split("\x1f");
        return { hash, date, message };
      });
  } catch {
    return [];
  }
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `$scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function deriveEncryptionKey(password: string) {
  const prk = crypto.createHmac("sha256", "clawkeep").update(password).digest();
  const info = Buffer.from("clawkeep-encryption");
  const t = crypto.createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
  return t.subarray(0, 32);
}

function unwrapKey(wrappedKeyBase64: string, passwordHash: string) {
  const hashBytes = Buffer.from(passwordHash.split("$")[3], "hex");
  const wrapped = Buffer.from(wrappedKeyBase64, "base64");
  const nonce = wrapped.subarray(0, NONCE_LENGTH);
  const tag = wrapped.subarray(wrapped.length - TAG_LENGTH);
  const encrypted = wrapped.subarray(NONCE_LENGTH, wrapped.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, hashBytes, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function encryptChunkWithKey(buffer: Buffer, key: Buffer) {
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC_CK02, nonce, encrypted, tag]);
}

function decryptChunk(encBuffer: Buffer, password: string | null, key: Buffer | null) {
  if (encBuffer.length < CK02_HEADER_LENGTH + TAG_LENGTH) {
    throw new Error("Invalid chunk: too small");
  }
  const magic = encBuffer.subarray(0, 4);
  if (magic.equals(MAGIC_CK02)) {
    if (!key) throw new Error("Missing encryption key");
    const nonce = encBuffer.subarray(4, 4 + NONCE_LENGTH);
    const tag = encBuffer.subarray(encBuffer.length - TAG_LENGTH);
    const encrypted = encBuffer.subarray(CK02_HEADER_LENGTH, encBuffer.length - TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }
  if (magic.equals(MAGIC_CK01)) {
    if (!password) throw new Error("Missing password");
    const salt = encBuffer.subarray(4, 4 + SALT_LENGTH);
    const nonce = encBuffer.subarray(4 + SALT_LENGTH, CK01_HEADER_LENGTH);
    const tag = encBuffer.subarray(encBuffer.length - TAG_LENGTH);
    const encrypted = encBuffer.subarray(CK01_HEADER_LENGTH, encBuffer.length - TAG_LENGTH);
    const derivedKey = crypto.scryptSync(password, salt, KEY_LENGTH, { N: 16384, r: 8, p: 1 });
    const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }
  throw new Error("Unknown chunk format");
}

async function createBundle(sourceDir: string, fromCommit: string | null) {
  const bundlePath = path.join(os.tmpdir(), `clawkeep-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.bundle`);
  const args = fromCommit
    ? ["bundle", "create", bundlePath, "HEAD", `^${fromCommit}`]
    : ["bundle", "create", bundlePath, "--all"];
  await runGit(sourceDir, args);
  return bundlePath;
}

async function countCommits(sourceDir: string, fromCommit: string | null, toCommit: string) {
  try {
    const range = fromCommit ? `${fromCommit}..${toCommit}` : toCommit;
    const output = await runGit(sourceDir, ["rev-list", "--count", range]);
    return Number.parseInt(output.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function hasNewCommits(sourceDir: string, fromCommit: string) {
  try {
    const output = await runGit(sourceDir, ["log", "--oneline", `${fromCommit}..HEAD`]);
    return output.trim().length > 0;
  } catch {
    return true;
  }
}

function manifestPath(targetDir: string, workspaceId: string) {
  return path.join(targetDir, workspaceId, "manifest.enc");
}

function readManifest(targetDir: string, workspaceId: string, password: string | null, key: Buffer | null): Manifest | null {
  const filePath = manifestPath(targetDir, workspaceId);
  if (!fs.existsSync(filePath)) return null;
  const decrypted = decryptChunk(fs.readFileSync(filePath), password, key);
  return JSON.parse(decrypted.toString("utf8")) as Manifest;
}

function writeManifest(targetDir: string, workspaceId: string, manifest: Manifest, password: string | null, key: Buffer | null) {
  const workspaceDir = path.join(targetDir, workspaceId);
  ensureDirectory(workspaceDir);
  const payload = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  const encrypted = key ? encryptChunkWithKey(payload, key) : Buffer.from(payload);
  fs.writeFileSync(path.join(workspaceDir, "manifest.enc"), encrypted);
}

function resolveBackupSecrets(sourceDir: string, config: ClawKeepConfig) {
  const externalSecrets = loadSecrets(sourceDir);
  if (externalSecrets?.passwordHash && externalSecrets.encryptionKey) {
    return {
      passwordHash: externalSecrets.passwordHash,
      key: Buffer.from(externalSecrets.encryptionKey, "base64"),
    };
  }

  const legacyPasswordHash = config.backup?.passwordHash;
  const legacyWrappedKey = config.backup?.wrappedKey;
  if (!legacyPasswordHash || !legacyWrappedKey) {
    return null;
  }

  const key = unwrapKey(legacyWrappedKey, legacyPasswordHash);
  saveSecrets(sourceDir, {
    passwordHash: legacyPasswordHash,
    encryptionKey: key.toString("base64"),
  });
  if (config.backup) {
    delete config.backup.passwordHash;
    delete config.backup.wrappedKey;
    saveConfig(sourceDir, config);
  }
  return { passwordHash: legacyPasswordHash, key };
}

function resolveBackupMode(backup: BackupConfig | undefined): "local" | "cloud" | "both" | null {
  const hasLocal = !!backup?.local?.path;
  const hasCloud = !!backup?.cloud?.enabled;
  if (hasLocal && hasCloud) return "both";
  if (hasLocal) return "local";
  if (hasCloud) return "cloud";
  return null;
}

async function getCloudAuthState(): Promise<CloudAuthState> {
  const config = await getAll().catch(() => ({} as Record<string, unknown>));
  const token = typeof config[CLAWBOX_AI_TOKEN_CONFIG_KEY] === "string"
    ? config[CLAWBOX_AI_TOKEN_CONFIG_KEY].trim()
    : "";
  return {
    connected: token.length > 0,
    token,
    providerLabel: "ClawBox AI",
  };
}

function resolveConfigForSync(sourceDir: string) {
  const config = loadConfig(sourceDir);
  const backup = config.backup ?? {};
  const hasLocal = !!backup.local?.path;
  const hasCloud = !!backup.cloud?.enabled;
  if (!hasLocal && !hasCloud) {
    throw new Error("Choose at least one backup destination first");
  }
  const secrets = resolveBackupSecrets(sourceDir, config);
  if (!secrets?.key) {
    throw new Error("Set an encryption password first");
  }
  return { config, backup, key: secrets.key };
}

async function createEncryptedChunkFile(sourcePath: string, key: Buffer) {
  const destinationPath = path.join(os.tmpdir(), `clawkeep-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.enc`);
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(sourcePath);
    const cipher = crypto.createCipheriv(ALGORITHM, key, nonce);
    const output = fs.createWriteStream(destinationPath);
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      input.destroy();
      cipher.destroy();
      output.destroy();
      reject(error);
    };

    input.on("error", fail);
    cipher.on("error", fail);
    output.on("error", fail);

    output.write(Buffer.concat([MAGIC_CK02, nonce]), (headerError) => {
      if (headerError) {
        fail(headerError);
        return;
      }
      cipher.pipe(output, { end: false });
      input.pipe(cipher);
    });

    cipher.on("end", () => {
      if (settled) return;
      output.write(cipher.getAuthTag(), (tagError) => {
        if (tagError) {
          fail(tagError);
          return;
        }
        output.end(() => {
          if (settled) return;
          settled = true;
          resolve();
        });
      });
    });
  });

  return {
    path: destinationPath,
    size: fs.statSync(destinationPath).size,
  };
}

function ensureSourceAndTargetAreSeparate(sourceDir: string, targetDir: string) {
  if (sourceDir === targetDir) {
    throw new Error("Source and backup target must be different directories");
  }
  if (sourceDir.startsWith(targetDir + path.sep) || targetDir.startsWith(sourceDir + path.sep)) {
    throw new Error("Source and backup target cannot be nested inside each other");
  }
}

function buildManifest(base: Manifest | null, workspaceId: string) {
  return base ?? {
    version: 1,
    workspaceId,
    createdAt: new Date().toISOString(),
    chunks: [],
    lastSync: null,
    totalCommits: 0,
    compactedAt: null,
  };
}

function applyManifestChunk(
  manifest: Manifest,
  chunkId: string,
  headCommit: string,
  lastSyncCommit: string | null,
  commitCount: number,
  encryptedSize: number,
) {
  const createdAt = new Date().toISOString();
  manifest.chunks.push({
    id: chunkId,
    type: manifest.chunks.length === 0 ? "full" : "incremental",
    fromCommit: manifest.chunks.length === 0 ? null : lastSyncCommit,
    toCommit: headCommit,
    commitCount,
    size: encryptedSize,
    createdAt,
  });
  manifest.lastSync = createdAt;
  manifest.totalCommits += commitCount;
}

async function syncToLocalTarget(targetDir: string, workspaceId: string, chunkId: string, encryptedChunkPath: string, encryptedSize: number, key: Buffer, headCommit: string, lastSyncCommit: string | null, commitCount: number): Promise<SyncOutcome> {
  const existingManifest = readManifest(targetDir, workspaceId, null, key);
  const manifest = buildManifest(existingManifest, workspaceId);
  const workspaceDir = path.join(targetDir, workspaceId);
  ensureDirectory(workspaceDir);
  fs.copyFileSync(encryptedChunkPath, path.join(workspaceDir, chunkId));
  applyManifestChunk(manifest, chunkId, headCommit, lastSyncCommit, commitCount, encryptedSize);
  writeManifest(targetDir, workspaceId, manifest, null, key);
  return {
    chunkCount: manifest.chunks.length,
    lastSync: manifest.lastSync ?? new Date().toISOString(),
    lastSyncCommit: headCommit,
  };
}

async function syncToCloudTarget({
  sourcePath,
  workspaceId,
  chunkId,
  encryptedChunkPath,
  encryptedSize,
  headCommit,
  lastSyncCommit,
  commitCount,
  endpoint,
  token,
}: {
  sourcePath: string;
  workspaceId: string;
  chunkId: string;
  encryptedChunkPath: string;
  encryptedSize: number;
  headCommit: string;
  lastSyncCommit: string | null;
  commitCount: number;
  endpoint: string;
  token: string;
}) {
  if (!token) {
    throw new Error("Connect ClawBox AI before turning on cloud backup");
  }
  if (!endpoint) {
    throw new Error("Cloud backup endpoint is not configured on this device");
  }

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error("Cloud backup failed: invalid endpoint configuration");
  }
  if (!["http:", "https:"].includes(parsedEndpoint.protocol)) {
    throw new Error("Cloud backup failed: invalid endpoint configuration");
  }

  const manifest = buildManifest(null, workspaceId);
  applyManifestChunk(manifest, chunkId, headCommit, lastSyncCommit, commitCount, encryptedSize);
  const payload = new FormData();
  payload.set("workspaceId", workspaceId);
  payload.set("chunkId", chunkId);
  payload.set("sourcePath", sourcePath);
  payload.set("manifest", JSON.stringify(manifest));
  const maybeFsWithBlob = fs as typeof fs & {
    openAsBlob?: (filePath: string, options?: { type?: string }) => Promise<Blob>;
  };
  const chunkBlob = typeof maybeFsWithBlob.openAsBlob === "function"
    ? await maybeFsWithBlob.openAsBlob(encryptedChunkPath, { type: "application/octet-stream" })
    : new Blob([fs.readFileSync(encryptedChunkPath)]);
  payload.set("chunk", chunkBlob, chunkId);

  const response = await fetch(parsedEndpoint.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-ClawKeep-Workspace": workspaceId,
    },
    body: payload,
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    console.error("Cloud backup error response:", response.status, bodyText);
    throw new Error(`Cloud backup failed (${response.status})`);
  }

  return {
    chunkCount: manifest.chunks.length,
    lastSync: manifest.lastSync ?? new Date().toISOString(),
    lastSyncCommit: headCommit,
  };
}

export async function getClawKeepStatus(relativeSourcePath: string): Promise<ClawKeepStatus> {
  const sourceDir = resolveManagedPath(relativeSourcePath);
  const sourceExists = fs.existsSync(sourceDir) && fs.statSync(sourceDir).isDirectory();
  const cloudAuth = await getCloudAuthState();
  if (!sourceExists) {
    return {
      initialized: false,
      sourcePath: relativeSourcePath,
      sourceAbsolutePath: toDisplayPath(relativeSourcePath),
      sourceExists: false,
      backup: {
        mode: null,
        passwordSet: false,
        workspaceId: null,
        chunkCount: 0,
        lastSync: null,
        lastSyncCommit: null,
        local: { enabled: false, path: null, lastSync: null, ready: false },
        cloud: {
          enabled: false,
          connected: cloudAuth.connected,
          available: !!CLAWKEEP_CLOUD_SYNC_URL,
          providerLabel: cloudAuth.providerLabel,
          endpoint: CLAWKEEP_CLOUD_SYNC_URL || null,
          lastSync: null,
        },
      },
      headCommit: null,
      trackedFiles: 0,
      totalSnaps: 0,
      dirtyFiles: 0,
      clean: true,
      recent: [],
    };
  }

  const initialized = fs.existsSync(configFilePath(sourceDir));
  if (!initialized) {
    return {
      initialized: false,
      sourcePath: relativeSourcePath,
      sourceAbsolutePath: sourceDir,
      sourceExists: true,
      backup: {
        mode: null,
        passwordSet: false,
        workspaceId: null,
        chunkCount: 0,
        lastSync: null,
        lastSyncCommit: null,
        local: { enabled: false, path: null, lastSync: null, ready: false },
        cloud: {
          enabled: false,
          connected: cloudAuth.connected,
          available: !!CLAWKEEP_CLOUD_SYNC_URL,
          providerLabel: cloudAuth.providerLabel,
          endpoint: CLAWKEEP_CLOUD_SYNC_URL || null,
          lastSync: null,
        },
      },
      headCommit: null,
      trackedFiles: 0,
      totalSnaps: 0,
      dirtyFiles: 0,
      clean: true,
      recent: [],
    };
  }

  const config = loadConfig(sourceDir);
  const backup = config.backup ?? {};
  const secrets = resolveBackupSecrets(sourceDir, config);
  const rawStatus = await runGit(sourceDir, ["status", "--porcelain"]).catch(() => "");
  const parsedStatus = parseStatus(rawStatus);
  const mode = resolveBackupMode(backup);

  return {
    initialized: true,
    sourcePath: relativeSourcePath,
    sourceAbsolutePath: sourceDir,
    sourceExists: true,
    backup: {
      mode,
      passwordSet: !!secrets?.passwordHash,
      workspaceId: backup.workspaceId ?? null,
      chunkCount: backup.chunkCount ?? 0,
      lastSync: backup.lastSync ?? null,
      lastSyncCommit: backup.lastSyncCommit ?? null,
      local: {
        enabled: !!backup.local?.path,
        path: backup.local?.path ?? null,
        lastSync: backup.lastSync ?? null,
        ready: !!backup.local?.path && !!secrets?.key,
      },
      cloud: {
        enabled: !!backup.cloud?.enabled,
        connected: cloudAuth.connected,
        available: !!CLAWKEEP_CLOUD_SYNC_URL,
        providerLabel: cloudAuth.providerLabel,
        endpoint: backup.cloud?.endpoint ?? (CLAWKEEP_CLOUD_SYNC_URL || null),
        lastSync: backup.cloud?.lastSync ?? null,
      },
    },
    headCommit: await getHeadCommit(sourceDir),
    trackedFiles: await getTrackedFiles(sourceDir),
    totalSnaps: await getTotalSnaps(sourceDir),
    dirtyFiles: parsedStatus.dirtyFiles,
    clean: parsedStatus.clean,
    recent: await getRecentLog(sourceDir),
  };
}

export async function initClawKeep(relativeSourcePath: string) {
  const sourceDir = resolveManagedPath(relativeSourcePath);
  ensureDirectory(sourceDir);

  if (fs.existsSync(configFilePath(sourceDir))) {
    throw new Error("ClawKeep is already initialized for this directory");
  }

  ensureDirectory(path.join(sourceDir, CLAWKEEP_DIR));

  if (!(await isGitRepo(sourceDir))) {
    await runGit(sourceDir, ["init"]);
    await runGit(sourceDir, ["checkout", "-b", "main"]).catch(() => {});
  }

  await runGit(sourceDir, ["config", "user.name", "ClawKeep"]);
  await runGit(sourceDir, ["config", "user.email", "backup@clawkeep.local"]);

  const config: ClawKeepConfig = {
    version: "0.2.0",
    createdAt: new Date().toISOString(),
    remote: null,
    watchInterval: 5000,
    ignore: [],
    backup: {
      target: null,
      local: { path: null },
      cloud: { enabled: false, endpoint: CLAWKEEP_CLOUD_SYNC_URL, provider: "clawai", lastSync: null },
      chunkCount: 0,
      lastSync: null,
      lastSyncCommit: null,
      workspaceId: null,
    },
  };
  saveConfig(sourceDir, config);
  syncIgnore(sourceDir);

  await snapClawKeep(relativeSourcePath, "initial backup");
  return await getClawKeepStatus(relativeSourcePath);
}

export async function configureClawKeepTargets(relativeSourcePath: string, input: ConfigureTargetsInput) {
  const sourceDir = resolveManagedPath(relativeSourcePath);
  const config = loadConfig(sourceDir);
  if (!config.backup) config.backup = {};
  const existingSecrets = resolveBackupSecrets(sourceDir, config);
  const trimmedPassword = input.password?.trim() ?? "";
  const trimmedLocalPath = input.localPath?.trim() ?? "";
  const localEnabled = trimmedLocalPath.length > 0;
  const cloudEnabled = !!input.cloudEnabled;

  if (!localEnabled && !cloudEnabled) {
    throw new Error("Choose a local folder, cloud backup, or both");
  }
  if (trimmedPassword && trimmedPassword.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  if (!trimmedPassword && !existingSecrets?.passwordHash) {
    throw new Error("Password must be at least 8 characters");
  }

  if (localEnabled) {
    const targetDir = resolveManagedPath(trimmedLocalPath);
    ensureSourceAndTargetAreSeparate(sourceDir, targetDir);
    ensureDirectory(targetDir);
    config.backup.local = { path: targetDir };
  } else {
    config.backup.local = { path: null };
  }

  config.backup.cloud = {
    enabled: cloudEnabled,
    endpoint: CLAWKEEP_CLOUD_SYNC_URL,
    provider: "clawai",
    lastSync: config.backup.cloud?.lastSync ?? null,
  };
  config.backup.target = resolveBackupMode(config.backup);
  config.backup.workspaceId = config.backup.workspaceId || `${path.basename(sourceDir)}-${crypto.randomBytes(4).toString("hex")}`;
  saveConfig(sourceDir, config);

  if (trimmedPassword) {
    saveSecrets(sourceDir, {
      passwordHash: hashPassword(trimmedPassword),
      encryptionKey: deriveEncryptionKey(trimmedPassword).toString("base64"),
    });
  } else if (existingSecrets) {
    saveSecrets(sourceDir, existingSecrets);
  }

  return await getClawKeepStatus(relativeSourcePath);
}

export async function configureClawKeepLocalTarget(relativeSourcePath: string, relativeTargetPath: string, password: string) {
  return await configureClawKeepTargets(relativeSourcePath, {
    localPath: relativeTargetPath,
    cloudEnabled: false,
    password,
  });
}

export async function snapClawKeep(relativeSourcePath: string, message?: string) {
  const sourceDir = resolveManagedPath(relativeSourcePath);
  syncIgnore(sourceDir);
  await runGit(sourceDir, ["add", "-A", "--", ".", ":(exclude).clawkeep/config.json"]);
  const status = await runGit(sourceDir, ["status", "--porcelain"]);
  if (!status.trim()) {
    return {
      ok: true,
      changed: false,
      message: "No changes to snapshot",
      status: await getClawKeepStatus(relativeSourcePath),
    };
  }

  const commitMessage = message?.trim() || "snapshot";
  await runGit(sourceDir, ["commit", "-m", commitMessage]);
  return {
    ok: true,
    changed: true,
    message: `Snapshot created: ${commitMessage}`,
    status: await getClawKeepStatus(relativeSourcePath),
  };
}

export async function syncClawKeep(relativeSourcePath: string) {
  const sourceDir = resolveManagedPath(relativeSourcePath);
  const { config, backup, key } = resolveConfigForSync(sourceDir);
  const cloudAuth = await getCloudAuthState();
  const workspaceId = backup.workspaceId || `${path.basename(sourceDir)}-${crypto.randomBytes(4).toString("hex")}`;
  const headCommit = await getHeadCommit(sourceDir);
  if (!headCommit) {
    throw new Error("No commits available to sync yet");
  }

  const lastSyncCommit = backup.lastSyncCommit ?? null;
  if (lastSyncCommit && lastSyncCommit === headCommit) {
    return {
      ok: true,
      synced: false,
      message: "Already up to date",
      status: await getClawKeepStatus(relativeSourcePath),
    };
  }

  if (lastSyncCommit && !(await hasNewCommits(sourceDir, lastSyncCommit))) {
    return {
      ok: true,
      synced: false,
      message: "Already up to date",
      status: await getClawKeepStatus(relativeSourcePath),
    };
  }

  const commitCount = await countCommits(sourceDir, lastSyncCommit, headCommit);
  const chunkId = `chunk-${String((backup.chunkCount ?? 0) + 1).padStart(6, "0")}.enc`;
  const bundlePath = await createBundle(sourceDir, lastSyncCommit);
  let encryptedChunk: { path: string; size: number } | null = null;
  const destinations: string[] = [];
  const warnings: string[] = [];
  let lastSyncAt = new Date().toISOString();

  try {
    encryptedChunk = await createEncryptedChunkFile(bundlePath, key);

    if (backup.local?.path) {
      const localOutcome = await syncToLocalTarget(
        backup.local.path,
        workspaceId,
        chunkId,
        encryptedChunk.path,
        encryptedChunk.size,
        key,
        headCommit,
        lastSyncCommit,
        commitCount,
      );
      lastSyncAt = localOutcome.lastSync;
      destinations.push("local");
    }

    if (backup.cloud?.enabled) {
      try {
        const cloudOutcome = await syncToCloudTarget({
          sourcePath: relativeSourcePath,
          workspaceId,
          chunkId,
          encryptedChunkPath: encryptedChunk.path,
          encryptedSize: encryptedChunk.size,
          headCommit,
          lastSyncCommit,
          commitCount,
          endpoint: backup.cloud.endpoint?.trim() || CLAWKEEP_CLOUD_SYNC_URL,
          token: cloudAuth.token,
        });
        config.backup ??= {};
        config.backup.cloud = {
          ...(config.backup.cloud ?? {}),
          enabled: true,
          endpoint: backup.cloud.endpoint?.trim() || CLAWKEEP_CLOUD_SYNC_URL,
          provider: "clawai",
          lastSync: cloudOutcome.lastSync,
        };
        lastSyncAt = cloudOutcome.lastSync;
        destinations.push("cloud");
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : "Cloud backup failed");
      }
    }
  } finally {
    try {
      fs.unlinkSync(bundlePath);
    } catch {
      // Ignore temp bundle cleanup failures.
    }
    if (encryptedChunk?.path) {
      try {
        fs.unlinkSync(encryptedChunk.path);
      } catch {
        // Ignore encrypted temp cleanup failures.
      }
    }
  }

  if (destinations.length === 0) {
    throw new Error(warnings[0] ?? "No backup destination completed successfully");
  }

  config.backup ??= {};
  config.backup.workspaceId = workspaceId;
  config.backup.chunkCount = (config.backup.chunkCount ?? 0) + 1;
  config.backup.lastSync = lastSyncAt;
  config.backup.lastSyncCommit = headCommit;
  config.backup.target = resolveBackupMode(config.backup);
  saveConfig(sourceDir, config);

  const warningSuffix = warnings.length > 0 ? ` Cloud warning: ${warnings.join(" ")}` : "";
  return {
    ok: true,
    synced: true,
    message: `Backed up to ${destinations.join(" + ")}.${warningSuffix}`.trim(),
    status: await getClawKeepStatus(relativeSourcePath),
  };
}
