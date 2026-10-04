import { describe, it, expect } from "vitest";
import { redactCredentials, REDACTED } from "../../../mcp/lib/redact-credentials";
import { redact } from "../../../mcp/lib/errors";
import { capResult } from "../../../mcp/lib/register";

// Synthetic, obviously fake credentials shaped like the real ones.
const OAT = "sk-ant-oat01-" + "Ab3_dE-f".repeat(12);
const ORT = "sk-ant-ort01-" + "Zy9-xW_v".repeat(10);
const OPAQUE_REFRESH = "rT" + "q8W2e_R-".repeat(9);
const API = "sk-ant-api03-" + "k".repeat(80);
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";

function leaks(out: string, ...secrets: string[]): string[] {
  // Any 12-char window of a secret surviving counts as a leak (catches partial masks).
  return secrets.filter((s) => {
    for (let i = 0; i + 12 <= s.length; i += 6) if (out.includes(s.slice(i, i + 12))) return true;
    return false;
  });
}

describe("redactCredentials", () => {
  it("masks OAuth access + refresh in an auth-profiles JSON dump", () => {
    const json = JSON.stringify({
      version: 1,
      profiles: {
        "anthropic:default": { type: "oauth", provider: "anthropic", access: OAT, refresh: ORT, expires: 1760000000000 },
        "anthropic:other": { type: "oauth", provider: "anthropic", access: OAT, refresh: OPAQUE_REFRESH },
        "openai-codex:default": { type: "oauth", access: JWT, refresh: OPAQUE_REFRESH, accountId: "acct_1" },
        "anthropic:key": { type: "api_key", apiKey: API },
      },
    }, null, 2);
    const out = redactCredentials(json);
    expect(leaks(out, OAT, ORT, OPAQUE_REFRESH, API, JWT)).toEqual([]);
    // Structure and non-secret fields survive.
    expect(out).toContain('"provider": "anthropic"');
    expect(out).toContain('"expires": 1760000000000');
    expect(out).toContain('"accountId": "acct_1"');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("masks escaped JSON inside a sqlite row dump", () => {
    const row = `anthropic:default|oauth|"{\\"access\\":\\"${OAT}\\",\\"refresh\\":\\"${OPAQUE_REFRESH}\\"}"`;
    const out = redactCredentials(row);
    expect(leaks(out, OAT, OPAQUE_REFRESH)).toEqual([]);
    expect(out).toContain("anthropic:default|oauth|");
  });

  it("masks compact sqlite JSON column and tokens in prose / logs", () => {
    const row = `1|anthropic|{"access":"${OAT}","refresh":"${OPAQUE_REFRESH}","expires":1}`;
    expect(leaks(redactCredentials(row), OAT, OPAQUE_REFRESH)).toEqual([]);
    const log = `gateway: refreshed token for profile; new access ${OAT} ok, id ${JWT}`;
    expect(leaks(redactCredentials(log), OAT, JWT)).toEqual([]);
  });

  it("masks env / yaml assignments", () => {
    const env = `ANTHROPIC_API_KEY=${API}\nCLAUDE_CODE_OAUTH_TOKEN=${OPAQUE_REFRESH}\nrefresh_token: ${OPAQUE_REFRESH}\n`;
    const out = redactCredentials(env);
    expect(leaks(out, API, OPAQUE_REFRESH)).toEqual([]);
    expect(out).toContain(`ANTHROPIC_API_KEY=${REDACTED}`);
  });

  it("leaves ordinary text alone", () => {
    const plain = "refresh: true\ntoken: none\nThe access road is closed. tokens used: 1234";
    expect(redactCredentials(plain)).toBe(plain);
  });

  it("is applied by the shared redact() and by capResult (every tool result)", () => {
    expect(leaks(redact(`{"access": "${OAT}"}`), OAT)).toEqual([]);
    const res = capResult({ content: [{ type: "text", text: `{"refresh":"${OPAQUE_REFRESH}"} ${ORT}` }] }, 10_000);
    const out = (res.content[0] as { text: string }).text;
    expect(leaks(out, OPAQUE_REFRESH, ORT)).toEqual([]);
  });
});

describe("redactCredentials: header, URL and flag forms", () => {
  const OPAQUE = "cbx" + "Q7wE9rT2yU4i".repeat(3);
  it("masks a Bearer/Basic token in an Authorization header at the shared tool gate", () => {
    const text = `> GET /v1/models HTTP/1.1\n> Authorization: Bearer ${OPAQUE}\n> authorization: basic ${OPAQUE}==\n`;
    const out = capResult({ content: [{ type: "text", text }] }, 10_000).content[0];
    expect(out.type === "text" && leaks(out.text, OPAQUE)).toEqual([]);
    expect(out.type === "text" && out.text).toContain("GET /v1/models");
  });
  it("masks dashed header keys, URL userinfo and secret CLI flags", () => {
    const text = `x-api-key: ${OPAQUE}\nremote https://bot:${OPAQUE}@github.com/o/r.git\nrun --token ${OPAQUE} --password=${OPAQUE}`;
    const out = redactCredentials(text);
    expect(leaks(out, OPAQUE)).toEqual([]);
    expect(out).toContain("https://bot:");
    expect(out).toContain("@github.com/o/r.git");
  });
  it("leaves prose with the words bearer/token alone", () => {
    const prose = "The token expired. Pass the bearer token through the header; basic auth is off.";
    expect(redactCredentials(prose)).toBe(prose);
  });
});
