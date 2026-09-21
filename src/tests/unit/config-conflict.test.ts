import { describe, expect, it } from "vitest";
import {
  CONFIG_BUSY_ERROR_CODE,
  CONFIG_BUSY_MESSAGE,
  isConfigBusyPayload,
  isConfigMutationConflict,
} from "@/lib/config-conflict";

// The sentence a real box put in the chat transcript, verbatim, as the first
// thing the owner saw after finishing setup. It carries no class name, which is
// exactly why the class-name-only retry never fired for it.
const HUMANIZED =
  "The config file changed while this command was writing (config changed since last load), so nothing was changed. Re-run the same command to pick up the new file and try again.";

/** The older spelling, the one ClawBox has always known. */
const CLASS_NAMED = "ConfigMutationConflictError: config changed since last load";

describe("isConfigMutationConflict", () => {
  it("matches the CLI's humanized refusal", () => {
    expect(isConfigMutationConflict(HUMANIZED)).toBe(true);
    expect(isConfigMutationConflict(new Error(HUMANIZED))).toBe(true);
  });

  it("still matches the class-named refusal", () => {
    expect(isConfigMutationConflict(CLASS_NAMED)).toBe(true);
    expect(isConfigMutationConflict(new Error(CLASS_NAMED))).toBe(true);
  });

  it("matches either half of the humanized wording on its own", () => {
    // The CLI could keep one clause and drop the other in a future release.
    // Neither half alone may take the conflict back to being unrecognised.
    expect(isConfigMutationConflict("config changed since last load")).toBe(true);
    expect(
      isConfigMutationConflict("The config file changed while this command was writing."),
    ).toBe(true);
  });

  it("ignores case, and finds the signature inside a longer stderr", () => {
    expect(isConfigMutationConflict("configmutationconflicterror: nope")).toBe(true);
    expect(
      isConfigMutationConflict(`openclaw config set agents.defaults.model.primary\n${HUMANIZED}\n`),
    ).toBe(true);
  });

  it("does not match failures that must stay final", () => {
    // A schema rejection does not become valid by being repeated, and a
    // predicate that retried one would turn a clear refusal into four slow ones.
    for (const raw of [
      "Invalid model reference: openai/nope is not in any enabled catalog",
      "Config path not found: models.providers.x. Nothing was changed.",
      "the config was written",
      "EACCES: permission denied",
      "",
    ]) {
      expect(isConfigMutationConflict(raw)).toBe(false);
    }
  });

  it("answers false for anything that is not an Error or a string", () => {
    for (const raw of [null, undefined, 42, {}, { message: "config changed since last load" }]) {
      expect(isConfigMutationConflict(raw)).toBe(false);
    }
  });
});

describe("isConfigBusyPayload", () => {
  it("recognises the code a current server sends", () => {
    expect(isConfigBusyPayload({ error: CONFIG_BUSY_MESSAGE, code: CONFIG_BUSY_ERROR_CODE }))
      .toBe(true);
  });

  it("recognises an older server that still sends the CLI's own sentence", () => {
    // One half of a rolling update, or a box that has not taken this fix yet.
    // The client must not put that sentence on screen just because the field
    // it arrived in has no code beside it.
    expect(isConfigBusyPayload({ error: HUMANIZED })).toBe(true);
    expect(isConfigBusyPayload({ error: CLASS_NAMED })).toBe(true);
  });

  it("leaves every other failure alone", () => {
    expect(isConfigBusyPayload({ error: "Selected AI provider is not configured" })).toBe(false);
    expect(isConfigBusyPayload({ code: "something_else" })).toBe(false);
    expect(isConfigBusyPayload({})).toBe(false);
    expect(isConfigBusyPayload(null)).toBe(false);
    expect(isConfigBusyPayload("config changed since last load")).toBe(false);
  });
});

describe("the copy that replaces the CLI's sentence", () => {
  it("names neither the config file nor a command to re-run", () => {
    expect(CONFIG_BUSY_MESSAGE).not.toMatch(/config file|re-run|command|openclaw/i);
  });
});
