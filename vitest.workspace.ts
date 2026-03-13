import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "./vitest.config.ts",
    test: {
      name: "unit",
      environment: "node",
      include: ["src/tests/unit/**/*.test.ts", "src/tests/routes/**/*.test.ts", "src/tests/*.test.ts"],
      exclude: ["**/node_modules/**", "**/.next/**"],
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "components",
      environment: "jsdom",
      include: ["src/tests/components/**/*.test.tsx"],
      exclude: ["**/node_modules/**", "**/.next/**"],
      setupFiles: ["src/tests/setup.ts"],
    },
  },
]);
