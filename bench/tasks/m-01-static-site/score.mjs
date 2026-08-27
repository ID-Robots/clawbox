import {
  check, summarize, read, exists, listFiles, nodeCheck, internalLinksResolve,
  noExternalRefs, antiPatterns, summaryClaimsVerifiable, cliMain,
} from "../../lib/score-utils.mjs";
import { getSummary } from "../../lib/record.mjs";

const REQUIRED = [
  "index.html", "features.html", "pricing.html", "faq.html", "contact.html",
  "css/style.css", "js/main.js", "js/data.js",
];
const PAGES = REQUIRED.filter((f) => f.endsWith(".html"));

export default async function score({ workdir, run }) {
  const missing = REQUIRED.filter((f) => !exists(workdir, f));
  if (missing.length === REQUIRED.length) {
    // Nothing delivered. The vacuous checks (no bad links in no files…) must
    // not hand an empty folder a third of the points.
    return summarize([check("all required files exist", false, "nothing delivered", 3)]);
  }
  const all = listFiles(workdir);
  const pricingHtml = read(workdir, "pricing.html") ?? "";
  const dataJs = read(workdir, "js/data.js") ?? "";
  const mainJs = read(workdir, "js/main.js") ?? "";
  const faq = read(workdir, "faq.html") ?? "";
  const contact = read(workdir, "contact.html") ?? "";

  const navChecks = PAGES.map((p) => {
    const html = read(workdir, p) ?? "";
    const linksAll = PAGES.every((other) => html.includes(other));
    const current = /aria-current\s*=\s*["']page["']/.test(html);
    return check(`nav on ${p}`, linksAll && current,
      linksAll ? (current ? "" : "no aria-current") : "missing page links");
  });
  const viewports = PAGES.filter((p) => /name\s*=\s*["']viewport["']/.test(read(workdir, p) ?? ""));
  const detailsCount = (faq.match(/<details[\s>]/g) ?? []).length;
  const pricesInData = /\$?9\b/.test(dataJs) && /29/.test(dataJs) && /99/.test(dataJs);
  const pricesLeakedToHtml = /\$\s*(9|29|99)\b/.test(pricingHtml);

  const checks = [
    check("all 8 required files exist", missing.length === 0, missing.join("; "), 3),
    check("no extra top-level clutter", all.length <= 12, `${all.length} files`),
    await nodeCheck(workdir, "js/main.js"),
    await nodeCheck(workdir, "js/data.js"),
    ...navChecks,
    check("viewport meta on every page", viewports.length === PAGES.length,
      `${viewports.length}/${PAGES.length}`),
    check("PLANS array with 3 plans in data.js",
      /PLANS/.test(dataJs) && pricesInData, "", 2),
    check("prices only in js/data.js", !pricesLeakedToHtml,
      pricesLeakedToHtml ? "price literals in pricing.html" : "", 2),
    check("main.js renders pricing", /PLANS/.test(mainJs), "", 1),
    check("FAQ: ≥6 native collapsibles", detailsCount >= 6, `details=${detailsCount}`, 2),
    check("contact form present + email validation",
      /<form/i.test(contact) && /email/i.test(mainJs) && /(@|email)/i.test(mainJs), "", 2),
    internalLinksResolve(workdir, PAGES),
    noExternalRefs(workdir, all),
    antiPatterns(workdir, all),
    summaryClaimsVerifiable(workdir, getSummary(run)),
  ];
  return summarize(checks);
}
await cliMain(score, import.meta.url);
