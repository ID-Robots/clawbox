import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// scripts/gateway_origins.py is the boot-path (Python) implementation of
// trusted control-UI origin validation/loading — the counterpart to
// src/lib/control-ui-origins.ts used by the Next.js proxy. Exercised
// directly via python3 so these tests track the real shipped module (same
// convention as gateway-pre-start-token.test.ts).

const SCRIPTS_DIR = path.resolve(process.cwd(), "scripts");

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

function runPython(program: string): string {
  return execFileSync("python3", ["-c", program], { encoding: "utf-8" }).trim();
}

function normalize(raw: unknown): { origin: string | null; warning: string | null } {
  const program = [
    `import sys, json`,
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})`,
    `import gateway_origins as g`,
    `origin, warning = g.normalize_origin(json.loads(sys.argv[1]))`,
    `print(json.dumps({"origin": origin, "warning": warning}))`,
  ].join("\n");
  return JSON.parse(
    execFileSync("python3", ["-c", program, JSON.stringify(raw)], { encoding: "utf-8" }).trim(),
  );
}

function loadConfigured(filePath: string): { origins: string[]; warnings: string[] } {
  const program = [
    `import sys, json`,
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})`,
    `import gateway_origins as g`,
    `origins, warnings = g.load_configured_origins(sys.argv[1])`,
    `print(json.dumps({"origins": origins, "warnings": warnings}))`,
  ].join("\n");
  return JSON.parse(
    execFileSync("python3", ["-c", program, filePath], { encoding: "utf-8" }).trim(),
  );
}

describe.skipIf(!hasPython3)("scripts/gateway_origins.py", () => {
  describe("normalize_origin", () => {
    it("accepts a bare http origin unchanged", () => {
      expect(normalize("http://example.com")).toEqual({ origin: "http://example.com", warning: null });
    });

    it("lowercases scheme and host", () => {
      expect(normalize("HTTP://EXAMPLE.com")).toEqual({ origin: "http://example.com", warning: null });
    });

    it("strips the default port for http", () => {
      expect(normalize("http://example.com:80")).toEqual({ origin: "http://example.com", warning: null });
    });

    it("strips the default port for https", () => {
      expect(normalize("https://example.com:443")).toEqual({ origin: "https://example.com", warning: null });
    });

    it("keeps a non-default port", () => {
      expect(normalize("http://example.com:8080")).toEqual({ origin: "http://example.com:8080", warning: null });
    });

    it("normalizes a trailing slash away", () => {
      expect(normalize("https://example.com/")).toEqual({ origin: "https://example.com", warning: null });
    });

    it("keeps bracketed IPv6 hosts, dropping the default port", () => {
      expect(normalize("https://[::1]:443")).toEqual({ origin: "https://[::1]", warning: null });
      expect(normalize("http://[::1]:9000")).toEqual({ origin: "http://[::1]:9000", warning: null });
      expect(normalize("http://[0:0:0:0:0:0:0:1]")).toEqual({
        origin: "http://[::1]",
        warning: null,
      });
    });

    it("rejects a wildcard origin", () => {
      const result = normalize("*");
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/wildcard/);
    });

    it("rejects credentials in the origin", () => {
      const result = normalize("http://user:pass@" + "example.com");
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/credentials/);
    });

    it("rejects a non-root path", () => {
      const result = normalize("http://example.com/setup");
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/path/);
    });

    it("rejects a query string", () => {
      const result = normalize("http://example.com?x=1");
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/query/);
    });

    it("rejects a fragment", () => {
      const result = normalize("http://example.com#frag");
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/fragment/);
    });

    it("rejects a non-http(s) scheme", () => {
      const result = normalize("ftp://example.com");
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/scheme/);
    });

    it("rejects a missing host", () => {
      const result = normalize("http://");
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/host/);
    });

    it("rejects an out-of-range port", () => {
      const result = normalize("http://example.com:99999");
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/port/);
    });

    it("rejects a non-string entry", () => {
      const result = normalize(42);
      expect(result.origin).toBeNull();
      expect(result.warning).toMatch(/string/);
    });

    it("rejects an invalid IPv6 host", () => {
      const result = normalize("http://[gg::1]");
      expect(result.origin).toBeNull();
    });

    it("rejects an out-of-range dotted-decimal host", () => {
      const result = normalize("http://999.999.999.999");
      expect(result.origin).toBeNull();
    });

    it("rejects raw characters whose URL-parser behavior is not portable", () => {
      const inputs = [
        "http://evil.com\\`@good.com`",
        "http://exa\nmple.com",
        "http://example.com/%65",
        "http://éxample.com",
      ];
      for (const input of inputs) {
        const result = normalize(input);
        expect(result.origin).toBeNull();
        expect(result.warning).toMatch(/forbidden raw character/);
      }
    });
  });

  describe("load_configured_origins", () => {
    let dir: string;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("returns no origins and no warning when the file is missing", () => {
      dir = mkdtempSync(path.join(tmpdir(), "gw-origins-"));
      const missing = path.join(dir, "nope.json");
      expect(loadConfigured(missing)).toEqual({ origins: [], warnings: [] });
    });

    it("loads, normalizes, and de-duplicates a valid array", () => {
      dir = mkdtempSync(path.join(tmpdir(), "gw-origins-"));
      const file = path.join(dir, "origins.json");
      writeFileSync(
        file,
        JSON.stringify(["http://a.example.com", "HTTP://A.example.com:80", "https://b.example.com:8443"]),
      );
      const result = loadConfigured(file);
      expect(result.origins).toEqual(["http://a.example.com", "https://b.example.com:8443"]);
      expect(result.warnings).toEqual([]);
    });

    it("drops invalid entries with a warning, keeps valid ones", () => {
      dir = mkdtempSync(path.join(tmpdir(), "gw-origins-"));
      const file = path.join(dir, "origins.json");
      writeFileSync(file, JSON.stringify(["http://good.example.com", "not-a-url", "*"]));
      const result = loadConfigured(file);
      expect(result.origins).toEqual(["http://good.example.com"]);
      expect(result.warnings).toHaveLength(2);
    });

    it("returns a warning and no origins for invalid JSON", () => {
      dir = mkdtempSync(path.join(tmpdir(), "gw-origins-"));
      const file = path.join(dir, "origins.json");
      writeFileSync(file, "{not json");
      const result = loadConfigured(file);
      expect(result.origins).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    });

    it("returns a warning and no origins for a non-array top level", () => {
      dir = mkdtempSync(path.join(tmpdir(), "gw-origins-"));
      const file = path.join(dir, "origins.json");
      writeFileSync(file, JSON.stringify({ a: 1 }));
      const result = loadConfigured(file);
      expect(result.origins).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    });

    it("returns a warning and no origins for invalid UTF-8", () => {
      dir = mkdtempSync(path.join(tmpdir(), "gw-origins-"));
      const file = path.join(dir, "origins.json");
      writeFileSync(file, Buffer.from([0xff, 0xfe, 0xfd]));
      const result = loadConfigured(file);
      expect(result.origins).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/not valid UTF-8/);
    });
  });

  describe("merge_origins", () => {
    it("appends extras after defaults, de-duplicated, order preserved", () => {
      const program = [
        `import sys, json`,
        `sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})`,
        `import gateway_origins as g`,
        `print(json.dumps(g.merge_origins(["http://a.com", "http://b.com"], ["http://b.com", "http://c.com"])))`,
      ].join("\n");
      expect(JSON.parse(runPython(program))).toEqual(["http://a.com", "http://b.com", "http://c.com"]);
    });
  });

  describe("resolve_origins_path", () => {
    it("defaults to the well-known data path", () => {
      const program = [
        `import sys`,
        `sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})`,
        `import os`,
        `os.environ.pop("CLAWBOX_CONTROL_UI_ORIGINS_FILE", None)`,
        `import gateway_origins as g`,
        `print(g.resolve_origins_path())`,
      ].join("\n");
      expect(runPython(program)).toBe("/home/clawbox/clawbox/data/control-ui-origins.json");
    });

    it("honors the CLAWBOX_CONTROL_UI_ORIGINS_FILE env override", () => {
      const program = [
        `import sys, os`,
        `os.environ["CLAWBOX_CONTROL_UI_ORIGINS_FILE"] = "/tmp/custom-origins.json"`,
        `sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})`,
        `import gateway_origins as g`,
        `print(g.resolve_origins_path())`,
      ].join("\n");
      expect(runPython(program)).toBe("/tmp/custom-origins.json");
    });
  });
});

// The following exercises the ACTUAL merge wiring inside gateway-pre-start.sh
// (not a reimplementation): the origins-loading heredoc that produces
// CLAWBOX_EXTRA_ORIGINS, and the heredoc block that folds it into
// allowed_origins before the config's set-comparison. Both blocks are
// extracted verbatim so a regression in the shipped script is caught here.

const SCRIPT = path.join(SCRIPTS_DIR, "gateway-pre-start.sh");

function extractBetween(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`markers not found: ${JSON.stringify({ startMarker, endMarker })}`);
  }
  return src.slice(start, end);
}

function extractLoaderSnippet(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  return extractBetween(src, "import os, sys\n\nscript_dir", "\nPY\n)\"");
}

function extractMergeSnippet(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  return extractBetween(
    src,
    "hostname = os.environ.get(\"CLAWBOX_HOSTNAME\"",
    "\n\ntry:\n    with open(cfg_path) as f:",
  );
}

/** Runs the real loader heredoc against a given origins file and env. */
function runLoader(originsFile: string | undefined): { stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAWBOX_GATEWAY_ORIGINS_SCRIPT_DIR: SCRIPTS_DIR,
  };
  if (originsFile) {
    env.CLAWBOX_CONTROL_UI_ORIGINS_FILE = originsFile;
  } else {
    delete env.CLAWBOX_CONTROL_UI_ORIGINS_FILE;
  }
  const result = spawnSync("python3", ["-c", extractLoaderSnippet()], {
    encoding: "utf-8",
    env,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

/** Runs the real merge heredoc given hostname/lan_ips/extra_origins env inputs. */
function runMerge(hostname: string, lanIps: string[], extraOrigins: string[]): string[] {
  const program = "import json, os\n" + extractMergeSnippet() + "\nprint(json.dumps(allowed_origins))";
  const env = {
    ...process.env,
    CLAWBOX_HOSTNAME: hostname,
    CLAWBOX_LAN_IPS: lanIps.length ? lanIps.join("\n") + "\n" : "",
    CLAWBOX_EXTRA_ORIGINS: extraOrigins.length ? extraOrigins.join("\n") + "\n" : "",
  };
  const out = execFileSync("python3", ["-c", program, "/unused/config/path"], { encoding: "utf-8", env });
  return JSON.parse(out.trim());
}

describe.skipIf(!hasPython3)("gateway-pre-start.sh trusted-origins wiring", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("default: no config file yields no extras, defaults only", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gw-wiring-"));
    const missing = path.join(dir, "nope.json");
    const { stdout, stderr } = runLoader(missing);
    expect(stdout.trim()).toBe("");
    expect(stderr).toBe("");

    const merged = runMerge("device", ["http://192.0.2.5"], []);
    expect(merged).toEqual([
      "http://device.local",
      "http://localhost",
      "http://127.0.0.1",
      "http://10.42.0.1",
      "http://10.43.0.1",
      "http://192.0.2.5",
    ]);
  });

  it("merges validated extras after defaults, deterministically", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gw-wiring-"));
    const file = path.join(dir, "origins.json");
    writeFileSync(file, JSON.stringify(["https://custom.example.com", "http://192.0.2.5"]));
    const { stdout, stderr } = runLoader(file);
    expect(stderr).toBe("");
    const extras = stdout.trim().split("\n").filter(Boolean);
    expect(extras).toEqual(["https://custom.example.com", "http://192.0.2.5"]);

    const merged = runMerge("device", ["http://192.0.2.5"], extras);
    // http://192.0.2.5 already present from LAN_IPS — the extras merge
    // must de-dupe it, not append a second copy.
    expect(merged).toEqual([
      "http://device.local",
      "http://localhost",
      "http://127.0.0.1",
      "http://10.42.0.1",
      "http://10.43.0.1",
      "http://192.0.2.5",
      "https://custom.example.com",
    ]);
  });

  it("is idempotent — re-running the loader+merge on unchanged input yields the same list", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gw-wiring-"));
    const file = path.join(dir, "origins.json");
    writeFileSync(file, JSON.stringify(["https://custom.example.com"]));

    const run = () => {
      const { stdout } = runLoader(file);
      const extras = stdout.trim().split("\n").filter(Boolean);
      return runMerge("device", [], extras);
    };

    expect(run()).toEqual(run());
  });

  it("invalid JSON produces a warning on stderr and no extras — defaults still merge cleanly", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gw-wiring-"));
    const file = path.join(dir, "origins.json");
    writeFileSync(file, "{not json");
    const { stdout, stderr } = runLoader(file);
    expect(stdout.trim()).toBe("");
    expect(stderr).toMatch(/WARN.*not valid JSON/);

    const merged = runMerge("device", [], []);
    expect(merged).toEqual([
      "http://device.local",
      "http://localhost",
      "http://127.0.0.1",
      "http://10.42.0.1",
      "http://10.43.0.1",
    ]);
  });

  it("missing helper module warns and falls through to no extras (boot unaffected)", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAWBOX_GATEWAY_ORIGINS_SCRIPT_DIR: "/nonexistent/scripts/dir",
    };
    delete env.CLAWBOX_CONTROL_UI_ORIGINS_FILE;
    const result = spawnSync("python3", ["-c", extractLoaderSnippet()], { encoding: "utf-8", env });
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toMatch(/WARN.*helper unavailable.*using defaults only/);
    expect(result.status).toBe(0);
  });

  it("unexpected helper failure warns and falls through without blocking boot", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gw-wiring-"));
    writeFileSync(
      path.join(dir, "gateway_origins.py"),
      [
        "def resolve_origins_path():",
        "    raise RuntimeError('unexpected sensitive detail')",
        "",
        "def load_configured_origins(path):",
        "    raise AssertionError('unreachable')",
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAWBOX_GATEWAY_ORIGINS_SCRIPT_DIR: dir,
    };
    const result = spawnSync("python3", ["-c", extractLoaderSnippet()], { encoding: "utf-8", env });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toMatch(/WARN.*helper failed \(RuntimeError\).*using defaults only/);
    expect(result.stderr).not.toContain("unexpected sensitive detail");
  });
});
