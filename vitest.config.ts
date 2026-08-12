import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
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
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/tests/unit/**/*.test.ts", "src/tests/routes/**/*.test.ts", "src/tests/middleware/**/*.test.ts", "src/tests/*.test.ts"],
          exclude: ["**/node_modules/**", "**/.next/**"],
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
