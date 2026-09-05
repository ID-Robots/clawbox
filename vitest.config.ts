import os from "os";
import path from "path";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import SlowFirstSequencer from "./src/tests/helpers/slow-first-sequencer";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    // Start the files known to take longest first (see the sequencer for the
    // measurements). Without a timing cache — every CI run — vitest orders by
    // file size, and the 50 s sudoers file and the 28 s tsc gate then started
    // late enough to be the tail of a four-worker run.
    sequence: { sequencer: SlowFirstSequencer },
    // Keep the suite HERMETIC. src/lib/edition-source.ts reads the device's
    // real /etc/clawbox/edition.env to resolve the SKU, so running the tests on
    // an actual ClawBox made them assert against that box's edition instead of
    // their own fixtures: on a Hermes device the edition tests flipped to
    // "hermes" and every app-store route returned 404 (correctly hidden on that
    // SKU) — 20 failures that appear only on hardware. Point the lookup at a
    // path that cannot exist so tests fall back to process.env, which they
    // control; the individual edition tests override this with a real tmp file.
    env: {
      CLAWBOX_EDITION_FILE: "/nonexistent/clawbox-test-edition.env",
      // ...and the ENV the lookup falls back to when that file is absent
      // (edition-source.ts reads CLAWBOX_EDITION next). Pointing the file at
      // nowhere only half-closed the hole: a shell on a Hermes box that
      // exports CLAWBOX_EDITION still reached every route that asks which
      // harness is active. Measured 2026-09-04: `CLAWBOX_EDITION=hermes`
      // turned 76 chat-model assertions into 409s. Tests that mean to be on
      // another edition set their own value or mock `@/lib/harness`.
      CLAWBOX_EDITION: "openclaw",
      // The same hermetic principle for device STATE: config-store falls back
      // to the real /home/clawbox/clawbox when CLAWBOX_ROOT is unset, so a
      // test that imports the real modules without re-pointing the root reads
      // — and can WRITE — the box's live data/. Measured on this box
      // (2026-08-27): a suite run while coding run run-0nxtbhb1 was in flight
      // loaded the real runs file in a worker and stamped the live run as
      // failed. Tests that need their own root still set one in beforeEach;
      // this is the floor that keeps a forgotten one harmless.
      CLAWBOX_ROOT: path.join(os.tmpdir(), `clawbox-test-root-${process.pid}`),
      // Same rule for OpenClaw's own store: `OPENCLAW_HOME` falls back to the
      // hard-coded /home/clawbox/.openclaw, so on the device a test that
      // "never linked" the box still found the box's REAL ClawBox AI token in
      // the real openclaw.json and went on to call the proxy. CI has no such
      // file; the suite must see the same nothing everywhere. Tests that need
      // an openclaw.json point OPENCLAW_HOME at their own fixture dir.
      OPENCLAW_HOME: path.join(os.tmpdir(), `clawbox-test-openclaw-${process.pid}`),
      // `CLAWBOX_OPENCLAW_HOME` OUTRANKS the line above wherever this repo
      // resolves OpenClaw's home, and a device carries it: `install-x64.sh`
      // bakes it into the web-server unit (`:1104`) and `src/lib/updater.ts`
      // (`:971`) exports it into every gateway pre-start child — so on a
      // device the floor was only half a floor: a suite run
      // from a shell carrying it reads the box's real openclaw.json past the
      // fixture, and `apps/uninstall`'s route tests would then `fs.rm` under
      // the box's REAL workspace and stay green. Emptied rather than pointed
      // somewhere, like OPENCLAW_STATE_DIR below and for the same reason:
      // every reader spells it `CLAWBOX_OPENCLAW_HOME || OPENCLAW_HOME || …`,
      // so "" neutralises an inherited value while leaving the floor above —
      // and every test that points OPENCLAW_HOME at its own fixture — in
      // charge.
      CLAWBOX_OPENCLAW_HOME: "",
      // And for the override OpenClaw honours above its home: with
      // OPENCLAW_STATE_DIR exported on the runner, openclaw-state-store.ts
      // would read that machine's real state/openclaw.sqlite (the Telegram
      // allowlist) instead of the fixture under OPENCLAW_HOME. Empty means
      // "no override", so the store follows the floored home above.
      OPENCLAW_STATE_DIR: "",
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/tests/unit/**/*.test.ts", "src/tests/routes/**/*.test.ts", "src/tests/middleware/**/*.test.ts", "src/tests/*.test.ts"],
          exclude: ["**/node_modules/**", "**/.next/**"],
          // A handful of files in this project opt into jsdom to render a
          // hook, and nothing was unmounting them — see the setup file.
          setupFiles: ["src/tests/setup-unit.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "components",
          environment: "jsdom",
          include: ["src/tests/components/**/*.test.tsx"],
          exclude: ["**/node_modules/**", "**/.next/**"],
          setupFiles: ["src/tests/setup.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html", "clover"],
      // Write the summary even when a test failed. Without this the reports are
      // skipped on a failing run, so pr-tests-coverage.yml's "Parse coverage"
      // step — which runs `if: always()` precisely so the PR comment can show
      // numbers on a red build — never found the file and silently reported
      // nothing. It does not affect the gate: a failing test fails the job
      // either way.
      reportOnFailure: true,
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/tests/**",
        "src/app/**/layout.tsx",
        "src/app/**/page.tsx",
        "src/instrumentation.ts",
        "src/instrumentation-node.ts",
        "src/components/**",
        "src/hooks/**",
        "src/lib/i18n.tsx",
        "src/lib/chat-markdown.tsx",
        "src/lib/client-kv.ts",
        "src/types/**",
        "**/*.d.ts",
        "src/app/setup-api/vnc/**",
        "src/app/setup-api/browser/route.ts",
        "src/app/setup-api/browser/manage/**",
      ],
      // Vitest reads the four metrics at the TOP level of `thresholds`. Any
      // other key here is treated as a glob selecting files to threshold, so
      // the previous `global: { ... }` nesting (Jest's shape) silently became a
      // glob matching no files, and the gate never ran. It type-checked, because
      // the glob form accepts exactly that object shape.
      //
      // The standard for this project is statements 80 / branches 75 /
      // functions 80 / lines 80. That is the goal and it has not been reached.
      //
      // The numbers below are NOT the standard — they are a ratchet stop, set
      // just under coverage as measured on CI (2026-08-11: 64.64 / 53.70 /
      // 62.27 / 66.77) so that coverage cannot regress while the gate is being
      // brought back into use. Setting them straight to 80 would fail every PR
      // on day one, and the gate would be switched off again. Raise them as
      // coverage climbs; that is the only route to the standard above.
      thresholds: {
        statements: 63,
        branches: 52,
        functions: 61,
        lines: 65,
      },
    },
  },
});
