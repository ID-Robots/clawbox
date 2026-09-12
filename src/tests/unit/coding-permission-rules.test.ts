/**
 * The grammar and the floor of an owner permission rule.
 *
 * The property this file exists for: **an owner rule can never widen past what
 * the device denies every run**. A deny rule outranks an allow rule in Claude
 * Code, so a rule inside a denied tree would grant nothing at all — the danger
 * is not that it works, it is that it sits in the owner's list looking like a
 * standing permission the box does not honour. Everything below is either that
 * property or the grammar that serves it.
 *
 * The one deliberate exception is the SOFT half: the harness's own per-project
 * state, which is denied only because it is outside the working folder. One
 * named project folder may be unlocked; the parent, the siblings and every
 * credential beside them may not.
 */
import { describe, expect, it } from "vitest";
import {
  ALLOW_RULE_REFUSAL_KEYS,
  ALLOW_RULE_REFUSALS,
  ALLOW_RULE_TOOLS,
  concretePrefix,
  deriveAllowRule,
  isAllowRuleRefusal,
  MAX_ALLOW_RULES,
  MAX_RULE_CHARS,
  normalizeAllowRules,
  softProjectDir,
  SOFT_HOME_SUBTREES,
  unlockedSoftPaths,
  validateAllowRule,
  type AllowRuleContext,
} from "@/lib/coding-permission-rules";
import { codingAgentEn as editionEn } from "@/lib/edition-translations/en-coding-agent";

const HOME = "/home/clawbox";

/** A device context in the shape `allowRuleContext()` builds on a real box. */
function context(extraDenies: string[] = []): AllowRuleContext {
  return {
    homeDir: HOME,
    denyRules: [
      // The wholesale harness-state deny a run gets with no rules of its own.
      `Read(/${HOME}/.claude-ds/**)`,
      `Edit(/${HOME}/.claude-ds/**)`,
      `Write(/${HOME}/.claude-ds/**)`,
      `Read(/${HOME}/.ssh/**)`,
      // The checkout's own secrets, denied file by file the way fileDenyRules
      // denies them.
      `Read(/${HOME}/clawbox/data/config.json)`,
      `Read(/${HOME}/clawbox/data/.mcp-token)`,
      ...extraDenies,
    ],
  };
}

/** The rule text, or the refusal code — whichever the verdict carries. */
function verdict(raw: unknown, known: string[] = [], ctx?: AllowRuleContext): string {
  const v = validateAllowRule(raw, known, ctx);
  return v.ok ? v.rule : v.code;
}

describe("the shape of a rule", () => {
  it("takes a file tool and the paths it may open", () => {
    for (const tool of ALLOW_RULE_TOOLS) {
      const v = validateAllowRule(`${tool}(//home/clawbox/Projects/notes/**)`, [], context());
      expect(v.ok, tool).toBe(true);
      if (v.ok) {
        expect(v.tool).toBe(tool);
        expect(v.specifier).toBe("//home/clawbox/Projects/notes/**");
        // Stored verbatim: what is on the list is what reaches argv.
        expect(v.rule).toBe(`${tool}(//home/clawbox/Projects/notes/**)`);
      }
    }
  });

  it("trims the surrounding whitespace and nothing else", () => {
    const v = validateAllowRule("  Read(//home/clawbox/Projects/notes/**)  ", [], context());
    expect(v.ok && v.rule).toBe("Read(//home/clawbox/Projects/notes/**)");
  });

  it("refuses anything that is not text", () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      expect(verdict(bad), JSON.stringify(bad) ?? "undefined").toBe("malformed");
    }
  });

  it("refuses an empty rule, and says so as its own code", () => {
    expect(verdict("")).toBe("empty");
    expect(verdict("   \t ")).toBe("empty");
  });

  it("refuses a rule longer than the bound", () => {
    const long = `Read(//home/clawbox/${"a".repeat(MAX_RULE_CHARS)}/**)`;
    expect(long.length).toBeGreaterThan(MAX_RULE_CHARS);
    expect(verdict(long)).toBe("too_long");
  });

  it("refuses control characters, which would travel into argv unread", () => {
    expect(verdict("Read(//home/clawbox/Projects/a\nb/**)")).toBe("malformed");
    expect(verdict("Read(//home/clawbox/Projects/a\u0000b/**)")).toBe("malformed");
  });

  it("refuses text that is not Tool(specifier) at all", () => {
    for (const bad of ["Read", "Read(", "//home/clawbox/x/**", "Read //home/x", "Read()", "-Read(//x/y/**)"]) {
      expect(verdict(bad), bad).toBe("malformed");
    }
  });

  it("refuses empty brackets", () => {
    expect(verdict("Read(   )")).toBe("malformed");
  });

  it("refuses a tool the list does not carry", () => {
    for (const bad of ["NotebookEdit", "WebFetch", "Task", "Agent"]) {
      expect(verdict(`${bad}(//home/clawbox/Projects/x/**)`), bad).toBe("unknown_tool");
    }
  });

  it("refuses Bash with a code of its own", () => {
    // A run already holds Bash(*) except the kill deny-list, so a Bash rule
    // would either grant nothing or ask for something untouchable.
    expect(verdict("Bash(pkill:*)")).toBe("bash_already_allowed");
    expect(verdict("Bash(npm test)")).toBe("bash_already_allowed");
  });

  it("refuses a single leading slash, which the CLI reads as project-relative", () => {
    expect(verdict("Read(/home/clawbox/Projects/notes/**)", [], context())).toBe("malformed");
  });

  it("allows a working-folder-relative pattern, which needs no absolute form", () => {
    expect(verdict("Read(docs/**)", [], context())).toBe("Read(docs/**)");
  });
});

describe("the floor: what no rule may ever reach", () => {
  it("refuses the everything specifiers in the spellings people try", () => {
    for (const spec of ["*", "**", "/*", "/**", "//*", "//**"]) {
      expect(verdict(`Read(${spec})`, [], context()), spec).toBe("too_broad");
    }
  });

  it("refuses a whole top-level region of the box", () => {
    for (const spec of ["//home/**", "//etc/**", "//usr/**", "//var/**"]) {
      expect(verdict(`Read(${spec})`, [], context()), spec).toBe("too_broad");
    }
  });

  it("refuses the home directory itself, and anything above it", () => {
    expect(verdict(`Read(/${HOME}/**)`, [], context())).toBe("too_broad");
  });

  it("refuses the credential and key stores by segment", () => {
    const paths = [
      "//home/clawbox/.ssh/**",
      "//home/clawbox/.ssh/id_ed25519",
      "//home/clawbox/.gnupg/**",
      "//home/clawbox/.aws/credentials",
      "//home/clawbox/.config/gcloud/**",
      "//home/clawbox/.config/gh/hosts.yml",
      "//home/clawbox/.openclaw/**",
      "//home/clawbox/.hermes/.env",
      "//home/clawbox/.clawkeep/**",
      "//home/clawbox/Projects/app/.env",
      "//home/clawbox/anywhere/.git-credentials",
      "//home/clawbox/clawbox/data/config.json",
    ];
    for (const spec of paths) {
      expect(verdict(`Read(${spec})`, [], context()), spec).toBe("protected");
    }
  });

  it("refuses the kernel and system trees", () => {
    for (const spec of ["//proc/self/environ", "//sys/class/**", "//etc/shadow", "//dev/mem"]) {
      expect(verdict(`Read(${spec})`, [], context()), spec).toBe("protected");
    }
  });

  it("does not mistake a folder that merely LOOKS like a store", () => {
    // Segment-wise matching, so `my.ssh-notes` is an ordinary folder.
    expect(verdict("Read(//home/clawbox/Projects/my.ssh-notes/**)", [], context()))
      .toBe("Read(//home/clawbox/Projects/my.ssh-notes/**)");
    expect(verdict("Read(//home/clawbox/Projects/dotenv-docs/**)", [], context()))
      .toBe("Read(//home/clawbox/Projects/dotenv-docs/**)");
  });

  it("refuses a rule that steps up out of the folder it names", () => {
    expect(verdict("Read(//home/clawbox/Projects/../../.ssh/**)", [], context())).toBe("unsafe");
    expect(verdict("Read(docs/../../../etc/**)", [], context())).toBe("unsafe");
  });

  it("refuses a relative rule that names a store by the same segments", () => {
    // A run's folder could be anywhere, so a relative `.ssh/**` is refused too.
    expect(verdict("Read(.ssh/**)", [], context())).toBe("protected");
    expect(verdict("Read(sub/.openclaw/**)", [], context())).toBe("protected");
  });

  it("refuses a rule INSIDE something this box denies right now", () => {
    // Not on the textual list at all: the device's own deny rules are what
    // catch it, which is why the context has to travel.
    const ctx = context([`Read(/${HOME}/Private/**)`]);
    expect(verdict("Read(//home/clawbox/Private/notes/**)", [], ctx)).toBe("protected");
    // ...and the exact file form of a deny rule, not only the tree form.
    expect(verdict("Read(//home/clawbox/clawbox/data/.mcp-token)", [], ctx)).toBe("protected");
  });

  it("refuses a rule that wraps AROUND something this box denies", () => {
    // The deny rule would still fence it at run time, but a rule this wide is
    // not what the owner means by naming a folder.
    expect(verdict("Read(//home/clawbox/clawbox/data/**)", [], context())).toBe("too_broad");
  });

  it("without a context it still clears the textual floor", () => {
    // The same validator runs in the browser, where none of the device's own
    // deny rules are knowable.
    expect(verdict("Read(//home/clawbox/.ssh/**)")).toBe("protected");
    expect(verdict("Read(//home/**)")).toBe("too_broad");
    // ...and lets through what only the server can judge, which the server does.
    expect(verdict("Read(//home/clawbox/clawbox/data/**)"))
      .toBe("Read(//home/clawbox/clawbox/data/**)");
  });
});

describe("the soft half: one named harness project folder", () => {
  it("allows a rule naming ONE project's state folder", () => {
    for (const sub of SOFT_HOME_SUBTREES) {
      const rule = `Read(/${HOME}/${sub}/-home-clawbox-Projects-app/**)`;
      expect(verdict(rule, [], context()), sub).toBe(rule);
    }
  });

  it("refuses the projects PARENT, which is every project at once", () => {
    for (const sub of SOFT_HOME_SUBTREES) {
      // Not soft (softProjectDir needs a segment past the subtree), so the
      // hard segment `.claude-ds` / `.claude` catches it.
      expect(verdict(`Read(/${HOME}/${sub}/**)`, [], context()), sub).toBe("protected");
    }
  });

  it("refuses the harness directory itself even so", () => {
    expect(verdict(`Read(/${HOME}/.claude-ds/**)`, [], context())).toBe("protected");
    expect(verdict(`Read(/${HOME}/.claude-ds/.credentials.json)`, [], context())).toBe("protected");
    expect(verdict(`Read(/${HOME}/.claude/settings.json)`, [], context())).toBe("protected");
  });

  it("gives no exemption to a lookalike path outside this box's home", () => {
    expect(verdict("Read(//srv/elsewhere/.claude-ds/projects/app/**)", [], context())).toBe("protected");
  });

  it("gives no exemption to a lookalike under a HARD segment inside home", () => {
    // The soft branch is judged first and returns before the hard floor, so a
    // loose `.claude-ds/projects` match anywhere under the home was a way to
    // store a rule naming a credential store. It granted nothing, which is
    // exactly the "saved rule that lies about what the box allows" the module
    // header refuses to ship.
    expect(verdict(`Read(/${HOME}/.ssh/.claude-ds/projects/app/**)`, [], context())).toBe("protected");
    expect(verdict(`Read(/${HOME}/.openclaw/.claude/projects/app/**)`, [], context())).toBe("protected");
    // Nor may the subtree sit one level too deep under the home.
    expect(verdict(`Read(/${HOME}/sub/.claude-ds/projects/app/**)`, [], context())).toBe("protected");
  });

  it("treats nothing as soft when the home is unknowable", () => {
    // No home means no anchor to check, so the path falls through to the hard
    // floor — the safe direction to be wrong in. Every caller that can STORE a
    // rule or write argv passes a home (allowRuleHomeContext).
    expect(verdict(`Read(/${HOME}/.claude-ds/projects/app/**)`)).toBe("protected");
    expect(softProjectDir(`${HOME}/.claude-ds/projects/app`)).toBeNull();
  });

  it("softProjectDir names the ONE project folder, however deep the path went", () => {
    expect(softProjectDir(`${HOME}/.claude-ds/projects/app`, HOME)).toBe(`${HOME}/.claude-ds/projects/app`);
    expect(softProjectDir(`${HOME}/.claude-ds/projects/app/memory/notes.md`, HOME))
      .toBe(`${HOME}/.claude-ds/projects/app`);
    expect(softProjectDir(`${HOME}/.claude/projects/other`, HOME)).toBe(`${HOME}/.claude/projects/other`);
    // One segment short: the parent is not a project.
    expect(softProjectDir(`${HOME}/.claude-ds/projects`, HOME)).toBeNull();
    expect(softProjectDir(`${HOME}/Projects/app`, HOME)).toBeNull();
    // Anchored: the subtree has to BE the home's, not merely look like it.
    expect(softProjectDir(`${HOME}/.ssh/.claude-ds/projects/app`, HOME)).toBeNull();
    expect(softProjectDir(`/elsewhere/.claude-ds/projects/app`, HOME)).toBeNull();
    // A trailing slash on the home is the same home.
    expect(softProjectDir(`${HOME}/.claude-ds/projects/app`, `${HOME}/`))
      .toBe(`${HOME}/.claude-ds/projects/app`);
  });

  it("unlockedSoftPaths reports exactly the folders a saved list opens", () => {
    const rules = [
      `Read(/${HOME}/.claude-ds/projects/app/**)`,
      `Write(/${HOME}/.claude-ds/projects/app/**)`, // the same folder twice
      `Read(/${HOME}/.claude/projects/other/**)`,
      "Read(//home/clawbox/Projects/notes/**)", // not soft at all
      "Read(docs/**)", // relative: no absolute folder to unlock
      "nonsense", // unparseable
      "Bash(*)", // not a tool this list carries
    ];
    expect(unlockedSoftPaths(rules, HOME).sort()).toEqual([
      `${HOME}/.claude-ds/projects/app`,
      `${HOME}/.claude/projects/other`,
    ]);
  });

  it("unlockedSoftPaths unlocks nothing outside this box's home", () => {
    expect(unlockedSoftPaths(["Read(//srv/other/.claude-ds/projects/app/**)"], HOME)).toEqual([]);
  });

  it("unlockedSoftPaths unlocks nothing for an unanchored lookalike", () => {
    // This is the half that actually DROPS a deny rule, so the anchor matters
    // here even more than at the door: it reported
    // `<home>/.ssh/.claude-ds/projects/app` as an unlocked folder.
    expect(unlockedSoftPaths([`Read(/${HOME}/.ssh/.claude-ds/projects/app/**)`], HOME)).toEqual([]);
    expect(unlockedSoftPaths([`Read(/${HOME}/sub/.claude/projects/app/**)`], HOME)).toEqual([]);
  });
});

describe("the list: duplicates and the cap", () => {
  it("refuses a rule already on the list", () => {
    const known = ["Read(//home/clawbox/Projects/notes/**)"];
    expect(verdict("Read(//home/clawbox/Projects/notes/**)", known, context())).toBe("duplicate");
    // Trimmed before the comparison, so whitespace is not a second row.
    expect(verdict("  Read(//home/clawbox/Projects/notes/**)  ", known, context())).toBe("duplicate");
  });

  it("refuses once the list is full", () => {
    const known = Array.from({ length: MAX_ALLOW_RULES }, (_, i) => `Read(//home/clawbox/Projects/p${i}/**)`);
    expect(verdict("Read(//home/clawbox/Projects/new/**)", known, context())).toBe("too_many");
    // A duplicate is still the duplicate answer at the cap: the owner is not
    // told to remove a rule to add one that is already there.
    expect(verdict(known[0], known, context())).toBe("duplicate");
  });
});

describe("normalizeAllowRules: the stored list, read defensively", () => {
  it("is empty for anything that is not an array", () => {
    for (const bad of [null, undefined, "Read(//x/y/**)", 3, {}]) {
      expect(normalizeAllowRules(bad)).toEqual([]);
    }
  });

  it("drops the entries this build would no longer accept", () => {
    const stored = [
      "Read(//home/clawbox/Projects/notes/**)",
      "Read(//home/clawbox/.ssh/**)", // the floor grew under it
      42, // never was a rule
      "Read(//home/**)", // too wide
      "Write(//home/clawbox/Projects/app/**)",
    ];
    expect(normalizeAllowRules(stored, context())).toEqual([
      "Read(//home/clawbox/Projects/notes/**)",
      "Write(//home/clawbox/Projects/app/**)",
    ]);
  });

  it("drops a rule that has gone inert under the device's own denies", () => {
    const stored = ["Read(//home/clawbox/Private/notes/**)"];
    // Legal on its face...
    expect(normalizeAllowRules(stored)).toEqual(stored);
    // ...and gone once the box says it denies that tree to every run.
    expect(normalizeAllowRules(stored, context([`Read(/${HOME}/Private/**)`]))).toEqual([]);
  });

  it("drops duplicates rather than storing the same permission twice", () => {
    const rule = "Read(//home/clawbox/Projects/notes/**)";
    expect(normalizeAllowRules([rule, rule, rule], context())).toEqual([rule]);
  });

  it("cuts an over-long list rather than refusing it wholesale", () => {
    const stored = Array.from({ length: MAX_ALLOW_RULES + 10 }, (_, i) => `Read(//home/clawbox/Projects/p${i}/**)`);
    const kept = normalizeAllowRules(stored, context());
    expect(kept).toHaveLength(MAX_ALLOW_RULES);
    expect(kept[0]).toBe(stored[0]);
  });

  it("keeps the owner's own order", () => {
    const stored = [
      "Write(//home/clawbox/Projects/b/**)",
      "Read(//home/clawbox/Projects/a/**)",
    ];
    expect(normalizeAllowRules(stored, context())).toEqual(stored);
  });
});

describe("deriveAllowRule: the narrowest rule that answers a refusal", () => {
  it("offers the CONTAINING folder of a refused file", () => {
    expect(deriveAllowRule({ tool: "Read", target: "/home/clawbox/.claude-ds/projects/app/memory/notes.md" }))
      .toBe("Read(//home/clawbox/.claude-ds/projects/app/memory/**)");
  });

  it("stops at the first wildcard of a refused pattern", () => {
    expect(deriveAllowRule({ tool: "Glob", target: "/home/clawbox/Projects/notes/**/*.md" }))
      .toBe("Glob(//home/clawbox/Projects/notes/**)");
  });

  it("writes the absolute form the CLI actually reads", () => {
    const rule = deriveAllowRule({ tool: "Read", target: "/srv/data/x/file.txt" });
    expect(rule?.startsWith("Read(//")).toBe(true);
  });

  it("offers nothing where there is nothing to offer", () => {
    expect(deriveAllowRule({ tool: "Read", target: null })).toBeNull();
    expect(deriveAllowRule({ tool: "Read", target: "  " })).toBeNull();
    // Bash: every command is already allowed but the untouchable ones.
    expect(deriveAllowRule({ tool: "Bash", target: "pkill -f next-server" })).toBeNull();
    expect(deriveAllowRule({ tool: "WebFetch", target: "/home/clawbox/x.md" })).toBeNull();
    // Relative: inside the working folder, which needs no rule.
    expect(deriveAllowRule({ tool: "Read", target: "docs/notes.md" })).toBeNull();
    // A file at the root would derive a rule for the whole filesystem.
    expect(deriveAllowRule({ tool: "Read", target: "/passwd" })).toBeNull();
  });

  it("derives text only — the floor is the caller's to apply", () => {
    // The point of the split: this says what WOULD allow it, and the validator
    // with the device's context is what decides whether it may be saved.
    const rule = deriveAllowRule({ tool: "Read", target: "/home/clawbox/.ssh/id_ed25519" });
    expect(rule).toBe("Read(//home/clawbox/.ssh/**)");
    expect(verdict(rule, [], context())).toBe("protected");
  });

  it("what it derives for the soft case is what the validator accepts", () => {
    // The round trip this whole feature is for: a refused read of the
    // harness's per-project notes becomes a rule that can actually be saved.
    const rule = deriveAllowRule({ tool: "Read", target: `${HOME}/.claude-ds/projects/app/plans/a.md` });
    expect(rule).toBe(`Read(/${HOME}/.claude-ds/projects/app/plans/**)`);
    expect(verdict(rule, [], context())).toBe(rule);
    // ...and it unlocks that one project folder, not the parent.
    expect(unlockedSoftPaths([rule as string], HOME)).toEqual([`${HOME}/.claude-ds/projects/app`]);
  });
});

describe("concretePrefix", () => {
  it("is everything before the first wildcard segment", () => {
    expect(concretePrefix("//home/me/notes/**")).toBe("/home/me/notes");
    expect(concretePrefix("//home/me/*.md")).toBe("/home/me");
    expect(concretePrefix("//home/me/notes/a.md")).toBe("/home/me/notes/a.md");
    expect(concretePrefix("**")).toBe("/");
    expect(concretePrefix("docs/**")).toBe("docs");
  });
});

describe("the refusal codes travel", () => {
  it("every code has a sentence", () => {
    for (const code of ALLOW_RULE_REFUSALS) {
      expect(ALLOW_RULE_REFUSAL_KEYS[code], code).toMatch(/^codingAgent\./);
    }
    expect(Object.keys(ALLOW_RULE_REFUSAL_KEYS).sort()).toEqual([...ALLOW_RULE_REFUSALS].sort());
  });

  it("a code read back off a record is checked before it is trusted", () => {
    for (const code of ALLOW_RULE_REFUSALS) expect(isAllowRuleRefusal(code)).toBe(true);
    for (const bad of ["", "nope", null, undefined, 1, {}]) expect(isAllowRuleRefusal(bad)).toBe(false);
  });

  it("unsafe-code-matches-its-cause: the one thing it means is the one thing it says", () => {
    // `unsafe` is returned from exactly one place — a specifier with a `..`
    // segment — and the owner-facing sentence used to describe the OTHER,
    // never-reached meaning ("this box refuses that to every run"), which is
    // the `protected` cause. A reason that is not the reason is worse than no
    // reason, so the pair is pinned.
    const v = validateAllowRule("Read(//home/clawbox/Projects/../../.ssh/**)", [], context());
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("unsafe");
      // The validator's own English and the catalogue key must tell one story.
      expect(v.message.toLowerCase()).toContain("out of the folder it names");
      expect(editionEn[ALLOW_RULE_REFUSAL_KEYS.unsafe].toLowerCase())
        .toContain("out of the folder it names");
    }
    // ...and the two codes stay distinguishable in the catalogue.
    expect(editionEn[ALLOW_RULE_REFUSAL_KEYS.unsafe])
      .not.toBe(editionEn[ALLOW_RULE_REFUSAL_KEYS.protected]);
  });

  it("every refusal carries an English sentence beside the code", () => {
    const v = validateAllowRule("Read(//home/clawbox/.ssh/**)", [], context());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message.length).toBeGreaterThan(10);
  });
});
