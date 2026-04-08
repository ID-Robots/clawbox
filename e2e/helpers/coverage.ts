import fs from "fs/promises";
import path from "path";
import { expect, test as base } from "@playwright/test";

export { expect };

export const test = base.extend({
  page: async ({ page, browserName }, runPage, testInfo) => {
    const shouldCollect = browserName === "chromium";

    if (shouldCollect) {
      await page.coverage.startJSCoverage({
        resetOnNavigation: false,
      });
    }

    await runPage(page);

    if (!shouldCollect) {
      return;
    }

    try {
      const jsCoverage = await page.coverage.stopJSCoverage();
      const outputPath = testInfo.outputPath("js-coverage.json");
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, JSON.stringify(jsCoverage, null, 2), "utf-8");
    } catch (error) {
      const outputPath = testInfo.outputPath("js-coverage-error.txt");
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(
        outputPath,
        error instanceof Error ? error.stack ?? error.message : String(error),
        "utf-8"
      );
    }
  },
});
