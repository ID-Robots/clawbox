/**
 * A per-project standing permission in the config store.
 *
 * Two of these exist — "the assistant may ship this project to production" and
 * "every run in this project goes through the delivery pipeline" — and both are
 * consents for something that happens while nobody is watching. So the rules
 * they share are tested once, here: every unreadable value fails towards OFF,
 * only the trues are stored, and `__proto__` is a legal project name.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

type Switch = typeof import("@/lib/project-switch");
type Store = typeof import("@/lib/coding-pipeline-store");

let lib: Switch;
let store: Store;
let root: string;
let restore: () => void;

const KEY = "coding_pipeline_projects";

function writeConfig(value: unknown): void {
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ [KEY]: value }), "utf-8");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, "data", "config.json"), "utf-8"))[KEY];
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "project-switch-"));
  root = path.join(base, "clawbox");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = base;
  process.env.CLAWBOX_ROOT = root;
  fs.writeFileSync(path.join(root, "data", "config.json"), "{}", "utf-8");
  const { vi } = await import("vitest");
  vi.resetModules();
  lib = await import("@/lib/project-switch");
  store = await import("@/lib/coding-pipeline-store");
});

afterEach(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
  restore();
});

describe("reading", () => {
  it("is off until an explicit true for THAT project", async () => {
    expect(await lib.readProjectSwitch(KEY, "shop")).toBe(false);
    writeConfig({ other: true });
    expect(await lib.readProjectSwitch(KEY, "shop")).toBe(false);
    writeConfig({ shop: true });
    expect(await lib.readProjectSwitch(KEY, "shop")).toBe(true);
  });

  it("fails towards OFF on every value that is not the map", async () => {
    for (const value of ["yes", 1, [], null, true]) {
      writeConfig(value);
      expect(await lib.readProjectSwitch(KEY, "shop")).toBe(false);
    }
    writeConfig({ shop: "yes" });
    expect(await lib.readProjectSwitch(KEY, "shop")).toBe(false);
  });

  it("is off for a caller that named no project at all", async () => {
    writeConfig({ shop: true });
    expect(await lib.readProjectSwitch(KEY, null)).toBe(false);
    expect(await lib.readProjectSwitch(KEY, "")).toBe(false);
  });

  it("does not read a prototype key as a project that is switched on", async () => {
    expect(await lib.readProjectSwitch(KEY, "constructor")).toBe(false);
    expect(await lib.readProjectSwitch(KEY, "toString")).toBe(false);
  });
});

describe("writing", () => {
  it("stores only the trues, so the map cannot grow a row per project ever looked at", async () => {
    await lib.setProjectSwitch(KEY, "shop", true);
    await lib.setProjectSwitch(KEY, "site", true);
    expect(readConfig()).toEqual({ shop: true, site: true });
    await lib.setProjectSwitch(KEY, "shop", false);
    expect(readConfig()).toEqual({ site: true });
  });

  it("survives a project actually called __proto__", async () => {
    await lib.setProjectSwitch(KEY, "__proto__", true);
    expect(await lib.readProjectSwitch(KEY, "__proto__")).toBe(true);
    // …and did not write the accumulator's prototype instead.
    expect(Object.prototype.hasOwnProperty.call({}, "polluted")).toBe(false);
  });

  it("serialises two writes that arrive together, so neither loses the other", async () => {
    await Promise.all([
      lib.setProjectSwitch(KEY, "a", true),
      lib.setProjectSwitch(KEY, "b", true),
      lib.setProjectSwitch(KEY, "c", true),
    ]);
    expect(readConfig()).toEqual({ a: true, b: true, c: true });
  });

  it("lists what is on, box scope and junk left out", async () => {
    await lib.setProjectSwitch(KEY, "shop", true);
    await lib.setProjectSwitch(KEY, "site", true);
    expect(await lib.readProjectSwitches(KEY)).toEqual(["shop", "site"]);
  });
});

describe("the pipeline's own default", () => {
  it("is that switch under its own key", async () => {
    expect(await store.readPipelineDefault("shop")).toBe(false);
    await store.setPipelineDefault("shop", true);
    expect(await store.readPipelineDefault("shop")).toBe(true);
    expect(await store.readPipelineProjects()).toEqual(["shop"]);
    expect(store.PIPELINE_PROJECTS_CONFIG_KEY).toBe(KEY);
  });
});

describe("a project name this cannot be filed under", () => {
  it("is not written, because the next write would drop it anyway", async () => {
    // `resolveProjectScope` answers a FOLDER's own name, which is not held to
    // the secret store's alphabet. Written, such a row would be filtered out by
    // the next write and missing from the list in between — a permission the
    // owner gave that quietly disappears.
    expect(await lib.setProjectSwitch(KEY, "my.project", true)).toBe(false);
    expect(readConfig()).toBeUndefined();
    expect(await lib.readProjectSwitches(KEY)).toEqual([]);
  });

  it("refuses the box-wide sentinel: these are PER-project switches", async () => {
    expect(await lib.setProjectSwitch(KEY, "@box", true)).toBe(false);
    expect(readConfig()).toBeUndefined();
  });

  it("still READS a row written before that rule, because it was the owner's answer", async () => {
    writeConfig({ "my.project": true });
    expect(await lib.readProjectSwitch(KEY, "my.project")).toBe(true);
  });
});
