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
      thresholds: {
        global: {
          statements: 80,
          branches: 75,
          functions: 80,
          lines: 80,
        },
      },
    },
  },
});
