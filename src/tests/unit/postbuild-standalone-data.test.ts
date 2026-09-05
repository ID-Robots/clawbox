import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * F-27 — the standalone build must not ship a copy of the runtime data/ tree.
 *
 * Next traces `data/` into `.next/standalone` because middleware.ts (and the
 * modules it pulls in) resolve `data/` through `process.cwd()`, and Next's own
 * exclude mechanism cannot reach that trace: `outputFileTracingExcludes` is
 * applied per ROUTE only — measured on Next 16.3.3, a route's .nft.json is
 * cleaned by `{"*": ["data/**"]}` while `middleware.js.nft.json` keeps its
 * `../../data/*` entries, with `"**"` no better. See the comment in
 * next.config.ts.
 *
 * What that left on every box: `.next/standalone/data` — 3.2 GB of it, a
 * second copy of the Gemma GGUF, plus build-time copies of the 0600 secrets
 * (.session-secret, .mcp-token, internal-token.env, .hermes-dashboard-pw,
 * .local-ai-token) sitting inside a build artifact, re-made by every build and
 * every update, and never read: `config/clawbox-setup.service` runs the server
 * with WorkingDirectory=/home/clawbox/clawbox and NODE_ENV=production, so every
 * reader resolves data/ from CLAWBOX_ROOT or the absolute default, never from
 * inside the standalone tree.
 *
 * So the postbuild step removes it, and asserts that it is gone — the removal
 * failing silently would put the duplicate straight back.
 *
 * TASK-692 gave the checkout's own `.env` (0600 on a box — the file systemd
 * hands to clawbox-setup, holding GOOGLE_OAUTH_CLIENT_SECRET and, where
 * install.sh was given one, CLAWBOX_AI_API_KEY), every `.env.*` beside it and
 * `.git` the same treatment. Only ONE of the two has a native switch:
 * `writeStandaloneDirectory()` copies `.env`/`.env.production` outside the
 * trace with no config key on that path, so the sweep is the only thing that
 * removes those; `.git` arrives on the instrumentation trace, which
 * `outputFileTracingExcludes` DOES reach (see next.config.ts), so it is
 * excluded there and swept here as the enforced post-condition — these cases
 * plant the copies by hand, so they pin the sweep whatever the trace does.
 * Removing them costs
 * the box nothing — @next/env never overwrites a variable systemd has already
 * set — and the sweep is depth-unbounded because that trace copies whole
 * project subdirectories, `.env` files and all.
 *
 * These tests run the REAL postbuild script out of package.json against a
 * temp tree, so they cannot drift from what ships.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = path.resolve(__dirname, "../../..");
const POSTBUILD: string = JSON.parse(
  fs.readFileSync(path.join(REPO, "package.json"), "utf-8"),
).scripts.postbuild;

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("sh", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

let tmp: string;
let standalone: string;

/** A standalone tree shaped like the one `next build` leaves behind. */
function buildFixture() {
  fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
  // Whatever package.json's postbuild actually invokes has to be in the
  // fixture: write-build-info.mjs, and the step's own script. Copied, not
  // linked, so the fixture is self-contained.
  for (const script of ["write-build-info.mjs", "postbuild.sh"]) {
    const dest = path.join(tmp, "scripts", script);
    fs.copyFileSync(path.join(REPO, "scripts", script), dest);
    fs.chmodSync(dest, 0o755);
  }
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ version: "0.0.0-test" }));

  fs.mkdirSync(path.join(tmp, "public"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "public", "marker.txt"), "public asset\n");
  fs.mkdirSync(path.join(tmp, ".next", "static"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".next", "static", "chunk.js"), "// chunk\n");
  fs.writeFileSync(path.join(tmp, ".next", "BUILD_ID"), "test-build-id\n");

  standalone = path.join(tmp, ".next", "standalone");
  fs.mkdirSync(path.join(standalone, ".next"), { recursive: true });
  fs.writeFileSync(path.join(standalone, "server.js"), "// standalone server\n");

  // scripts/ IS resolved from the process cwd, so it must survive whatever the
  // data/ removal does. Two readers today: system-profile.ts:81
  // (`resolveScript(..., { allowRepoFallback: true })` → `CLAWBOX_ROOT ||
  // process.cwd()`), which stays a cwd reader; and hermes-image-plugin.ts:99,
  // which is one until PR #697 moves it to `resolveConfigRoot()`. Both are
  // named because the invariant is "something still resolves scripts/ from the
  // cwd", and dropping the second early would lose the record if #697 changes
  // shape.
  fs.mkdirSync(path.join(standalone, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(standalone, "scripts", "start-llamacpp.sh"), "#!/bin/sh\n");

  // Decoys: `find -maxdepth 3 -name server.js` reaches package-root server.js
  // files under node_modules (next/, react-dom/ both have one), and readdir
  // order decides which one it hits first. If one of those wins, $SDIR points
  // into node_modules and every removal below is a no-op that still reports
  // success.
  for (const pkg of ["next", "react-dom"]) {
    fs.mkdirSync(path.join(standalone, "node_modules", pkg), { recursive: true });
    fs.writeFileSync(path.join(standalone, "node_modules", pkg, "server.js"), "// decoy\n");
  }

  // What the trace copies in, at the sizes and modes that make it matter.
  const data = path.join(standalone, "data");
  fs.mkdirSync(path.join(data, "llamacpp", "models"), { recursive: true });
  fs.mkdirSync(path.join(data, "webapps", "demo"), { recursive: true });
  fs.writeFileSync(path.join(data, "config.json"), "{}\n");
  fs.writeFileSync(path.join(data, "llamacpp", "models", "model.gguf"), "GGUF");
  fs.writeFileSync(path.join(data, "webapps", "demo", "index.html"), "<html></html>");
  for (const secret of [".session-secret", ".mcp-token", ".local-ai-token", "internal-token.env"]) {
    fs.writeFileSync(path.join(data, secret), "redacted\n", { mode: 0o600 });
  }

  // The two routes TASK-692 closes. `.env`/`.env.production` are copied by
  // Next itself beside the entry; `.git` and the rest of the project root
  // arrive on the instrumentation trace, which is why one of these sits two
  // levels down: `e2e-install/.env.test` is gitignored and its tracked
  // `.example` documents seven provider keys.
  fs.writeFileSync(path.join(standalone, ".env"), "GOOGLE_OAUTH_CLIENT_SECRET=redacted\n", {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(standalone, ".env.production"), "LLAMACPP_REASONING=off\n", {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(standalone, ".env.example"), "ALLOW_INSECURE_CONTROL_UI=\n");
  fs.mkdirSync(path.join(standalone, "e2e-install"), { recursive: true });
  fs.writeFileSync(path.join(standalone, "e2e-install", ".env.test"), "OPENAI_API_KEY=redacted\n", {
    mode: 0o600,
  });
  fs.mkdirSync(path.join(standalone, ".git", "objects"), { recursive: true });
  fs.writeFileSync(path.join(standalone, ".git", "config"), "[core]\n");
  fs.writeFileSync(path.join(standalone, ".git", "objects", "blob"), "object\n");

  // …and one that must SURVIVE. Packages ship their own `.env` fixtures, and
  // a sweep that failed the build over somebody else's test data would be a
  // false failure on a healthy build.
  fs.mkdirSync(path.join(standalone, "node_modules", "dotenv", "tests"), { recursive: true });
  fs.writeFileSync(path.join(standalone, "node_modules", "dotenv", "tests", ".env"), "FIXTURE=1\n");
}

function runPostbuild() {
  return spawnSync("sh", ["-c", POSTBUILD], {
    cwd: tmp,
    encoding: "utf-8",
    // write-build-info.mjs resolves its project dir from CLAWBOX_ROOT first,
    // and the suite sets that globally to a shared temp path — point it at the
    // fixture so the stamp lands where the postbuild step looks for it.
    env: { ...process.env, CLAWBOX_ROOT: tmp },
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-postbuild-"));
  buildFixture();
});

afterEach(() => {
  try {
    fs.chmodSync(standalone, 0o755);
  } catch {
    /* only the permission test changes it */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

d("postbuild step", () => {
  it("removes the traced copy of data/ from the standalone tree", () => {
    const res = runPostbuild();
    expect(res.status, res.stderr).toBe(0);
    expect(fs.existsSync(path.join(standalone, "data"))).toBe(false);
  });

  it("removes every copy of the checkout's .env, wherever the trace put it", () => {
    const res = runPostbuild();
    expect(res.status, res.stderr).toBe(0);
    expect(fs.existsSync(path.join(standalone, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(standalone, ".env.production"))).toBe(false);
    expect(fs.existsSync(path.join(standalone, ".env.example"))).toBe(false);
    // Depth 2: the trace copies whole project subdirectories, so a top-level
    // sweep would have shipped this one and reported the build clean.
    expect(fs.existsSync(path.join(standalone, "e2e-install", ".env.test"))).toBe(false);
  });

  it("removes the copied .git", () => {
    const res = runPostbuild();
    expect(res.status, res.stderr).toBe(0);
    expect(fs.existsSync(path.join(standalone, ".git"))).toBe(false);
  });

  it("leaves a package's own .env fixture under node_modules alone", () => {
    const res = runPostbuild();
    expect(res.status, res.stderr).toBe(0);
    expect(
      fs.existsSync(path.join(standalone, "node_modules", "dotenv", "tests", ".env")),
    ).toBe(true);
  });

  it("still assembles the standalone tree it is there to assemble", () => {
    const res = runPostbuild();
    expect(res.status, res.stderr).toBe(0);
    expect(fs.existsSync(path.join(standalone, ".next", "static", "chunk.js"))).toBe(true);
    expect(fs.existsSync(path.join(standalone, "public", "marker.txt"))).toBe(true);
    expect(fs.existsSync(path.join(standalone, ".next", "build-info.json"))).toBe(true);
  });

  it("leaves scripts/ alone — it is resolved from the process cwd at runtime", () => {
    // The exit code first: buildFixture() plants this file, so without it the
    // case passes on its own fixture — a postbuild that died before reaching
    // the data/ removal would look like one that deliberately spared scripts/.
    const res = runPostbuild();
    expect(res.status, res.stderr).toBe(0);
    expect(fs.existsSync(path.join(standalone, "scripts", "start-llamacpp.sh"))).toBe(true);
  });

  // The post-condition has to be an EXIT CODE, not a log line: a removal that
  // fails quietly ships the duplicate and the secret copies anyway. A
  // read-only standalone dir is only a way to make the removal fail — what is
  // pinned here is that the leftover is reported as a build failure, and named.
  // The mode is not enforced for root, so that uid cannot prove it.
  const isRoot = process.getuid?.() === 0;
  it.skipIf(isRoot)(
    "fails the build, naming the path, when data/ survives the removal (non-root uid only)",
    () => {
      fs.chmodSync(standalone, 0o555);
      const res = runPostbuild();
      expect(fs.existsSync(path.join(standalone, "data"))).toBe(true);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain(path.join(".next", "standalone", "data"));
    },
  );

  // The same post-condition for the secrets half. data/ is checked first and
  // would be the path named, so this fixture removes data/ — and every other
  // top-level match — before making the tree read-only, leaving .env as the
  // one thing that can survive. The assertion is on the GUARD's own line, not
  // merely on the path: `rm` writes its own "Permission denied" naming the
  // same path onto the same stream, so a message-free guard would pass.
  it.skipIf(isRoot)(
    "fails the build, naming the path, when the .env copy survives the removal (non-root uid only)",
    () => {
      for (const gone of ["data", ".git", ".env.production", ".env.example"]) {
        fs.rmSync(path.join(standalone, gone), { recursive: true, force: true });
      }
      // Deeper matches stay removable — only the top level is frozen.
      fs.chmodSync(standalone, 0o555);
      const res = runPostbuild();
      expect(fs.existsSync(path.join(standalone, ".env"))).toBe(true);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain(
        `postbuild: ${path.join(".next", "standalone", ".env")} survived removal`,
      );
    },
  );

  // The nested layout is the one where $SDIR is not .next/standalone: Next
  // writes server.js AND the traced data/ under
  // <standalone>/<path from the tracing root to the app>, and the postbuild
  // step's own symlink branch exists for exactly this shape. Both the removal
  // and the symlink have to survive it — the assertion is a post-condition of
  // the whole step, so it must not pre-empt the symlink.
  it("removes data/ and still links server.js in the nested standalone layout", () => {
    fs.rmSync(path.join(standalone, "server.js"));
    fs.rmSync(path.join(standalone, "data"), { recursive: true });
    const nested = path.join(standalone, "app");
    fs.mkdirSync(path.join(nested, ".next"), { recursive: true });
    fs.writeFileSync(path.join(nested, "server.js"), "// standalone server\n");
    fs.mkdirSync(path.join(nested, "data", "llamacpp"), { recursive: true });
    fs.writeFileSync(path.join(nested, "data", "config.json"), "{}\n");
    // Next writes .env beside the entry it writes, so in this layout that is
    // the nested directory rather than the top of the standalone tree.
    fs.writeFileSync(path.join(nested, ".env"), "GOOGLE_OAUTH_CLIENT_SECRET=redacted\n", {
      mode: 0o600,
    });

    const res = runPostbuild();
    expect(res.status, res.stderr).toBe(0);
    expect(fs.existsSync(path.join(nested, "data"))).toBe(false);
    expect(fs.existsSync(path.join(nested, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(standalone, ".git"))).toBe(false);
    expect(fs.lstatSync(path.join(standalone, "server.js")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(standalone, "server.js")))
      .toBe(fs.realpathSync(path.join(nested, "server.js")));
  });
});
