import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();
const TEST_RESULTS_DIR = path.join(ROOT, "test-results");
const SUMMARY_PATH = path.join(ROOT, "coverage", "e2e-summary.json");
const BUNDLES_PATH = path.join(ROOT, "coverage", "e2e-bundles.json");
const BASE_ORIGIN = "http://localhost:3000";
// Baseline for current e2e suite. Raise this as new tests land — but never
// drop it without explicit reason, since this is the regression backstop.
const MIN_APP_COVERAGE = 48;

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

function mergeRanges(ranges) {
  const sorted = [...ranges]
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start);

  if (sorted.length === 0) {
    return [];
  }

  const merged = [sorted[0]];
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = merged[merged.length - 1];

    if (current.start <= previous.end) {
      previous.end = Math.max(previous.end, current.end);
      continue;
    }

    merged.push({ ...current });
  }

  return merged;
}

function totalCoveredBytes(ranges) {
  const normalized = ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .map((range) => ({
      start: range.start,
      end: range.end,
      count: Number(range.count ?? 0),
    }));

  if (normalized.length === 0) {
    return 0;
  }

  const boundaries = [...new Set(normalized.flatMap((range) => [range.start, range.end]))].sort((a, b) => a - b);
  let covered = 0;

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    let deepest = null;

    for (const range of normalized) {
      if (range.start > start || range.end < end) {
        continue;
      }

      if (
        !deepest ||
        range.start > deepest.start ||
        (range.start === deepest.start && range.end < deepest.end)
      ) {
        deepest = range;
      }
    }

    if (deepest && deepest.count > 0) {
      covered += end - start;
    }
  }

  return covered;
}

function entrySource(entry) {
  if (typeof entry?.source === "string") {
    return entry.source;
  }

  if (typeof entry?.text === "string") {
    return entry.text;
  }

  return "";
}

function entryRanges(entry) {
  if (Array.isArray(entry?.ranges)) {
    return entry.ranges.map((range) => ({
      start: range.start ?? range.startOffset ?? 0,
      end: range.end ?? range.endOffset ?? 0,
      count: range.count ?? 1,
    }));
  }

  if (!Array.isArray(entry?.functions)) {
    return [];
  }

  return entry.functions.flatMap((fn) =>
    (fn?.ranges ?? [])
      .map((range) => ({
        start: range.start ?? range.startOffset ?? 0,
        end: range.end ?? range.endOffset ?? 0,
        count: range.count ?? 0,
      }))
  );
}

function classifyUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== BASE_ORIGIN || !parsed.pathname.endsWith(".js")) {
      return { firstParty: false, appBundle: false };
    }

    const isRuntime =
      parsed.pathname.includes("/webpack") ||
      parsed.pathname.includes("main-app") ||
      parsed.pathname.includes("app-pages-internals") ||
      parsed.pathname.includes("polyfills") ||
      parsed.pathname.includes("react-refresh") ||
      parsed.pathname.includes("/node_modules_") ||
      parsed.pathname.includes("turbopack-_") ||
      parsed.pathname.includes("%5Bturbopack%5D");

    return {
      firstParty: true,
      appBundle: !isRuntime,
    };
  } catch {
    return { firstParty: false, appBundle: false };
  }
}

function createBucket() {
  return {
    totalBytes: 0,
    coveredBytes: 0,
  };
}

function toPercent(bucket) {
  if (!bucket.totalBytes) {
    return 0;
  }

  return Number(((bucket.coveredBytes / bucket.totalBytes) * 100).toFixed(2));
}

async function main() {
  let coverageFiles = [];
  try {
    const allFiles = await walk(TEST_RESULTS_DIR);
    coverageFiles = allFiles.filter((file) => file.endsWith("js-coverage.json"));
  } catch {
    coverageFiles = [];
  }

  if (coverageFiles.length === 0) {
    console.error("No Playwright JS coverage artifacts were found under test-results.");
    process.exitCode = 1;
    return;
  }

  const bundles = new Map();

  for (const file of coverageFiles) {
    const entries = JSON.parse(await fs.readFile(file, "utf-8"));

    for (const entry of entries) {
      const source = entrySource(entry);
      if (!entry?.url || !source) {
        continue;
      }

      const existing = bundles.get(entry.url) ?? {
        url: entry.url,
        textLength: source.length,
        ranges: [],
      };

      existing.textLength = Math.max(existing.textLength, source.length);
      existing.ranges.push(...entryRanges(entry));
      bundles.set(entry.url, existing);
    }
  }

  const firstParty = createBucket();
  const appBundles = createBucket();
  const perBundle = [];

  for (const bundle of bundles.values()) {
    const coveredBytes = totalCoveredBytes(bundle.ranges);
    const classification = classifyUrl(bundle.url);
    const record = {
      url: bundle.url,
      totalBytes: bundle.textLength,
      coveredBytes,
      coveragePercent: bundle.textLength ? Number(((coveredBytes / bundle.textLength) * 100).toFixed(2)) : 0,
      ...classification,
    };

    perBundle.push(record);

    if (classification.firstParty) {
      firstParty.totalBytes += bundle.textLength;
      firstParty.coveredBytes += coveredBytes;
    }

    if (classification.appBundle) {
      appBundles.totalBytes += bundle.textLength;
      appBundles.coveredBytes += coveredBytes;
    }
  }

  perBundle.sort((left, right) => left.coveragePercent - right.coveragePercent || right.totalBytes - left.totalBytes);

  const summary = {
    coverageFiles,
    thresholds: {
      appBundleJsPercent: MIN_APP_COVERAGE,
    },
    firstPartyJs: {
      ...firstParty,
      coveragePercent: toPercent(firstParty),
    },
    appBundleJs: {
      ...appBundles,
      coveragePercent: toPercent(appBundles),
    },
    generatedAt: new Date().toISOString(),
  };

  await fs.mkdir(path.dirname(SUMMARY_PATH), { recursive: true });
  await fs.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf-8");
  await fs.writeFile(BUNDLES_PATH, JSON.stringify(perBundle, null, 2), "utf-8");

  console.log(`E2E JS coverage (first-party): ${summary.firstPartyJs.coveragePercent}%`);
  console.log(`E2E JS coverage (app bundles): ${summary.appBundleJs.coveragePercent}%`);
  console.log(`Coverage summary: ${path.relative(ROOT, SUMMARY_PATH)}`);
  console.log(`Per-bundle breakdown: ${path.relative(ROOT, BUNDLES_PATH)}`);

  const worstBundles = perBundle
    .filter((bundle) => bundle.appBundle)
    .slice(0, 10)
    .map((bundle) => `  ${bundle.coveragePercent.toFixed(2)}% ${new URL(bundle.url).pathname}`);

  if (worstBundles.length > 0) {
    console.log("Lowest app-bundle coverage:");
    console.log(worstBundles.join("\n"));
  }

  if (summary.appBundleJs.coveragePercent < MIN_APP_COVERAGE) {
    process.exitCode = 1;
  }
}

await main();
