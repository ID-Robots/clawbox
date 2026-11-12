import fs from "fs";
import path from "@/lib/runtime-path";
import { canonicalPath, filesBrowseRoot, isProtectedFilePath } from "@/lib/file-guard";

/**
 * WHOSE files the Files API serves, and the one fence every Files route asks
 * (TASK-2377).
 *
 * The owner — and the agent's MCP bearer, and every user of a HOME box — is
 * served the browse root as always (`filesBrowseRoot()`, the owner's home,
 * secret stores carved out by file-guard.ts). A member of staff on an
 * ORGANISATION box (`org_mode`, src/lib/org-mode.ts) is served exactly two
 * folders and nothing else:
 *
 *   Home/…    their own Linux home (`getent passwd`), which the web server — the
 *             owner's account — reaches through the ACL the root-owned helper
 *             lays on it (`home_access`, config/clawbox-user-helper.sh);
 *   Shared/…  `<owner home>/Shared`, one folder every member of staff and the
 *             owner read and write, created when missing.
 *
 * The browse root of a member is a VIRTUAL folder holding those two: nothing
 * can be written there, and neither root can be renamed, moved or deleted.
 *
 * Containment is judged twice, the shape file-guard.ts uses: lexically (the
 * request resolved under its root, `..` and absolute paths refused) and on the
 * path with every link resolved (`canonicalPath`), so a symlink a user left in
 * their home that points into the owner's home, another user's home or `/etc`
 * leads nowhere. The secret-store inventory (`isProtectedFilePath`) is applied
 * on top, inside their own home too: `~/.ssh` is not a file manager's business
 * whoever owns it.
 *
 * Pure apart from the filesystem reads a resolve needs; the request side —
 * who is asking, the switch, the helper — is files-scope-server.ts.
 */

/** The folder of the owner's home every member of staff shares, created when missing. */
export const SHARED_FOLDER_NAME = "Shared";
/** The member's view: their home and the shared folder, as the two top entries. */
export const MEMBER_HOME_ENTRY = "Home";
export const MEMBER_SHARED_ENTRY = "Shared";

export interface FilesRoot {
  /** The top-level name the member's Files app shows (`Home`, `Shared`). */
  name: string;
  /** The root with its links resolved: every containment test is against this. */
  real: string;
}

export type FilesScope =
  | { kind: "owner"; base: string }
  | { kind: "member"; username: string; roots: readonly FilesRoot[] };

/** The owner's view: the browse root, unchanged. */
export function ownerScope(base: string = filesBrowseRoot()): FilesScope {
  return { kind: "owner", base: path.resolve(base) };
}

/** Where the shared folder lives: `<owner home>/Shared`. */
export function sharedFolderPath(ownerBase: string = filesBrowseRoot()): string {
  return path.join(path.resolve(ownerBase), SHARED_FOLDER_NAME);
}

/**
 * Is `child` at or under `parent`, by prefix? Not file-guard's `isInside`:
 * that one's `rel.startsWith("..")` refuses `~/..hidden`, a legitimate name the
 * Files app has always listed.
 */
function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * Do two folders overlap — is either at or under the other? A member's home
 * that holds the owner's home (`/home`) or sits inside it would hand them the
 * owner's files or the box's state, so such a home is never served.
 */
export function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

/**
 * The fence of one scope: every Files route resolves through it instead of
 * spelling its own containment rule.
 */
export interface FilesFence {
  readonly scope: FilesScope;
  /** `owner`, or `member:<name>`: what a zip ticket is bound to. */
  readonly key: string;
  /** True for the member's virtual top folder (`""`, `/`, `.`). Never for the owner. */
  isVirtualRoot(rel: string): boolean;
  /**
   * The absolute path a browse-relative path names, or null when it is outside
   * the scope, a secret store, or (for a member) the virtual root itself.
   */
  resolve(rel: string): string | null;
  /** The browse-relative path of an absolute path inside the scope (`Home/Documents/x`). */
  relOf(abs: string): string;
  /** May this entry be listed, searched, zipped or moved — inside the scope once its links are resolved, and no secret store? */
  allows(abs: string): boolean;
  /** Is `abs` one of the scope's roots (never renamed, moved or deleted)? */
  isRoot(abs: string): boolean;
  /** The virtual root's listing: one folder per root. Empty for the owner. */
  rootEntries(): Array<{ name: string; type: "directory"; size: null; modified: string }>;
}

function memberRootOf(roots: readonly FilesRoot[], abs: string): FilesRoot | null {
  for (const root of roots) if (within(abs, root.real)) return root;
  return null;
}

/** The member half of {@link fenceFor}. */
function memberFence(scope: Extract<FilesScope, { kind: "member" }>): FilesFence {
  const { roots } = scope;
  const isVirtualRoot = (rel: string) => {
    const trimmed = rel.replace(/^[/\\]+|[/\\]+$/g, "");
    return trimmed === "" || trimmed === ".";
  };
  /** Inside its root as typed AND once every link on the way is resolved. */
  const contained = (abs: string, root: FilesRoot) => {
    if (!within(abs, root.real)) return false;
    const real = canonicalPath(abs);
    return real !== null && within(real, root.real);
  };
  const fence: FilesFence = {
    scope,
    key: `member:${scope.username}`,
    isVirtualRoot,
    resolve(rel) {
      if (typeof rel !== "string" || rel.includes("\0")) return null;
      if (isVirtualRoot(rel)) return null;
      // A member names paths relative to their two folders only: an absolute
      // path (the owner's "Open in Files" sends one) is not theirs to name.
      if (path.isAbsolute(rel) || /^[/\\]/.test(rel)) return null;
      const segments = rel.split(/[/\\]+/).filter((s) => s !== "");
      const root = roots.find((r) => r.name === segments[0]);
      if (!root) return null;
      const resolved = path.resolve(root.real, ...segments.slice(1));
      if (!contained(resolved, root)) return null;
      if (isProtectedFilePath(resolved)) return null;
      return resolved;
    },
    relOf(abs) {
      const root = memberRootOf(roots, abs);
      if (!root) return "";
      const rest = path.relative(root.real, abs).split(path.sep).join("/");
      return rest ? `${root.name}/${rest}` : root.name;
    },
    allows(abs) {
      const root = memberRootOf(roots, abs);
      return root !== null && contained(abs, root) && !isProtectedFilePath(abs);
    },
    isRoot(abs) {
      return roots.some((root) => path.resolve(abs) === root.real);
    },
    rootEntries() {
      return roots.map((root) => {
        let modified = "";
        try {
          modified = fs.statSync(/* turbopackIgnore: true */ root.real).mtime.toISOString();
        } catch {
          // a root that vanished still has its name
        }
        return { name: root.name, type: "directory" as const, size: null, modified };
      });
    },
  };
  return fence;
}

/** The owner half of {@link fenceFor}: the browse root, exactly the rule the routes always had. */
function ownerFence(scope: Extract<FilesScope, { kind: "owner" }>): FilesFence {
  const base = scope.base;
  return {
    scope,
    key: "owner",
    isVirtualRoot: () => false,
    resolve(rel) {
      // The accepted set is exactly the one this API always had (pinned by
      // safe-path-containment.test.ts against beta's own predicate).
      if (typeof rel !== "string") return null;
      const resolved = path.resolve(base, rel);
      // The browse root itself.
      if (resolved === base) return isProtectedFilePath(base) ? null : base;
      // Anything else must be INSIDE it (with the separator, otherwise sibling
      // dirs like "/home/clawboxmalicious" would slip through).
      if (!resolved.startsWith(base + path.sep)) return null;
      // The browse root is $HOME, so secret stores (.ssh, .openclaw, the data/
      // tokens) sit inside the sandbox — denied at this one chokepoint.
      if (isProtectedFilePath(resolved)) return null;
      return resolved;
    },
    relOf(abs) {
      return path.relative(base, abs).split(path.sep).join("/");
    },
    allows(abs) {
      return !isProtectedFilePath(abs);
    },
    isRoot(abs) {
      return path.resolve(abs) === base;
    },
    rootEntries() {
      return [];
    },
  };
}

export function fenceFor(scope: FilesScope): FilesFence {
  return scope.kind === "owner" ? ownerFence(scope) : memberFence(scope);
}

/**
 * The member's two roots, resolved, or why they cannot be served: a home that
 * does not resolve, or that overlaps the owner's home (or the box's root), is
 * `home_unavailable` — never quietly replaced by something else.
 */
export function memberRoots(home: string, ownerBase: string = filesBrowseRoot()): { ok: true; roots: FilesRoot[] } | { ok: false; code: "home_unavailable" | "shared_unavailable" } {
  let homeReal: string;
  let ownerReal: string;
  try {
    homeReal = fs.realpathSync(/* turbopackIgnore: true */ home);
    ownerReal = fs.realpathSync(/* turbopackIgnore: true */ path.resolve(ownerBase));
  } catch {
    return { ok: false, code: "home_unavailable" };
  }
  if (homeReal === path.parse(homeReal).root || overlaps(homeReal, ownerReal)) return { ok: false, code: "home_unavailable" };
  const shared = sharedFolderPath(ownerReal);
  let sharedReal: string;
  try {
    fs.mkdirSync(/* turbopackIgnore: true */ shared, { recursive: true, mode: 0o770 });
    sharedReal = fs.realpathSync(/* turbopackIgnore: true */ shared);
  } catch {
    return { ok: false, code: "shared_unavailable" };
  }
  // A Shared that is a link out of the owner's home, or into a member's home,
  // is not the shared folder this rule describes.
  if (!within(sharedReal, ownerReal) || sharedReal === ownerReal || overlaps(sharedReal, homeReal) || isProtectedFilePath(sharedReal)) {
    return { ok: false, code: "shared_unavailable" };
  }
  return {
    ok: true,
    roots: [
      { name: MEMBER_HOME_ENTRY, real: homeReal },
      { name: MEMBER_SHARED_ENTRY, real: sharedReal },
    ],
  };
}
