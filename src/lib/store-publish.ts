/**
 * Publishing a ClawBox app — a Coding Agent project that carries clawbox.json
 * (src/lib/clawbox-manifest.ts) — to the ClawBox Store.
 *
 * The box packs the project folder into a tar.gz (`packProject`) and hands it
 * to the portal under the box's own portal token, the `claw_…` bearer the
 * ClawBox AI login stored (`resolveClawaiToken`). Up to 4 MB the package
 * travels inside the publish request itself (multipart: `metadata` JSON and
 * `package`); a larger one is uploaded to the Store's blob storage first with
 * a client token the portal issues for exactly that path, and the publish
 * request then names it by URL. Whether this owner may publish at all is the
 * portal's decision, never the box's: until the Developer plan opens, the
 * portal answers 403 `coming_soon` for everyone but its admins, and the UI
 * shows that as "coming soon" rather than as a failure.
 *
 * Every portal answer is mapped to ONE typed outcome (`mapPublishResponse`),
 * so the route, the dialog and the MCP tool `app_publish` all say the same
 * thing about the same refusal, and nothing the portal says reaches the owner
 * as an unexplained status code.
 *
 * What a package never carries: dependencies and build output (node_modules,
 * dist, build, .next), the repository itself (.git), the box's own state in
 * the project (.clawbox — run notes), and anything that looks like a secret
 * (.env*, *.pem, *.key, data/secrets*). Files the project's .gitignore names
 * are left out too: through `git ls-files` when the folder is its own
 * repository, through the root .gitignore's simple patterns otherwise.
 * Symlinks are never followed or packed — one pointing at ~/.ssh would
 * otherwise publish it.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "./runtime-path";
import { runChild } from "./child-run";
import {
  CLAWBOX_MANIFEST_FILE,
  MANIFEST_DESCRIPTION_MAX,
  MANIFEST_SLUG_RE,
  manifestSlug,
  readClawboxManifest,
  type ClawboxAppKind,
  type ClawboxManifest,
} from "./clawbox-manifest";
import { packTarGz, TarError, type TarEntry } from "./tar-gz";
import { CLAWBOX_AI_PROXY_URL, resolveClawaiToken } from "./harness/credentials";
import { isClawboxAiToken } from "./clawai-token";
import { CURRENT_PORTAL_ORIGIN, migrateLegacyPortalUrl } from "./portal-legacy-domain";

/** The largest package sent inside the publish request; anything bigger goes through blob storage. */
export const PUBLISH_DIRECT_MAX_BYTES = 4 * 1024 * 1024;
/** The largest package the box will make at all. */
export const PACKAGE_MAX_BYTES = 50 * 1024 * 1024;
/** Files in one package, and the bytes read to make it — a bound on the walk, before compression. */
export const PACKAGE_MAX_FILES = 10_000;
const PACKAGE_MAX_RAW_BYTES = 256 * 1024 * 1024;
const PUBLISH_TIMEOUT_MS = 120_000;
const STATUS_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 15_000;
export const VERSION_MAX = 32;
const ICON_URL_MAX = 500;
/** The portal's own page for a developer's apps — also where the plan is upgraded. */
export const PORTAL_APPS_PATH = "/portal/apps";

// ── Where the portal is ──────────────────────────────────────────────────────

/**
 * The portal's origin: the one the portal link names (`PORTAL_WEB`), else the
 * one the ClawBox AI proxy is reached at, else clawbox.com. Read per call so a
 * test (or an operator) can point it elsewhere without a restart.
 */
export function storePortalBase(): string {
  const configured = process.env.PORTAL_WEB?.trim();
  if (configured) return migrateLegacyPortalUrl(configured).replace(/\/+$/, "");
  try {
    return migrateLegacyPortalUrl(new URL(CLAWBOX_AI_PROXY_URL).origin);
  } catch {
    return CURRENT_PORTAL_ORIGIN;
  }
}

/** A portal-relative path (`/portal/apps`) as an absolute http(s) URL on the portal, or the apps page when it is not one. */
export function portalUrl(relative: unknown, base: string = storePortalBase()): string {
  const fallback = `${base}${PORTAL_APPS_PATH}`;
  if (typeof relative !== "string" || !relative.trim()) return fallback;
  try {
    const url = new URL(relative, `${base}/`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

// ── Packing ──────────────────────────────────────────────────────────────────

export type PackErrorReason = "no_manifest" | "too_large" | "failed";

export class PackError extends Error {
  constructor(readonly reason: PackErrorReason, message: string) {
    super(message);
    this.name = "PackError";
  }
}

export interface PackedProject {
  buffer: Buffer;
  size: number;
  /** Lowercase hex. */
  sha256: string;
  /** What went in, relative and POSIX, in packing order. */
  files: string[];
  manifest: ClawboxManifest;
}

/** True when `child` is `parent` or inside it (both real paths). */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

/** Folder names never packed, at any depth. */
const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".clawbox"]);

/** True when a project-relative POSIX path must stay out of a package. */
export function isExcludedFromPackage(rel: string): boolean {
  const parts = rel.split("/");
  if (parts.slice(0, -1).some((dir) => EXCLUDED_DIRS.has(dir))) return true;
  const name = parts[parts.length - 1];
  if (EXCLUDED_DIRS.has(name)) return true;
  if (name.startsWith(".env")) return true;
  if (/\.(pem|key)$/i.test(name)) return true;
  if (rel === "data/secrets" || rel.startsWith("data/secrets")) return true;
  return false;
}

interface IgnoreRule {
  re: RegExp;
  dirOnly: boolean;
}

/** One glob of a .gitignore line as a regex body: `*`, `?`, `**` and character classes. */
function globBody(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        out += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) { out += "\\["; continue; }
      const inner = glob.slice(i + 1, close).replace(/\\/g, "\\\\");
      out += `[${inner.startsWith("!") ? `^${inner.slice(1)}` : inner}]`;
      i = close;
    } else {
      out += ch.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return out;
}

/**
 * The root .gitignore's patterns, for a folder that is not its own repository
 * (git answers the real question when it is). Negations are not honoured —
 * they would only bring a file back — so this can leave out MORE than git
 * would, never less.
 */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    let pattern = line.replace(/^\\/, "");
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.replace(/\/+$/, "");
    if (!pattern) continue;
    const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");
    pattern = pattern.replace(/^\/+/, "");
    const body = globBody(pattern);
    rules.push({ re: new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`), dirOnly });
  }
  return rules;
}

function ignoredBy(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  return rules.some((rule) => (!rule.dirOnly || isDir) && rule.re.test(rel));
}

function gitEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? os.homedir(),
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
  };
}

/**
 * The files git would keep — tracked plus untracked-but-not-ignored — when the
 * folder is the root of its OWN repository; null otherwise. A code project
 * sits inside ClawBox's checkout, whose .gitignore ignores the whole data
 * folder: asking git there would answer "nothing", so the walk decides.
 */
async function gitListedFiles(root: string): Promise<string[] | null> {
  const top = await runChild("git", ["rev-parse", "--show-toplevel"], { cwd: root, timeoutMs: GIT_TIMEOUT_MS, env: gitEnv() });
  if (top.code !== 0) return null;
  const [realTop, realRoot] = await Promise.all([
    fs.promises.realpath(top.stdout.trim()).catch(() => null),
    fs.promises.realpath(root).catch(() => null),
  ]);
  if (!realTop || realTop !== realRoot) return null;
  const listed = await runChild(
    "git",
    ["-c", "core.fsmonitor=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, timeoutMs: GIT_TIMEOUT_MS, env: gitEnv() },
  );
  if (listed.code !== 0) return null;
  return [...new Set(listed.stdout.split("\0").filter(Boolean))].sort();
}

/** The walk for a folder git cannot answer for: no symlinks followed, the root .gitignore applied. */
async function walkedFiles(root: string): Promise<string[]> {
  const rules = parseGitignore(await fs.promises.readFile(path.join(root, ".gitignore"), "utf-8").catch(() => ""));
  const out: string[] = [];
  async function walk(relDir: string, depth: number): Promise<void> {
    if (depth > 32) return;
    const entries = await fs.promises.readdir(path.join(root, relDir), { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (isExcludedFromPackage(rel)) continue;
      if (entry.isDirectory()) {
        if (ignoredBy(rules, rel, true)) continue;
        await walk(rel, depth + 1);
      } else if (entry.isFile()) {
        if (!ignoredBy(rules, rel, false)) out.push(rel);
      }
      if (out.length > PACKAGE_MAX_FILES) return;
    }
  }
  await walk("", 0);
  return out;
}

/**
 * Pack a project folder into a gzip'd tar for the Store. The folder must
 * carry a clawbox.json at its root that `parseClawboxManifest` accepts; the
 * manifest is always packed, even where .gitignore names it.
 */
export async function packProject(projectDir: string): Promise<PackedProject> {
  const root = path.resolve(projectDir);
  const manifest = await readClawboxManifest(root);
  if (!manifest) {
    throw new PackError("no_manifest", `The project has no valid ${CLAWBOX_MANIFEST_FILE} at its root, so it is not a ClawBox app yet.`);
  }
  const listed = (await gitListedFiles(root)) ?? (await walkedFiles(root));
  const candidates = [CLAWBOX_MANIFEST_FILE, ...listed.filter((rel) => rel !== CLAWBOX_MANIFEST_FILE)]
    .filter((rel) => !isExcludedFromPackage(rel));
  if (candidates.length > PACKAGE_MAX_FILES) {
    throw new PackError("too_large", `The project has more than ${PACKAGE_MAX_FILES} files to publish.`);
  }

  const files: string[] = [];
  let rawBytes = 0;
  const resolvedRoot = await fs.promises.realpath(root).catch(() => null);
  if (!resolvedRoot) throw new PackError("failed", "The project folder could not be read.");
  const realRoot: string = resolvedRoot;
  async function* entries(): AsyncGenerator<TarEntry> {
    for (const rel of candidates) {
      const abs = path.join(root, ...rel.split("/"));
      // The file's FOLDER must really be inside the project. O_NOFOLLOW below
      // guards the last name only, and git's index still lists `sub/x` after
      // `sub` has been replaced by a symlink to somewhere else — `sub/id_rsa`
      // would then be read from outside the project and published.
      const realParent = await fs.promises.realpath(path.dirname(abs)).catch(() => null);
      if (!realParent || !isWithin(realRoot, realParent)) continue;
      const real = path.join(realParent, path.basename(abs));
      // ONE handle, opened without following a symlink (a symlink is skipped,
      // never packed), and every question asked of the handle rather than of
      // the path: a check on the path and a read of it are two moments, and a
      // link swapped in between would publish whatever it points at.
      const handle = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(() => null);
      if (!handle) continue;
      let entry: TarEntry | null = null;
      try {
        const stat = await handle.stat();
        // And the file opened is the one at that path inside the project, not
        // one a folder swapped in after the check above led to.
        const there = await fs.promises.lstat(real).catch(() => null);
        if (stat.isFile() && there && there.ino === stat.ino && there.dev === stat.dev) {
          rawBytes += stat.size;
          if (rawBytes > PACKAGE_MAX_RAW_BYTES) {
            throw new PackError("too_large", `The project's files add up to more than ${PACKAGE_MAX_RAW_BYTES / (1024 * 1024)} MB.`);
          }
          entry = { path: rel, type: "file", mode: stat.mode, mtime: Math.floor(stat.mtimeMs / 1000), data: await handle.readFile() };
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      if (!entry) continue;
      files.push(rel);
      yield entry;
    }
  }

  let buffer: Buffer;
  try {
    buffer = await packTarGz(entries(), { maxBytes: PACKAGE_MAX_BYTES });
  } catch (err) {
    if (err instanceof PackError) throw err;
    if (err instanceof TarError && err.reason === "too_large") {
      throw new PackError("too_large", `The package would be larger than ${PACKAGE_MAX_BYTES / (1024 * 1024)} MB.`);
    }
    throw new PackError("failed", `Packing the project failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
  }
  return {
    buffer,
    size: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    files,
    manifest,
  };
}

// ── Talking to the portal ────────────────────────────────────────────────────

export type PublishCode =
  | "not_linked"
  | "token_rejected"
  | "coming_soon"
  | "invalid"
  | "not_found"
  | "no_manifest"
  | "slug_taken"
  | "package_too_large"
  | "store_unavailable"
  | "unreachable"
  | "upstream"
  | "failed";

export interface PublishFailure {
  ok: false;
  code: PublishCode;
  message: string;
  /** The HTTP status the box's own route answers with — never 401, which the desktop reads as "signed out". */
  status: number;
  retryable: boolean;
  /** The field a validation refusal is about (`slug`, `version`, …). */
  field?: string;
  /** For `coming_soon`: where the plan is upgraded, as an absolute URL on the portal. */
  upgradeUrl?: string;
}

export interface PublishSuccess {
  ok: true;
  /** The Store's record of the app, as the portal returned it. */
  app: Record<string, unknown>;
  /** True for a new app, false for a new version of one already in the Store. */
  created: boolean;
  /** Where the owner sees the entry. */
  storeUrl: string;
}

export type PublishOutcome = PublishSuccess | PublishFailure;

const CODE_STATUS: Record<PublishCode, number> = {
  not_linked: 409,
  token_rejected: 409,
  coming_soon: 403,
  invalid: 400,
  not_found: 404,
  no_manifest: 422,
  slug_taken: 409,
  package_too_large: 413,
  store_unavailable: 503,
  unreachable: 502,
  upstream: 502,
  failed: 500,
};

const RETRYABLE = new Set<PublishCode>(["store_unavailable", "unreachable", "upstream", "failed"]);

const DEFAULT_MESSAGES: Record<PublishCode, string> = {
  not_linked: "This ClawBox is not connected to a ClawBox account. Sign in to ClawBox AI in Settings first, then publish again.",
  token_rejected: "Your ClawBox account no longer accepts this box's sign-in. Sign in to ClawBox AI again in Settings, then publish again.",
  coming_soon: "Publishing to the ClawBox Store is coming soon with the Developer plan.",
  invalid: "The Store did not accept the app's details.",
  not_found: "That project is not one of the Coding Agent's projects.",
  no_manifest: `The project has no valid ${CLAWBOX_MANIFEST_FILE}, so it is not a ClawBox app yet.`,
  slug_taken: "Another developer already published an app with this slug. Choose a different slug.",
  package_too_large: "The app's package is larger than the Store accepts.",
  store_unavailable: "The ClawBox Store is not taking new apps right now. Try again in a few minutes.",
  unreachable: "The ClawBox Store could not be reached. Check the box's internet connection and try again.",
  upstream: "The ClawBox Store answered with an error. Try again in a few minutes.",
  failed: "Publishing failed on the box.",
};

export function publishFailure(code: PublishCode, message?: string | null, extra: { field?: string; upgradeUrl?: string } = {}): PublishFailure {
  const text = typeof message === "string" && message.trim() ? message.trim().slice(0, 500) : DEFAULT_MESSAGES[code];
  return {
    ok: false,
    code,
    message: text,
    status: CODE_STATUS[code],
    retryable: RETRYABLE.has(code),
    ...(extra.field ? { field: extra.field } : {}),
    ...(extra.upgradeUrl ? { upgradeUrl: extra.upgradeUrl } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * The portal's token errors are `{ error: { message, type, code } }` — the
 * AI proxy's shape — on 401/403/503; the Store's own refusals are flat
 * `{ code, message, … }`. Null when the body is not a token error.
 */
function tokenError(body: Record<string, unknown> | null): { message?: string; code?: string } | null {
  const error = asRecord(body?.error);
  if (!error) return null;
  return { message: str(error.message), code: str(error.code) };
}

/** Map one answer of POST /api/store/publish (or of the upload-token request) to an outcome. */
export function mapPublishResponse(status: number, rawBody: unknown, base: string = storePortalBase()): PublishOutcome {
  const body = asRecord(rawBody);
  const code = str(body?.code);
  const message = str(body?.message);
  if (status === 200 || status === 201) {
    const app = asRecord(body?.app);
    if (!app) return publishFailure("upstream", "The ClawBox Store accepted the request but did not return the app.");
    const link = str(app.url);
    return {
      ok: true,
      app,
      created: status === 201 || body?.created === true,
      storeUrl: link && /^https?:\/\//i.test(link) ? link : portalUrl(PORTAL_APPS_PATH, base),
    };
  }
  const token = tokenError(body);
  if (token) {
    if (status === 503) return publishFailure("store_unavailable", token.message);
    // The portal's own sentence alone: every surface already says what to do
    // next (the dialog's body, app_publish's `next`), and appending it here
    // put the same instruction on screen twice.
    if (status === 401 || status === 403) return publishFailure("token_rejected", token.message);
  }
  if (status === 403 && code === "coming_soon") {
    return publishFailure("coming_soon", message, { upgradeUrl: portalUrl(body?.upgradeUrl ?? PORTAL_APPS_PATH, base) });
  }
  if (status === 401 || status === 403) return publishFailure("token_rejected", message);
  if (status === 400) return publishFailure("invalid", message, { field: str(body?.field) });
  if (status === 409) return publishFailure("slug_taken", message, { field: "slug" });
  if (status === 413) return publishFailure("package_too_large", message);
  if (status === 503) return publishFailure("store_unavailable", message);
  if (status === 404) return publishFailure("store_unavailable", "This ClawBox Store does not take published apps yet.");
  return publishFailure("upstream", message ?? `The ClawBox Store answered HTTP ${status}.`);
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The box's portal token, or null when it has none (or none that is a portal token). */
async function portalToken(): Promise<string | null> {
  const token = await resolveClawaiToken().catch(() => null);
  return token && isClawboxAiToken(token) ? token : null;
}

export interface PublishInput {
  version: string;
  description?: string | null;
  iconUrl?: string | null;
  /** Overrides the manifest's slug (or the one derived from its name). */
  slug?: string | null;
}

export interface PublishMetadata {
  slug: string;
  name: string;
  description: string;
  kind: ClawboxAppKind;
  version: string;
  iconUrl: string;
}

const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,20})?$/;

export function isPublishVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= VERSION_MAX && VERSION_RE.test(value);
}

/** The next patch version after `version`, or 1.0.0 when there is none to bump. */
export function bumpVersion(version: unknown): string {
  if (typeof version !== "string") return "1.0.0";
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})/.exec(version);
  if (!match) return "1.0.0";
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** The kind the Store files the app under: the manifest's, else server for a port, else webapp. */
export function publishKind(manifest: ClawboxManifest): ClawboxAppKind {
  return manifest.kind ?? (manifest.port ? "server" : "webapp");
}

/**
 * Validate what the owner typed against the manifest, and build the metadata
 * the portal takes. A refusal names the field it is about.
 */
export function buildPublishMetadata(manifest: ClawboxManifest, folder: string, input: PublishInput): PublishMetadata | PublishFailure {
  if (!isPublishVersion(input.version)) {
    return publishFailure("invalid", "Give the version as three numbers, like 1.0.0.", { field: "version" });
  }
  const slug = input.slug?.trim() ? input.slug.trim() : manifestSlug(manifest, folder);
  if (!slug || !MANIFEST_SLUG_RE.test(slug)) {
    return publishFailure("invalid", "Give the app a slug of lowercase letters, digits and dashes (at most 64), like my-app.", { field: "slug" });
  }
  const description = (input.description ?? manifest.description ?? "").replace(/\s+/g, " ").trim();
  if (description.length > MANIFEST_DESCRIPTION_MAX) {
    return publishFailure("invalid", `Keep the description under ${MANIFEST_DESCRIPTION_MAX} characters.`, { field: "description" });
  }
  const iconUrl = (input.iconUrl ?? "").trim();
  if (iconUrl && (iconUrl.length > ICON_URL_MAX || !/^https:\/\/[^\s]+$/i.test(iconUrl))) {
    return publishFailure("invalid", "The icon URL must be an https:// address.", { field: "iconUrl" });
  }
  return { slug, name: manifest.name, description, kind: publishKind(manifest), version: input.version, iconUrl };
}

/** The blob path the portal issues an upload token for. */
export function packagePathname(slug: string, version: string): string {
  return `store/apps/${slug}/${version}.tgz`;
}

async function postPublish(base: string, token: string, body: BodyInit, contentType?: string): Promise<PublishOutcome> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/store/publish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(contentType ? { "Content-Type": contentType } : {}) },
      body,
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
  } catch {
    return publishFailure("unreachable");
  }
  return mapPublishResponse(res.status, await readJson(res), base);
}

/** The big-package path: a client token for one blob path, the upload itself, then the publish by URL. */
async function publishViaBlob(base: string, token: string, metadata: PublishMetadata, pack: PackedProject): Promise<PublishOutcome> {
  const pathname = packagePathname(metadata.slug, metadata.version);
  let res: Response;
  try {
    res = await fetch(`${base}/api/store/publish/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ type: "blob.generate-client-token", payload: { pathname, clientPayload: null, multipart: true } }),
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS * 3),
    });
  } catch {
    return publishFailure("unreachable");
  }
  const answer = await readJson(res);
  const clientToken = res.ok ? str(asRecord(answer)?.clientToken) : undefined;
  if (!clientToken) {
    if (!res.ok) {
      const mapped = mapPublishResponse(res.status, answer, base);
      if (!mapped.ok) return mapped;
    }
    return publishFailure("upstream", "The ClawBox Store did not issue an upload token for the package.");
  }
  let packageUrl: string;
  try {
    const { put } = await import("@vercel/blob/client");
    const uploaded = await put(pathname, pack.buffer, { access: "private", token: clientToken, multipart: true, contentType: "application/gzip" });
    packageUrl = uploaded.url;
  } catch (err) {
    return publishFailure("store_unavailable", `Uploading the package to the Store failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
  }
  return postPublish(base, token, JSON.stringify({ ...metadata, packageUrl }), "application/json");
}

/** Publish an already-packed project with metadata already checked. Exposed for the tests. */
export async function sendPackage(metadata: PublishMetadata, pack: PackedProject, token: string, base: string = storePortalBase()): Promise<PublishOutcome> {
  if (pack.size > PUBLISH_DIRECT_MAX_BYTES) return publishViaBlob(base, token, metadata, pack);
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("package", new Blob([new Uint8Array(pack.buffer)], { type: "application/gzip" }), `${metadata.slug}-${metadata.version}.tgz`);
  return postPublish(base, token, form);
}

/** One of the Coding Agent's projects, as `publishProject` needs it. */
export interface PublishableProject {
  folder: string;
  directory: string;
}

/**
 * Publish one of the owner's projects. `resolveProject` finds it by the id
 * the caller gave (the route resolves through the Coding Agent's own listing,
 * so an arbitrary folder can never be published).
 */
export async function publishProject(
  projectId: string,
  input: PublishInput,
  resolveProject: (id: string) => Promise<PublishableProject | null>,
): Promise<PublishOutcome> {
  const project = await resolveProject(projectId);
  if (!project) return publishFailure("not_found");
  const manifest = await readClawboxManifest(project.directory);
  if (!manifest) return publishFailure("no_manifest");
  const metadata = buildPublishMetadata(manifest, project.folder, input);
  if ("ok" in metadata) return metadata;
  const token = await portalToken();
  if (!token) return publishFailure("not_linked");
  let pack: PackedProject;
  try {
    pack = await packProject(project.directory);
  } catch (err) {
    if (err instanceof PackError) {
      return publishFailure(err.reason === "too_large" ? "package_too_large" : err.reason === "no_manifest" ? "no_manifest" : "failed", err.message);
    }
    return publishFailure("failed", err instanceof Error ? err.message : String(err));
  }
  const outcome = await sendPackage(metadata, pack, token);
  if (!outcome.ok) console.warn(`[store-publish] ${metadata.slug}@${metadata.version}: ${outcome.code} — ${outcome.message}`);
  return outcome;
}

export interface PublishStatus {
  /** The box holds a portal token the portal still accepts (as far as it said). */
  linked: boolean;
  /** The portal's answer; null when it could not be asked. */
  canPublish: boolean | null;
  /** The owner's own apps in the Store, as the portal lists them. */
  apps: Record<string, unknown>[];
  /** Why publishing is not possible, when it is not. */
  code?: PublishCode;
  message?: string;
  /** Where the Developer plan is (for a `canPublish: false`). */
  upgradeUrl: string;
  /** The portal's origin, for "open the website". */
  portalUrl: string;
}

/** GET /api/store/publish: may this box's owner publish, and what have they published. */
export async function storePublishStatus(): Promise<PublishStatus> {
  const base = storePortalBase();
  const upgradeUrl = portalUrl(PORTAL_APPS_PATH, base);
  const token = await portalToken();
  if (!token) {
    const why = publishFailure("not_linked");
    return { linked: false, canPublish: false, apps: [], code: why.code, message: why.message, upgradeUrl, portalUrl: base };
  }
  let res: Response;
  try {
    res = await fetch(`${base}/api/store/publish`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
  } catch {
    const why = publishFailure("unreachable");
    return { linked: true, canPublish: null, apps: [], code: why.code, message: why.message, upgradeUrl, portalUrl: base };
  }
  const body = await readJson(res);
  const record = asRecord(body);
  if (res.ok) {
    const apps = Array.isArray(record?.apps) ? (record.apps as unknown[]).map(asRecord).filter((a): a is Record<string, unknown> => a !== null) : [];
    const canPublish = record?.canPublish === true;
    return {
      linked: true,
      canPublish,
      apps,
      ...(canPublish ? {} : { code: "coming_soon" as const, message: str(record?.message) ?? DEFAULT_MESSAGES.coming_soon }),
      upgradeUrl: portalUrl(record?.upgradeUrl ?? PORTAL_APPS_PATH, base),
      portalUrl: base,
    };
  }
  const mapped = mapPublishResponse(res.status, body, base);
  if (mapped.ok) return { linked: true, canPublish: null, apps: [], upgradeUrl, portalUrl: base };
  if (mapped.code === "coming_soon") {
    return { linked: true, canPublish: false, apps: [], code: mapped.code, message: mapped.message, upgradeUrl: mapped.upgradeUrl ?? upgradeUrl, portalUrl: base };
  }
  return {
    linked: mapped.code !== "token_rejected",
    canPublish: mapped.code === "token_rejected" ? false : null,
    apps: [],
    code: mapped.code,
    message: mapped.message,
    upgradeUrl,
    portalUrl: base,
  };
}
