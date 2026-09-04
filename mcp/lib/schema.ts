// Parameter-schema builders.
//
// Rules these encode, because the device may run a 4-8B local model and both
// harnesses rewrite schemas on the way in:
//   - Every number is a bounded integer with a stated default. A bare
//     z.number() is how read_file got a negative `offset` and mis-sliced.
//   - Every string has a max, and a regex whenever the domain is closed.
//   - Closed sets are z.enum, never free text: the schema IS the validation,
//     so a wrong value never reaches the device.
//   - No .nullable() (emits anyOf:[X,{type:null}], which the two harnesses
//     rewrite differently), no $ref/oneOf/allOf, no nested objects, and no
//     JSON-in-a-string parameters.
//   - Parameter names match ^[a-z][a-z0-9_]{0,31}$ — Hermes' schema sanitizer
//     silently renames anything else and the handler stops seeing its argument.

import { z } from "zod";

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,49}$/;
export const PARAM_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * A bounded integer with a default — for a knob whose absence has a MEANING:
 * `limit`, `timeout`, `offset`. `.default()` makes the parameter optional, so
 * this is the wrong builder for an identifier, where a missing argument would
 * quietly become a real record's id. Use zReqInt for those.
 */
export function zInt(min: number, max: number, def: number, description: string) {
  return z.number().int().min(min).max(max).default(def).describe(description);
}

/** A bounded integer the caller must supply. */
export function zReqInt(min: number, max: number, description: string) {
  return z.number().int().min(min).max(max).describe(description);
}

/** A length-capped required string. */
export function zText(max: number, description: string) {
  return z.string().min(1).max(max).describe(description);
}

/**
 * A length-capped string that may be empty — for a replacement value where ""
 * legitimately means "delete this". Never use `.or()` to express this: a union
 * emits anyOf, which the two harnesses rewrite differently.
 */
export function zMaybeEmptyText(max: number, description: string) {
  return z.string().max(max).describe(description);
}

/** A length-capped optional string. */
export function zOptText(max: number, description: string) {
  return z.string().min(1).max(max).optional().describe(description);
}

/** A lowercase id: app ids, project ids, webapp ids. */
/**
 * An `installed-<id>` the caller invented, gated on SHAPE only — membership is
 * checked separately against what the device reports.
 *
 * The alphabet is the PRODUCERS', not this file's: `APP_ID_RE`
 * (src/lib/code-projects.ts, the webapp routes) and the store's `SLUG`
 * (setup-api/apps/install) both accept upper case and underscores, so a webapp
 * legitimately called `Foo_Bar` exists on boxes today. Gating on `zSlug`'s
 * narrower lowercase-and-hyphen rule refused to open it — a tool saying "that
 * is not a valid app id" about an id the device created. Kept in step by
 * src/tests/unit/mcp-desktop-apps.test.ts.
 *
 * Deliberately still a closed alphabet: no dots, no slashes, no whitespace, so
 * the value cannot become a path or a second field on its way to the desktop.
 */
export const INSTALLED_APP_ID_RE = /^installed-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function zSlug(description: string) {
  return z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "lowercase letters, digits and hyphens only").describe(description);
}

/** A boolean with a stated default. */
export function zBool(def: boolean, description: string) {
  return z.boolean().default(def).describe(description);
}

/** A closed set built from a runtime-known list. */
export function zEnumOf(values: readonly string[], description: string) {
  return z.enum(values as unknown as [string, ...string[]]).describe(description);
}

/**
 * The confirmation gate on irreversible device actions. A literal `true` is the
 * cheapest thing an injected web page cannot supply by accident and the
 * cheapest thing a small model gets right when the user actually asked.
 */
export function zConfirm(description: string) {
  return z.literal(true).describe(description);
}

export type Shape = Record<string, z.ZodTypeAny>;
