import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

const FILES_ROOT = path.resolve(process.env.FILES_ROOT ?? (process.env.HOME || "/home/clawbox"));
const CLAWKEEP_DIR = ".clawkeep";
const CONFIG_PATH = path.join(CLAWKEEP_DIR, "config.json");
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
    target: string | null;
    targetLabel: string;
    passwordSet: boolean;
    wrappedKeySet: boolean;
    workspaceId: string | null;
    chunkCount: number;
    lastSync: string | null;
    lastSyncCommit: string | null;
  };
  headCommit: string | null;
  trackedFiles: number;
  totalSnaps: number;
  dirtyFiles: number;
  clean: boolean;
  recent: ClawKeepLogEntry[];
}

interface BackupConfig {
  target?: string | null;
  local?: { path?: string | null } | null;
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
    backup: config.backup ? { ...config.backup } : undefined,
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

function encryptChunk(buffer: Buffer, password: string) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const key = crypto.scryptSync(password, salt, KEY_LENGTH, { N: 16384, r: 8, p: 1 });
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC_CK01, salt, nonce, encrypted, tag]);
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
  const encrypted = key ? encryptChunkWithKey(payload, key) : encryptChunk(payload, password!);
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

function resolveConfigForSync(
  sourceDir: string,
  getKey: (config: ClawKeepConfig) => Buffer | null = (config) => resolveBackupSecrets(sourceDir, config)?.key ?? null,
) {
  const config = loadConfig(sourceDir);
  const backup = config.backup ?? {};
  if (backup.target !== "local" || !backup.local?.path) {
    throw new Error("Configure a local backup target first");
  }
  const key = getKey(config);
  if (!key) {
    throw new Error("Set an encryption password first");
  }
  return { config, backup, key };
}

async function writeEncryptedChunkFromFile(sourcePath: string, destinationPath: string, key: Buffer) {
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  ensureDirectory(path.dirname(destinationPath));

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
      const tag = cipher.getAuthTag();
      output.write(tag, (writeError) => {
        if (writeError) {
          fail(writeError);
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

  return fs.statSync(destinationPath).size;
}

function ensureSourceAndTargetAreSeparate(sourceDir: string, targetDir: string) {
  if (sourceDir === targetDir) {
    throw new Error("Source and backup target must be different directories");
  }
  if (sourceDir.startsWith(targetDir + path.sep) || targetDir.startsWith(sourceDir + path.sep)) {
    throw new Error("Source and backup target cannot be nested inside each other");
  }
}

export async function getClawKeepStatus(relativeSourcePath: string): Promise<ClawKeepStatus> {
  const sourceDir = resolveManagedPath(relativeSourcePath);
  const sourceExists = fs.existsSync(sourceDir) && fs.statSync(sourceDir).isDirectory();
  if (!sourceExists) {
    return {
      initialized: false,
      sourcePath: relativeSourcePath,
      sourceAbsolutePath: toDisplayPath(relativeSourcePath),
      sourceExists: false,
      backup: {
        target: null,
        targetLabel: "Not configured",
        passwordSet: false,
        wrappedKeySet: false,
        workspaceId: null,
        chunkCount: 0,
        lastSync: null,
        lastSyncCommit: null,
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
        target: null,
        targetLabel: "Not configured",
        passwordSet: false,
        wrappedKeySet: false,
        workspaceId: null,
        chunkCount: 0,
        lastSync: null,
        lastSyncCommit: null,
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

  return {
    initialized: true,
    sourcePath: relativeSourcePath,
    sourceAbsolutePath: sourceDir,
    sourceExists: true,
    backup: {
      target: backup.target ?? null,
      targetLabel: backup.target === "local" && backup.local?.path
        ? backup.local.path
        : "Not configured",
      passwordSet: !!secrets?.passwordHash,
      wrappedKeySet: !!secrets?.key,
      workspaceId: backup.workspaceId ?? null,
      chunkCount: backup.chunkCount ?? 0,
      lastSync: backup.lastSync ?? null,
      lastSyncCommit: backup.lastSyncCommit ?? null,
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
    version: "0.1.0",
    createdAt: new Date().toISOString(),
    remote: null,
    watchInterval: 5000,
    ignore: [],
    backup: {
      target: null,
      local: { path: null },
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

export async function configureClawKeepLocalTarget(relativeSourcePath: string, relativeTargetPath: string, password: string) {
  const sourceDir = resolveManagedPath(relativeSourcePath);
  const targetDir = resolveManagedPath(relativeTargetPath);
  ensureSourceAndTargetAreSeparate(sourceDir, targetDir);
  ensureDirectory(targetDir);

  const config = loadConfig(sourceDir);
  if (!config.backup) config.backup = {};
  const workspaceId = config.backup.workspaceId || `${path.basename(sourceDir)}-${crypto.randomBytes(4).toString("hex")}`;

  config.backup.target = "local";
  config.backup.local = { path: targetDir };
  config.backup.workspaceId = workspaceId;
  saveConfig(sourceDir, config);

  saveSecrets(sourceDir, {
    passwordHash: hashPassword(password),
    encryptionKey: deriveEncryptionKey(password).toString("base64"),
  });

  return await getClawKeepStatus(relativeSourcePath);
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
  const targetDir = backup.local?.path!;
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

  const manifest = readManifest(targetDir, workspaceId, null, key) ?? {
    version: 1,
    workspaceId,
    createdAt: new Date().toISOString(),
    chunks: [],
    lastSync: null,
    totalCommits: 0,
    compactedAt: null,
  };

  const chunkId = `chunk-${String(manifest.chunks.length + 1).padStart(6, "0")}.enc`;
  const workspaceDir = path.join(targetDir, workspaceId);
  ensureDirectory(workspaceDir);

  const bundlePath = await createBundle(sourceDir, manifest.chunks.length === 0 ? null : lastSyncCommit);
  let encryptedSize = 0;
  try {
    encryptedSize = await writeEncryptedChunkFromFile(bundlePath, path.join(workspaceDir, chunkId), key);
  } finally {
    try {
      fs.unlinkSync(bundlePath);
    } catch {
      // Ignore temp bundle cleanup failures.
    }
  }

  const commitCount = await countCommits(sourceDir, manifest.chunks.length === 0 ? null : lastSyncCommit, headCommit);
  manifest.chunks.push({
    id: chunkId,
    type: manifest.chunks.length === 0 ? "full" : "incremental",
    fromCommit: manifest.chunks.length === 0 ? null : lastSyncCommit,
    toCommit: headCommit,
    commitCount,
    size: encryptedSize,
    createdAt: new Date().toISOString(),
  });
  manifest.lastSync = new Date().toISOString();
  manifest.totalCommits += commitCount;
  writeManifest(targetDir, workspaceId, manifest, null, key);

  if (!config.backup) config.backup = {};
  config.backup.workspaceId = workspaceId;
  config.backup.chunkCount = manifest.chunks.length;
  config.backup.lastSync = manifest.lastSync;
  config.backup.lastSyncCommit = headCommit;
  saveConfig(sourceDir, config);

  return {
    ok: true,
    synced: true,
    message: `Synced ${manifest.chunks.length} encrypted backup chunk${manifest.chunks.length === 1 ? "" : "s"}`,
    status: await getClawKeepStatus(relativeSourcePath),
  };
}
