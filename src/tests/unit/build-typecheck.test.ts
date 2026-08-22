import { describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

// `next build` type-checks the product sources under `strict`; nothing in the
// vitest suite did. So a product file could type-check NOWHERE and still be
// green everywhere a reviewer looked. It happened: this feature shipped
//
//     const sock = tls.connect({ socket: plain, ... }, () => resolve(sock));
//     sock.once("error", (err) => { ... });
//
// where `sock` is referenced inside its own initializer. vitest was green
// (esbuild strips types without checking them) and `bun run build` died at that
// line with TS7006 — the whole feature could not be deployed.
//
// WHY THE WHOLE PROJECT AND NOT JUST THIS FEATURE'S FILES. That was the first
// attempt, and it does not work: type-checking src/lib/smtp-client.ts (or even
// every product source) in a narrower program resolves `tls.connect` to its
// real signature and reports nothing. The error only exists in the FULL program
// — the same program `next build` builds — because of a declaration that only
// gets pulled in there. A check narrower than the build cannot stand in for the
// build.
//
// WHY ERRORS IN src/tests ARE TOLERATED. The repo carries 15 of them (2026-08),
// and `next build` never sees them: test files are outside its graph. Failing on
// those would make this test red on a tree that builds perfectly, which is how
// gates get switched off. The invariant worth holding is the one the build
// holds — no type error in a file the build compiles.

const REPO = path.resolve(__dirname, "../../..");
const TSC = path.join(REPO, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const CAN_RUN = fs.existsSync(TSC);
const d = CAN_RUN ? describe : describe.skip;

/** "src/lib/smtp-client.ts(279,27): error TS7006: ..." → the path. */
const ERROR_LINE = /^(\S+?)\((\d+),(\d+)\): error TS\d+/;

d("the production build's type-check", () => {
  it("reports no type error in any file the build compiles", () => {
    const result = spawnSync(TSC, ["--noEmit", "-p", path.join(REPO, "tsconfig.json")], {
      cwd: REPO,
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    const productErrors = output
      .split(/\r?\n/)
      .filter((line) => {
        const match = ERROR_LINE.exec(line);
        return match !== null && !match[1].replace(/\\/g, "/").startsWith("src/tests/");
      });

    expect(productErrors).toEqual([]);
  }, 300_000);
});
