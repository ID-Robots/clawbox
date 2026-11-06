// Config for the hidden acceptance tests only (keeps them out of the project's own `npm test`).
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["__acceptance__/**/*.accept.jsx"],
    setupFiles: [],
  },
});
