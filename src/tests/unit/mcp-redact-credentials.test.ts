import { describe, it, expect } from "vitest";
import { redactCredentials, REDACTED } from "../../../mcp/lib/redact-credentials";
import { redact, sanitize } from "../../../mcp/lib/errors";
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

/** What the agent reads of a tool's text: the shared tool gate, `capResult`. */
const gate = (text: string, maxChars = 1_000_000) => {
  const out = capResult({ content: [{ type: "text", text }] }, maxChars).content[0];
  return out.type === "text" ? out.text : "";
};

describe("the tool gate: a quoted key with a name before it", () => {
  it.each([
    ['{"DB_PASSWORD": "hunter2hunter2"}', `{"DB_PASSWORD": "${REDACTED}"}`],
    ['{"APP_SECRET": "abcdef0123456789abcdef"}', `{"APP_SECRET": "${REDACTED}"}`],
    ["{'STRIPE_API_KEY': 'abcdef0123456789abcdef'}", `{'STRIPE_API_KEY': '${REDACTED}'}`],
    ['{\\"DB_PASSWORD\\":\\"hunter2hunter2\\"}', `{\\"DB_PASSWORD\\":\\"${REDACTED}\\"}`],
  ])("masks %s at the shared tool gate", (input, expected) => {
    expect(gate(input)).toBe(expected);
    expect(gate(expected)).toBe(expected);
    for (const out of [gate(redact(input)), sanitize(input)]) expect(out).not.toMatch(/hunter2hunter2|abcdef0123456789abcdef/);
  });
  it("leaves a JSON boolean or number under such a key, and a longer key, alone", () => {
    const text = '{"is_secret": true, "total_tokens": 123456789, "password_hint": "ask the admin"}';
    expect(gate(text)).toBe(text);
  });
  it("takes a string under a prefixed key at its word, as under the bare key", () => {
    expect(gate('{"password": "false", "show_password": "false"}'))
      .toBe(`{"password": "${REDACTED}", "show_password": "${REDACTED}"}`);
  });
  it("keeps a one-line YAML value and a value on the next line redacted", () => {
    expect(gate("api_key: abcdefgh12345678\nother: value")).toBe(`api_key: ${REDACTED}\nother: value`);
    expect(gate("api_key:\n  abcdefgh12345678")).not.toContain("abcdefgh12345678");
  });
});

describe("the tool gate: a quoted value is read through the quote that opened it", () => {
  const PHRASE = "correct horse battery staple";
  // The other quote character inside the value: an apostrophe in "…", a double quote in '…'.
  const otherQuote = (q: string) => (q === '"' ? "abcd'efghijklmnop" : 'abcd"efghijklmnop');
  const PIECES = /correct|horse|battery|staple|abcd|efghijklmnop/;

  it("masks the whole value, whichever way the key, quote and separator are written", () => {
    const inputs = ['"', "'"].flatMap((q) => [PHRASE, otherQuote(q)].flatMap((v) =>
      ["password", "DB_PASSWORD"].flatMap((key) => [key, `${q}${key}${q}`].flatMap((k) =>
        [":", ": ", " : ", "=", "= ", " = "].map((sep) => `${k}${sep}${q}${v}${q}`)))));
    const leaked = inputs.filter((input) => {
      const out = gate(input);
      return PIECES.test(out) || !out.includes(REDACTED) || gate(out) !== out
        || [gate(redact(input)), sanitize(input)].some((composed) => PIECES.test(composed));
    });
    expect(leaked).toEqual([]);
  });

  it.each([
    [`{"DB_PASSWORD":"abcd'efghijklmnop"}`, `{"DB_PASSWORD":"${REDACTED}"}`],
    ['{"password":"abcd\\"efghijkl"}', `{"password":"${REDACTED}"}`],
    [`{"password": "${PHRASE}", "user": "ada"}`, `{"password": "${REDACTED}", "user": "ada"}`],
    [`password: "${PHRASE}"`, `password: "${REDACTED}"`],
    [`{\\"refresh\\":\\"${PHRASE}\\",\\"type\\":\\"oauth\\"}`, `{\\"refresh\\":\\"${REDACTED}\\",\\"type\\":\\"oauth\\"}`],
    [`{"password" = "${PHRASE}"}`, `{"password" = "${REDACTED}"}`],
    // No closing quote on the line: the value runs to the end of it, and the next line is kept.
    [`{"user": "ada", "password": "${PHRASE}`, `{"user": "ada", "password": "${REDACTED}`],
    [`{"password": "${PHRASE}\n"user": "ada"}`, `{"password": "${REDACTED}\n"user": "ada"}`],
    // A Basic or Bearer token no other rule took goes with its scheme.
    ['Authorization: "Basic dXNlcjpwYXNz"', `Authorization: "${REDACTED}"`],
    ['Authorization: "Bearer abcdefghijklmnopqrstuv"', `Authorization: "${REDACTED}"`],
  ])("masks %s and keeps what follows the value", (input, expected) => {
    expect(gate(input)).toBe(expected);
    expect(gate(expected)).toBe(expected);
  });

  it("never lets a value in escaped quotes run over a bare quote", () => {
    const escaped = '{"task":"Set password: \\"abc def","status":"done","note":"see token: \\"0123456789abcdef\\""}';
    expect(gate(escaped)).toBe(
      `{"task":"Set password: \\"abc def","status":"done","note":"see token: \\"${REDACTED}\\""}`);
  });

  it("keeps a quoted reference, and the scheme of a quoted Bearer value, for the rules that know them", () => {
    for (const text of ['token: "${{ secrets.GITHUB_TOKEN }}"', 'password: "${DB_PASSWORD}"', 'token: "{{ .Values.apiToken }}"']) {
      expect(gate(text)).toBe(text);
    }
    expect(gate('Authorization: "Bearer abcdef12345678"')).toBe(`Authorization: "Bearer ${REDACTED}"`);
  });

  it("masks a value with an escaped quote in it whole under a quoted key, however early or late the escape", () => {
    const values = (q: string) => [`abcdefghij\\${q}klmnop`, `a\\${q}bcdefghijklmnop`, `abcdefghij\\${q}klm\\${q}nopqr`];
    const inputs = ['"', "'"].flatMap((q) => values(q).flatMap((v) => ["password", "DB_PASSWORD"].flatMap((key) =>
      [":", ": ", "=", " = "].map((sep) => `${q}${key}${q}${sep}${q}${v}${q} and the rest`))));
    const leaked = inputs.filter((input) => {
      const out = gate(input);
      return /bcdefghij|klm|nopqr/.test(out) || !out.endsWith(" and the rest")
        || [gate(redact(input)), sanitize(input)].some((composed) => /bcdefghij|klm|nopqr/.test(composed));
    });
    expect(leaked).toEqual([]);
  });

  it("keeps the value of a later key redacted when an earlier value holds an escaped quote", () => {
    const delivered = (input: string) => [gate(input), gate(redact(input)), sanitize(input)];
    for (const out of delivered('password: "abcdefghij\\"klm token" : "zzreal secret phrase"')) expect(out).not.toContain("zzreal");
    for (const input of [
      "password: 'abcdefghij\\'klm \"token' = 'real secret phrase'",
      'password: "abcdefghij\\"klm token\nrealsecret12345',
      'password: "abcdefghij\\"klm Bearer\nrealsecret12345',
      'password: "abcdefghij\\"klm basic\nrealsecret12345',
    ]) for (const out of delivered(input)) expect(out).not.toMatch(/real secret phrase|realsecret12345/);
  });

  it("never takes an escaped quote inside a value for its close, after redact()", () => {
    for (const [input, expected] of [
      ['password: "ab\\", efgh ijkl" was rejected', 'password: "[REDACTED]" was rejected'],
      ["password: 'ab\\', efgh ijkl' was rejected", "password: '[REDACTED]' was rejected"],
      ['password: "ab\\". efgh ijkl"', 'password: "[REDACTED]"'],
    ]) {
      expect(sanitize(input)).toBe(expected);
      expect(gate(redact(input))).toBe(expected);
    }
  });

  it("leaves an empty or short quoted value as it was", () => {
    for (const text of [
      '{"password": "", "name": "a name with spaces"}',
      'token: "none"',
    ]) expect(gate(text)).toBe(text);
    // A quoted key took a value on the next line before, and still does.
    expect(gate('{"password":\n  "several words here"}')).toBe(`{"password":\n  "${REDACTED}"}`);
  });

  it("stays fast on a long line: 100 kB of prose, and a quote that never closes", () => {
    const prose = "the password field is required and the token limit was hit. ".repeat(1_700);
    const started = performance.now();
    expect(gate(prose)).toBe(prose);
    expect(gate(`{"password": "${"a b ".repeat(25_000)}`)).toBe(`{"password": "${REDACTED}`);
    expect(gate(`password: "${"a b ".repeat(25_000)}`)).toBe(`password: "${REDACTED}`);
    expect(gate(`password: "${"a b ".repeat(25_000)}\nnext line`)).toBe(`password: "${REDACTED}\nnext line`);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("stays fast on a quoted value holding a long run of escapes that ends in a key word", () => {
    const run = `password: "abcdefghij\\"${"\\\\".repeat(50_000)}token"`;
    const started = performance.now();
    gate(run);
    gate(redact(`${run}\nnext`));
    gate(`--password ${run.slice(10)}`);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("stays fast on a value that opens with an escaped quote and holds a long run of backslashes", () => {
    const started = performance.now();
    expect(gate(redact(`password: \\"x${"\\".repeat(100_000)}\\"`))).toBe(`password: ${REDACTED}`);
    expect(gate(redact(`password: \\"x${"\\".repeat(100_001)}\\" more`))).toBe(`password: ${REDACTED} more`);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});

describe("the tool gate after redact(), as a tool's text reaches the agent", () => {
  it("keeps hidden what the gate hid after redact(), when a value holds an apostrophe", () => {
    const text = `{'password': "o'brien-2024", 'note': 'ok', 'token': "it's fakevalue2"}`;
    for (const out of [
      gate(redact(text)),
      gate(redact(redact(text))),
      gate(JSON.stringify({ problem_text: redact(text) })),
      gate(`Goal: ${redact(text)}\nnext line`),
    ]) expect(out).not.toMatch(/brien|fakevalue2/);
  });

  it("keeps the rest of a line after a value whose closing quote redact()'s label rule took", () => {
    const line = 'SMTP login refused: password: "hunter2hunter2" was rejected; check the account settings.';
    const expected = 'SMTP login refused: password: "[REDACTED] was rejected; check the account settings.';
    expect(redact(line)).toBe(expected);
    expect(gate(redact(line))).toBe(expected);
    expect(sanitize(line)).toBe(expected);
  });

  it("masks the rest of a quoted pass-phrase that redact() took the first word of", () => {
    expect(gate(redact('password: "correct horse battery staple" was rejected'))).toBe('password: "[REDACTED]" was rejected');
    expect(sanitize('password: "correct horse battery staple" was rejected')).toBe('password: "[REDACTED]" was rejected');
  });

  it("counts every character the cap drops in its note, where a placeholder pushed the text past the cap too", () => {
    // `show_password` is a key only the quoted-value pass reads, so "false" becomes "[REDACTED]" (5 more) after the cap.
    const text = `{"show_password": "false"} ${"y".repeat(3_000)}`;
    const out = gate(text, 2_000);
    const note = /\n…\[truncated, (\d+) chars omitted — narrow the query\]$/.exec(out);
    expect(note).not.toBeNull();
    expect(Number(note![1])).toBe(text.length - 2_000 + 5);
    expect(note!.index).toBe(2_000);
    expect(out.startsWith(`{"show_password": "${REDACTED}"}`)).toBe(true);
  });

  it("keeps the cut's own count where the masked text still fits the cap", () => {
    const text = `{"show_password": "false-and-more-words"} ${"y".repeat(3_000)}`;
    expect(gate(text, 2_000).endsWith(`\n…[truncated, ${text.length - 2_000} chars omitted — narrow the query]`)).toBe(true);
    expect(gate(`{"show_password": "false"} short`, 50)).toBe(`{"show_password": "${REDACTED}"} short`);
  });
});

describe("redactCredentials: the box's own ClawBox AI token", () => {
  const CLAW = "claw_" + "0a1b2c3d".repeat(4);
  it("masks clawai_token in a config.json read and the bare token in prose", () => {
    const json = JSON.stringify({ setup_complete: true, clawai_token: CLAW, clawai_tier: "pro", github_token: "Q7wE9rT2yU4iO0pZ" }, null, 2);
    const out = redactCredentials(json);
    expect(leaks(out, CLAW, "Q7wE9rT2yU4iO0pZ")).toEqual([]);
    expect(out).toContain('"clawai_tier": "pro"');
    expect(leaks(redactCredentials(`using ${CLAW} for the portal`), CLAW)).toEqual([]);
  });
  it("leaves numeric token counts alone", () => {
    const usage = '{"input_tokens": 1234, "max_tokens": 4096}\nmax_tokens: 4096';
    expect(redactCredentials(usage)).toBe(usage);
  });
});
