/**
 * What of a project folder goes up in an uploaded deployment.
 *
 * The property that matters most: **the ignore rule is git's, not ours.** A
 * deploy of a folder the coding agent has been working in is a deploy of
 * somebody's real project, and the thing that must never be uploaded is the
 * thing they already told git not to track — `.env`, a key, a database dump.
 * So where the folder is a repository, `git ls-files --cached --others
 * --exclude-standard` IS the list; a second matcher written here would be a
 * worse copy of a rule the folder already states, and being wrong about it is a
 * credential on somebody else's servers.
 *
 * And three more:
 *  - a SYMLINK is never followed and never uploaded. A run can write one, and
 *    `data/` — which holds this box's credential stores — is one `ln -s` away
 *    from the internet otherwise;
 *  - `.git`, `node_modules` and `.clawbox` are skipped whatever git says,
 *    because a repository whose ignores do not cover them still must not
 *    upload its own history or a second copy of itself;
 *  - a folder with no repository still deploys, on the weaker rule, and says so
 *    (`usedGit: false`) rather than letting a caller assume otherwise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { collectDeployFiles, sha1Of, MAX_DEPLOY_FILES } from "@/lib/vercel-files";

// Starts a real process (git): vitest's 5 s test and 10 s hook defaults are not
// enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let dir: string;

function write(rel: string, body: string) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function gitInit() {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
}

function names(files: { file: string }[]): string[] {
  return files.map((f) => f.file).sort();
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-deploy-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("a folder that is a git repository", () => {
  it("uploads what git tracks and what git does not ignore — and nothing it does", async () => {
    gitInit();
    write("index.html", "<h1>hi</h1>");
    write("src/app.js", "console.log(1)");
    write(".gitignore", "secret.env\ndist/\n");
    write("secret.env", "API_KEY=hunter2hunter2");
    write("dist/bundle.js", "built");
    const got = await collectDeployFiles(dir);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.usedGit).toBe(true);
    expect(names(got.files)).toEqual([".gitignore", "index.html", "src/app.js"]);
    // The whole point: the credential the owner told git to ignore is not in
    // the payload, under any name.
    expect(JSON.stringify(got.files)).not.toContain("hunter2hunter2");
  });

  it("skips .git, node_modules and .clawbox even when the repository does not ignore them", async () => {
    gitInit();
    write("index.html", "x");
    write("node_modules/left-pad/index.js", "pad");
    write(".clawbox/worktrees/run-1/index.html", "a copy of the project");
    const got = await collectDeployFiles(dir);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(names(got.files)).toEqual(["index.html"]);
  });

  it("keeps a filename's own whitespace, which git permits and -z carries", async () => {
    gitInit();
    write("index.html", "x");
    write("report ", "trailing space is a legal filename");
    const got = await collectDeployFiles(dir);
    expect(got.ok).toBe(true);
    // Trimming each path changed it before it was opened, so the tracked file
    // was dropped from the deployment.
    expect(got.ok && names(got.files)).toEqual(["index.html", "report "]);
  });

  it("keeps a credential-shaped name out even when git TRACKS it", async () => {
    // A run can write a .env, commit it and ask for a deployment, after which
    // the file is served on an address anybody with the link can open. What
    // git ignores is still git's to decide; this is the floor underneath it.
    gitInit();
    write("index.html", "x");
    write(".env", "API_KEY=hunter2hunter2");
    write("deploy.pem", "-----BEGIN KEY-----");
    // An ssh key is as often named this way as `id_rsa`, and an
    // alphanumeric-only suffix let both of these through.
    write("id_rsa_backup", "-----BEGIN OPENSSH PRIVATE KEY-----");
    write("id_ed25519-old", "-----BEGIN OPENSSH PRIVATE KEY-----");
    execFileSync("git", ["add", "-A", "-f"], { cwd: dir });
    const got = await collectDeployFiles(dir);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(names(got.files)).toEqual(["index.html"]);
    expect(JSON.stringify(got.files)).not.toContain("hunter2hunter2");
    expect(JSON.stringify(got.files)).not.toContain("OPENSSH PRIVATE KEY");
    // And it is REPORTED rather than dropped silently: an owner who tracked it
    // on purpose is entitled to know it did not go up.
    expect(got.skipped.sort()).toEqual([".env", "deploy.pem", "id_ed25519-old", "id_rsa_backup"]);
  });

  it("hashes each file the way Vercel addresses it", async () => {
    gitInit();
    write("index.html", "hello");
    const got = await collectDeployFiles(dir);
    expect(got.ok && got.files[0].sha).toBe(sha1Of(Buffer.from("hello")));
    expect(got.ok && got.files[0].size).toBe(5);
  });
});

describe("when git cannot say what the project ignores", () => {
  it("REFUSES a repository rather than falling back to an unrestricted walk", async () => {
    gitInit();
    write("index.html", "x");
    write(".gitignore", "secret.env\n");
    write("secret.env", "API_KEY=hunter2hunter2");
    // A git that fails or times out in a repository must not become "upload
    // everything": .gitignore is what keeps a .env out of a deployment.
    const broken = path.join(dir, "no-git-here");
    fs.mkdirSync(broken);
    fs.renameSync(path.join(dir, ".git"), path.join(broken, "moved"));
    // `.git` is now a FILE-shaped absence: put a plain file there, which is
    // what a worktree checkout looks like and what git will refuse to read.
    fs.writeFileSync(path.join(dir, ".git"), "not a gitdir");
    const got = await collectDeployFiles(dir);
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.code).toBe("ignores_unreadable");
  });
});

describe("a folder that is not a repository", () => {
  it("still deploys, on the weaker rule, and says the rule was weaker", async () => {
    write("index.html", "x");
    write("node_modules/a/b.js", "dep");
    const got = await collectDeployFiles(dir);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // An owner is entitled to know their own ignore rules were not what decided.
    expect(got.usedGit).toBe(false);
    expect(names(got.files)).toEqual(["index.html"]);
  });

  it("still keeps the credential-shaped names out — the walk has no .gitignore to honour", async () => {
    write("index.html", "x");
    write(".env", "API_KEY=hunter2hunter2");
    write(".env.production", "API_KEY=hunter2hunter2");
    write("deploy.pem", "-----BEGIN KEY-----");
    const got = await collectDeployFiles(dir);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(names(got.files)).toEqual(["index.html"]);
    expect(JSON.stringify(got.files)).not.toContain("hunter2hunter2");
    // Reported here too: a rule that is silent on one path and spoken on the
    // other is a rule nobody can check.
    expect(got.skipped.sort()).toEqual([".env", ".env.production", "deploy.pem"]);
  });
});

describe("symlinks", () => {
  it("are never followed and never uploaded, on either path", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-secrets-"));
    fs.writeFileSync(path.join(outside, "config.json"), '{"token":"hunter2hunter2"}');
    try {
      write("index.html", "x");
      fs.symlinkSync(path.join(outside, "config.json"), path.join(dir, "stolen.json"));
      fs.symlinkSync(outside, path.join(dir, "stolen-dir"));
      const walked = await collectDeployFiles(dir);
      expect(walked.ok && names(walked.files)).toEqual(["index.html"]);

      // And with git, which lists a symlink as an ordinary path — there the
      // refusal is `O_NOFOLLOW` on the one descriptor each file is read
      // through, which is also what closes the window between checking a path
      // and reading it.
      gitInit();
      const listed = await collectDeployFiles(dir);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.usedGit).toBe(true);
      expect(names(listed.files)).toEqual(["index.html"]);
      expect(JSON.stringify(listed.files)).not.toContain("hunter2hunter2");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("a folder symlink planted inside the project", () => {
  it("does not get its contents uploaded, even when the name reads as inside", async () => {
    // O_NOFOLLOW refuses a link at the FINAL component only, so the guard that
    // has to catch this is the realpath'd PARENT — the second stage.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-secrets-"));
    fs.writeFileSync(path.join(outside, "config.json"), '{"token":"hunter2hunter2"}');
    try {
      write("index.html", "x");
      fs.symlinkSync(outside, path.join(dir, "assets"));
      // The name a caller could hand in reads as inside the project; the file
      // it names is not.
      const got = await collectDeployFiles(dir);
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(names(got.files)).toEqual(["index.html"]);
      expect(JSON.stringify(got.files)).not.toContain("hunter2hunter2");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("what is refused", () => {
  it("refuses an empty folder with a sentence rather than deploying nothing", async () => {
    const got = await collectDeployFiles(dir);
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.code).toBe("empty");
  });

  it("refuses a folder with more files than this box uploads", async () => {
    // Cheaper than making MAX_DEPLOY_FILES real files: one folder, many names,
    // and the walk's own count is what trips.
    for (let i = 0; i <= MAX_DEPLOY_FILES + 1; i++) write(`f${i}.txt`, "x");
    const got = await collectDeployFiles(dir);
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.code).toBe("too_many_files");
  });

  it("says which folder could not be read rather than throwing", async () => {
    const got = await collectDeployFiles(path.join(dir, "not-there"));
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.code).toBe("unreadable");
  });
});
