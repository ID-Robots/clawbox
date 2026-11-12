/**
 * What the coding agent may publish on GitHub on its own (TASK-1366) —
 * src/lib/publish-redaction.ts.
 *
 * Each category is pinned twice: what it must take out, and the ordinary text
 * beside it that it must leave alone. The second half is the one a redactor
 * usually loses — a rule that eats `1.2.3.4` out of a package name or
 * `.env.local` out of a file list turns every pull request into a puzzle.
 *
 * Every value here is invented. Token-shaped strings are assembled at run time,
 * so this file carries nothing a secret scanner would stop a push for.
 */
import { describe, expect, it } from "vitest";
import {
  EMAIL_PLACEHOLDER as EMAIL,
  HOST_PLACEHOLDER as HOST,
  PRIVATE_IP_PLACEHOLDER as IP,
  SECRET_PLACEHOLDER as SECRET,
  isPrivateIpv4,
  isPrivateIpv6,
  redactForPublishing,
} from "@/lib/publish-redaction";

const r = (text: string, hostNames?: string[]) => redactForPublishing(text, { hostNames });
/** The text as it goes out: what the GitHub door sends, with the quoted-value pass. */
const sent = (text: string, hostNames?: string[]) => redactForPublishing(text, { hostNames, quotedValues: true });

const GHP = `ghp_${"a1B2c3D4e5".repeat(4)}`;
const GITHUB_PAT = `github_pat_${"11ABCDEFG0".repeat(3)}_${"x9Y8z7W6v5".repeat(5)}`;
const OPENAI = `sk-proj-${"Qw3rTy9Ui0".repeat(4)}`;
const ANTHROPIC = `sk-ant-api03-${"Zx8cV7bN6m".repeat(5)}`;
const SLACK = `xoxb-${"1234567890"}-${"abcdefGHIJ".repeat(2)}`;
const AWS = `AKIA${"ABCDEFGH23456789"}`;
const HEX40 = "0123456789abcdef".repeat(2) + "01234567";
const B64 = `${"QmFzZTY0U2VjcmV0".repeat(2)}==`;

describe("private IPs", () => {
  it.each([
    "10.0.0.5", "10.255.255.255", // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    "172.16.0.1", "172.20.10.2", "172.31.255.254", // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    "192.168.0.1", "192.168.1.20", // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    "100.64.0.1", "100.101.102.103", "100.127.255.254",
  ])("replaces %s", (ip) => {
    expect(r(`ssh pi@${ip} and flash it`)).toBe(`ssh pi@${IP} and flash it`);
    expect(r(`open http://${ip}:3000/admin`)).toBe(`open http://${IP}:3000/admin`);
    expect(r(`the board at ${ip}.`)).toBe(`the board at ${IP}.`);
  });

  it.each([
    // Public addresses are nobody's secret, and the edges of every range stay out.
    "8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1",
    "192.169.0.1", "11.0.0.1", "9.255.255.255",
    // Not addresses at all.
    "10.0.0.256", "999.1.1.1",
  ])("leaves %s alone", (value) => {
    expect(r(`reach ${value} first`)).toBe(`reach ${value} first`);
  });

  it("does not mistake a version for an address", () => {
    for (const text of [
      "bump lodash to 1.2.3.4",
      "pin react@18.2.0 and pkg@1.2.3.4",
      "build v10.0.0.1 shipped",
      "tarball libfoo-10.2.0.1.tar.gz", // public-hygiene: allow synthetic test fixture, not a real host/account/credential
      "five parts 10.0.0.1.2 is a version",
      "and 1.10.0.0.1 too",
      "python3.10.1.2",
    ]) expect(r(text)).toBe(text);
  });

  it("catches both ends of a range", () => {
    expect(r("DHCP 192.168.1.100-192.168.1.200")).toBe(`DHCP ${IP}-${IP}`); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
  });

  it.each([
    ["fe80::1", IP], // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    ["fe80::1ff:fe23:4567:890a%eth0", IP], // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    ["fd12:3456:789a:1::1", IP], // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    ["fc00::", IP],
    ["febf:0:0:0:0:0:0:1", IP], // public-hygiene: allow synthetic test fixture, not a real host/account/credential
  ])("replaces the private IPv6 %s", (address, expected) => {
    expect(r(`ping ${address} now`)).toBe(`ping ${expected} now`);
  });

  it("keeps a sentence's own colon and brackets around an IPv6 address", () => {
    expect(r("fe80::1: unreachable")).toBe(`${IP}: unreachable`); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    expect(r("curl http://[fd00::5]:8080/")).toBe(`curl http://[${IP}]:8080/`); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
  });

  it("leaves public IPv6, loopback, clocks, MACs and C++ alone", () => {
    for (const text of [
      "2001:db8::1 is documentation",
      "listen on ::1",
      "at 12:30:45 it failed",
      "MAC fc:aa:14:2b:3c:4d",
      "std::vector<int> and a::b",
      "fec0::1 is not link-local",
    ]) expect(r(text)).toBe(text);
  });

  it("classifies exact ranges", () => {
    expect(isPrivateIpv4("172.16.0.0")).toBe(true); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    expect(isPrivateIpv4("172.15.0.0")).toBe(false);
    expect(isPrivateIpv4("100.64.0.0")).toBe(true);
    expect(isPrivateIpv4("100.128.0.0")).toBe(false);
    expect(isPrivateIpv4("1.2.3.4")).toBe(false);
    expect(isPrivateIpv4("10.0.0")).toBe(false);
    expect(isPrivateIpv6("fe80::1")).toBe(true); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    expect(isPrivateIpv6("fdff::1")).toBe(true); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    expect(isPrivateIpv6("fe00::1")).toBe(false);
    expect(isPrivateIpv6("::1")).toBe(false);
    expect(isPrivateIpv6("2001:db8::1")).toBe(false);
  });
});

describe("home paths", () => {
  it("turns a home path into ~ and keeps the layout below it", () => {
    expect(r("read /home/ada/Projects/briefs/task.md first")).toBe("read ~/Projects/briefs/task.md first"); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    expect(r("cd /Users/ada.lovelace/dev/app")).toBe("cd ~/dev/app"); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    expect(r("the box's own /home/clawbox/Projects/site")).toBe("the box's own ~/Projects/site");
    expect(r("everything under /home/clawbox.")).toBe("everything under ~.");
    expect(r("`/home/ada`")).toBe("`~`"); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    expect(r("file:///home/ada/index.html")).toBe("file://~/index.html"); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
  });

  it("leaves a URL's route, a folder called home, and a placeholder alone", () => {
    for (const text of [
      "https://example.com/home/ada/profile",
      "see ~/home/notes",
      "src/home/page.tsx",
      "/home/<user>/Projects",
      "/home/$USER/bin",
    ]) expect(r(text)).toBe(text);
  });
});

describe("email addresses", () => {
  it("replaces an address", () => {
    expect(r("mail ada@example.com about it")).toBe(`mail ${EMAIL} about it`);
    expect(r("<ada.lovelace+pr@mail.example.co.uk>")).toBe(`<${EMAIL}>`);
    expect(r("Co-Authored-By: Ada <12345+ada@users.noreply.github.com>")).toBe(`Co-Authored-By: Ada <${EMAIL}>`);
  });

  it("leaves address-shaped code alone", () => {
    for (const text of [
      "logo@2x.png and icon@3x.webp",
      "git@github.com:octo/repo.git",
      "@coderabbitai review",
      "npm i react@18.2.0 @scope/pkg@1.2.3",
      "user@host without a domain",
    ]) expect(r(text)).toBe(text);
  });
});

describe("token-shaped strings", () => {
  it.each([
    ["a classic GitHub token", GHP],
    ["a fine-grained GitHub token", GITHUB_PAT],
    ["an OpenAI key", OPENAI],
    ["an Anthropic key", ANTHROPIC],
    ["a Slack token", SLACK],
    ["an AWS access key id", AWS],
  ])("replaces %s", (_name, token) => {
    expect(r(`use ${token} for it`)).toBe(`use ${SECRET} for it`);
  });

  it("replaces the value after token=, password= and key=, keeping the name", () => {
    expect(r(`curl "https://api.example.com/x?token=${HEX40}"`)).toBe(`curl "https://api.example.com/x?token=${SECRET}"`);
    expect(r("password=hunter2hunter2")).toBe(`password=${SECRET}`);
    expect(r(`key=${HEX40}`)).toBe(`key=${SECRET}`);
    expect(r(`SSH_KEY: '${B64}'`)).toBe(`SSH_KEY: '${SECRET}'`);
    expect(r(`API_KEY="${B64}"`)).toBe(`API_KEY="${SECRET}"`);
  });

  it("replaces the value after a PREFIXED name, the way a .env writes it", () => {
    // `\btoken\b` never matches inside DEPLOY_TOKEN: these survived the shared rule.
    expect(r(`DEPLOY_TOKEN=${HEX40}`)).toBe(`DEPLOY_TOKEN=${SECRET}`);
    expect(r(`NPM_TOKEN: "${B64}"`)).toBe(`NPM_TOKEN: "${SECRET}"`);
    expect(r(`APP_SECRET=${HEX40}`)).toBe(`APP_SECRET=${SECRET}`);
    expect(r("DB_PASSWORD=hunter22")).toBe(`DB_PASSWORD=${SECRET}`);
    expect(r("smtpPasswd: 'S3cret!pass'")).toBe(`smtpPasswd: '${SECRET}'`);
    expect(r("ADMIN_PWD=s3cret!x")).toBe(`ADMIN_PWD=${SECRET}`);
  });

  it("replaces the value under a QUOTED name, the way JSON writes it", () => {
    for (const [input, expected] of [
      ['{"DB_PASSWORD": "hunter2hunter2"}', `{"DB_PASSWORD": "${SECRET}"}`],
      [`{"DEPLOY_TOKEN": "${HEX40}"}`, `{"DEPLOY_TOKEN": "${SECRET}"}`],
      [`{'APP_SECRET': '${B64}'}`, `{'APP_SECRET': '${SECRET}'}`],
      [`{"token": "${HEX40}"}`, `{"token": "${SECRET}"}`],
      ['{\\"DB_PASSWORD\\":\\"hunter2hunter2\\"}', `{\\"DB_PASSWORD\\":\\"${SECRET}\\"}`],
      [`{\\"DEPLOY_TOKEN\\":\\"${HEX40}\\"}`, `{\\"DEPLOY_TOKEN\\":\\"${SECRET}\\"}`],
    ]) {
      expect(sent(input)).toBe(expected);
      expect(sent(expected)).toBe(expected);
    }
  });

  it("keeps redacting a value on the line after its name", () => {
    expect(sent(`DEPLOY_TOKEN:\n  ${HEX40}`)).not.toContain(HEX40);
    expect(sent("DB_PASSWORD:\n  hunter2hunter2")).not.toContain("hunter2hunter2");
  });

  it("replaces a quoted password whole, whichever way the name, quote and separator are written", () => {
    // Spaces and the other quote character are part of a quoted value.
    const otherQuote = (q: string) => (q === '"' ? "abcd'efghijklmnop" : 'abcd"efghijklmnop');
    const leaked = ["password", "DB_PASSWORD"].flatMap((key) => ['"', "'"].flatMap((q) => [key, `${q}${key}${q}`].flatMap((k) =>
      [":", ": ", " : ", "=", "= ", " = "].flatMap((sep) =>
        ["correct horse battery staple", otherQuote(q)].map((v) => `${k}${sep}${q}${v}${q}`)))))
      .filter((input) => {
        const out = sent(input);
        return /correct|horse|battery|staple|abcd|efghijklmnop/.test(out) || !out.includes(SECRET) || sent(out) !== out;
      });
    expect(leaked).toEqual([]);
  });

  it("reads a quoted password through its closing quote and keeps what follows", () => {
    for (const [input, expected] of [
      ['{"DB_PASSWORD": "correct horse battery staple"}', `{"DB_PASSWORD": "${SECRET}"}`],
      ['DB_PASSWORD="correct horse battery staple" in the env file', `DB_PASSWORD="${SECRET}" in the env file`],
      ['{"DB_PASSWORD":"abcd\'efghijklmnop"}', `{"DB_PASSWORD":"${SECRET}"}`],
      ['{\\"DB_PASSWORD\\":\\"correct horse battery staple\\"}', `{\\"DB_PASSWORD\\":\\"${SECRET}\\"}`],
      // No closing quote on the line: the value runs to the end of it, and the next line is kept.
      ['NOTE="kept as is"\nDB_PASSWORD="correct horse battery staple', `NOTE="kept as is"\nDB_PASSWORD="${SECRET}`],
      ['DB_PASSWORD="an unclosed value mid-text\nNOTE="kept as is"', `DB_PASSWORD="${SECRET}\nNOTE="kept as is"`],
      // The shared rule keeps `Bearer` in a quoted value; this one leaves that alone.
      [`DB_PASSWORD: "Bearer ${HEX40}"`, `DB_PASSWORD: "Bearer ${SECRET}"`],
    ]) {
      expect(sent(input)).toBe(expected);
      expect(sent(expected)).toBe(expected);
    }
  });

  it("leaves an empty quoted password and a reference as they were", () => {
    for (const text of [
      '{"DB_PASSWORD": "", "note": "a note with spaces"}',
      '{"DB_PASSWORD": "${DB_PASSWORD}"}',
      '{"DB_PASSWORD": "{{ .Values.dbPassword }}"}',
      'Set the "password" field, then save.',
    ]) expect(sent(text)).toBe(text);
    const bearer = sent(`Authorization: "Bearer ${HEX40}"`);
    expect(bearer).toBe(`Authorization: "Bearer ${SECRET}"`);
    expect(sent(bearer)).toBe(bearer);
  });

  it("replaces a password with an escaped quote in it whole under a quoted name, however early or late the escape", () => {
    const values = (q: string) => [`abcdefghij\\${q}klmnop`, `a\\${q}bcdefghijklmnop`, `abcdefghij\\${q}klm\\${q}nopqr`];
    const leaked = ["password", "DB_PASSWORD"].flatMap((key) => ['"', "'"].flatMap((q) => values(q).flatMap((v) =>
      [":", ": ", "=", " = "].map((sep) => `${q}${key}${q}${sep}${q}${v}${q} and the rest`))))
      .filter((input) => {
        const out = sent(input);
        return /bcdefghij|klm|nopqr/.test(out) || !out.endsWith(" and the rest") || sent(out) !== out;
      });
    expect(leaked).toEqual([]);
    expect(sent('{"DB_PASSWORD":"abcdef\\"ghijkl"}')).toBe(`{"DB_PASSWORD":"${SECRET}"}`);
  });

  it("keeps a placeholder and a reference in a quoted password as they are", () => {
    for (const [input, expected] of [
      // Already redacted by the shared rule, in a text quoted into a pull request.
      ['password: "[redacted]"', 'password: "[redacted]"'],
      ['token: "${{ secrets.GITHUB_TOKEN }}"', 'token: "${{ secrets.GITHUB_TOKEN }}"'],
      ['{"password": "${DB_PASSWORD}"}', '{"password": "${DB_PASSWORD}"}'],
    ]) {
      expect(sent(input)).toBe(expected);
      expect(sent(expected)).toBe(expected);
    }
  });

  it("stays fast on a long line: 100 kB of prose, and a quote that never closes", () => {
    const prose = "the password field is required and the token limit was hit. ".repeat(1_700);
    const open = `DB_PASSWORD="${"a b ".repeat(25_000)}`;
    const started = performance.now();
    expect(sent(prose)).toBe(prose);
    expect(sent(open)).toBe(`DB_PASSWORD="${SECRET}`);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("stays fast on a quoted password holding a long run of escapes that ends in a key word", () => {
    const run = `DB_PASSWORD="abcdefghij\\"${"\\\\".repeat(50_000)}token"`;
    const started = performance.now();
    sent(run);
    sent(`${run}\nnext`);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("leaves prefixed names alone when what follows is code, a count or a reference", () => {
    for (const text of [
      "max_token: 4096",
      "tokens: 5",
      "dbPassword: string",
      "DB_PASSWORD=${DB_PASSWORD}",
      "pwd: /srv/www",
      "password_field: required",
      '{"max_token": 4096}',
      '{"dbPassword": "string"}',
    ]) expect(r(text)).toBe(text);
  });

  it("keeps the Markdown around a secret: a closing backtick is not part of the value", () => {
    expect(r("set `password=hunter2hunter2` there")).toBe(`set \`password=${SECRET}\` there`);
    expect(r(`send \`Authorization: Bearer ${HEX40}\` with it`)).toBe(`send \`Authorization: Bearer ${SECRET}\` with it`);
    expect(r(`use \`${GHP}\``)).toBe(`use \`${SECRET}\``);
  });

  it("replaces a URL's password and a PEM private key", () => {
    expect(r("git clone https://ada:s3cretPass@git.example.com/r.git"))
      .toBe(`git clone https://ada:${SECRET}@git.example.com/r.git`);
    // An `@` inside the password: everything up to the LAST `@` before the host goes.
    expect(r("git clone https://ada:p@ss@git.example.com/r.git"))
      .toBe(`git clone https://ada:${SECRET}@git.example.com/r.git`);
    expect(r('push to "https://ada:pa:ss@git.example.com"'))
      .toBe(`push to "https://ada:${SECRET}@git.example.com"`);
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----"; // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    expect(r(`key:\n${pem}\ndone`)).toBe(`key:\n${SECRET}\ndone`);
    expect(r("-----BEGIN RSA PRIVATE KEY-----\nMIIEow cut off here")).toBe(SECRET); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
  });

  it("leaves ordinary code that merely looks like it alone", () => {
    for (const text of [
      "key=codingAgent.autoPrLabel",
      "hotkey: Ctrl+Shift+K",
      `commit ${HEX40} is the head`,
      "the cache key: build",
      "task-1366 and desk-lamp",
      "keyboard=us",
    ]) expect(r(text)).toBe(text);
  });
});

describe("host names", () => {
  it("replaces LAN and mDNS names", () => {
    expect(r("open http://ada-desk.local:3000/")).toBe(`open http://${HOST}:3000/`);
    expect(r("nas.lan and printer.home.arpa")).toBe(`${HOST} and ${HOST}`);
    expect(r("ping clawbox.local.")).toBe(`ping ${HOST}.`);
    expect(r("box.localdomain")).toBe(HOST);
  });

  it("replaces the box's own name, whole word and any case", () => {
    expect(r("ssh ada-desk and reboot", ["ada-desk"])).toBe(`ssh ${HOST} and reboot`);
    expect(r("ADA-DESK said hi", ["ada-desk"])).toBe(`${HOST} said hi`);
    expect(r("ada-desk.example.org is up", ["ada-desk.example.org", "ada-desk"])).toBe(`${HOST} is up`);
    expect(r("ssh pi@ada-desk", ["ada-desk"])).toBe(`ssh pi@${HOST}`);
  });

  it("does not rewrite a longer word, a generic name or a tiny one", () => {
    expect(r("ada-desktop is another box", ["ada-desk"])).toBe("ada-desktop is another box");
    expect(r("Opened by the ClawBox coding agent.", ["clawbox"])).toBe("Opened by the ClawBox coding agent.");
    expect(r("an ubuntu box", ["ubuntu"])).toBe("an ubuntu box");
    expect(r("the pi is fine", ["pi"])).toBe("the pi is fine");
  });

  it("leaves file names with a .local in them, localhost and public hosts alone", () => {
    for (const text of [
      "edit .env.local",
      "and .claude/settings.local.json",
      "docker-compose.local.yml",
      "http://localhost:3000",
      "https://github.com/octo/repo",
    ]) expect(r(text)).toBe(text);
  });
});

describe("redactForPublishing", () => {
  const mixed = [
    "Deploy to 192.168.1.20 from /home/ada/Projects/site,", // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    `tell ada@example.com, token ${GHP}, then check ada-desk.local and fd00::7.`, // public-hygiene: allow synthetic test fixture, not a real host/account/credential
  ].join("\n");

  it("takes every category out of one text, in order", () => {
    expect(r(mixed)).toBe([
      `Deploy to ${IP} from ~/Projects/site,`,
      `tell ${EMAIL}, token ${SECRET}, then check ${HOST} and ${IP}.`,
    ].join("\n"));
  });

  it("is idempotent, so the composer and the gh door can both apply it", () => {
    const once = r(mixed, ["ada-desk"]);
    expect(r(once, ["ada-desk"])).toBe(once);
  });

  it("is safe on empty and non-string input", () => {
    expect(r("")).toBe("");
    expect(redactForPublishing(undefined as unknown as string)).toBe("");
    expect(redactForPublishing(42 as unknown as string)).toBe("");
  });

  it("leaves a text with nothing private in it exactly as it was", () => {
    const text = "Fix the paginator in src/lib/list.ts — v2.3.1 broke `next()` at 10:30.\n\n- [x] tests";
    expect(r(text, ["ada-desk"])).toBe(text);
  });
});
