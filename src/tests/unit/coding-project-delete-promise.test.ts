/**
 * THE SENTENCE THE OWNER AGREES TO, HELD AGAINST WHAT THE BOX ACTUALLY DOES.
 *
 * Removing a project is consented to on the strength of one line of copy. The
 * first version of that line said the folder was "kept there for 30 days" and
 * nothing else — while `pruneProjectTrash` has always ALSO enforced a count
 * bound, so an eleventh removal deletes the oldest for good, possibly minutes
 * after it was put there. The code was right (an appliance cannot keep an
 * unbounded shelf of whole project folders); the sentence was not.
 *
 * A test over the retention CODE could not have caught that: it passed. What
 * was wrong was the gap between the policy and the promise, so that gap is what
 * this file tests — in both directions, and in every language, because an owner
 * reading the German string is agreeing to exactly as much as one reading the
 * English.
 */

import { describe, expect, it } from "vitest";
import { translations } from "@/lib/translations";
import { MAX_TRASH_ENTRIES, TRASH_RETENTION_DAYS } from "@/lib/coding-project-delete";
import type { Locale } from "@/lib/i18n";

const LOCALES = Object.keys(translations) as Locale[];

/** The two lines that state the retention rule: one before, one after. */
const PROMISES = ["codingAgent.delete.willMove", "codingAgent.delete.retention"];

/** The lines that exist only to report the count bound biting. */
const PURGE_LINES = ["codingAgent.delete.willPurge", "codingAgent.delete.purged"];

describe("the retention promise", () => {
  it("is made of exactly the two bounds the prune enforces", () => {
    // If a third bound is ever added to `planTrashPrune`, this is the test that
    // should be updated in the same commit as the copy.
    expect(TRASH_RETENTION_DAYS).toBe(30);
    expect(MAX_TRASH_ENTRIES).toBe(10);
  });

  for (const locale of LOCALES) {
    it(`'${locale}' states BOTH bounds wherever it states one`, () => {
      for (const key of PROMISES) {
        const copy = translations[locale][key];
        expect(copy, `${locale} is missing ${key}`).toBeTruthy();
        // The count bound is the one that makes the period conditional. A
        // sentence that names the days and not the count is the defect this
        // file exists for, whatever language it is written in.
        expect(copy, `${locale}.${key} names the period but not the count bound: ${copy}`)
          .toContain("{max}");
        expect(copy, `${locale}.${key} names the count bound but not the period: ${copy}`)
          .toContain("{days}");
      }
    });

    it(`'${locale}' can name what an early purge takes`, () => {
      for (const key of PURGE_LINES) {
        const copy = translations[locale][key];
        expect(copy, `${locale} is missing ${key}`).toBeTruthy();
        // Without the names, the warning is "something will be deleted" — which
        // is not a thing anyone can consent to.
        expect(copy, `${locale}.${key} does not name what goes: ${copy}`).toContain("{names}");
      }
    });
  }

  it("never promises the period unconditionally in English", () => {
    // The exact wording that was wrong, pinned as a shape rather than a string:
    // "for {days} days" with nothing qualifying it. "up to {days} days" passes,
    // "for {days} days" alone does not.
    for (const key of PROMISES) {
      expect(translations.en[key]).not.toMatch(/(?<!up to )\{days\} days\b(?![^.]*\{max\})/);
    }
  });
});
