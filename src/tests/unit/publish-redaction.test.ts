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
    "10.0.0.5", "10.255.255.255",
    "172.16.0.1", "172.20.10.2", "172.31.255.254",
    "192.168.0.1", "192.168.1.20",
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
      "tarball libfoo-10.2.0.1.tar.gz",
      "five parts 10.0.0.1.2 is a version",
      "and 1.10.0.0.1 too",
      "python3.10.1.2",
    ]) expect(r(text)).toBe(text);
  });

  it("catches both ends of a range", () => {
    expect(r("DHCP 192.168.1.100-192.168.1.200")).toBe(`DHCP ${IP}-${IP}`);
  });

  it.each([
    ["fe80::1", IP],
    ["fe80::1ff:fe23:4567:890a%eth0", IP],
    ["fd12:3456:789a:1::1", IP],
    ["fc00::", IP],
    ["febf:0:0:0:0:0:0:1", IP],
  ])("replaces the private IPv6 %s", (address, expected) => {
    expect(r(`ping ${address} now`)).toBe(`ping ${expected} now`);
  });

  it("keeps a sentence's own colon and brackets around an IPv6 address", () => {
    expect(r("fe80::1: unreachable")).toBe(`${IP}: unreachable`);
    expect(r("curl http://[fd00::5]:8080/")).toBe(`curl http://[${IP}]:8080/`);
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
    expect(isPrivateIpv4("172.16.0.0")).toBe(true);
    expect(isPrivateIpv4("172.15.0.0")).toBe(false);
    expect(isPrivateIpv4("100.64.0.0")).toBe(true);
    expect(isPrivateIpv4("100.128.0.0")).toBe(false);
    expect(isPrivateIpv4("1.2.3.4")).toBe(false);
    expect(isPrivateIpv4("10.0.0")).toBe(false);
    expect(isPrivateIpv6("fe80::1")).toBe(true);
    expect(isPrivateIpv6("fdff::1")).toBe(true);
    expect(isPrivateIpv6("fe00::1")).toBe(false);
    expect(isPrivateIpv6("::1")).toBe(false);
    expect(isPrivateIpv6("2001:db8::1")).toBe(false);
  });
});

describe("home paths", () => {
  it("turns a home path into ~ and keeps the layout below it", () => {
    expect(r("read /home/ada/Projects/briefs/task.md first")).toBe("read ~/Projects/briefs/task.md first");
    expect(r("cd /Users/ada.lovelace/dev/app")).toBe("cd ~/dev/app");
    expect(r("the box's own /home/clawbox/Projects/site")).toBe("the box's own ~/Projects/site");
    expect(r("everything under /home/clawbox.")).toBe("everything under ~.");
    expect(r("`/home/ada`")).toBe("`~`");
    expect(r("file:///home/ada/index.html")).toBe("file://~/index.html");
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

  it("leaves prefixed names alone when what follows is code, a count or a reference", () => {
    for (const text of [
      "max_token: 4096",
      "tokens: 5",
      "dbPassword: string",
      "DB_PASSWORD=${DB_PASSWORD}",
      "pwd: /srv/www",
      "password_field: required",
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
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
    expect(r(`key:\n${pem}\ndone`)).toBe(`key:\n${SECRET}\ndone`);
    expect(r("-----BEGIN RSA PRIVATE KEY-----\nMIIEow cut off here")).toBe(SECRET);
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
    "Deploy to 192.168.1.20 from /home/ada/Projects/site,",
    `tell ada@example.com, token ${GHP}, then check ada-desk.local and fd00::7.`,
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
