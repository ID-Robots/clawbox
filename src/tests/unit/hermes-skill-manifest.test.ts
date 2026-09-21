import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  diffManifest,
  fetchGithubBlob,
  gitBlobSha,
  githubTreeManifest,
  isSafeRelativePath,
  listSkillFiles,
  referencedPaths,
  referencedSupportPaths,
  removeSkillDir,
  repairFromGithub,
} from '@/lib/hermes-skill-manifest';

/**
 * TASK-452 / crit9a + crit9b — the completeness half.
 *
 * The device's installer decides which support files to fetch by running a
 * regex over SKILL.md's prose, and that regex requires a `](`, a backtick or
 * whitespace immediately to the left of the path. Two upstream skills prove
 * what that misses, and both fixtures below are the real files' shapes:
 *
 *   algorithmic-art  `**templates/generator_template.js**` (bold, no matching
 *                    left delimiter) and a root-level LICENSE.txt named only in
 *                    the frontmatter → 2 of 4 files installed;
 *   pdf              REFERENCE.md and FORMS.md named in running prose, plus
 *                    eight scripts/*.py → 1 of 12 files installed.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ALGORITHMIC_ART_SKILL_MD = `---
name: algorithmic-art
description: Creating algorithmic art using p5.js.
license: Complete terms in LICENSE.txt
---

# Algorithmic art

See the [viewer](templates/viewer.html) for the harness.

- **templates/generator_template.js**: Reference for p5.js best practices.
- Read \`scripts/render.py\` before changing the pipeline.

Full docs at https://example.com/docs/generator_template.js — not a local file.
`;

const PDF_SKILL_MD = `---
name: pdf
description: Work with PDF files.
---

For advanced features, JavaScript libraries, and detailed examples, see REFERENCE.md.
If you need to fill out a PDF form, read FORMS.md and follow its instructions.

Write your results to report.md when you are done, and dump the raw table to output.json.
`;

describe('referencedPaths (TASK-452)', () => {
  it('finds the bold path the shipped installer regex drops', () => {
    expect(referencedPaths(ALGORITHMIC_ART_SKILL_MD)).toContain('templates/generator_template.js');
  });

  it('finds the frontmatter LICENSE.txt and the markdown-link and backticked paths', () => {
    const found = referencedPaths(ALGORITHMIC_ART_SKILL_MD);
    expect(found).toContain('LICENSE.txt');
    expect(found).toContain('templates/viewer.html');
    expect(found).toContain('scripts/render.py');
  });

  it('finds the bare prose filenames that made the pdf skill a one-file stub', () => {
    const found = referencedPaths(PDF_SKILL_MD);
    expect(found).toContain('REFERENCE.md');
    expect(found).toContain('FORMS.md');
  });

  it('never treats a URL path as a local file', () => {
    // The docs URL above ends in the same basename as the real template.
    const found = referencedPaths(ALGORITHMIC_ART_SKILL_MD);
    expect(found).not.toContain('docs/generator_template.js');
    expect(found.some((p) => p.includes('example.com'))).toBe(false);
  });

  it('never yields SKILL.md itself, traversal or absolute paths', () => {
    const md = 'See SKILL.md, ../../etc/passwd.txt and /etc/shadow.txt.';
    const found = referencedPaths(md);
    expect(found).not.toContain('SKILL.md');
    expect(found.some((p) => p.includes('..') || p.startsWith('/'))).toBe(false);
  });
});

describe('referencedSupportPaths (TASK-452)', () => {
  it('keeps the files a skill ships', () => {
    expect(referencedSupportPaths(ALGORITHMIC_ART_SKILL_MD).sort()).toEqual([
      'LICENSE.txt',
      'scripts/render.py',
      'templates/generator_template.js',
      'templates/viewer.html',
    ]);
    expect(referencedSupportPaths(PDF_SKILL_MD).sort()).toEqual(['FORMS.md', 'REFERENCE.md']);
  });

  it('drops the files a skill tells the agent to WRITE', () => {
    // This origin has no hashes and no authoritative list, so a false positive
    // here refuses an install rather than merely warning. `report.md` and
    // `output.json` are outputs, not payload — they must never be "missing".
    const found = referencedSupportPaths(PDF_SKILL_MD);
    expect(found).not.toContain('report.md');
    expect(found).not.toContain('output.json');
  });
});

describe('isSafeRelativePath', () => {
  it.each([
    ['scripts/run.py', true],
    ['LICENSE.txt', true],
    ['.curated/pdf.md', true],
    ['../escape.md', false],
    ['/etc/passwd', false],
    ['C:\\win.txt', false],
    ['a/b/c/d/e/f/g.md', false],
    ['', false],
  ])('%s -> %s', (input, expected) => {
    expect(isSafeRelativePath(input)).toBe(expected);
  });
});

describe('gitBlobSha', () => {
  it('matches what git itself computes', () => {
    const content = Buffer.from('hello\n');
    // The canonical example: `printf 'hello\\n' | git hash-object --stdin`.
    expect(gitBlobSha(content)).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    // And against the local git, so the assertion cannot drift from reality.
    const fromGit = execFileSync('git', ['hash-object', '--stdin'], { input: content })
      .toString()
      .trim();
    expect(gitBlobSha(content)).toBe(fromGit);
  });
});

// ── GitHub tree + blob ─────────────────────────────────────────────────────

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 404,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

const ART_TREE = {
  truncated: false,
  tree: [
    { path: 'README.md', type: 'blob', mode: '100644', size: 10, sha: 'a'.repeat(40) },
    { path: 'skills/algorithmic-art/SKILL.md', type: 'blob', mode: '100644', size: 100, sha: 'b'.repeat(40) },
    { path: 'skills/algorithmic-art/LICENSE.txt', type: 'blob', mode: '100644', size: 20, sha: 'c'.repeat(40) },
    { path: 'skills/algorithmic-art/templates', type: 'tree', mode: '040000' },
    { path: 'skills/algorithmic-art/templates/viewer.html', type: 'blob', mode: '100644', size: 30, sha: 'd'.repeat(40) },
    { path: 'skills/algorithmic-art/templates/generator_template.js', type: 'blob', mode: '100644', size: 40, sha: 'e'.repeat(40) },
    // Neither of these is content we will ever materialise on the device.
    { path: 'skills/algorithmic-art/link.md', type: 'blob', mode: '120000', size: 12, sha: 'f'.repeat(40) },
    { path: 'skills/algorithmic-art/vendor', type: 'commit', mode: '160000', sha: '0'.repeat(40) },
  ],
};

describe('githubTreeManifest (TASK-452)', () => {
  it('returns exactly the skill directory, relative, with sizes and object ids', async () => {
    const files = await githubTreeManifest('anthropics/skills', 'skills/algorithmic-art', {
      fetchImpl: async () => jsonResponse(ART_TREE),
    });
    expect(files?.map((f) => f.path)).toEqual([
      'LICENSE.txt',
      'SKILL.md',
      'templates/generator_template.js',
      'templates/viewer.html',
    ]);
    expect(files?.find((f) => f.path === 'LICENSE.txt')).toMatchObject({ size: 20, sha: 'c'.repeat(40) });
  });

  it('drops symlink and submodule entries', async () => {
    const files = await githubTreeManifest('anthropics/skills', 'skills/algorithmic-art', {
      fetchImpl: async () => jsonResponse(ART_TREE),
    });
    expect(files?.some((f) => f.path === 'link.md' || f.path === 'vendor')).toBe(false);
  });

  it('refuses a TRUNCATED tree rather than reporting a short file list', async () => {
    // A truncated tree is not a file list; using one would "prove" that files
    // present upstream do not exist, and pass a broken install.
    const files = await githubTreeManifest('anthropics/skills', 'skills/algorithmic-art', {
      fetchImpl: async () => jsonResponse({ ...ART_TREE, truncated: true }),
    });
    expect(files).toBeNull();
  });

  it('returns null when the device is offline, so an install can still proceed', async () => {
    const files = await githubTreeManifest('anthropics/skills', 'skills/algorithmic-art', {
      fetchImpl: async () => {
        throw new Error('ENOTFOUND api.github.com');
      },
    });
    expect(files).toBeNull();
  });

  it('rejects a repo that is not owner/repo', async () => {
    let called = false;
    const files = await githubTreeManifest('../../etc', 'skills/x', {
      fetchImpl: async () => {
        called = true;
        return jsonResponse(ART_TREE);
      },
    });
    expect(files).toBeNull();
    expect(called).toBe(false);
  });
});

describe('fetchGithubBlob (TASK-452)', () => {
  const content = Buffer.from('licence text\n');
  const sha = gitBlobSha(content);

  it('returns bytes that hash back to the object id', async () => {
    const got = await fetchGithubBlob('anthropics/skills', sha, {
      fetchImpl: async () => jsonResponse({ encoding: 'base64', content: content.toString('base64') }),
    });
    expect(got?.toString()).toBe('licence text\n');
  });

  it('refuses bytes that do not', async () => {
    const got = await fetchGithubBlob('anthropics/skills', sha, {
      fetchImpl: async () =>
        jsonResponse({ encoding: 'base64', content: Buffer.from('something else').toString('base64') }),
    });
    expect(got).toBeNull();
  });
});

// ── Diff + repair against a real directory ─────────────────────────────────

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function truncatedInstall(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clawbox-skill-'));
  tmpDirs.push(root);
  const dir = path.join(root, 'algorithmic-art');
  await fs.mkdir(path.join(dir, 'templates'), { recursive: true });
  // Exactly what the device installed on 2026-08-22: 2 of the 4 upstream files.
  await fs.writeFile(path.join(dir, 'SKILL.md'), 'x'.repeat(100));
  await fs.writeFile(path.join(dir, 'templates', 'viewer.html'), 'y'.repeat(30));
  return dir;
}

describe('diffManifest + repairFromGithub (TASK-452)', () => {
  it('names the files the installer skipped', async () => {
    const dir = await truncatedInstall();
    const files = (await githubTreeManifest('anthropics/skills', 'skills/algorithmic-art', {
      fetchImpl: async () => jsonResponse(ART_TREE),
    }))!;
    const diff = diffManifest({ origin: 'github-tree', files, complete: true }, await listSkillFiles(dir));
    expect(diff.missing).toEqual(['LICENSE.txt', 'templates/generator_template.js']);
    expect(diff.expectedCount).toBe(4);
    expect(diff.presentCount).toBe(2);
  });

  it('fetches them, verifies each against its object id, and writes them', async () => {
    const dir = await truncatedInstall();
    const licence = Buffer.from('MIT\n');
    const template = Buffer.from('// p5 template\n');
    const files = [
      { path: 'LICENSE.txt', size: licence.length, sha: gitBlobSha(licence) },
      { path: 'templates/generator_template.js', size: template.length, sha: gitBlobSha(template) },
    ];
    const blobs: Record<string, Buffer> = {
      [gitBlobSha(licence)]: licence,
      [gitBlobSha(template)]: template,
    };
    const result = await repairFromGithub(
      'anthropics/skills',
      dir,
      { origin: 'github-tree', files, complete: true },
      files.map((f) => f.path),
      {
        fetchImpl: async (url) => {
          const sha = url.split('/').pop() as string;
          return jsonResponse({ encoding: 'base64', content: blobs[sha].toString('base64') });
        },
      },
    );
    expect(result.stillMissing).toEqual([]);
    expect(result.repaired.sort()).toEqual(['LICENSE.txt', 'templates/generator_template.js']);
    expect(await fs.readFile(path.join(dir, 'LICENSE.txt'), 'utf8')).toBe('MIT\n');
    expect(await fs.readFile(path.join(dir, 'templates', 'generator_template.js'), 'utf8')).toBe(
      '// p5 template\n',
    );
  });

  it('reports a file it could not obtain instead of writing an unverified one', async () => {
    const dir = await truncatedInstall();
    const licence = Buffer.from('MIT\n');
    const files = [{ path: 'LICENSE.txt', size: 4, sha: gitBlobSha(licence) }];
    const result = await repairFromGithub(
      'anthropics/skills',
      dir,
      { origin: 'github-tree', files, complete: true },
      ['LICENSE.txt'],
      // Wrong bytes for that object id — a tampered or corrupted transfer.
      { fetchImpl: async () => jsonResponse({ encoding: 'base64', content: Buffer.from('gpl').toString('base64') }) },
    );
    expect(result.repaired).toEqual([]);
    expect(result.stillMissing).toEqual(['LICENSE.txt']);
    await expect(fs.access(path.join(dir, 'LICENSE.txt'))).rejects.toThrow();
  });

  // CodeQL js/http-to-file-access on the repair write (PR #465). resolveInside()
  // is a lexical check — path.resolve plus a prefix test — so it proves the
  // manifest path holds no '..' and nothing whatsoever about the file system.
  // These two pin the part the lexical check cannot see.
  it('follows no symlink out of the install directory', async () => {
    const dir = await truncatedInstall();
    const outside = path.join(dir, '..', 'config.yaml');
    await fs.writeFile(outside, 'model: sonnet\n');
    // A dangling or out-of-tree link reads as "missing" to the completeness
    // scan, so this is exactly the shape repair is handed. 'LICENSE.txt' is a
    // legal manifest path; the escape is the link, not the name.
    await fs.symlink(outside, path.join(dir, 'LICENSE.txt'));

    const evil = Buffer.from('pwned\n');
    const result = await repairFromGithub(
      'anthropics/skills',
      dir,
      { origin: 'github-tree', files: [{ path: 'LICENSE.txt', sha: gitBlobSha(evil) }], complete: true },
      ['LICENSE.txt'],
      { fetchImpl: async () => jsonResponse({ encoding: 'base64', content: evil.toString('base64') }) },
    );

    expect(result.repaired).toEqual([]);
    expect(result.stillMissing).toEqual(['LICENSE.txt']);
    expect(await fs.readFile(outside, 'utf8')).toBe('model: sonnet\n');
  });

  it('refuses to overwrite a file that is already there', async () => {
    const dir = await truncatedInstall();
    // Repair only ever creates files the installer failed to write. A target
    // that exists means the premise is wrong, so nothing is written.
    const kept = path.join(dir, 'LICENSE.txt');
    await fs.writeFile(kept, 'MIT\n');

    const other = Buffer.from('GPL\n');
    const result = await repairFromGithub(
      'anthropics/skills',
      dir,
      { origin: 'github-tree', files: [{ path: 'LICENSE.txt', sha: gitBlobSha(other) }], complete: true },
      ['LICENSE.txt'],
      { fetchImpl: async () => jsonResponse({ encoding: 'base64', content: other.toString('base64') }) },
    );

    expect(result.repaired).toEqual([]);
    expect(result.stillMissing).toEqual(['LICENSE.txt']);
    expect(await fs.readFile(kept, 'utf8')).toBe('MIT\n');
  });

  it('never writes outside the install directory', async () => {
    const dir = await truncatedInstall();
    const evil = Buffer.from('pwned\n');
    const result = await repairFromGithub(
      'anthropics/skills',
      dir,
      { origin: 'github-tree', files: [{ path: '../escaped.txt', sha: gitBlobSha(evil) }], complete: true },
      ['../escaped.txt'],
      { fetchImpl: async () => jsonResponse({ encoding: 'base64', content: evil.toString('base64') }) },
    );
    expect(result.stillMissing).toEqual(['../escaped.txt']);
    await expect(fs.access(path.join(dir, '..', 'escaped.txt'))).rejects.toThrow();
  });
});

describe('removeSkillDir', () => {
  it('removes an install path inside the skills root and refuses one outside it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clawbox-skills-root-'));
    tmpDirs.push(root);
    await fs.mkdir(path.join(root, 'algorithmic-art'), { recursive: true });
    await fs.writeFile(path.join(root, 'algorithmic-art', 'SKILL.md'), 'x');
    const outside = path.join(root, 'keep.txt');
    await fs.writeFile(outside, 'keep');

    expect(await removeSkillDir(root, '../keep.txt')).toBe(false);
    await expect(fs.access(outside)).resolves.toBeUndefined();

    expect(await removeSkillDir(root, 'algorithmic-art')).toBe(true);
    await expect(fs.access(path.join(root, 'algorithmic-art'))).rejects.toThrow();
  });
});
