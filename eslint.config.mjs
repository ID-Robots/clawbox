import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // data/ is the box's runtime state — config, the owner's code projects, the
  // coding agent's evidence folders and streams — not source. `eslint` with no
  // arguments lints the whole checkout, and on a box that means whatever a run
  // left there.
  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", "next-env.d.ts", "bench/tasks/**/seed/**", "data/**"]),
]);

export default eslintConfig;
