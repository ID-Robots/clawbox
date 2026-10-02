/**
 * What never leaves the box in a Projects → GitHub backup (TASK-1358): the
 * safe `.gitignore` merge, the check before every commit, repository names,
 * and remote addresses as the owner sees them. Pure, plus a temp folder for
 * the files the check reads.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  describeRemote,
  firstFreeRepoName,
  looksLikeSecretContent,
  looksLikeSecretName,
  mergeGitignore,
  preflight,
  repoNameCandidates,
  SAFE_GITIGNORE_HEADER,
  SAFE_GITIGNORE_PATTERNS,
  sanitizeRepoName,
  scrubSecrets,
} from "@/lib/project-backup-safety";
import { LARGE_FILE_BYTES } from "@/lib/project-backup-shared";

// Built at run time, never written out whole: a realistic token in this repo's
// own source is exactly what GitHub's push protection exists to stop.
const FAKE_GHP = ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
const FAKE_PAT = ["github", "_pat_", "11ABCDEFG0123456789_abcdefghijklmnopqrstuv"].join("");
const FAKE_SK = ["sk", "-ant-", "api03-abcdefghijklmnopqrstuvwxyz012345"].join("");
const FAKE_AKIA = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
const FAKE_XOX = ["xox", "b-", "123456789012-abcdefghijkl"].join("");
const PEM_HEAD = ["-----BEGIN", " OPENSSH PRIVATE", " KEY-----"].join("");

describe("mergeGitignore", () => {
  it("writes the whole safe list under a header when there is no .gitignore", () => {
    const { text, added } = mergeGitignore(null);
    expect(added).toEqual([...SAFE_GITIGNORE_PATTERNS]);
    const lines = text.split("\n");
    expect(lines[0]).toBe(SAFE_GITIGNORE_HEADER);
    for (const p of [".env*", "*.pem", "*.key", "id_rsa*", "*.p12", "credentials*", "secrets*", "node_modules/", ".venv/", "__pycache__/", "dist/", ".next/", "build/", "*.log", ".DS_Store", "*.gguf", "*.safetensors", "*.onnx"]) {
      expect(lines, p).toContain(p);
    }
    expect(text.endsWith("\n")).toBe(true);
  });

  it("keeps every line of the owner's file, in its order, and appends only what is missing", () => {
    const own = "# my rules\nnode_modules/\n!keep.key\ncoverage\n*.log";
    const { text, added } = mergeGitignore(own);
    expect(text.startsWith(`${own}\n\n`)).toBe(true);
    expect(added).not.toContain("node_modules/");
    expect(added).not.toContain("*.log");
    expect(added).toContain(".env*");
    // The owner's own exception is still there, untouched.
    expect(text).toContain("!keep.key\ncoverage\n");
  });

  it("is idempotent: a second merge adds nothing and changes nothing", () => {
    const once = mergeGitignore("dist/\n").text;
    const twice = mergeGitignore(once);
    expect(twice.added).toEqual([]);
    expect(twice.text).toBe(once);
  });

  it("does not repeat its header when a later release adds a pattern", () => {
    const old = `${SAFE_GITIGNORE_HEADER}\n.env*\n`;
    const { text } = mergeGitignore(old);
    expect(text.split(SAFE_GITIGNORE_HEADER).length).toBe(2);
  });

  it("follows a Windows-style file's line endings", () => {
    const { text } = mergeGitignore("dist/\r\nbuild/\r\n");
    expect(text.startsWith("dist/\r\nbuild/\r\n\r\n")).toBe(true);
    expect(text).toContain("\r\n.env*\r\n");
  });

  it("does not count a commented-out pattern as present", () => {
    expect(mergeGitignore("# .env*\n").added).toContain(".env*");
  });
});

describe("the check before every commit", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "project-backup-preflight-"));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "README.md"), "# my site\nAsk the desk-top team; we use sk-learn.\n");
    fs.writeFileSync(path.join(dir, "src", "app.js"), "console.log('hello')\n");
    fs.writeFileSync(path.join(dir, ".env"), "PASSWORD=hunter2\n");
    fs.writeFileSync(path.join(dir, "src", "config.js"), `export const token = "${FAKE_GHP}";\n`);
    fs.writeFileSync(path.join(dir, "notes.txt"), `lots of words\n${PEM_HEAD}\nabc\n`);
    // 60 MB without writing 60 MB: a sparse file has the size and none of the blocks.
    const big = path.join(dir, "model.bin");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, 60 * 1024 * 1024);
    fs.symlinkSync("/etc/passwd", path.join(dir, "link-to-elsewhere"));
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("leaves out a .env, a file holding a ghp_ token, a private key and a 60 MB file — and says why", () => {
    const { safe, leftOut } = preflight(dir, [
      { path: "README.md" },
      { path: "src/app.js" },
      { path: ".env" },
      { path: "src/config.js" },
      { path: "notes.txt" },
      { path: "model.bin" },
      { path: "link-to-elsewhere" },
      { path: "vendor/other-repo/" },
      { path: "gone.txt", deleted: true },
    ]);
    expect(safe).toEqual(["README.md", "src/app.js", "link-to-elsewhere", "gone.txt"]);
    expect(leftOut).toEqual([
      { path: ".env", reason: "secret_name" },
      { path: "src/config.js", reason: "secret_content" },
      { path: "notes.txt", reason: "secret_content" },
      { path: "model.bin", reason: "too_large" },
      { path: "vendor/other-repo", reason: "nested_git" },
    ]);
  });

  it("measures 'too big' at exactly 50 MB", () => {
    expect(LARGE_FILE_BYTES).toBe(50 * 1024 * 1024);
    const edge = path.join(dir, "edge.bin");
    fs.writeFileSync(edge, "");
    fs.truncateSync(edge, LARGE_FILE_BYTES);
    expect(preflight(dir, [{ path: "edge.bin" }]).safe).toEqual(["edge.bin"]);
    fs.truncateSync(edge, LARGE_FILE_BYTES + 1);
    expect(preflight(dir, [{ path: "edge.bin" }]).leftOut).toEqual([{ path: "edge.bin", reason: "too_large" }]);
  });

  it("never reads through a link (the target's bytes are not what git stores)", () => {
    // /etc/passwd holds nothing secret-shaped anyway; the point is the link is judged by name only.
    expect(preflight(dir, [{ path: "link-to-elsewhere" }]).leftOut).toEqual([]);
  });

  it("judges names by every folder on the path, the way a .gitignore pattern does", () => {
    for (const name of [".env", ".env.local", ".envrc", "server.pem", "tls.key", "id_rsa", "id_ed25519.pub", "cert.p12", "credentials.json", "secrets.yaml", "secrets/db.txt", "config/credentials/x.json", ".netrc", ".git-credentials", "keys/CLIENT.PEM"]) {
      expect(looksLikeSecretName(name), name).toBe(true);
    }
    for (const name of ["src/app.ts", "environment.md", "docs/keyboard.md", "my-secret-garden/readme.md", "README.md", "package.json"]) {
      expect(looksLikeSecretName(name), name).toBe(false);
    }
  });

  it("knows the common token prefixes and private-key headers, and not prose that merely contains the letters", () => {
    for (const s of [FAKE_GHP, FAKE_PAT, FAKE_SK, FAKE_AKIA, FAKE_XOX, PEM_HEAD, "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN PGP PRIVATE KEY BLOCK-----"]) {
      expect(looksLikeSecretContent(`x = ${s}\n`), s.slice(0, 12)).toBe(true);
    }
    for (const s of ["ask the desk-top team", "pip install sk-learn", "task-runner-for-everyone-forever", "ghp_short", "AKIA is a prefix", "-----BEGIN PUBLIC KEY-----"]) {
      expect(looksLikeSecretContent(s), s).toBe(false);
    }
  });
});

describe("repository names", () => {
  it("turns a folder name into one GitHub accepts", () => {
    expect(sanitizeRepoName("My Site")).toBe("My-Site");
    expect(sanitizeRepoName("Café Menü 2026!")).toBe("Cafe-Menu-2026");
    expect(sanitizeRepoName("  ..hidden--project..  ")).toBe("hidden-project");
    expect(sanitizeRepoName("site.git")).toBe("site");
    expect(sanitizeRepoName("a/b\\c")).toBe("a-b-c");
    expect(sanitizeRepoName("ok_name-1.2")).toBe("ok_name-1.2");
  });

  it("falls back to clawbox-project when nothing usable is left", () => {
    expect(sanitizeRepoName("Проект")).toBe("clawbox-project");
    expect(sanitizeRepoName("…")).toBe("clawbox-project");
    expect(sanitizeRepoName("..")).toBe("clawbox-project");
    expect(sanitizeRepoName("")).toBe("clawbox-project");
  });

  it("leaves room for a -20 within GitHub's 100 characters", () => {
    const name = sanitizeRepoName("x".repeat(300));
    expect(name.length).toBe(90);
    expect(`${name}-20`.length).toBeLessThanOrEqual(100);
  });

  it("offers name, name-2, name-3 … name-20", () => {
    const c = repoNameCandidates("site");
    expect(c.slice(0, 3)).toEqual(["site", "site-2", "site-3"]);
    expect(c).toHaveLength(20);
    expect(c.at(-1)).toBe("site-20");
  });

  it("on a clash suggests the next free -N and says which name was taken", async () => {
    const taken = new Set(["site", "site-2"]);
    const asked: string[] = [];
    const out = await firstFreeRepoName("site", async (n) => { asked.push(n); return taken.has(n); });
    expect(out).toEqual({ ok: true, name: "site-3", taken: "site" });
    expect(asked).toEqual(["site", "site-2", "site-3"]);
  });

  it("answers the name itself when it is free", async () => {
    expect(await firstFreeRepoName("site", async () => false)).toEqual({ ok: true, name: "site", taken: null });
  });

  it("stops at the first answer it could not get — never guesses a name is free", async () => {
    const out = await firstFreeRepoName("site", async (n) => (n === "site" ? true : null));
    expect(out).toEqual({ ok: false, reason: "unreachable" });
  });

  it("gives up after twenty tries instead of walking GitHub forever", async () => {
    expect(await firstFreeRepoName("site", async () => true)).toEqual({ ok: false, reason: "exhausted" });
  });
});

describe("remotes, as the owner sees them", () => {
  it("takes the password or token out of an address", () => {
    const d = describeRemote(`https://someone:${FAKE_GHP}@github.com/acme/site.git`);
    expect(d).toEqual({ label: "github.com/acme/site", webUrl: "https://github.com/acme/site" });
    expect(JSON.stringify(d)).not.toContain(FAKE_GHP);
    expect(JSON.stringify(d)).not.toContain("someone");
  });

  it("reads scp-style and ssh:// addresses, and other hosts without a web link", () => {
    expect(describeRemote("git@github.com:acme/site.git")).toEqual({ label: "github.com/acme/site", webUrl: "https://github.com/acme/site" });
    expect(describeRemote("ssh://git@gitlab.example.com:2222/team/app.git")).toEqual({ label: "gitlab.example.com/team/app", webUrl: null });
    expect(describeRemote("https://x-access-token:abc@gitlab.com/g/p")).toEqual({ label: "gitlab.com/g/p", webUrl: null });
  });

  it("shows a remote on this box by its path", () => {
    expect(describeRemote("/srv/git/site.git").label).toBe("srv/git/site");
    expect(describeRemote("file:///srv/git/site.git")).toEqual({ label: "srv/git/site", webUrl: null });
  });

  it("scrubs addresses and token shapes out of anything git said", () => {
    const said = `fatal: unable to access 'https://me:${FAKE_GHP}@github.com/acme/site.git/': 403\nhint: token ${FAKE_PAT}`;
    const out = scrubSecrets(said);
    expect(out).not.toContain(FAKE_GHP);
    expect(out).not.toContain(FAKE_PAT);
    expect(out).not.toContain("me:");
    expect(out).toContain("https://github.com/acme/site.git");
  });
});
