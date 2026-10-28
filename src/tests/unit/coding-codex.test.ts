/**
 * The Codex runner's pure half (src/lib/coding-codex.ts): what an `openai` run
 * hands `codex exec`, and how the box reads the JSON lines it prints back.
 *
 * The event fixtures marked "captured" are lines codex-cli 0.154.0 printed on
 * this project's own probes (a run with no credential, and one with a refused
 * key); the rest follow the same CLI's `exec --json` item shapes.
 */
import { describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  CODEX_API_KEY_ENV,
  CODEX_MODEL_EFFORTS,
  CODEX_QUOTA_LIMIT_MS,
  CODEX_RATE_LIMIT_MS,
  codexCommandText,
  codexConfigOverrides,
  codexEventActions,
  codexLimitResetAt,
  codexLimitUntil,
  codexReasoningEffort,
  codexRulesText,
  isCodexAuthFailure,
  isCodexLimit,
  tomlMcpServer,
  tomlString,
} from "@/lib/coding-codex";
import { OPENAI_MODELS } from "@/lib/coding-provider";
import { BASH_KILL_DENYLIST, EFFORT_LEVELS } from "@/lib/coding-agent";

const BASE = { model: "gpt-6-astra", effort: "xhigh", developerInstructions: "Be brief." };

/** The value of the `-c key=…` override in an argv, or undefined. */
function override(args: string[], key: string): string | undefined {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === "-c" && args[i + 1].startsWith(`${key}=`)) return args[i + 1].slice(key.length + 1);
  }
  return undefined;
}

describe("the argv", () => {
  it("starts a fresh run as `codex exec --json`, the task on stdin, nobody to approve anything", () => {
    const args = buildCodexArgs(BASE);
    expect(args.slice(0, 3)).toEqual(["exec", "--json", "--skip-git-repo-check"]);
    // The task is read from stdin, so it never sits in argv.
    expect(args[args.length - 1]).toBe("-");
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-6-astra");
    expect(override(args, "approval_policy")).toBe('"never"');
    // The box's own fence (setpriv, the run's scope) is the sandbox, as for a
    // Claude run's Bash(*): Codex's bubblewrap sandbox fails on this device class.
    expect(override(args, "sandbox_mode")).toBe('"danger-full-access"');
    expect(override(args, "model_reasoning_effort")).toBe('"xhigh"');
    expect(override(args, "check_for_update_on_startup")).toBe("false");
    expect(override(args, "developer_instructions")).toBe('"Be brief."');
  });

  it("continues a thread with `exec resume <id>`, which takes the policy as config too", () => {
    const args = buildCodexArgs({ ...BASE, resumeSessionId: "01a1827d-9442-74b2-b718-988b181c55c9" });
    expect(args.slice(0, 4)).toEqual(["exec", "resume", "--json", "--skip-git-repo-check"]);
    // `exec resume` has no --sandbox and no --cd: everything travels as -c.
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("-s");
    expect(override(args, "sandbox_mode")).toBe('"danger-full-access"');
    expect(override(args, "approval_policy")).toBe('"never"');
    // The model again, so the thread answers on the model it was opened on;
    // then the thread, then stdin.
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-6-astra");
    expect(args.slice(-2)).toEqual(["01a1827d-9442-74b2-b718-988b181c55c9", "-"]);
  });

  it("holds a read-only run to Codex's own read-only sandbox", () => {
    expect(override(buildCodexArgs({ ...BASE, readOnly: true }), "sandbox_mode")).toBe('"read-only"');
  });

  it("keeps the run's own API key from the commands it starts, and nothing else", () => {
    const args = buildCodexArgs(BASE);
    expect(override(args, "shell_environment_policy.exclude")).toBe(`["${CODEX_API_KEY_ENV}"]`);
    // The owner's injected secrets reach the run's commands, as a Claude run's
    // Bash gets them: Codex's own name filter would otherwise drop *_TOKEN.
    expect(override(args, "shell_environment_policy.ignore_default_excludes")).toBe("true");
    expect(override(args, "shell_environment_policy.inherit")).toBe('"all"');
    // And the key itself is never in argv.
    expect(args.join(" ")).not.toMatch(/sk-/);
  });

  it("hands the run's MCP servers over as config, in TOML", () => {
    const args = buildCodexArgs({
      ...BASE,
      mcpServers: { clawbox: { command: "/home/u/.bun/bin/bun", args: ["run", "/srv/mcp/clawbox-mcp.ts"], env: { CLAWBOX_MCP_PROFILE: "browser", CLAWBOX_RUN_DIR: "/srv/p" } } },
    });
    expect(override(args, "mcp_servers.clawbox")).toBe(
      '{ command = "/home/u/.bun/bin/bun", args = ["run", "/srv/mcp/clawbox-mcp.ts"], env = { CLAWBOX_MCP_PROFILE = "browser", CLAWBOX_RUN_DIR = "/srv/p" } }',
    );
    expect(codexConfigOverrides(BASE).some((o) => o.startsWith("mcp_servers."))).toBe(false);
  });
});

describe("TOML values", () => {
  it("quotes what JSON quotes, and the two things JSON leaves TOML cannot read", () => {
    expect(tomlString('say "hi"\nthen\\go')).toBe('"say \\"hi\\"\\nthen\\\\go"');
    expect(tomlString("a\u007fb")).toBe('"a\\u007Fb"');
    // A lone surrogate is not a scalar TOML can escape: replaced, never sent.
    expect(tomlString("x\ud800y")).toBe('"x�y"');
    // A whole pair is kept.
    expect(tomlString("🙂")).toBe('"🙂"');
  });

  it("quotes a key that is not bare", () => {
    expect(tomlMcpServer({ command: "c", args: [], env: { "WEIRD.KEY": "v" } })).toBe('{ command = "c", args = [], env = { "WEIRD.KEY" = "v" } }');
  });
});

describe("effort", () => {
  it("passes the levels both CLIs share through, on a model that has them", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) expect(codexReasoningEffort(level, "gpt-6-astra")).toBe(level);
  });

  it("lowers a level the model does not offer, never raises it", () => {
    expect(codexReasoningEffort("max", "gpt-5.5")).toBe("xhigh");
    expect(codexReasoningEffort("max", "gpt-5.6-luna")).toBe("max");
    expect(codexReasoningEffort("low", "gpt-5.2")).toBe("low");
  });

  it("gives ultracode its thinking half, xhigh — Codex has no Workflow tool for the rest", () => {
    // Ultracode is xhigh plus orchestration (EFFORT_LEVELS); it must never put a
    // Codex run on a costlier tier than any Claude run's level reaches.
    expect(codexReasoningEffort("ultracode", "gpt-6-astra")).toBe("xhigh");
    expect(codexReasoningEffort("ultracode", "gpt-5.6-luna")).toBe("xhigh");
    expect(codexReasoningEffort("ultracode", "gpt-5.2")).toBe("xhigh");
    // And Codex's own top word is not a box level to pass through.
    expect(codexReasoningEffort("ultra", "gpt-6-astra")).toBe("xhigh");
  });

  it("maps every box level to something every offered model accepts", () => {
    for (const model of OPENAI_MODELS) {
      for (const level of EFFORT_LEVELS) expect(CODEX_MODEL_EFFORTS[model]).toContain(codexReasoningEffort(level, model));
    }
  });

  it("caps a model this build does not know at the levels every model has, and reads junk as xhigh", () => {
    expect(codexReasoningEffort("max", "gpt-9")).toBe("xhigh");
    expect(codexReasoningEffort("turbo", "gpt-6-astra")).toBe("xhigh");
    expect(codexReasoningEffort("max", null)).toBe("xhigh");
  });
});

describe("the command fence", () => {
  it("is the kill deny-list a Claude run gets, as forbidden execpolicy prefixes", () => {
    const rules = codexRulesText(BASH_KILL_DENYLIST, "why");
    expect(rules).toContain('prefix_rule(pattern = ["pkill"], decision = "forbidden", justification = "why")');
    expect(rules).toContain('prefix_rule(pattern = ["kill", "-9", "-1"], decision = "forbidden"');
    // One rule per entry: nothing dropped, nothing invented.
    expect(rules.match(/^prefix_rule/gm)).toHaveLength(BASH_KILL_DENYLIST.length);
  });

  it("skips anything that is not a `Bash(prefix:*)` rule", () => {
    expect(codexRulesText(["Read(//tmp/**)", "Bash(:*)"], "x").match(/^prefix_rule/gm)).toBeNull();
  });
});

describe("reading the stream", () => {
  it("takes the thread id as the run's session (captured)", () => {
    expect(codexEventActions({ type: "thread.started", thread_id: "01a1827d-9442-74b2-b718-988b181c55c9" }))
      .toEqual([{ kind: "session", id: "01a1827d-9442-74b2-b718-988b181c55c9" }]);
  });

  it("reads a refused turn as the failure, in the CLI's words (captured)", () => {
    const line = '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Incorrect API key provided: sk-proj-*******************0000. You can find your API key at https://platform.openai.com/account/api-keys., url: https://api.openai.com/v1/responses"}}';
    const actions = codexEventActions(JSON.parse(line));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "failed" });
    const error = (actions[0] as { error: string }).error;
    expect(isCodexAuthFailure(error)).toBe(true);
    expect(isCodexLimit(error)).toBe(false);
  });

  it("keeps the CLI's retries as notices, never as a verdict (captured)", () => {
    const line = '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)"}';
    expect(codexEventActions(JSON.parse(line))).toEqual([{ kind: "notice", text: expect.stringMatching(/^Reconnecting\.\.\. 2\/5/) }]);
    // …and an error ITEM (a transport fallback, a model-mismatch warning) the same.
    expect(codexEventActions({ type: "item.completed", item: { id: "item_0", type: "error", message: "Falling back from WebSockets to HTTPS transport." } }))
      .toEqual([{ kind: "notice", text: "Falling back from WebSockets to HTTPS transport." }]);
  });

  it("reads a finished turn as its usage, then the verdict", () => {
    expect(codexEventActions({ type: "turn.completed", usage: { input_tokens: 24_000, cached_input_tokens: 20_000, output_tokens: 900 } })).toEqual([
      { kind: "usage", input: 24_000, cachedInput: 20_000, output: 900 },
      { kind: "completed" },
    ]);
    // Garbage in a usage field is no tokens, not NaN on the record.
    expect(codexEventActions({ type: "turn.completed", usage: { input_tokens: "lots" } })[0]).toEqual({ kind: "usage", input: 0, cachedInput: 0, output: 0 });
  });

  it("says each command once, when it starts, without the shell Codex wraps it in", () => {
    const started = { type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc 'npm test'", status: "in_progress" } };
    const done = { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "bash -lc 'npm test'", aggregated_output: "ok", exit_code: 0, status: "completed" } };
    expect(codexEventActions(started)).toEqual([{ kind: "command", command: "npm test" }]);
    expect(codexEventActions(done)).toEqual([]);
  });

  it("counts a file only once Codex says the change was applied", () => {
    const change = (status: string) => ({ type: "item.completed", item: { id: "item_2", type: "file_change", changes: [{ path: "/srv/p/index.html", kind: "add" }, { path: "src/app.js", kind: "update" }], status } });
    expect(codexEventActions(change("completed"))).toEqual([{ kind: "files", paths: ["/srv/p/index.html", "src/app.js"] }]);
    expect(codexEventActions(change("failed"))).toEqual([]);
    expect(codexEventActions({ ...change("completed"), type: "item.started" })).toEqual([]);
  });

  it("takes the agent's words when the message is complete, and its plan whole", () => {
    expect(codexEventActions({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: "  Done: added the page.  " } }))
      .toEqual([{ kind: "message", text: "Done: added the page." }]);
    expect(codexEventActions({ type: "item.updated", item: { id: "item_3", type: "agent_message", text: "Do" } })).toEqual([]);
    expect(codexEventActions({ type: "item.updated", item: { id: "item_4", type: "todo_list", items: [{ text: "write", completed: true }, { text: "test", completed: false }, { text: " " }] } }))
      .toEqual([{ kind: "todos", items: [{ text: "write", completed: true }, { text: "test", completed: false }] }]);
  });

  it("names a tool call and a web search for the feed", () => {
    expect(codexEventActions({ type: "item.started", item: { id: "i", type: "mcp_tool_call", server: "clawbox", tool: "browser_open", status: "in_progress" } }))
      .toEqual([{ kind: "tool", label: "clawbox.browser_open" }]);
    expect(codexEventActions({ type: "item.completed", item: { id: "i", type: "web_search", query: "vitest maxWorkers" } }))
      .toEqual([{ kind: "tool", label: "Web search: vitest maxWorkers" }]);
    expect(codexEventActions({ type: "item.started", item: { id: "r", type: "reasoning", text: "" } })).toEqual([{ kind: "reasoning" }]);
  });

  it("ignores what it does not know, rather than failing the run", () => {
    for (const event of [null, 7, "x", {}, { type: "turn.started" }, { type: "item.completed" }, { type: "item.completed", item: { type: "collab_tool_call" } }, { type: "brand.new" }]) {
      expect(codexEventActions(event)).toEqual([]);
    }
  });
});

describe("a command as the feed says it", () => {
  it("unwraps Codex's shell, in both of its shapes", () => {
    expect(codexCommandText("/bin/bash -lc \"ls -la\"")).toBe("ls -la");
    expect(codexCommandText("bash -lc ls")).toBe("ls");
    expect(codexCommandText(["bash", "-lc", "git status"])).toBe("git status");
    expect(codexCommandText(["rg", "-n", "x"])).toBe("rg -n x");
    expect(codexCommandText("npm run build")).toBe("npm run build");
    expect(codexCommandText(7)).toBeNull();
  });
});

describe("limits and refused credentials", () => {
  it("tells a limit from a refused credential", () => {
    expect(isCodexLimit("You've hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes.")).toBe(true);
    expect(isCodexLimit("429 Too Many Requests: Rate limit reached for requests")).toBe(true);
    expect(isCodexLimit("You exceeded your current quota, please check your plan and billing details.")).toBe(true);
    expect(isCodexLimit("unexpected status 401 Unauthorized")).toBe(false);
    expect(isCodexAuthFailure("Not logged in")).toBe(true);
    expect(isCodexAuthFailure("Your refresh token has already been used; please sign in again")).toBe(true);
    expect(isCodexAuthFailure("stream disconnected before completion")).toBe(false);
  });

  it("reads when a limit says it frees up", () => {
    const now = Date.UTC(2026, 9, 28, 12, 0, 0);
    expect(codexLimitResetAt("try again in 2 hours 5 minutes", now)).toBe(now + 2 * 3_600_000 + 5 * 60_000);
    expect(codexLimitResetAt("Please try again in 37s.", now)).toBe(now + 37_000);
    expect(codexLimitResetAt("no time here", now)).toBeNull();
  });

  it("assumes an hour for a spent plan or quota, and moments for a rate limit, when nothing is said", () => {
    const now = 1_000_000;
    expect(codexLimitUntil("You've hit your usage limit.", now)).toBe(now + CODEX_QUOTA_LIMIT_MS);
    expect(codexLimitUntil("429 Too Many Requests", now)).toBe(now + CODEX_RATE_LIMIT_MS);
    expect(codexLimitUntil("usage limit; try again in 3 minutes", now)).toBe(now + 3 * 60_000);
  });
});
