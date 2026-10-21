/**
 * The App Store's data layer for ClawBox Apps (src/lib/store-categories.ts):
 * the category tab is first, named and counted, never doubled, and absent
 * when the Store lists no ClawBox app at all.
 */
import { describe, expect, it } from "vitest";
import { CLAWBOX_APPS_CATEGORY, CLAWBOX_APPS_CATEGORY_NAME, isClawboxListing, mergeStoreCategories } from "@/lib/store-categories";

const skills = [
  { id: "productivity", name: "Productivity", count: 120 },
  { id: "developer", name: "Developer", count: 80 },
];

describe("mergeStoreCategories", () => {
  it("puts ClawBox Apps first when the portal lists it", () => {
    const merged = mergeStoreCategories([...skills, { id: CLAWBOX_APPS_CATEGORY, name: "ClawBox Apps", count: 3 }], []);
    expect(merged.map((c) => c.id)).toEqual([CLAWBOX_APPS_CATEGORY, "productivity", "developer"]);
    expect(merged[0]).toEqual({ id: CLAWBOX_APPS_CATEGORY, name: "ClawBox Apps", count: 3 });
  });

  it("adds the tab, named and counted, when the apps carry ClawBox apps the categories do not", () => {
    const apps = [{ source: "clawbox", category: CLAWBOX_APPS_CATEGORY }, { source: "clawbox", category: CLAWBOX_APPS_CATEGORY }, { category: "developer" }];
    expect(mergeStoreCategories(skills, apps)[0]).toEqual({ id: CLAWBOX_APPS_CATEGORY, name: CLAWBOX_APPS_CATEGORY_NAME, count: 2 });
  });

  it("names an unnamed tab and never counts fewer than the page shows", () => {
    const merged = mergeStoreCategories([{ id: CLAWBOX_APPS_CATEGORY, name: "", count: 1 }], [{ source: "clawbox" }, { source: "clawbox" }]);
    expect(merged).toEqual([{ id: CLAWBOX_APPS_CATEGORY, name: CLAWBOX_APPS_CATEGORY_NAME, count: 2 }]);
  });

  it("never lists a category twice", () => {
    const merged = mergeStoreCategories([...skills, skills[0], { id: CLAWBOX_APPS_CATEGORY, name: "ClawBox Apps", count: 1 }, { id: CLAWBOX_APPS_CATEGORY, name: "ClawBox Apps", count: 1 }], []);
    expect(merged.map((c) => c.id)).toEqual([CLAWBOX_APPS_CATEGORY, "productivity", "developer"]);
  });

  it("shows no ClawBox Apps tab when there is no ClawBox app", () => {
    expect(mergeStoreCategories(skills, [{ category: "developer" }])).toEqual(skills);
    expect(mergeStoreCategories([], [])).toEqual([]);
  });
});

describe("isClawboxListing", () => {
  it("is the listing's source, not its category", () => {
    expect(isClawboxListing({ source: "clawbox" })).toBe(true);
    expect(isClawboxListing({ source: "clawhub" })).toBe(false);
    expect(isClawboxListing(null)).toBe(false);
  });
});
