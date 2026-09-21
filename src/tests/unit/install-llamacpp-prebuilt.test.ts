import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/**
 * Building llama.cpp on the device costs 18m51s, measured on an Orin Nano, and
 * produces an identical result on every unit — so install.sh can accept a
 * prebuilt archive instead. The risk that buys is a bad prebuilt reaching a
 * customer, which fails silently at install and loudly at first inference.
 *
 * These drive the shell function itself against real archives, so the guarantee
 * cannot rot into a comment. The rule under test is one line: ANY doubt about
 * the prebuilt falls through to the source build, because a slow install beats
 * a device with no working inference binary.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const INSTALL_SH = path.join(process.cwd(), "install.sh");

/** Run install_prebuilt_llamacpp in isolation. Returns its exit code + output. */
function runInstall(archive: string, wantCuda: string, llamaDir: string, binDir: string) {
  const script = `
    set -u
    CLAWBOX_USER="$(id -un)"
    # Lift just the function out — sourcing install.sh would install a machine.
    sed -n '/^install_prebuilt_llamacpp() {/,/^}/p' "$1" > "$4/fn.sh"
    . "$4/fn.sh"
    # Redirect the final install(1) so the test never writes to /usr/local/bin.
    install() { command install "\${@//\\/usr\\/local\\/bin/$5}"; }
    install_prebuilt_llamacpp "$2" "$3" "$4/llama"
  `;
  try {
    const out = execFileSync("bash",
      ["-c", script, "bash", INSTALL_SH, archive, wantCuda, llamaDir, binDir],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("install.sh accepts a prebuilt llama.cpp only when it is usable", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prebuilt-"));
    fs.mkdirSync(path.join(tmp, "llama"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** An archive whose llama-server is a host-native script, not aarch64. */
  function archiveWithFakeBinary(extra: string[] = []): string {
    const stage = path.join(tmp, "stage");
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, "llama-server"), "#!/bin/sh\necho fake\n", { mode: 0o755 });
    for (const f of extra) fs.writeFileSync(path.join(stage, f), "x");
    const out = path.join(tmp, "a.tar.gz");
    execFileSync("tar", ["--force-local", "-czf", out, "-C", stage, "."]);
    return out;
  }

  it("rejects an archive that is not a tarball at all", () => {
    const bogus = path.join(tmp, "not.tar.gz");
    fs.writeFileSync(bogus, "this is not an archive");
    const r = runInstall(bogus, "ON", tmp, path.join(tmp, "bin"));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/unreadable/i);
  });

  it("rejects a missing source rather than continuing", () => {
    const r = runInstall(path.join(tmp, "nope.tar.gz"), "ON", tmp, path.join(tmp, "bin"));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/not found/i);
  });

  it("rejects an archive with no llama-server in it", () => {
    const stage = path.join(tmp, "empty");
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, "README"), "x");
    const out = path.join(tmp, "empty.tar.gz");
    execFileSync("tar", ["--force-local", "-czf", out, "-C", stage, "."]);
    const r = runInstall(out, "ON", tmp, path.join(tmp, "bin"));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/no llama-server/i);
  });

  it("rejects a binary built for the wrong architecture", () => {
    // The realistic mistake: built on the flash host instead of a Jetson.
    const r = runInstall(archiveWithFakeBinary(["libggml-cuda.so.0"]), "ON", tmp, path.join(tmp, "bin"));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/aarch64/i);
  });

  it("rejects a CUDA-less build when the device expects CUDA", () => {
    // No libggml-cuda.so present. Checked before the arch test can be reached
    // on a real aarch64 host, so assert on either rejection — both are correct
    // and both fall back to the source build.
    const r = runInstall(archiveWithFakeBinary(), "ON", tmp, path.join(tmp, "bin"));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/CUDA|aarch64/i);
  });

  it("never leaves a partially-installed binary behind on rejection", () => {
    const binDir = path.join(tmp, "bin");
    runInstall(archiveWithFakeBinary(), "ON", tmp, binDir);
    expect(fs.existsSync(path.join(binDir, "llama-server"))).toBe(false);
  });
});

describe("install.sh pins llama.cpp instead of tracking master", () => {
  const src = fs.readFileSync(INSTALL_SH, "utf8");

  it("checks out an explicit commit", () => {
    // Two devices here ended up on different upstream commits because the clone
    // was unpinned — the same install produced different inference binaries.
    expect(src).toMatch(/LLAMACPP_COMMIT="\$\{LLAMACPP_COMMIT:-[0-9a-f]{40}\}"/);
    expect(src).toMatch(/git checkout --quiet \$LLAMACPP_COMMIT/);
  });

  it("does not shallow-clone, which cannot reach an arbitrary commit", () => {
    const block = src.slice(src.indexOf("step_llamacpp_install"));
    expect(block).not.toMatch(/clone --depth 1 https:\/\/github\.com\/ggml-org\/llama\.cpp/);
  });
});

describe("install.sh does not run a prebuilt of unknown provenance", () => {
  const src = fs.readFileSync(INSTALL_SH, "utf8");

  it("refuses http rather than downgrading to it", () => {
    // The binary is executed as root by the --version probe, so on a factory
    // bench pointed at a build host, plain http would make the network the
    // authority on what runs on every device flashed.
    const fn = src.slice(src.indexOf("install_prebuilt_llamacpp() {"));
    expect(fn).toMatch(/must be served over https/i);
    expect(fn).toMatch(/--proto '=https'/);
  });

  it("checks a supplied digest BEFORE unpacking or executing anything", () => {
    const fn = src.slice(src.indexOf("install_prebuilt_llamacpp() {"));
    const digestAt = fn.indexOf("LLAMACPP_PREBUILT_SHA256");
    const untarAt = fn.indexOf("tar --force-local -xzf");
    const execAt = fn.indexOf("--version >/dev/null");
    expect(digestAt).toBeGreaterThan(-1);
    // Ordering is the whole point: a digest checked after execution proves
    // nothing about what already ran.
    expect(digestAt).toBeLessThan(untarAt);
    expect(digestAt).toBeLessThan(execAt);
  });

  it("rejects on a digest mismatch instead of warning and continuing", () => {
    const fn = src.slice(src.indexOf("install_prebuilt_llamacpp() {"));
    expect(fn).toMatch(/digest does not match.*ignoring it/i);
  });
});
