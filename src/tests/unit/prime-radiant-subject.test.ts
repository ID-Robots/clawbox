/**
 * What a claim is about, on the live test's own examples: 84 of 85
 * contradiction items were false because claims were written without a
 * subject ("It is Project Gutenberg eBook #5", "The work is called the oldest
 * military treatise") and the pass paired claims from unrelated pages (a
 * black hole against the US Constitution) by their wording. The writer now
 * keeps only self-contained claims; the pass pairs only claims about the
 * same thing. Fixtures are synthetic or public-domain titles.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collectClaims, comparable, createHashEmbedder, runContradictionPass } from "@/lib/prime-radiant/contradictions";
import type { FlashClient } from "@/lib/prime-radiant/flash-client";
import { readJudgeItems } from "@/lib/prime-radiant/judge";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { noPairReason, pairable } from "@/lib/prime-radiant/pairing";
import { sideIdentifiers } from "@/lib/prime-radiant/identifiers";
import { claimOpener, claimSubject, documentStatement, sameSubject, selfContainedClaim, subjectWords } from "@/lib/prime-radiant/subject";
import { claim, pageText, snapshot } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe("self-contained claims", () => {
  const ART = "The Art of War";

  it.each([
    ["It is Project Gutenberg eBook #132.", "The Art of War is Project Gutenberg eBook #132."],
    ["The work is called the oldest military treatise.", "The Art of War is called the oldest military treatise."],
    ["The work, written around 500 BC, is attributed to Sun Tzu.", "The Art of War, written around 500 BC, is attributed to Sun Tzu."],
    ["This book was translated by Lionel Giles in 1910.", "The Art of War was translated by Lionel Giles in 1910."],
    ["This is the oldest military treatise.", "The Art of War is the oldest military treatise."],
    ["It's a classic of strategy.", "The Art of War is a classic of strategy."],
    ["Its author is Sun Tzu.", "The Art of War's author is Sun Tzu."],
    ["The book's 13 chapters each cover one aspect of war.", "The Art of War's 13 chapters each cover one aspect of war."],
    ["The author was Sun Tzu.", "The Art of War's author was Sun Tzu."],
  ])("repairs %j with the page's title", (raw, repaired) => {
    expect(selfContainedClaim(raw, ART)).toBe(repaired);
  });

  it.each([
    "The author, Sun Tzu, was a Chinese general.",
    "The company Acme Widgets Ltd was founded in 1990.",
    "The price of the blue widget is 10 EUR.",
    "Sun Tzu wrote The Art of War.",
    "There are 13 chapters in The Art of War.",
    "This year the office moved to Sofia.",
    "The ID Robots office is at 25 Tsar Boris III Blvd.",
  ])("keeps %j as written: it names its subject", (text) => {
    expect(claimOpener(text)).toEqual({ kind: "named" });
    expect(selfContainedClaim(text, ART)).toBe(text);
  });

  it.each(["He was a Chinese general.", "They fought at the battle of Boju.", "These chapters are short.", "The chapter on spies is the last.", "Their army was small."])(
    "drops %j: the pointer could mean someone else",
    (text) => {
      expect(selfContainedClaim(text, ART)).toBeNull();
    },
  );

  it("drops a pronoun-led claim when the title names nothing either", () => {
    expect(selfContainedClaim("It is Project Gutenberg eBook #5.", "Notes")).toBeNull();
    expect(selfContainedClaim("It is Project Gutenberg eBook #5.", "")).toBeNull();
    expect(selfContainedClaim("It is Project Gutenberg eBook #5.", "The United States Constitution.")).toBe(
      "The United States Constitution is Project Gutenberg eBook #5.",
    );
  });

  it("reads the subject before the verb", () => {
    expect([...subjectWords("The ID Robots office is at 25 Tsar Boris III Blvd.")]).toEqual(["id", "robot", "office"]);
    expect([...subjectWords("ID Robots moved its office to 10 Vitosha Blvd.")]).toEqual(["id", "robot"]);
    expect([...subjectWords("The price of the blue widget is 10 EUR.")]).toEqual(["price", "blue", "widget"]);
    expect([...subjectWords("It is Project Gutenberg eBook #5.")]).toEqual([]);
  });
});

describe("same subject", () => {
  const S = claimSubject;
  const same: Array<[string, ReturnType<typeof S>, ReturnType<typeof S>]> = [
    ["two prices of the blue widget", S("acme-sales/pricing/a", "The blue widget costs 10 EUR per unit.", "Widget pricing"), S("acme-sales/catalogue/b", "The blue widget costs 12 EUR per unit.", "Catalogue")],
    ["the office, in two documents", S("general/office-move/a", "The ID Robots office is at 25 Tsar Boris III Blvd.", "Office move"), S("general/company-info/b", "ID Robots moved its office to 10 Vitosha Blvd.", "Company info")],
    ["one claim naming the other's subject", S("military/sun-tzu/a", "Sun Tzu wrote The Art of War around 500 BC.", "Sun Tzu"), S("military/the-art-of-war/b", "The Art of War was written in the 4th century BC.", "The Art of War")],
    ["the same entity", S("general/acme/a", "It was founded in 1990.", "Acme"), S("general/acme/b", "The company employs 40 people.", "Acme")],
  ];
  const different: Array<[string, ReturnType<typeof S>, ReturnType<typeof S>]> = [
    ["a black hole and the US Constitution", S("science/black-hole/a", "A black hole is a region of spacetime where gravity prevents escape.", "Black hole"), S("law/united-states-constitution/b", "The United States Constitution is Project Gutenberg eBook #5.", "The United States Constitution")],
    ["two books with alike wording", S("law/united-states-constitution/a", "The United States Constitution is Project Gutenberg eBook #5.", "The United States Constitution"), S("military/the-art-of-war/b", "The Art of War is Project Gutenberg eBook #132.", "The Art of War")],
    ["two old pronoun-led claims of two books", S("law/united-states-constitution/a", "It is Project Gutenberg eBook #5.", "The United States Constitution"), S("military/the-art-of-war/b", "It is Project Gutenberg eBook #132.", "The Art of War")],
    ["two old pronoun-led claims, a black hole and a constitution", S("science/black-hole/a", "It is a region of spacetime.", "Black hole"), S("law/united-states-constitution/b", "It is the supreme law of the United States.", "The United States Constitution")],
    ["two numbered products", S("acme-sales/catalogue-0/a", "The widget model 0 costs 10 EUR per unit.", "Catalogue 0"), S("acme-sales/catalogue-1/b", "The widget model 1 costs 11 EUR per unit.", "Catalogue 1")],
    ["the price of two things", S("shop/blue-widget/a", "The price is 10 EUR.", "Blue widget"), S("shop/laptop/b", "The price is 900 EUR.", "Laptop")],
  ];
  it.each(same)("pairs %s", (_, a, b) => {
    expect(sameSubject(a, b)).toBe(true);
    expect(sameSubject(b, a)).toBe(true);
  });
  it.each(different)("does not pair %s", (_, a, b) => {
    expect(sameSubject(a, b)).toBe(false);
    expect(sameSubject(b, a)).toBe(false);
  });

  it("never pairs a statement with itself on another page", () => {
    const a = { text: "The blue widget costs 10 EUR.", subject: S("x/a/f", "The blue widget costs 10 EUR.") };
    expect(comparable(a, { ...a })).toBe(false);
  });
});

// ── the pass ──────────────────────────────────────────────────────────────

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-subject-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;

beforeEach(() => {
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

/** The live test's vault, in miniature: three books (two with old pronoun-led claims), a black hole, and an office that moved. */
function liveVault() {
  return snapshot({
    "concepts/united-states-constitution.md": pageText({
      title: "The United States Constitution",
      claims: [
        claim("law/united-states-constitution/ebook", "It is Project Gutenberg eBook #5."),
        claim("law/united-states-constitution/articles", "The United States Constitution has seven articles."),
      ],
    }),
    "concepts/the-art-of-war.md": pageText({
      title: "The Art of War",
      claims: [
        claim("military/the-art-of-war/ebook", "It is Project Gutenberg eBook #132."),
        claim("military/the-art-of-war/treatise", "The work is called the oldest military treatise."),
        claim("military/the-art-of-war/chapters", "The Art of War has 13 chapters."),
      ],
    }),
    "concepts/black-hole.md": pageText({
      title: "Black hole",
      claims: [
        claim("science/black-hole/region", "It is a region of spacetime where gravity is so strong nothing escapes."),
        claim("science/black-hole/articles", "A black hole has seven known properties."),
      ],
    }),
    "concepts/office-move.md": pageText({ title: "Office move", claims: [claim("general/office-move/address", "The ID Robots office is at 25 Tsar Boris III Blvd.")] }),
    "concepts/company-info.md": pageText({ title: "Company info", claims: [claim("general/company-info/address", "The ID Robots office is at 10 Vitosha Blvd.")] }),
  });
}

describe("the contradiction pass pairs only claims about the same thing", () => {
  it("asks the judge about the office alone, never a black hole against a constitution", async () => {
    const asked: Array<[string, string]> = [];
    // A judge that calls EVERY pair a contradiction: only the pairing can keep the items true.
    const client: FlashClient = {
      model: "deepseek-v4-flash",
      async complete(request) {
        const items = readJudgeItems(request.user) ?? [];
        for (const it of items) asked.push([it.a, it.b]);
        const text = JSON.stringify(items.map((it) => ({ i: it.i, verdict: "contradiction", why: "differs" })));
        return { text, model: "deepseek-v4-flash", usage: { promptTokens: 100, completionTokens: 10, cacheHitTokens: 0 } };
      },
    };
    const r = await runContradictionPass(liveVault(), { stateVault: vaultDir(), scope: null, client, embedder: createHashEmbedder(), retry: { attempts: 1, sleep: async () => undefined } });
    expect(asked).toHaveLength(1);
    expect(asked[0].join(" | ")).toMatch(/25 Tsar Boris III Blvd.*10 Vitosha Blvd|10 Vitosha Blvd.*25 Tsar Boris III Blvd/);
    expect(r.findings).toHaveLength(1);
    expect(r.reviewItems).toHaveLength(1);
    expect(r.pairs).toBe(1);
  });

  it("reads an old claim's subject from its page", () => {
    const claims = collectClaims(liveVault());
    const ebook5 = claims.find((c) => c.id === "law/united-states-constitution/ebook")!;
    const ebook132 = claims.find((c) => c.id === "military/the-art-of-war/ebook")!;
    expect([...ebook5.subject.words]).toEqual(expect.arrayContaining(["united", "state", "constitution"]));
    expect(comparable(ebook5, ebook132)).toBe(false);
  });
});

// ── a document named as the subject (TASK-2188) ───────────────────────────
//
// The TASK-2180 UI test planted three contradictions in a fictional company's
// documents. The writer named the DOCUMENT as each fact's subject ("Acme
// Widgets Ltd Employee Handbook grants …" against "Acme Widgets Ltd Annual
// Leave Policy HR-07 grants …"), two documents' names were two subjects, and
// none of the three reached the judge — though both sources said "Every
// full-time employee of Acme Widgets Ltd …". A document's statement is about
// what it says; the facts of one company's documents are not all one subject.

const HANDBOOK = "Acme Widgets Ltd Employee Handbook";
/** The three planted pairs, as the writer worded them on the test (the report's leave pair, its remote-work and pallet misses). */
const PLANTED: Array<[string, [string, string, string], [string, string, string]]> = [
  [
    "annual leave 25 vs 20 days",
    ["hr/acme-widgets-ltd-employee-handbook/leave", HANDBOOK, `${HANDBOOK} grants full-time employees 25 working days of paid annual leave per calendar year.`],
    ["hr/annual-leave-policy-hr-07/leave", "Annual Leave Policy HR-07", "Acme Widgets Ltd Annual Leave Policy HR-07 grants full-time employees 20 working days of paid annual leave per calendar year."],
  ],
  [
    "remote work 2 vs 3 days a week",
    ["hr/acme-widgets-ltd-employee-handbook/remote", HANDBOOK, `${HANDBOOK} allows office-based employees to work remotely up to 2 days per week.`],
    ["hr/remote-work-policy-hr-09/remote", "Remote Work Policy HR-09", "Acme Widgets Ltd Remote Work Policy HR-09 allows employees in office-based roles to work from home up to 3 days per week."],
  ],
  [
    "1,200 vs 950 pallet spaces",
    ["operations/warehouse-operations-guide/pallets", "Warehouse Operations Guide", "Acme Widgets Ltd Warehouse Operations Guide states that the Plovdiv warehouse has 1,200 pallet spaces in 14 racking aisles."],
    ["management/management-review-5-october-2026/pallets", "Management Review 5 October 2026", "Acme Widgets Ltd Management Review of 5 October 2026 notes that the Plovdiv warehouse has 950 pallet spaces."],
  ],
];

const side = ([id, title, text]: [string, string, string]) => ({ text, subject: claimSubject(id, text, title), ids: sideIdentifiers(title, text, "concept") });

describe("a document named as the subject is about what it says", () => {
  it("reads whose document it is and what it says, and nothing from a fact about the document itself", () => {
    const leave = documentStatement(`${HANDBOOK} grants full-time employees 25 working days of paid annual leave per calendar year.`);
    expect([...leave!.name]).toEqual(["acme", "widget", "ltd", "employee"]);
    expect([...leave!.topic]).toEqual(["full", "time", "employee", "working", "day", "annual", "leave", "calendar", "year"]);
    expect([...documentStatement("Acme Widgets Ltd Annual Leave Policy HR-07 also does not allow unpaid leave.")!.name]).toEqual(["acme", "widget", "ltd", "annual", "leave"]);
    expect([...documentStatement("Acme Widgets Ltd Management Review of 5 October 2026 notes that the Plovdiv warehouse has 950 pallet spaces.")!.name]).toEqual(["acme", "widget", "ltd", "management"]);
    expect([...documentStatement("According to the Acme Widgets employee handbook, every full-time employee gets 25 working days of leave.")!.topic]).toEqual(["full", "time", "employee", "get", "working", "day", "leave"]);
    for (const text of [
      // About the document itself, as the writer wrote them on the board.
      "The Acme Widgets employee handbook is version 3.2, dated January 2026.",
      "The Acme Widgets Annual Leave Policy HR-07 is effective 1 January 2026.",
      "The Acme Widgets purchasing procedure carries the document code PUR-01.",
      // A real-world subject.
      "Every full-time employee of Acme Widgets is entitled to 20 working days of paid annual leave per calendar year.",
      "Acme Widgets pays all approved suppliers 45 days after the invoice date.",
      "Office-based Acme Widgets employees may work remotely up to 2 days per week with their line manager's approval.",
      // A stand-in, no name: the writer repairs it with the page's title.
      "The handbook grants full-time employees 25 working days of paid annual leave.",
      // No document: "According to" a person.
      "According to the warehouse manager, the Plovdiv warehouse has 950 pallet spaces.",
    ]) {
      expect(documentStatement(text), text).toBeNull();
    }
  });

  it.each(PLANTED)("pairs the planted %s, whatever their documents are called", (_, a, b) => {
    const [x, y] = [side(a), side(b)];
    expect(sameSubject(x.subject, y.subject)).toBe(true);
    expect(sameSubject(y.subject, x.subject)).toBe(true);
    expect(noPairReason(x, y)).toBeNull();
    expect(pairable(y, x)).toBe(true);
  });

  const S = claimSubject;
  /** The same planted facts as the writer worded them on the board for TASK-2188's beta runs: a document on one side only. */
  it.each([
    [
      S("hr/acme-widgets-employee-handbook-v3-2/a", "The Acme Widgets employee handbook grants full-time employees 25 working days of paid annual leave per calendar year.", "Acme Widgets Employee Handbook (v3.2)"),
      S("hr/annual-leave-policy-hr-07/b", "Every full-time employee of Acme Widgets is entitled to 20 working days of paid annual leave per calendar year.", "Annual Leave Policy HR-07"),
    ],
    [
      S("hr/acme-employee-handbook/a", "The employee handbook gives full-time Acme employees 25 working days of paid annual leave per calendar year.", "Acme Employee Handbook"),
      S("hr/annual-leave-policy-hr-07/b", "Full-time Acme employees are entitled to 20 working days of paid annual leave per calendar year.", "Annual Leave Policy HR-07"),
    ],
    [
      S("hr/acme-widgets-ltd-employee-handbook/a", `${HANDBOOK} grants full-time employees 25 working days of paid annual leave per calendar year.`, HANDBOOK),
      S("hr/annual-leave-policy-hr-07/b", "Every full-time employee of Acme Widgets Ltd is entitled to 20 working days of paid annual leave per calendar year.", "Annual Leave Policy HR-07"),
    ],
  ])("pairs a document's statement with the same fact worded about the company (%#)", (a, b) => {
    expect(sameSubject(a, b)).toBe(true);
    expect(sameSubject(b, a)).toBe(true);
  });

  const apart: Array<[string, ReturnType<typeof S>, ReturnType<typeof S>]> = [
    [
      "two policies' own dates",
      S("hr/annual-leave-policy-hr-07/a", "The Acme Widgets Annual Leave Policy HR-07 is effective 1 January 2026.", "Annual Leave Policy HR-07"),
      S("hr/remote-work-policy-hr-09/b", "The Acme Widgets Remote Work Policy HR-09 is effective 1 February 2026.", "Remote Work Policy HR-09"),
    ],
    [
      "two documents of one company that say different things",
      S("it/it-security-policy-it-02/a", "Acme Widgets Ltd IT Security Policy IT-02 requires passwords of at least 12 characters.", "IT Security Policy IT-02"),
      S("finance/travel-and-expense-policy-fin-03/b", "Acme Widgets Ltd Travel and Expense Policy FIN-03 requires expense receipts to be submitted within 30 days of the trip.", "Travel and Expense Policy FIN-03"),
    ],
    [
      "full-time leave against part-time leave",
      S("hr/acme-widgets-ltd-employee-handbook/a", `${HANDBOOK} grants full-time employees 25 working days of paid annual leave per calendar year.`, HANDBOOK),
      S("hr/annual-leave-policy-hr-07/b", "Acme Widgets Ltd Annual Leave Policy HR-07 grants part-time employees annual leave in proportion to their contracted hours.", "Annual Leave Policy HR-07"),
    ],
    [
      "the leave of another company",
      S("hr/acme-widgets-ltd-employee-handbook/a", `${HANDBOOK} grants full-time employees 25 working days of paid annual leave per calendar year.`, HANDBOOK),
      S("hr/globex-staff-handbook/b", "Globex Corporation Staff Handbook grants full-time employees 20 working days of paid annual leave per calendar year.", "Globex Staff Handbook"),
    ],
    [
      "two numbered products",
      S("support/acme-customer-faq/a", "Acme Widgets Ltd Customer FAQ states that the Sprocket X200 weighs 1.5 kg.", "Acme Customer FAQ"),
      S("sales/acme-product-catalogue/b", "Acme Widgets Ltd Product Catalogue states that the Sprocket X300 weighs 1.2 kg.", "Acme Product Catalogue"),
    ],
    [
      "two policies' statements on different things, though their names share most words",
      S("hr/annual-leave-policy-hr-07/a", "Acme Widgets Ltd Annual Leave Policy HR-07 allows at most 5 unused leave days to be carried over to 31 March of the next year.", "Annual Leave Policy HR-07"),
      S("it/it-security-policy-it-02/b", "Acme Widgets Ltd IT Security Policy IT-02 requires a security incident to be reported to the IT helpdesk within 24 hours.", "IT Security Policy IT-02"),
    ],
    [
      "a policy's statement and a fact about another document",
      S("hr/acme-employee-handbook/a", "The employee handbook gives full-time Acme employees 25 working days of paid annual leave per calendar year.", "Acme Employee Handbook"),
      S("hr/new-employee-onboarding-checklist/b", "Before a new employee's first day, Acme HR sends the employment contract and the employee handbook.", "New Employee Onboarding Checklist"),
    ],
  ];
  it.each(apart)("does not pair %s", (_, a, b) => {
    expect(sameSubject(a, b)).toBe(false);
    expect(sameSubject(b, a)).toBe(false);
  });
});

/** The test's documents in miniature, every fact worded with its document as the subject. */
function documentSubjectVault() {
  const page = (title: string, facts: Array<[string, string]>) =>
    pageText({ title, claims: facts.map(([id, text]) => claim(id, text)) });
  return snapshot({
    "concepts/acme-widgets-ltd-employee-handbook.md": page(HANDBOOK, [
      ["hr/acme-widgets-ltd-employee-handbook/leave", PLANTED[0][1][2]],
      ["hr/acme-widgets-ltd-employee-handbook/remote", PLANTED[1][1][2]],
      ["hr/acme-widgets-ltd-employee-handbook/sick", `${HANDBOOK} requires an ill employee to tell their line manager before 10:00 on the first day of absence.`],
      ["hr/acme-widgets-ltd-employee-handbook/version", `${HANDBOOK} is version 3.2, dated January 2026.`],
    ]),
    "concepts/annual-leave-policy-hr-07.md": page("Annual Leave Policy HR-07", [
      ["hr/annual-leave-policy-hr-07/leave", PLANTED[0][2][2]],
      ["hr/annual-leave-policy-hr-07/carry-over", "Acme Widgets Ltd Annual Leave Policy HR-07 allows at most 5 unused leave days to be carried over to 31 March of the next year."],
      ["hr/annual-leave-policy-hr-07/effective", "Acme Widgets Ltd Annual Leave Policy HR-07 is effective 1 January 2026."],
    ]),
    "concepts/remote-work-policy-hr-09.md": page("Remote Work Policy HR-09", [
      ["hr/remote-work-policy-hr-09/remote", PLANTED[1][2][2]],
      ["hr/remote-work-policy-hr-09/reachable", "Acme Widgets Ltd Remote Work Policy HR-09 requires remote employees to be reachable between 10:00 and 16:00."],
    ]),
    "concepts/warehouse-operations-guide.md": page("Warehouse Operations Guide", [
      ["operations/warehouse-operations-guide/pallets", PLANTED[2][1][2]],
      ["operations/warehouse-operations-guide/forklift", "Acme Widgets Ltd Warehouse Operations Guide requires a valid forklift certificate to operate a forklift."],
    ]),
    "concepts/management-review-5-october-2026.md": page("Management Review 5 October 2026", [
      ["management/management-review-5-october-2026/pallets", PLANTED[2][2][2]],
      ["management/management-review-5-october-2026/revenue", "Acme Widgets Ltd Management Review of 5 October 2026 reports Q3 revenue of EUR 1.42 million, 6% above plan."],
    ]),
    "concepts/it-security-policy-it-02.md": page("IT Security Policy IT-02", [
      ["it/it-security-policy-it-02/passwords", "Acme Widgets Ltd IT Security Policy IT-02 requires passwords of at least 12 characters."],
      ["it/it-security-policy-it-02/incidents", "Acme Widgets Ltd IT Security Policy IT-02 requires a security incident to be reported to the IT helpdesk within 24 hours."],
    ]),
    "concepts/travel-and-expense-policy-fin-03.md": page("Travel and Expense Policy FIN-03", [
      ["finance/travel-and-expense-policy-fin-03/receipts", "Acme Widgets Ltd Travel and Expense Policy FIN-03 requires expense receipts to be submitted within 30 days of the trip."],
    ]),
  });
}

describe("the contradiction pass judges a document's statement against the same fact elsewhere", () => {
  it("asks the judge about the three planted pairs, and about no two different facts of the company's documents", async () => {
    const asked: string[] = [];
    // A judge that calls EVERY pair a contradiction: only the pairing decides what reaches Review.
    const client: FlashClient = {
      model: "deepseek-v4-flash",
      async complete(request) {
        const items = readJudgeItems(request.user) ?? [];
        for (const it of items) asked.push([it.a, it.b].sort().join(" | "));
        const text = JSON.stringify(items.map((it) => ({ i: it.i, verdict: "contradiction", why: "differs" })));
        return { text, model: "deepseek-v4-flash", usage: { promptTokens: 100, completionTokens: 10, cacheHitTokens: 0 } };
      },
    };
    const r = await runContradictionPass(documentSubjectVault(), { stateVault: vaultDir(), scope: null, client, embedder: createHashEmbedder(), retry: { attempts: 1, sleep: async () => undefined } });
    expect(asked.sort()).toEqual(PLANTED.map(([, a, b]) => [a[2], b[2]].sort().join(" | ")).sort());
    expect(r.pairs).toBe(3);
    expect(r.reviewItems).toHaveLength(3);
  });
});
