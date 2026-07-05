import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

// The setup/control-UI origin validation runs in Python inside
// gateway-pre-start.sh (issue #232). It lives in an importable module,
// scripts/gateway_origins.py, so it can be exercised here without booting the
// gateway. The `test` CI job runs on ubuntu-latest, which ships python3.
function pythonBin(): string {
  for (const bin of ["python3", "python"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error("python3 not found on the test runner");
}

describe("gateway_origins.py (configurable extra trusted origins)", () => {
  const py = pythonBin();

  it("passes the module self-test (valid, invalid, and default cases)", () => {
    const out = execFileSync(py, ["scripts/gateway_origins.py"], { encoding: "utf8" });
    expect(out).toContain("self-test: OK");
  });

  it("accepts a full https origin and rejects a bare hostname", () => {
    const script = [
      "import sys; sys.path.insert(0, 'scripts')",
      "from gateway_origins import normalize_origin as n",
      "print(n('https://vpn.example.ts.net'))",
      "print(n('vpn.example.ts.net'))",
    ].join("; ");
    const [valid, invalid] = execFileSync(py, ["-c", script], { encoding: "utf8" }).trim().split(/\r?\n/);
    expect(valid).toBe("https://vpn.example.ts.net");
    expect(invalid).toBe("None");
  });

  it("merges a configured origin into the defaults (default behavior unchanged when unset)", () => {
    const script = [
      "import sys; sys.path.insert(0, 'scripts')",
      "from gateway_origins import merge_extra_origins as m",
      "d = ['http://localhost']",
      "print(m(d, None)[0] == d)",
      "print(m(d, ['https://ok.example.com'])[0] == d + ['https://ok.example.com'])",
    ].join("; ");
    const [unchanged, merged] = execFileSync(py, ["-c", script], { encoding: "utf8" }).trim().split(/\r?\n/);
    expect(unchanged).toBe("True");
    expect(merged).toBe("True");
  });
});
