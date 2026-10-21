/**
 * Installing a ClawBox app from the ClawBox Store: a Coding Agent project
 * another box published (src/lib/store-publish.ts), listed by the portal with
 * `source: "clawbox"`, a `packageUrl` and the package's `sha256`.
 *
 * The package is downloaded HERE, server side, and its SHA-256 compared with
 * the listing's before a single byte of it is unpacked — a package that does
 * not match is refused whole, and nothing is written. It is then unpacked
 * into the owner's project folder as `<slug>` (src/lib/tar-gz.ts refuses
 * links, devices and paths that leave the folder), given a repository of its
 * own the way an imported folder is (`ensureRepository`), and put on the
 * desktop the way its clawbox.json says:
 *
 *   - a `port`: the existing server-app flow — started with its `start`
 *     command when nothing listens yet, then proxied under `/apps/<slug>/`
 *     (`registerOrStartServerApp`, src/lib/app-proxy.ts);
 *   - a `webapp` or `site` with an index.html: bundled into one page, as a
 *     code project's build is (`bundleFolderHtml`), and served as a desktop
 *     web app;
 *   - anything else (a `tool`, or a page that still needs a build): a small
 *     page saying where its files are, so it is on the desktop and can be
 *     uninstalled from there.
 *
 * `.clawbox/store-app.json` inside the folder records that the Store put it
 * there. It is what lets an install be repeated (the files stay, only the
 * registration is retried) and what lets the uninstall remove the folder: a
 * folder of the same name the owner made themselves is never touched.
 */
import crypto from "crypto";
import fs from "fs";
import path from "./runtime-path";
import { CLAWBOX_MANIFEST_FILE, MANIFEST_KINDS, parseClawboxManifest, readClawboxManifest, type ClawboxAppKind, type ClawboxManifest } from "./clawbox-manifest";
import { readTarGz, TarError, type TarEntry } from "./tar-gz";
import { storePortalBase } from "./store-publish";
import { CLAWBOX_APP_SOURCE } from "./store-categories";
import { readStoreMarker, STORE_MARKER, type StoreMarker } from "./store-install-receipt";
import { isPng, placeIcon, safeAppId, webappIconPath } from "./webapp-icon";
import { getDefaultDirectory } from "./coding-agent";
import { ensureRepository, freeBytes, IMPORT_FREE_RESERVE_BYTES } from "./project-import";
import { registerOrStartServerApp } from "./app-server-start";
import { bundleFolderHtml, deployWebapp } from "./code-projects";
import { resolveClawaiToken } from "./harness/credentials";
import { isClawboxAiToken } from "./clawai-token";

/** The largest package downloaded — the same cap the publisher packs under. */
export const INSTALL_MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
/** What a package may unpack to, and how many files. */
const INSTALL_MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const INSTALL_MAX_FILES = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const ICON_MAX_BYTES = 1024 * 1024;

/** A ClawBox app as the Store lists it — only what installing it needs. */
export interface ClawboxStoreApp {
  slug: string;
  name: string;
  description: string;
  kind: ClawboxAppKind | null;
  version: string;
  packageUrl: string;
  /** Lowercase hex. */
  sha256: string;
  size: number | null;
  iconUrl: string | null;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/**
 * The Store's record of a ClawBox app, checked: null for a ClawHub skill or a
 * record missing what an install cannot do without (a package, its digest).
 */
export function clawboxStoreAppFrom(raw: unknown): ClawboxStoreApp | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.source !== CLAWBOX_APP_SOURCE) return null;
  const slug = typeof r.slug === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(r.slug) ? r.slug : null;
  const packageUrl = typeof r.packageUrl === "string" && r.packageUrl.length <= 2048 ? r.packageUrl : null;
  const sha256 = typeof r.sha256 === "string" && /^[0-9a-f]{64}$/i.test(r.sha256) ? r.sha256.toLowerCase() : null;
  const version = text(r.version, 32);
  if (!slug || !packageUrl || !sha256 || !version) return null;
  const kind = typeof r.kind === "string" && (MANIFEST_KINDS as readonly string[]).includes(r.kind) ? (r.kind as ClawboxAppKind) : null;
  const size = typeof r.size === "number" && Number.isInteger(r.size) && r.size >= 0 ? r.size : null;
  const iconUrl = typeof r.iconUrl === "string" && /^https:\/\//i.test(r.iconUrl) && r.iconUrl.length <= 500 ? r.iconUrl : null;
  return { slug, name: text(r.name, 60) || slug, description: text(r.description, 300), kind, version, packageUrl, sha256, size, iconUrl };
}

export type StoreInstallFailureCode =
  | "invalid_listing"
  | "no_project_folder"
  | "exists"
  | "download_failed"
  | "package_too_large"
  | "sha256_mismatch"
  | "invalid_package"
  | "no_space"
  | "failed";

export interface StoreInstallFailure {
  ok: false;
  code: StoreInstallFailureCode;
  error: string;
  retryable: boolean;
  status: number;
}

export interface StoreInstallSuccess {
  ok: true;
  appId: string;
  /** The project folder's name — the slug. */
  folder: string;
  directory: string;
  version: string;
  kind: ClawboxAppKind | null;
  /** On the desktop. False when the files are in place but the app could not be registered (its server would not start). */
  registered: boolean;
  /** What the desktop opens, when registered. */
  webappUrl: string | null;
  /** Why it is not registered, or what else the owner should know. */
  detail: string | null;
  /** The folder was already there from an earlier install; only the registration was retried. */
  alreadyInstalled: boolean;
}

export type StoreInstallOutcome = StoreInstallSuccess | StoreInstallFailure;

function failure(code: StoreInstallFailureCode, error: string, status: number, retryable = false): StoreInstallFailure {
  return { ok: false, code, error, retryable, status };
}

// ── Download and verify ──────────────────────────────────────────────────────

/**
 * Where the package is fetched from: https anywhere (blob storage), or the
 * portal's own origin whatever its scheme (a test portal on http). Anything
 * else — a LAN address on plain http, a file: URL — is refused.
 */
export function packageFetchUrl(packageUrl: string, base: string = storePortalBase()): URL | null {
  try {
    const url = new URL(packageUrl, `${base}/`);
    if (url.origin === new URL(base).origin) return url;
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Compare a downloaded package with the listing. The digest is the listing's;
 * the portal's `X-ClawBox-Package-SHA256` header, when sent, must agree with
 * it too, and so must the size the listing names. Null when it matches.
 */
export function verifyPackage(buffer: Buffer, app: Pick<ClawboxStoreApp, "sha256" | "size" | "name">, headerSha256?: string | null): StoreInstallFailure | null {
  const actual = crypto.createHash("sha256").update(buffer).digest("hex");
  const header = headerSha256?.trim().toLowerCase() || null;
  const sizeOff = app.size !== null && app.size !== buffer.length;
  if (actual !== app.sha256.toLowerCase() || (header !== null && header !== actual) || sizeOff) {
    return failure(
      "sha256_mismatch",
      `The package downloaded for ${app.name} does not match the checksum the Store published for it, so nothing was installed.`,
      422,
    );
  }
  return null;
}

async function downloadPackage(app: ClawboxStoreApp): Promise<{ ok: true; buffer: Buffer; headerSha256: string | null } | StoreInstallFailure> {
  const base = storePortalBase();
  const url = packageFetchUrl(app.packageUrl, base);
  if (!url) return failure("invalid_listing", "The Store listed a package address the box will not download from.", 502);
  const headers: Record<string, string> = { Accept: "application/gzip" };
  // The box's portal token goes to the portal and nowhere else.
  if (url.origin === new URL(base).origin) {
    const token = await resolveClawaiToken().catch(() => null);
    if (token && isClawboxAiToken(token)) headers.Authorization = `Bearer ${token}`;
  }
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: "follow" });
  } catch {
    return failure("download_failed", "The package could not be downloaded from the Store. Check the box's internet connection and try again.", 502, true);
  }
  if (!res.ok) {
    return failure("download_failed", `The Store answered HTTP ${res.status} for the package.`, res.status === 404 ? 404 : 502, res.status !== 404);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > INSTALL_MAX_PACKAGE_BYTES) {
    return failure("package_too_large", "The package is larger than the box installs.", 413);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    const reader = res.body?.getReader();
    if (!reader) return failure("download_failed", "The Store sent an empty package.", 502, true);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > INSTALL_MAX_PACKAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return failure("package_too_large", "The package is larger than the box installs.", 413);
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return failure("download_failed", "The download of the package broke off. Try again.", 502, true);
  }
  return { ok: true, buffer: Buffer.concat(chunks, total), headerSha256: res.headers.get("x-clawbox-package-sha256") };
}

// ── Unpack ───────────────────────────────────────────────────────────────────

/**
 * The package's files rebased onto the app's root, and its manifest. A
 * package whose manifest sits one folder down (`<name>/clawbox.json`, how
 * other packers wrap a tree) is taken from inside that folder.
 */
export function packageLayout(entries: TarEntry[]): { entries: TarEntry[]; manifest: ClawboxManifest } | null {
  const manifestOf = (list: TarEntry[]) => {
    const file = list.find((e) => e.type === "file" && e.path === CLAWBOX_MANIFEST_FILE);
    return file?.data ? parseClawboxManifest(file.data.toString("utf-8")) : null;
  };
  const atRoot = manifestOf(entries);
  if (atRoot) return { entries: installable(entries), manifest: atRoot };
  const tops = new Set(entries.map((e) => e.path.split("/")[0]));
  if (tops.size !== 1) return null;
  const [top] = [...tops];
  const rebased = entries
    .filter((e) => e.path !== top)
    .map((e) => ({ ...e, path: e.path.slice(top.length + 1) }))
    .filter((e) => e.path !== "");
  const inner = manifestOf(rebased);
  return inner ? { entries: installable(rebased), manifest: inner } : null;
}

/**
 * What of a package is unpacked: never a `.git` at any depth, never the
 * project's `.clawbox`. A repository's config and hooks are code the box's
 * own git runs — `core.fsmonitor` on the Changes tab's `git status`, a hook
 * (unpacked executable) on a run's commit — so a package carrying one would
 * turn even a sandboxed web app into a command on the box; the folder gets
 * a fresh repository of its own instead (`ensureRepository`). `.clawbox` is
 * the box's state in a project, the Store's receipt among it.
 */
function installable(entries: TarEntry[]): TarEntry[] {
  return entries.filter((e) => {
    const segments = e.path.split("/");
    return !segments.includes(".git") && segments[0] !== ".clawbox";
  });
}

async function writeEntries(directory: string, entries: TarEntry[]): Promise<void> {
  const root = path.resolve(directory);
  for (const entry of entries) {
    const target = path.resolve(root, ...entry.path.split("/"));
    // The reader already refused every path that leaves the folder; this is
    // the check that stands on its own, on the resolved path.
    if (!target.startsWith(root + path.sep)) throw new Error(`Refused a path outside the app's folder: ${entry.path}`);
    if (entry.type === "dir") {
      await fs.promises.mkdir(target, { recursive: true, mode: 0o755 });
      continue;
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    // `wx`: the folder was made empty for this install, so a file that is
    // already there can only be a second entry for one path the reader let
    // through, and nothing is ever written THROUGH an existing name.
    await fs.promises.writeFile(target, entry.data ?? Buffer.alloc(0), { flag: "wx", mode: entry.mode & 0o111 ? 0o755 : 0o644 });
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}

/** The window of an app with no page of its own: what it is and where its files are. */
export function folderAppHtml(manifest: ClawboxManifest, folder: string): string {
  const what = manifest.kind === "tool"
    ? "This is a tool: it has no window of its own."
    : "This app has no page to open yet — it may need to be built first.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(manifest.name)}</title><style>` +
    "body{background:#1a1a2e;color:#e0e0e0;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}" +
    "main{max-width:34rem;text-align:center}h1{font-size:1.05rem;font-weight:600;margin:0 0 .6rem}p{margin:.4rem 0;font-size:.9rem;line-height:1.6;color:#b9b9c6}code{color:#f9a66c}" +
    `</style></head><body><main><h1>${escapeHtml(manifest.name)}</h1>` +
    (manifest.description ? `<p>${escapeHtml(manifest.description)}</p>` : "") +
    `<p>${what} Its files are in the <code>${escapeHtml(folder)}</code> project — open the Coding Agent to run or change it.</p>` +
    "</main></body></html>";
}

async function exists(file: string): Promise<boolean> {
  return fs.promises.stat(file).then((s) => s.isFile(), () => false);
}

/** Put an installed app on the desktop the way its manifest says. */
async function registerInstalledApp(appId: string, directory: string, manifest: ClawboxManifest, description: string): Promise<{ registered: boolean; webappUrl: string | null; detail: string | null }> {
  const meta = { name: manifest.name, description: manifest.description ?? (description || undefined) };
  try {
    if (manifest.port) {
      const outcome = await registerOrStartServerApp({
        id: appId,
        directory,
        manifest,
        searchPath: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      });
      if (outcome.ok) return { registered: true, webappUrl: `/apps/${appId}/`, detail: null };
      return {
        registered: false,
        webappUrl: null,
        detail: `${manifest.name} is in your projects, but its server could not be put on the desktop: ${outcome.detail} Start it from the Coding Agent, then use Add to desktop.`,
      };
    }
    const html = manifest.kind !== "tool" && (await exists(path.join(directory, "index.html")))
      ? await bundleFolderHtml(directory)
      : folderAppHtml(manifest, path.basename(directory));
    await deployWebapp(appId, html, meta);
    return { registered: true, webappUrl: `/setup-api/webapps?app=${appId}`, detail: null };
  } catch (err) {
    return {
      registered: false,
      webappUrl: null,
      detail: `${manifest.name} is in your projects, but putting it on the desktop failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400),
    };
  }
}

/** The listing's icon as the app's desktop icon, when it is a PNG; never a reason to fail. */
async function saveListingIcon(appId: string, iconUrl: string | null): Promise<void> {
  if (!iconUrl) return;
  try {
    const res = await fetch(iconUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > ICON_MAX_BYTES || !isPng(bytes)) return;
    await placeIcon(webappIconPath(appId), bytes);
  } catch (err) {
    console.warn(`[store-install] icon for ${appId} not saved:`, err instanceof Error ? err.message : err);
  }
}

// ── Install and remove ───────────────────────────────────────────────────────

/** Install one ClawBox app the Store listed. */
export async function installClawboxApp(app: ClawboxStoreApp): Promise<StoreInstallOutcome> {
  const appId = safeAppId(app.slug);
  if (!appId) return failure("invalid_listing", "The Store listed this app under an id the box cannot use.", 502);
  const projectsRoot = await getDefaultDirectory();
  if (!projectsRoot) {
    return failure("no_project_folder", "Set a project folder in the Coding Agent's settings first: a ClawBox app is installed there as a project.", 409);
  }
  const root = path.resolve(projectsRoot);
  const directory = path.resolve(root, appId);
  if (path.dirname(directory) !== root) return failure("invalid_listing", "The Store listed this app under an id the box cannot use.", 502);

  const present = await fs.promises.lstat(directory).catch(() => null);
  if (present) {
    const marker = present.isDirectory() ? await readStoreMarker(directory) : null;
    if (!marker || marker.slug !== appId) {
      return failure("exists", `There is already a "${appId}" in your project folder that did not come from the Store. Rename or remove it first.`, 409);
    }
    const manifest = await readClawboxManifest(directory);
    if (!manifest) return failure("invalid_package", `The installed "${appId}" no longer has a valid ${CLAWBOX_MANIFEST_FILE}. Uninstall it and install it again.`, 409);
    const registration = await registerInstalledApp(appId, directory, manifest, app.description);
    return { ok: true, appId, folder: appId, directory, version: marker.version, kind: manifest.kind, ...registration, alreadyInstalled: true };
  }

  const downloaded = await downloadPackage(app);
  if (!downloaded.ok) return downloaded;
  const mismatch = verifyPackage(downloaded.buffer, app, downloaded.headerSha256);
  if (mismatch) return mismatch;

  let layout: ReturnType<typeof packageLayout>;
  try {
    layout = packageLayout(readTarGz(downloaded.buffer, { maxBytes: INSTALL_MAX_UNPACKED_BYTES, maxEntries: INSTALL_MAX_FILES }));
  } catch (err) {
    if (err instanceof TarError) {
      return err.reason === "too_large"
        ? failure("package_too_large", err.message, 413)
        : failure("invalid_package", `The package cannot be installed: ${err.message}`, 422);
    }
    throw err;
  }
  if (!layout) return failure("invalid_package", `The package has no valid ${CLAWBOX_MANIFEST_FILE} at its root, so it is not a ClawBox app.`, 422);

  const unpacked = layout.entries.reduce((sum, e) => sum + (e.data?.length ?? 0), 0);
  await fs.promises.mkdir(root, { recursive: true }).catch(() => undefined);
  const free = await freeBytes(root);
  if (free !== null && free - unpacked < IMPORT_FREE_RESERVE_BYTES) {
    return failure("no_space", `Not enough free space on the box for ${app.name}.`, 507);
  }

  // CLAIMED with a mkdir that fails when the name exists, so two installs of
  // one app cannot both pass the check above; the loser is refused here and
  // the winner removes only the folder it made.
  try {
    await fs.promises.mkdir(directory, { mode: 0o755 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return failure("exists", `There is already a "${appId}" in your project folder. Try again in a moment.`, 409, true);
    }
    return failure("failed", `Could not make the project folder: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), 500, true);
  }
  try {
    await writeEntries(directory, layout.entries);
    const marker: StoreMarker = { source: CLAWBOX_APP_SOURCE, slug: appId, version: app.version, sha256: app.sha256, installedAt: new Date().toISOString() };
    await fs.promises.mkdir(path.join(directory, path.dirname(STORE_MARKER)), { recursive: true });
    await fs.promises.writeFile(path.join(directory, STORE_MARKER), JSON.stringify(marker, null, 2) + "\n", { mode: 0o644 });
  } catch (err) {
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    return failure("failed", `Unpacking the app failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), 500, true);
  }

  const repo = await ensureRepository(directory, "the ClawBox Store").catch((err: unknown) => ({ initialized: false, detail: err instanceof Error ? err.message : String(err) }));
  if (repo.detail) console.warn(`[store-install] ${appId}: repository not made: ${repo.detail}`);
  await saveListingIcon(appId, app.iconUrl);
  const registration = await registerInstalledApp(appId, directory, layout.manifest, app.description);
  return { ok: true, appId, folder: appId, directory, version: app.version, kind: layout.manifest.kind, ...registration, alreadyInstalled: false };
}
