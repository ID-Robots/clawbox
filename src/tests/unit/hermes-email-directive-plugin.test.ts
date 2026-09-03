import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

// The Hermes half of TASK-697: the `transform_llm_output` plugin that takes
// `EMAIL:<uid>` card directives out of a reply on its way to a channel.
//
// These drive the SHIPPED plugin with python3 — the same module Hermes imports
// out of ~/.hermes/plugins/ — rather than a TypeScript restatement of it, so
// what is asserted is the thing that runs on the box.
//
// The contract being pinned comes from the 0.20.5 checkout on the Hermes box:
//
//   agent/turn_finalizer.py:596   fires only when the reply is non-empty and
//                                 the turn was not interrupted
//   agent/turn_finalizer.py:607   `isinstance(result, str) and result` — a
//                                 non-empty string REPLACES the reply; None and
//                                 "" both mean "unchanged"
//   agent/agent_init.py:654       `platform` is the surface the turn came from
//   hermes_cli/plugins.py:5140    every exception is caught and logged
//
// The keep/strip rule has to be an allow-list of surfaces to KEEP rather than a
// deny-list of channels, because `Platform._missing_` (gateway/config.py:349)
// mints a platform for any channel a plugin adapter adds — a deny-list would
// silently miss the next one.

const REPO = path.resolve(__dirname, "../../..");
const PLUGINS_ROOT = path.join(REPO, "scripts/hermes-plugins");

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasPython3 ? describe : describe.skip;

/**
 * Run a snippet with the plugin package importable, and parse its JSON stdout.
 * `input` arrives as the parsed value of `stdin` inside the snippet.
 */
function py<T>(body: string, input: unknown = null): T {
  const program = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "stdin = json.loads(sys.stdin.read() or 'null')",
    body,
  ].join("\n");
  const out = execFileSync("python3", ["-c", program, PLUGINS_ROOT], {
    input: JSON.stringify(input),
    encoding: "utf-8",
  });
  return JSON.parse(out);
}

/**
 * The hook's answer for each (text, platform) pair. `null` is Python's `None`,
 * i.e. "leave the reply exactly as the model wrote it".
 */
function transform(cases: Array<{ text: unknown; platform: unknown }>): Array<string | null> {
  return py<Array<string | null>>(
    [
      "import clawbox_email_directives as p",
      "print(json.dumps([p.transform_llm_output(response_text=c['text'], platform=c['platform'])",
      "                  for c in stdin]))",
    ].join("\n"),
    cases,
  );
}

const REPLY = "Here are your last two emails.\nEMAIL:10960\nEMAIL:10959";
const STRIPPED = "Here are your last two emails.";

d("Hermes transform_llm_output plugin — EMAIL: directives", () => {
  it("strips the directives on every channel the box can reach", () => {
    const platforms = ["telegram", "whatsapp", "whatsapp_cloud", "discord", "slack", "signal", "email", "sms"];
    const answers = transform(platforms.map((platform) => ({ text: REPLY, platform })));
    expect(answers).toEqual(platforms.map(() => STRIPPED));
  });

  it("strips on a channel nobody has added yet — the rule is allow-list-to-keep", () => {
    // `Platform._missing_` mints a member for a plugin adapter's own name, so a
    // deny-list of known channels would let the next channel through.
    expect(transform([{ text: REPLY, platform: "irc" }])).toEqual([STRIPPED]);
    expect(transform([{ text: REPLY, platform: "some-channel-from-2027" }])).toEqual([STRIPPED]);
  });

  it("KEEPS the directives on ClawBox's own chat, which is where the card renders", () => {
    // `clawbox-chat` is the session `source` ClawBox sends in session.create /
    // session.resume; Hermes carries it through to agent.platform. Nothing else
    // produces that string.
    expect(transform([{ text: REPLY, platform: "clawbox-chat" }])).toEqual([null]);
  });

  it("KEEPS them on the local interactive surfaces Hermes itself names", () => {
    // INTERACTIVE_CODING_PLATFORMS, agent/coding_context.py:72. `cli` matters
    // twice: it is also ClawBox's chat spawn fallback (`hermes chat -q`), where
    // a replacing transform would make the CLI print
    // "[Response transformed after streaming]" above the answer (cli.py:3518).
    const answers = transform(
      ["", "cli", "tui", "acp", "desktop"].map((platform) => ({ text: REPLY, platform })),
    );
    expect(answers).toEqual([null, null, null, null, null]);
  });

  it("KEEPS them on an agent-to-agent turn, which is not a surface at all", () => {
    // A delegated turn's answer is read by the PARENT agent, not by a person.
    // Stripping there deletes ids the parent still has to relay: the owner asks
    // the chat to read their mail, the mailbox work is delegated, and the chat
    // gets a summary with no cards.
    const answers = transform(["subagent", "curator"].map((platform) => ({ text: REPLY, platform })));
    expect(answers).toEqual([null, null]);
  });

  it("still strips on cron and the API server, whose output a person does read", () => {
    const answers = transform(["cron", "api_server"].map((platform) => ({ text: REPLY, platform })));
    expect(answers).toEqual([STRIPPED, STRIPPED]);
  });

  it("is case- and padding-insensitive about the platform name", () => {
    expect(transform([{ text: REPLY, platform: " Clawbox-Chat " }])).toEqual([null]);
  });

  it("leaves a reply with no directive alone rather than replacing it with itself", () => {
    // Returning the same string would set `response_transformed`, which makes
    // the gateway re-send or edit an already streamed message
    // (gateway/run.py:29745, :29804) for nothing.
    expect(transform([{ text: "Your ClawBox is ready.", platform: "telegram" }])).toEqual([null]);
  });

  it("leaves a directive whose payload is not a usable id as text", () => {
    const text = "I could not find it.\nEMAIL:not-a-number";
    expect(transform([{ text, platform: "telegram" }])).toEqual([null]);
  });

  it("never returns an empty string, because Hermes would ignore it", () => {
    // turn_finalizer.py:607 accepts a replacement only when it is a NON-EMPTY
    // str, so returning "" for an all-directives reply would deliver the raw
    // ids. The placeholder carries no information instead.
    expect(transform([{ text: "EMAIL:4471\nEMAIL:4468", platform: "telegram" }])).toEqual(["…"]);
  });

  it("does not fire on an empty or non-string reply", () => {
    const answers = transform([
      { text: "", platform: "telegram" },
      { text: null, platform: "telegram" },
      { text: 17, platform: "telegram" },
    ]);
    expect(answers).toEqual([null, null, null]);
  });

  it("survives a missing platform kwarg — the hook must never raise", () => {
    const answer = py<Array<string | null>>(
      [
        "import clawbox_email_directives as p",
        "print(json.dumps([p.transform_llm_output(response_text='a\\nEMAIL:1')]))",
      ].join("\n"),
    );
    // No platform at all reads as "" — a local surface — so the reply stands.
    expect(answer).toEqual([null]);
  });

  it("accepts the additive kwargs Hermes injects, including telemetry_schema_version", () => {
    // hermes_cli/plugins.py:5131 adds telemetry_schema_version to every hook
    // payload; a callback without **kwargs would raise on it.
    const answer = py<Array<string | null>>(
      [
        "import clawbox_email_directives as p",
        "print(json.dumps([p.transform_llm_output(response_text='a\\nEMAIL:1', session_id='s', "
          + "model='m', platform='telegram', telemetry_schema_version=3)]))",
      ].join("\n"),
    );
    expect(answer).toEqual(["a"]);
  });

  it("registers exactly one hook, under the name Hermes actually fires", () => {
    // hermes_cli/plugins.py:3120 WARNS on an unknown hook name but registers it
    // anyway, so a typo here would be a silent no-op on every box.
    const registered = py<Array<[string, string]>>(
      [
        "import clawbox_email_directives as p",
        "class Ctx:",
        "    def __init__(self): self.hooks = []",
        "    def register_hook(self, name, cb): self.hooks.append((name, cb.__name__))",
        "ctx = Ctx()",
        "p.register(ctx)",
        "print(json.dumps(ctx.hooks))",
      ].join("\n"),
    );
    expect(registered).toEqual([["transform_llm_output", "transform_llm_output"]]);
  });

  it("ships the two files Hermes needs to load a plugin at all", () => {
    // hermes_cli/plugins.py:5001 raises FileNotFoundError without __init__.py;
    // _scan_directory reads plugin.yaml as the manifest.
    const files = py<Record<string, boolean>>(
      [
        "import os",
        "d = os.path.join(sys.argv[1], 'clawbox_email_directives')",
        "print(json.dumps({n: os.path.isfile(os.path.join(d, n)) "
          + "for n in ('__init__.py', 'plugin.yaml', 'email_directives.py')}))",
      ].join("\n"),
    );
    expect(files).toEqual({ "__init__.py": true, "plugin.yaml": true, "email_directives.py": true });
  });
});
