/**
 * MCP CLI — clawbox-cli is the AI agent's user-space entrypoint. It
 * wraps a subset of the MCP tool surface so a shell or an LLM can drive
 * the desktop without a websocket. This spec exercises the safe,
 * read-only commands plus a couple of mutating ones whose effects we
 * can verify end-to-end.
 *
 * Runs at NN=35 between files (30) and terminal (40).
 */
import { test, expect } from "@playwright/test";
import { dockerExec } from "./helpers/container";

const CLI_PATH = "/home/clawbox/clawbox/mcp/clawbox-cli.ts";
const cli = (...args: string[]) => ["/home/clawbox/.bun/bin/bun", "run", CLI_PATH, ...args];

test.describe("clawbox-cli (MCP user-space wrapper)", () => {
  test("system stats prints JSON with cpu+memory", async () => {
    const out = await dockerExec(cli("system", "stats"), {
      user: "clawbox",
      timeoutMs: 30_000,
    });
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty("cpu");
    expect(parsed).toHaveProperty("memory");
  });

  test("system info prints JSON with hostname", async () => {
    const out = await dockerExec(cli("system", "info"), {
      user: "clawbox",
      timeoutMs: 30_000,
    });
    const parsed = JSON.parse(out);
    expect(typeof parsed.hostname).toBe("string");
    expect(parsed.hostname.length).toBeGreaterThan(0);
  });

  test("app list prints the built-in apps for this edition", async () => {
    // The CLI prints an edition-tagged header, then one `<id> — <name>` line
    // per app — not JSON. The set is edition-dependent (see `builtInApps` in
    // mcp/lib/context.ts): every edition gets the common apps, and each
    // harness adds its own on top. Asking the CLI which edition it is keeps
    // this assertion true on an OpenClaw box and on a Hermes box, instead of
    // pinning it to whichever one CI happens to install.
    const edition = (
      await dockerExec(cli("edition"), { user: "clawbox", timeoutMs: 30_000 })
    ).trim();
    expect(edition, "`clawbox edition` should name a known edition").toMatch(
      /^(openclaw|hermes|dual)$/,
    );

    const out = await dockerExec(cli("app", "list"), {
      user: "clawbox",
      timeoutMs: 30_000,
    });

    // Header carries the edition, so a reader knows which app set this is —
    // and, when the two differ, the harness the apps belong to: on the premium
    // `dual` SKU the list follows the ACTIVE harness, so the line reads
    // "(dual edition, running hermes)".
    expect(out).toMatch(
      new RegExp(`^Built-in apps \\(${edition} edition[,)]`, "im"),
    );
    const harness = /^Built-in apps \([^,)]+(?:, running (\w+))?\)/im.exec(out)?.[1] ?? edition;

    // Common apps — listed on every edition.
    for (const id of ["settings", "terminal", "files", "browser", "vnc"]) {
      expect(out, `built-in app '${id}' should be listed`).toMatch(
        new RegExp(`^\\s+${id} — `, "m"),
      );
    }

    // Harness-specific apps. A Hermes box has the skills app and neither the
    // OpenClaw chat app nor the store; listing an app whose backend isn't
    // installed would point the agent at a window that cannot open. Branch on
    // the HARNESS the header reports rather than on the edition: a `dual` box
    // follows whichever harness is running.
    if (harness === "hermes") {
      expect(out).toMatch(/^\s+hermes-skills — /m);
      expect(out).not.toMatch(/^\s+openclaw — /m);
      expect(out).not.toMatch(/^\s+store — /m);
    } else {
      expect(out).toMatch(/^\s+openclaw — /m);
      expect(out).toMatch(/^\s+store — /m);
      expect(out).not.toMatch(/^\s+hermes-skills — /m);
    }
  });

  test("notify writes a ui:pending-action with the message into kv.json", async () => {
    const message = `mcp-test-${Date.now()}`;
    const out = await dockerExec(cli("notify", message), {
      user: "clawbox",
      timeoutMs: 30_000,
    });
    expect(out).toMatch(/Notification sent/i);
    // The CLI stores into kv via /setup-api/kv. The kv-store on disk
    // serializes pending-action as a JSON-stringified value.
    const kv = await dockerExec(
      [
        "bash",
        "-lc",
        "cat /home/clawbox/clawbox/data/kv.json 2>/dev/null || echo '{}'",
      ],
      { user: "clawbox" },
    );
    expect(kv).toContain(message);
  });

  test("code init creates a project on disk + tidy with code delete", async () => {
    const projectId = `mcptest${Date.now().toString().slice(-6)}`;
    const out = await dockerExec(
      cli("code", "init", projectId, "MCP Test"),
      { user: "clawbox", timeoutMs: 60_000 },
    );
    expect(out).toMatch(/Created project/i);
    // Verify the project directory landed on disk with the scaffold files.
    const ls = await dockerExec(
      [
        "bash",
        "-lc",
        `ls /home/clawbox/clawbox/data/code-projects/${projectId}/`,
      ],
      { user: "clawbox" },
    );
    expect(ls).toMatch(/index\.html/);
    // Tidy up.
    await dockerExec(cli("code", "delete", projectId), {
      user: "clawbox",
      timeoutMs: 30_000,
    });
  });
});
