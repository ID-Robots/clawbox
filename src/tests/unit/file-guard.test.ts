import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// file-guard reads DATA_DIR from config-store at import time, which resolves
// from CLAWBOX_ROOT — set it before importing so the data-secret paths are
// deterministic under a temp root.
let TEST_ROOT: string;
let DATA_DIR: string;
let guard: typeof import("@/lib/file-guard");

beforeAll(async () => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-fileguard-"));
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  DATA_DIR = path.join(TEST_ROOT, "data");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  guard = await import("@/lib/file-guard");
});

afterAll(() => {
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("isProtectedFilePath", () => {
  const home = "/home/clawbox";

  it.each([
    `${home}/.ssh/id_rsa`,
    `${home}/.ssh`,
    `${home}/.openclaw/openclaw.json`,
    `${home}/.openclaw/agents/x/agent/y.sqlite`,
    `${home}/.hermes/config.yaml`,        // dashboard secret + ClawBox AI token
    `${home}/.hermes/.env`,               // provider keys
    `${home}/.hermes/auth.json`,          // OAuth tokens
    `${home}/.hermes/config.yaml.bak-basicauth`,
    `${home}/.codex/auth.json`,
    `${home}/.gnupg/secring.gpg`,
    `${home}/.aws/credentials`,
    `${home}/.config/gcloud/credentials.db`,
    `${home}/.config/gh/hosts.yml`,
  ])("flags credential store %s", (p) => {
    expect(guard.isProtectedFilePath(p)).toBe(true);
  });

  // The inventory the product actually writes under DATA_DIR, as of this
  // commit. It is here to show the rule covers the real directory — the rule
  // itself is pinned by the runtime-name and unknown-name cases below, which do
  // not depend on this list staying current.
  it.each([
    // Tokens and stores.
    ".session-secret",
    ".mcp-token",
    ".local-ai-token",
    ".local-ai-token-migrated",
    ".hermes-dashboard-pw",
    "config.json",
    "kv.json",
    "clawbox.db",
    "dual-license.txt",
    // OAuth flow files.
    "oauth-device-tokens.json",
    "oauth-device-state.json",
    "oauth-state.json",
    "oauth-org.json",
    "clawai-connect-state.json",
    // Credentials-change and login state.
    ".chpasswd-input",
    ".login-attempts.json",
    // Tunnel and network state.
    "tunnel-state.json",
    "tunnel.pid",
    "tunnel-url.txt",
    "control-ui-origins.json",
    "network.env",
    "hotspot.env",
    "ap-runtime.env",
    "hostname.env",
    "wifi-scan-cache.json",
  ])("flags the data-dir server-state file %s", (n) => {
    expect(guard.isProtectedFilePath(path.join(DATA_DIR, n))).toBe(true);
  });

  it("flags a nested file under a protected data-dir subtree", () => {
    expect(guard.isProtectedFilePath(path.join(DATA_DIR, "cloudflared"))).toBe(true);
    expect(guard.isProtectedFilePath(path.join(DATA_DIR, "cloudflared", "cert.pem"))).toBe(true);
  });

  // The rule is containment, so it has to hold for names that no list could
  // carry: one the code generates at runtime, and one that does not exist yet.
  it("flags a runtime-named atomic-write sidecar", () => {
    expect(
      guard.isProtectedFilePath(path.join(DATA_DIR, "oauth-device-tokens.json.tmp.deadbeef")),
    ).toBe(true);
    expect(guard.isProtectedFilePath(path.join(DATA_DIR, "config.json.tmp"))).toBe(true);
  });

  it("flags a data-dir file this test has never heard of", () => {
    expect(guard.isProtectedFilePath(path.join(DATA_DIR, "some-future-store.json"))).toBe(true);
    expect(guard.isProtectedFilePath(path.join(DATA_DIR, "future-dir", "nested", "x.bin"))).toBe(true);
  });

  // POSIX only: on Windows a backslash really is a separator, so the question
  // does not arise. On the device it is a legal filename character, and a name
  // containing one is a single entry in the data dir — not a path into the
  // public subtree its first half happens to spell.
  it.skipIf(path.sep !== "/")("reads a backslash in a name as part of the name", () => {
    expect(guard.isProtectedFilePath(`${DATA_DIR}/webapps\\evil`)).toBe(true);
    expect(guard.isProtectedFilePath(`${DATA_DIR}/icons\\..\\config.json`)).toBe(true);
  });

  it("keeps the data dir itself listable so its public subtrees can be reached", () => {
    // The Files API filters a listing entry by entry; a protected DATA_DIR
    // would make the whole directory unopenable and hide the subtrees below.
    expect(guard.isProtectedFilePath(DATA_DIR)).toBe(false);
  });

  it.each([
    "webapps",
    "icons",
    "catalog-cache",
    "code-projects",
    "llamacpp",
  ])("does not over-block the public data-dir subtree %s", (sub) => {
    expect(guard.isProtectedFilePath(path.join(DATA_DIR, sub))).toBe(false);
    expect(guard.isProtectedFilePath(path.join(DATA_DIR, sub, "demo", "index.html"))).toBe(false);
  });

  it("does not over-block a sibling of the data dir", () => {
    expect(guard.isProtectedFilePath(path.join(TEST_ROOT, "data-backup", "notes.txt"))).toBe(false);
    expect(guard.isProtectedFilePath(path.join(TEST_ROOT, "src", "index.ts"))).toBe(false);
  });

  it.each([
    `${home}/.clawkeep`,
    `${home}/.clawkeep/token`,
    `${home}/.clawkeep/passphrase`,
    `${home}/.clawkeep/config.toml`,
  ])("flags the backup tool's store %s", (p) => {
    expect(guard.isProtectedFilePath(p)).toBe(true);
  });

  it("does not over-block a name that merely starts with .clawkeep", () => {
    expect(guard.isProtectedFilePath(`${home}/.clawkeep-notes.txt`)).toBe(false);
    expect(guard.isProtectedFilePath(`${home}/clawkeep/readme.md`)).toBe(false);
  });

  it.each([
    `${home}/.kube/config`,
    `${home}/.docker/config.json`,
    `${home}/.config/rclone/rclone.conf`,
    `${home}/.netrc`,
    `${home}/.npmrc`,
    `${home}/.pypirc`,
    `${home}/.pgpass`,
    `${home}/.git-credentials`,
    `${home}/.config/git/credentials`,
  ])("flags dev-box credential store %s", (p) => {
    expect(guard.isProtectedFilePath(p)).toBe(true);
  });

  it.each([
    `${home}/notopenclaw/file.txt`,   // .openclaw pattern must not match without the dot
    `${home}/my.openclaw-backup/x`,   // trailing char is '-', not '/'
    `${home}/.ssh-notes.txt`,         // .ssh must be a full segment
    `${home}/hermes-notes/todo.md`,   // .hermes must be a full dot-segment
    `${home}/.hermes-backup.txt`,
    `${home}/.config/git/config`,     // gitconfig is NOT the credential file
    `${home}/project/.npmrc.example`, // basename must match exactly
  ])("does NOT over-block %s", (p) => {
    expect(guard.isProtectedFilePath(p)).toBe(false);
  });

  it.each([
    `${home}/Documents/notes.txt`,
    `${home}/Downloads/photo.png`,
    `${home}/Desktop/config.json`, // a config.json OUTSIDE the data dir is fine
    `${home}/project/src/index.ts`,
  ])("allows ordinary file %s", (p) => {
    expect(guard.isProtectedFilePath(p)).toBe(false);
  });

  it("judges a deep new path under a link by where it would land", () => {
    // `~/link -> ~/.ssh`, then `link/newdir/key`: neither the leaf nor its
    // parent exists, so a resolve of either fails and the typed spelling —
    // which names no store — used to be the verdict. The nearest existing
    // ancestor is what a write would actually go under.
    const secretDir = path.join(TEST_ROOT, ".ssh");
    fs.mkdirSync(secretDir, { recursive: true });
    const link = path.join(TEST_ROOT, "deep-link");
    try {
      fs.symlinkSync(secretDir, link, "dir");
    } catch {
      return;
    }
    expect(guard.isProtectedFilePath(path.join(link, "newdir", "key"))).toBe(true);
    expect(guard.isProtectedFilePath(path.join(link, "a", "b", "c", "key"))).toBe(true);
  });

  it("defeats an in-base symlink pointing at a secret dir (CWE-59)", () => {
    // Real secret dir + an innocuously-named symlink to it. Resolving the link
    // must still classify the target as protected.
    const secretDir = path.join(TEST_ROOT, ".ssh");
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, "id_rsa"), "KEY");
    const link = path.join(TEST_ROOT, "innocent-link");
    try {
      fs.symlinkSync(secretDir, link, "dir");
    } catch {
      // Some CI filesystems disallow symlinks — skip rather than fail.
      return;
    }
    expect(guard.isProtectedFilePath(path.join(link, "id_rsa"))).toBe(true);
  });
});

describe("canonicalPath", () => {
  it("is the realpath of a path that exists", () => {
    expect(guard.canonicalPath(DATA_DIR)).toBe(fs.realpathSync(DATA_DIR));
  });

  it("resolves the nearest existing ancestor and re-joins the rest", () => {
    const real = fs.realpathSync(TEST_ROOT);
    expect(guard.canonicalPath(path.join(TEST_ROOT, "missing", "deeper", "file.txt")))
      .toBe(path.join(real, "missing", "deeper", "file.txt"));
  });

  it("follows a link on the way down", () => {
    const target = path.join(TEST_ROOT, "canon-target");
    fs.mkdirSync(target, { recursive: true });
    const link = path.join(TEST_ROOT, "canon-link");
    try {
      fs.symlinkSync(target, link, "dir");
    } catch {
      return;
    }
    expect(guard.canonicalPath(path.join(link, "new", "x")))
      .toBe(path.join(fs.realpathSync(target), "new", "x"));
  });

  it("follows a dangling leaf link to the name the kernel would create", () => {
    // `realpathSync` refuses this exactly as it refuses a missing file, and
    // re-joining the basename onto the resolved parent answered the link's
    // own path — where nothing lands: open(2) creates the TARGET.
    const target = path.join(TEST_ROOT, "canon-absent", "new.txt");
    const link = path.join(TEST_ROOT, "canon-dangling");
    try {
      fs.symlinkSync(target, link);
    } catch {
      return;
    }
    expect(guard.canonicalPath(link))
      .toBe(path.join(fs.realpathSync(TEST_ROOT), "canon-absent", "new.txt"));
    // …and a path BELOW a dangling directory link lands under the target too.
    expect(guard.canonicalPath(path.join(link, "deeper")))
      .toBe(path.join(fs.realpathSync(TEST_ROOT), "canon-absent", "new.txt", "deeper"));
  });

  it("resolves a relative dangling target against the link's own directory", () => {
    const holder = path.join(TEST_ROOT, "canon-rel");
    fs.mkdirSync(holder, { recursive: true });
    const link = path.join(holder, "up");
    try {
      fs.symlinkSync(path.join("..", "canon-rel-target", "f"), link);
    } catch {
      return;
    }
    expect(guard.canonicalPath(link))
      .toBe(path.join(fs.realpathSync(TEST_ROOT), "canon-rel-target", "f"));
  });

  it("answers null for a cycle of links rather than walking it forever", () => {
    const a = path.join(TEST_ROOT, "canon-loop-a");
    const b = path.join(TEST_ROOT, "canon-loop-b");
    try {
      fs.symlinkSync(b, a);
      fs.symlinkSync(a, b);
    } catch {
      return;
    }
    expect(guard.canonicalPath(a)).toBeNull();
    expect(guard.canonicalPath(path.join(a, "x"))).toBeNull();
  });
});

describe("isProtectedFilePath through a dangling link", () => {
  it("flags a dangling link whose target would be created inside a credential store", () => {
    // `~/proj/keys.txt -> ~/.ssh/authorized_keys` with the target absent: the
    // link's own spelling names no store, its parent is an ordinary folder,
    // and a write through it creates the key file. Verified on the box before
    // this: the parent-and-basename fallback answered false here.
    fs.mkdirSync(path.join(TEST_ROOT, ".ssh"), { recursive: true });
    const link = path.join(TEST_ROOT, "proj-keys.txt");
    try {
      fs.symlinkSync(path.join(TEST_ROOT, ".ssh", "authorized_keys"), link);
    } catch {
      return;
    }
    expect(fs.existsSync(path.join(TEST_ROOT, ".ssh", "authorized_keys"))).toBe(false);
    expect(guard.isProtectedFilePath(link)).toBe(true);
  });

  it("flags a dangling link whose target would be created inside the data dir", () => {
    const link = path.join(TEST_ROOT, "proj-config.json");
    try {
      fs.symlinkSync(path.join(DATA_DIR, "not-yet.json"), link);
    } catch {
      return;
    }
    expect(guard.isProtectedFilePath(link)).toBe(true);
  });

  it("leaves a dangling link into an ordinary place alone", () => {
    const link = path.join(TEST_ROOT, "proj-latest.log");
    try {
      fs.symlinkSync(path.join(TEST_ROOT, "logs", "today.log"), link);
    } catch {
      return;
    }
    expect(guard.isProtectedFilePath(link)).toBe(false);
  });
});

describe("isProtectedResolvedPath", () => {
  it("applies the inventory to the path as given, without a resolve", () => {
    expect(guard.isProtectedResolvedPath("/home/clawbox/.ssh/id_rsa")).toBe(true);
    expect(guard.isProtectedResolvedPath(path.join(DATA_DIR, "config.json"))).toBe(true);
    expect(guard.isProtectedResolvedPath("/home/clawbox/Documents/notes.txt")).toBe(false);
  });
});

// Listability and mutability are two answers. `isProtectedFilePath(DATA_DIR)`
// is false so the Files app can open it; `isProtectedContainer(DATA_DIR)` is
// true so nothing can rename or delete it.
describe("isProtectedContainer", () => {
  let home: string;

  beforeAll(() => {
    // The browse root is the test root, the arrangement the device has: the
    // checkout (and so the data dir) sits under the home the Files app browses.
    process.env.FILES_ROOT = TEST_ROOT;
    home = TEST_ROOT;
  });

  afterAll(() => {
    delete process.env.FILES_ROOT;
  });

  it("holds for the data dir and every ancestor of it", () => {
    expect(guard.isProtectedContainer(DATA_DIR)).toBe(true);
    expect(guard.isProtectedContainer(path.dirname(DATA_DIR))).toBe(true);
    // …while the same directory stays openable for the listing.
    expect(guard.isProtectedFilePath(DATA_DIR)).toBe(false);
  });

  it("holds for the browse root itself", () => {
    expect(guard.isProtectedContainer(home)).toBe(true);
  });

  it("holds for the parent of a two-segment credential store", () => {
    expect(guard.isProtectedContainer(path.join(home, ".config"))).toBe(true);
  });

  it("does not hold for a sibling or a near-miss", () => {
    expect(guard.isProtectedContainer(path.join(home, ".config-old"))).toBe(false);
    expect(guard.isProtectedContainer(path.join(TEST_ROOT, "data-backup"))).toBe(false);
    expect(guard.isProtectedContainer(path.join(home, "Documents"))).toBe(false);
  });

  it("does not hold for the contents of the data dir, which are the other rule's", () => {
    // A file inside data/ is refused by isProtectedFilePath already; the
    // container rule is about the directories ABOVE the stores.
    expect(guard.isProtectedContainer(path.join(DATA_DIR, "webapps"))).toBe(false);
  });

  it("recognises the data dir through a link", () => {
    const link = path.join(TEST_ROOT, "container-link");
    try {
      fs.symlinkSync(TEST_ROOT, link, "dir");
    } catch {
      return;
    }
    expect(guard.isProtectedContainer(path.join(link, "data"))).toBe(true);
  });
});
