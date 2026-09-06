// What may leave the CI bots' model call and reach GitHub.
//
// Both bots (issue-triage, pr-review) hand the model's JSON to `gh`: label
// names, a comment body. The OAuth CLI transport only PASTES the schema into
// the prompt — nothing enforced it — and an issue body is attacker-chosen
// text, so a coaxed reply could name a label, @-mention a maintainer or drop
// an `<a href>` into a comment signed by the bot. Three fences live here, in
// a module with no side effects so a test can import them (the bot scripts
// themselves read GITHUB_EVENT_PATH and run at load):
//
//   - assertMatchesSchema: the model object against the schema it was asked
//     for, on BOTH transports. Enum/type violations and a missing required key
//     THROW (the triage is skipped and the run page says why); an unknown key
//     is DROPPED and an over-long string TRUNCATED, because a stray key or a
//     sentence five characters over the cap is not worth an untriaged issue.
//   - the label tables: every label `gh label create` ever sees is a value of
//     one of these, looked up by the model's key — a missing key throws, so no
//     model string is a label name on any transport.
//   - plain(): the free-text fields rendered into a comment, with the Markdown
//     and HTML that could restyle it or notify someone taken out.
//
// No ajv, no dependency: the workflows install only the CLI or the SDK.

/**
 * Validate `value` against the JSON-schema subset the two bots use — object,
 * string, array, boolean, `enum`, `required`, `additionalProperties: false`,
 * `maxLength`, `maxItems`, nested `properties`/`items` — and return the
 * conformed copy: unknown keys gone, strings and arrays cut to their caps.
 *
 * Throws `model output rejected at <path>: …` on a type or enum violation, a
 * missing required key, or a schema keyword this validator cannot check — a
 * schema it does not understand must not pass silently.
 */
export function assertMatchesSchema(schema, value, path = "$") {
  const fail = (what) => {
    throw new Error(`model output rejected at ${path}: ${what}`);
  };
  const describe = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    fail(`expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)?.slice(0, 80) ?? describe(value)}`);
  }

  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") fail(`expected a string, got ${describe(value)}`);
      return typeof schema.maxLength === "number" && value.length > schema.maxLength
        ? value.slice(0, schema.maxLength)
        : value;
    }
    case "boolean": {
      if (typeof value !== "boolean") fail(`expected a boolean, got ${describe(value)}`);
      return value;
    }
    case "array": {
      if (!Array.isArray(value)) fail(`expected an array, got ${describe(value)}`);
      const items = typeof schema.maxItems === "number" && value.length > schema.maxItems
        ? value.slice(0, schema.maxItems)
        : value;
      return schema.items ? items.map((item, i) => assertMatchesSchema(schema.items, item, `${path}[${i}]`)) : items;
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail(`expected an object, got ${describe(value)}`);
      }
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`missing required key "${key}"`);
      }
      const out = {};
      for (const [key, sub] of Object.entries(properties)) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          out[key] = assertMatchesSchema(sub, value[key], `${path}.${key}`);
        }
      }
      // Unknown keys are dropped, never refused — and never passed through:
      // every schema here declares `additionalProperties: false`, and a
      // schema that did not would still be handing a caller a key it did not
      // ask for.
      return out;
    }
    default:
      return fail(`schema type ${JSON.stringify(schema.type)} is not one this validator checks`);
  }
}

// ---------- the label tables ---------------------------------------------------

// Keep the `area` keys in sync with AREA_RULES in scripts/pr-review.mjs — both
// bots must emit the same `area: X` label taxonomy.
export const PRIORITY_LABELS = Object.freeze({
  high: Object.freeze({ name: "priority: high", color: "b60205", icon: "🔴" }),
  medium: Object.freeze({ name: "priority: medium", color: "fbca04", icon: "🟡" }),
  low: Object.freeze({ name: "priority: low", color: "0e8a16", icon: "🟢" }),
});

export const CATEGORY_LABELS = Object.freeze({
  bug: Object.freeze({ name: "bug", color: "d73a4a" }),
  enhancement: Object.freeze({ name: "enhancement", color: "a2eeef" }),
  documentation: Object.freeze({ name: "documentation", color: "0075ca" }),
  question: Object.freeze({ name: "question", color: "d876e3" }),
  invalid: Object.freeze({ name: "invalid", color: "e4e669" }),
});

export const AREA_LABELS = Object.freeze(
  Object.fromEntries(["install", "ui", "ci-e2e", "gateway", "docs", "other"].map((area) => [
    area,
    Object.freeze({ name: `area: ${area}`, color: "c5def5" }),
  ])),
);

/**
 * The label for a model-chosen key, from one of the tables above — or a throw.
 * There is deliberately no fallback colour and no fallback name: the old
 * `?? "ededed"` was what let any string become a label.
 */
export function labelFor(table, tableName, key) {
  if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(table, key)) {
    throw new Error(`model output rejected: ${tableName} ${JSON.stringify(key)?.slice(0, 80) ?? String(key)} is not one of ${JSON.stringify(Object.keys(table))}`);
  }
  return table[key];
}

// The triage schema is BUILT from the tables, so the enum the model is asked
// for and the keys the labels are looked up by cannot drift apart.
export const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: Object.keys(CATEGORY_LABELS) },
    priority: { type: "string", enum: Object.keys(PRIORITY_LABELS) },
    area: { type: "string", enum: Object.keys(AREA_LABELS) },
    summary: { type: "string", maxLength: 200, description: "One plain-language sentence, <=140 chars." },
    suggested_action: { type: "string", maxLength: 500, description: "One concrete next step for the maintainer." },
  },
  required: ["category", "priority", "area", "summary", "suggested_action"],
  additionalProperties: false,
};

// ---------- the comment sanitiser ----------------------------------------------

/**
 * Model free text as ONE inert line of a GitHub comment.
 *
 * GitHub renders HTML in comments (the bots' own footers use `<a>`), turns
 * `[x](y)` and bare `https://…` into links, notifies every `@user`, and reads
 * a newline as the end of the line the text was put on — so a summary could
 * close "**Suggested next step:**" and open a heading of its own. Each of
 * those is taken apart rather than trusted to the model: `&`, `<` and `>`
 * escaped, the link syntax, the scheme and a `www.` broken, a zero-width
 * space after `@`,
 * newlines collapsed, a leading block marker (heading, quote, list, fence)
 * removed, and the whole thing capped. What stays is text; a URL a reader can
 * still copy out is the accepted residual (`#123` autolinks too).
 */
export function plain(text, max = 500) {
  let out = String(text ?? "");
  out = out.replace(/\s*[\r\n]+\s*/g, " ");
  out = out.replace(/^(?:\s*(?:#{1,6}(?=\s|$)|>|[-*+](?=\s)|```|~~~))+\s*/, "");
  // `&` first, so an entity the model wrote (`&#64;maintainer` is `@` once
  // GitHub has decoded it, and the mention filter runs over the decoded text)
  // is shown as the entity and never decoded — and so the `&lt;` written on
  // the next line is not itself re-escaped.
  out = out.replace(/&/g, "&amp;");
  out = out.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  out = out.replace(/\]\(/g, "] (");
  out = out.replace(/(https?):\/\//gi, "$1:\u200b//");
  // GitHub's extended autolink makes a link of `www.` with no scheme at all.
  out = out.replace(/\bwww\./gi, "www.\u200b");
  out = out.replace(/@(?=[\w-])/g, "@\u200b");
  out = out.trim();
  if (out.length > max) out = `${out.slice(0, Math.max(0, max - 1))}…`;
  return out;
}
