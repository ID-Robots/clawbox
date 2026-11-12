/**
 * The shared redaction of error text, class by class.
 *
 * Everything this module lets through ends up in a PUBLIC GitHub issue, so the
 * suite is written as a list of things that must never appear in the output
 * rather than a list of pretty rewrites. Each redaction class from the brief
 * gets its own case, and beside them sit the false positives that made earlier
 * drafts unusable — a stack frame is not a hostname, a clock is not an IPv6
 * address — because a sanitizer that destroys the diagnosis gets switched off.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_STACK_FRAMES,
  normalizeMessage,
  redactCredentialShapes,
  redactQuotedCredentialValues,
  REDACTED,
  sanitizeContext,
  sanitizeStack,
  sanitizeText,
} from "@/lib/incident-sanitize";

/** The shared rules, then the quoted-value pass, the way a caller runs them. */
const quoted = (input: string, replacement?: string) =>
  redactQuotedCredentialValues(redactCredentialShapes(input, replacement), replacement);

describe("sanitizeText — credential shapes", () => {
  it.each([
    ["ClawBox AI", "Failed to authenticate with claw_abcdef1234567890 on the proxy", "claw_abcdef1234567890"],
    ["OpenAI", "provider said sk-proj-AbCdEf1234567890 is invalid", "sk-proj-AbCdEf1234567890"],
    ["GitHub classic", "remote rejected (ghp_1234567890abcdefGHIJ)", "ghp_1234567890abcdefGHIJ"],
    ["GitHub fine-grained", "auth: github_pat_11ABCDE0Y_9zAbCdEfGh", "github_pat_11ABCDE0Y_9zAbCdEfGh"],
    ["GitHub server", "token ghs_0987654321zyxwvuTSRQ rejected", "ghs_0987654321zyxwvuTSRQ"],
    ["Slack", "posted with xoxb-11111111-2222222222", "xoxb-11111111-2222222222"],
    ["JWT", "session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.q1w2e3r4t5 expired", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.q1w2e3r4t5"],
  ])("removes a %s token", (_name, input, secret) => {
    const out = sanitizeText(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it("removes the value after Bearer and keeps the scheme", () => {
    const out = sanitizeText("Authorization: Bearer AbCdEf0123456789xyz");
    expect(out).not.toContain("AbCdEf0123456789xyz");
    expect(out).toContain("Bearer");
    // The exact defect that reordering the rules fixed: `[redacted]]`.
    expect(out).not.toContain("]]");
  });

  it.each(["api_key", "apikey", "password", "client_secret", "refresh_token"])(
    "removes the value after %s",
    (keyword) => {
      const out = sanitizeText(`${keyword}=hunter2hunter2hunter2`);
      expect(out).not.toContain("hunter2hunter2hunter2");
      expect(out).toContain(REDACTED);
    },
  );

  it("does not eat ordinary prose that happens to contain the word token", () => {
    // A real message from this box. `\\btoken\\b\\s+\\S+` swallowed "limit after".
    expect(sanitizeText("Stopped at the token limit after 12 steps")).toBe("Stopped at the token limit after 12 steps");
  });

  it.each([
    ['{"token": "0123456789abcdef0123456789abcdef"}', '{"token": "[redacted]"}'],
    ['{"apiKey":"0123456789abcdef"}', '{"apiKey":"[redacted]"}'],
    ["{'password': 'hunter2hunter2'}", "{'password': '[redacted]'}"],
    ['{\\"token\\":\\"0123456789abcdef0123\\"}', '{\\"token\\":\\"[redacted]\\"}'],
  ])("removes the value under a quoted key and keeps the JSON shape: %s", (input, expected) => {
    const out = sanitizeText(input);
    expect(out).toBe(expected);
    expect(sanitizeText(out)).toBe(out);
  });

  it("leaves a quoted key's quotes in place with the empty replacement", () => {
    expect(quoted('{"token": "0123456789abcdef0123456789abcdef"}', "")).toBe('{"token": ""}');
  });

  it("rewrites an unquoted key exactly as before", () => {
    expect(quoted("token: abcdef123456")).toBe("token=[redacted]");
    expect(quoted("token: abcdef123456", "")).toBe("");
    expect(quoted("password='hunter2hunter2'")).toBe("password='[redacted]'");
  });

  it("keeps redacting a value on the line after its label", () => {
    expect(quoted("token:\n  0123456789abcdef")).not.toContain("0123456789abcdef");
  });

  it("removes a value that is only a secret because this box says it is", () => {
    const out = sanitizeText("config rejected value wondrous-passphrase", { secrets: ["wondrous-passphrase"] });
    expect(out).not.toContain("wondrous-passphrase");
  });

  it("ignores a short config value, which is a word rather than a credential", () => {
    expect(sanitizeText("the desktop is enabled", { secrets: ["enabled"] })).toContain("enabled");
  });
});

describe("the quoted-value pass after redactCredentialShapes — a quoted value is read through its closing quote", () => {
  const PHRASE = "correct horse battery staple";
  // The other quote character inside the value: an apostrophe in "…", a double quote in '…'.
  const otherQuote = (q: string) => (q === '"' ? "abcd'efghijklmnop" : 'abcd"efghijklmnop');
  const PIECES = /correct|horse|battery|staple|abcd|efghijklmnop/;
  const forms = (key: string) =>
    ['"', "'"].flatMap((q) => [key, `${q}${key}${q}`].flatMap((k) =>
      [":", ": ", " : ", "=", "= ", " = "].flatMap((sep) => [PHRASE, otherQuote(q)].map((v) => `${k}${sep}${q}${v}${q}`))));

  it("takes the whole value out, whichever way the key, quote and separator are written", () => {
    const leaked = [...forms("password"), ...forms("token"), ...forms("api_key")].filter((input) => {
      const out = quoted(input);
      return PIECES.test(out) || !out.includes(REDACTED) || quoted(out) !== out
        || PIECES.test(quoted(input, ""));
    });
    expect(leaked).toEqual([]);
  });

  it.each([
    ['{"password": "correct horse battery staple"}', '{"password": "[redacted]"}'],
    ['password="correct horse battery staple" was refused', 'password="[redacted]" was refused'],
    ['{"password":"abcd\'efghijklmnop"}', '{"password":"[redacted]"}'],
    ['{"password":"abcd\\"efghijkl"}', '{"password":"[redacted]"}'],
    ['{\\"password\\":\\"correct horse battery staple\\"}', '{\\"password\\":\\"[redacted]\\"}'],
    ['token: "correct horse battery staple" and then "more text here"', 'token: "[redacted]" and then "more text here"'],
  ])("rewrites %s and keeps what follows the closing quote", (input, expected) => {
    expect(sanitizeText(input)).toBe(expected);
    expect(sanitizeText(expected)).toBe(expected);
  });

  it("keeps a quoted key's quotes with the empty replacement, and drops a bare key's pair as before", () => {
    expect(quoted('{"password": "correct horse battery staple"}', "")).toBe('{"password": ""}');
    expect(quoted('password="correct horse battery staple" was refused', "")).toBe(" was refused");
  });

  it("keeps the cut's marker where the cap falls inside a quoted value", () => {
    const out = sanitizeText(`{"password": "${"a b ".repeat(100)}"}`, { maxChars: 50 });
    expect(out).toBe('{"password": "[redacted]…');
    const stack = sanitizeStack(`Error: password: "${"a b ".repeat(150)}" was refused\n    at f (/srv/x.js:1:1)`);
    expect(stack?.split("\n")[0]).toBe('Error: password: "[redacted]…');
  });

  it("takes a value with no closing quote to the end of its line, and no further", () => {
    expect(quoted('{"password": "correct horse battery staple')).toBe('{"password": "[redacted]');
    expect(quoted('{"password": "correct horse battery staple\n')).toBe('{"password": "[redacted]\n');
    expect(quoted('{"password": "correct horse battery staple\n"note": "kept as is"}'))
      .toBe('{"password": "[redacted]\n"note": "kept as is"}');
    // A key after an unclosed quote keeps its value on the next line redacted.
    expect(quoted('note: "abc def token:\n  0123456789abcdef')).toBe('note: "abc def token=[redacted]');
    const joined = quoted('password: "abc def token:\n  0123456789abcdef');
    expect(joined).not.toMatch(/abc def|0123456789abcdef/);
    expect(quoted(joined)).toBe(joined);
  });

  it("leaves prose and an empty or short quoted value as they were", () => {
    for (const text of [
      "the password field is required",
      'He said "the token is fine" and left',
      '{"password": "", "name": "a name with spaces"}',
      '{"token": ""}',
      'password: "short"',
    ]) {
      expect(quoted(text)).toBe(text);
      expect(quoted(text, "")).toBe(text);
    }
  });

  it("takes a value with an escaped quote in it whole under a quoted key, however early or late the escape", () => {
    // Late (ten characters before the escape), early, and twice.
    const values = (q: string) => [`abcdefghij\\${q}klmnop`, `a\\${q}bcdefghijklmnop`, `abcdefghij\\${q}klm\\${q}nopqr`];
    const inputs = ['"', "'"].flatMap((q) => values(q).flatMap((v) =>
      [":", ": ", "=", " = "].map((sep) => `${q}password${q}${sep}${q}${v}${q} and the rest`)));
    const leaked = inputs.filter((input) => [quoted(input), quoted(input, ""), sanitizeText(input)]
      .some((out) => /bcdefghij|klm|nopqr/.test(out) || !out.endsWith(" and the rest")));
    expect(leaked).toEqual([]);
    expect(sanitizeText('{"password":"abcdef\\"ghijkl"}')).toBe('{"password":"[redacted]"}');
    expect(quoted('{"password":"abcdef\\"ghijkl"}', "")).toBe('{"password":""}');
  });

  it("keeps the value of a later key redacted when an earlier value holds an escaped quote", () => {
    for (const input of [
      'password: "abcdefghij\\"klm token" : "real secret phrase"',
      'password: "abcdefghij\\"klm token\n: realsecret12345',
    ]) {
      for (const out of [quoted(input), quoted(input, ""), sanitizeText(input)]) {
        expect(out).not.toMatch(/real secret phrase|realsecret12345/);
      }
    }
    // With the empty replacement a pair taken out must not make a later `"name" : "` look like a key.
    const glued = quoted('token: "fakeone fakeone2" secret: "fakethree\\"fakefour" : "x"', "");
    expect(glued).not.toMatch(/fakeone|fakethree/);
  });

  it("never lets a value in escaped quotes run over a bare quote, and keeps the next key's value redacted", () => {
    for (const [input, expected] of [
      // The bare quote ends the string the value is escaped in, so the fields after it stay.
      ['{"task":"Set password: \\"abc def","status":"done","note":"see token: \\"0123456789abcdef\\""}',
        '{"task":"Set password: \\"[redacted]","status":"done","note":"see token: \\"[redacted]\\""}'],
      ['{"task":"Set password: \\"abc def","status":"done","note":"he said \\"hi\\""}',
        '{"task":"Set password: \\"[redacted]","status":"done","note":"he said \\"hi\\""}'],
    ]) {
      expect(quoted(input)).toBe(expected);
      expect(quoted(expected)).toBe(expected);
    }
    expect(quoted('password: "abc def, token: "0123456789abcdef"', "")).not.toContain("0123456789abcdef");
  });

  it("leaves a quoted reference to a secret held elsewhere as it was", () => {
    for (const text of [
      'token: "${{ secrets.GITHUB_TOKEN }}"',
      'password: "${DB_PASSWORD}"',
      'token: "{{ .Values.apiToken }}"',
      "The deploy workflow passes token: \"${{ secrets.GITHUB_TOKEN }}\" to the checkout step.",
    ]) {
      expect(quoted(text)).toBe(text);
      expect(quoted(text, "")).toBe(text);
    }
  });

  it("keeps the scheme word of a quoted Bearer value", () => {
    const once = quoted('Authorization: "Bearer AbCdEf0123456789xyz"');
    expect(once).toBe('Authorization: "Bearer [redacted]"');
    expect(quoted(once)).toBe(once);
  });

  it("takes a quoted sentence under a credential key at its word", () => {
    expect(quoted('{"password": "must be at least 8 characters"}')).toBe('{"password": "[redacted]"}');
  });

  it("stays fast on a long line: 100 kB of prose, and a quote that never closes", () => {
    const prose = "the password field is required and the token limit was hit. ".repeat(1_700);
    const open = `password: "${"a b ".repeat(25_000)}`;
    const started = performance.now();
    expect(quoted(prose)).toBe(prose);
    expect(quoted(open)).toBe('password: "[redacted]');
    expect(quoted(`${open}\nnext line`)).toBe('password: "[redacted]\nnext line');
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("stays fast on a quoted value holding a long run of escapes that ends in a key word", () => {
    const run = `password: "abcdefghij\\"${"\\\\".repeat(50_000)}token"`;
    const started = performance.now();
    quoted(run);
    quoted(run, "");
    sanitizeText(`${run}\nnext`);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});

describe("sanitizeText — identities and addresses", () => {
  it("removes an email address", () => {
    const out = sanitizeText("could not deliver to ada.lovelace@example.org");
    expect(out).not.toContain("ada.lovelace@example.org");
    expect(out).not.toContain("example.org");
  });

  it("removes a LAN IPv4 and keeps loopback, which IS the diagnosis", () => {
    const out = sanitizeText("ECONNREFUSED 192.168.1.44:8080 (gateway on 127.0.0.1:18789)");
    expect(out).not.toContain("192.168.1.44");
    expect(out).toContain("127.0.0.1:18789");
  });

  it("removes an IPv6 address and keeps ::1", () => {
    const out = sanitizeText("no route to fe80::1ff:fe23:4567:890a from ::1");
    expect(out).not.toContain("fe80::1ff:fe23:4567:890a");
    expect(out).toContain("::1");
  });

  it("leaves a clock and a MAC alone — neither is an address of the owner's", () => {
    expect(sanitizeText("failed at 10:30:45")).toContain("10:30:45");
    expect(sanitizeText("iface aa:bb:cc:dd:ee:ff")).toContain("aa:bb:cc:dd:ee:ff");
  });

  it("removes a hostname that is not localhost, and keeps ClawBox's own", () => {
    const out = sanitizeText("could not resolve adas-box.local, but clawbox.com answered");
    expect(out).not.toContain("adas-box.local");
    expect(out).toContain("clawbox.com");
  });

  it("keeps github.com, which is where the reports go", () => {
    expect(sanitizeText("api.github.com refused")).toContain("api.github.com");
  });

  it("replaces a home path with ~ and keeps the layout under it", () => {
    expect(sanitizeText("ENOENT: /home/adalovelace/clawbox/data/config.json"))
      .toBe("ENOENT: ~/clawbox/data/config.json");
    expect(sanitizeText("open /Users/ada/Projects/app")).toBe("open ~/Projects/app");
  });

  it("removes a query string and keeps the route", () => {
    const out = sanitizeText("GET /setup-api/coding-agent/runs?id=run-abc&token=secret failed");
    expect(out).not.toContain("run-abc");
    expect(out).not.toContain("secret");
    expect(out).toContain("/setup-api/coding-agent/runs?");
  });
});

describe("sanitizeText — what must survive, or the report is worthless", () => {
  it.each([
    "at finishRun (~/clawbox/src/lib/coding-agent.ts:4954:12)",
    "install.sh refused clawbox-tts.sh",
    "openclaw 2026.8.1 is older than 2026.9.0",
    "could not read package.json",
  ])("leaves %s alone", (input) => {
    expect(sanitizeText(input)).toBe(input);
  });

  it("caps the result and says it was cut", () => {
    const out = sanitizeText("a".repeat(5_000), { maxChars: 100 });
    expect(out).toHaveLength(101);
    expect(out.endsWith("…")).toBe(true);
  });

  it("answers the empty string for a non-string", () => {
    expect(sanitizeText(undefined as unknown as string)).toBe("");
    expect(sanitizeText("")).toBe("");
  });
});

describe("sanitizeStack", () => {
  const stack = [
    "Error: boom at 10.0.0.5",
    ...Array.from({ length: 30 }, (_, i) => `    at frame${i} (/home/ada/app/src/lib/x.ts:${i}:1)`),
  ].join("\n");

  it("keeps the message line and at most MAX_STACK_FRAMES frames", () => {
    const out = sanitizeStack(stack)!;
    const lines = out.split("\n");
    expect(lines[0]).toContain("Error: boom");
    expect(lines.filter((l) => l.trim().startsWith("at "))).toHaveLength(MAX_STACK_FRAMES);
  });

  it("sanitizes every line it keeps", () => {
    const out = sanitizeStack(stack)!;
    expect(out).not.toContain("10.0.0.5");
    expect(out).not.toContain("/home/ada");
    // …and keeps the frames legible, which is the whole point of keeping them.
    expect(out).toContain("~/app/src/lib/x.ts");
  });

  it("answers null for nothing worth keeping", () => {
    expect(sanitizeStack(null)).toBeNull();
    expect(sanitizeStack("   ")).toBeNull();
    expect(sanitizeStack(undefined)).toBeNull();
  });
});

describe("sanitizeContext", () => {
  it("keeps scalars and sanitizes them", () => {
    expect(sanitizeContext({ step: "post_update", exitCode: 3, failFast: true, host: "adas-box.local" }))
      .toEqual({ step: "post_update", exitCode: "3", failFast: "true", host: REDACTED });
  });

  it("drops anything structured — a transcript or a file's contents gets in no other way", () => {
    expect(sanitizeContext({ transcript: ["hello", "world"], blob: { a: 1 }, ok: "yes" })).toEqual({ ok: "yes" });
  });

  it("drops a key that is not an identifier, and caps how many are kept", () => {
    expect(sanitizeContext({ "a key": "x", "__proto__": "y" })).toEqual({});
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v"]));
    expect(Object.keys(sanitizeContext(many))).toHaveLength(12);
  });

  it("answers an empty object for nothing", () => {
    expect(sanitizeContext(undefined)).toEqual({});
  });
});

describe("normalizeMessage — what makes two occurrences one fault", () => {
  it("folds the numbers that differ between occurrences", () => {
    expect(normalizeMessage("Stopped after 31 steps")).toBe(normalizeMessage("Stopped after 47 steps"));
  });

  it("folds a quoted fragment", () => {
    expect(normalizeMessage('cannot open "alpha"')).toBe(normalizeMessage('cannot open "beta"'));
  });

  it("still tells two different faults apart", () => {
    expect(normalizeMessage("disk is full")).not.toBe(normalizeMessage("network is down"));
  });
});
