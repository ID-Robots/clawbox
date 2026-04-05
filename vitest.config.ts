import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
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
