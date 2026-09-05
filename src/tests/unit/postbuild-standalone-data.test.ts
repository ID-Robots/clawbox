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
  fs.copyFileSync(
    path.join(REPO, "scripts", "write-build-info.mjs"),
    path.join(tmp, "scripts", "write-build-info.mjs"),
  );
  // The step that points the standalone tree at the real `next` package
  // (scripts/link-standalone-next.sh) runs in postbuild too, and needs that
  // package to exist in the project it is run from.
  fs.copyFileSync(
    path.join(REPO, "scripts", "link-standalone-next.sh"),
    path.join(tmp, "scripts", "link-standalone-next.sh"),
  );
  fs.mkdirSync(path.join(tmp, "node_modules", "next"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "node_modules", "next", "package.json"), JSON.stringify({ name: "next", version: "0.0.0-test" }));
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ version: "0.0.0-test" }));

  fs.mkdirSync(path.join(tmp, "public"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "public", "marker.txt"), "public asset\n");
  fs.mkdirSync(path.join(tmp, ".next", "static"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".next", "static", "chunk.js"), "// chunk\n");
  fs.writeFileSync(path.join(tmp, ".next", "BUILD_ID"), "test-build-id\n");

  standalone = path.join(tmp, ".next", "standalone");
  fs.mkdirSync(path.join(standalone, ".next"), { recursive: true });
  fs.writeFileSync(path.join(standalone, "server.js"), "// standalone server\n");

  // scripts/ IS resolved from the process cwd by system-profile.ts and
  // hermes-image-plugin.ts, so it must survive whatever the data/ removal does.
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

  it("still assembles the standalone tree it is there to assemble", () => {
    const res = runPostbuild();
    expect(res.status, res.stderr).toBe(0);
    // …and the traced `next` is a link to the real package now.
    const linked = path.join(standalone, "node_modules", "next");
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linked)).toBe(fs.realpathSync(path.join(tmp, "node_modules", "next")));
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
    // The nested app carries its own traced node_modules, like the real layout.
    fs.mkdirSync(path.join(nested, "node_modules", "next"), { recursive: true });
    fs.mkdirSync(path.join(nested, "data", "llamacpp"), { recursive: true });
    fs.writeFileSync(path.join(nested, "data", "config.json"), "{}\n");

    const res = runPostbuild();
    expect(res.status, res.stderr).toBe(0);
    expect(fs.existsSync(path.join(nested, "data"))).toBe(false);
    expect(fs.lstatSync(path.join(standalone, "server.js")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(standalone, "server.js")))
      .toBe(fs.realpathSync(path.join(nested, "server.js")));
  });
});
