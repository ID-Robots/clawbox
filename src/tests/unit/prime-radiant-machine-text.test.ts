/**
 * The machine-text heuristic on real-looking samples: logs, table exports,
 * encoded blobs and settings dumps are left out; a person's notes — with a
 * pasted log in a fence, a table, a recipe, a chat export, dated journal
 * entries — are kept, and so is anything too short to judge.
 */
import { describe, expect, it } from "vitest";
import { MACHINE_TEXT_SAMPLE_CHARS, MIN_LINES, isMachineText, judgeMachineText } from "@/lib/prime-radiant/machine-text";

const lines = (...l: string[]) => l.join("\n");

const MACHINE: Record<string, { text: string; kind: string }> = {
  "an application log with ISO timestamps and levels": {
    kind: "log",
    text: lines(
      "2026-10-14 08:12:01,233 INFO  [main] server.App - Starting App v2.3.1 on clawbox with PID 4121",
      "2026-10-14 08:12:01,410 DEBUG [main] config.Loader - Loaded 14 properties from /etc/app/app.properties",
      "2026-10-14 08:12:02,007 INFO  [main] db.Pool - HikariPool-1 - Start completed.",
      "2026-10-14 08:12:02,118 WARN  [main] cache.Redis - Connection refused, retrying in 2s",
      "2026-10-14 08:12:04,131 INFO  [main] cache.Redis - Connected to redis://127.0.0.1:6379",
      "2026-10-14 08:12:04,502 INFO  [http-nio-8080-exec-1] web.Dispatcher - Initializing Servlet 'dispatcherServlet'",
      "2026-10-14 08:12:04,510 INFO  [http-nio-8080-exec-1] web.Dispatcher - Completed initialization in 8 ms",
      "2026-10-14 08:15:44,902 ERROR [worker-3] jobs.Sync - Sync failed: java.net.SocketTimeoutException: Read timed out",
    ),
  },
  "a syslog excerpt": {
    kind: "log",
    text: lines(
      "Oct 14 07:58:12 clawbox systemd[1]: Started Daily apt download activities.",
      "Oct 14 07:58:13 clawbox kernel: [12345.678901] usb 1-1: new high-speed USB device number 4 using xhci_hcd",
      "Oct 14 07:58:14 clawbox NetworkManager[812]: <info>  [1728892694.1234] device (wlan0): state change: activated",
      "Oct 14 07:59:01 clawbox CRON[20211]: (root) CMD (command -v debian-sa1 > /dev/null && debian-sa1 1 1)",
      "Oct 14 08:00:02 clawbox sshd[20233]: Accepted publickey for clawbox from 192.0.2.20 port 51522 ssh2",
      "Oct 14 08:00:02 clawbox sshd[20233]: pam_unix(sshd:session): session opened for user clawbox(uid=1000)",
      "Oct 14 08:01:17 clawbox systemd[1]: apt-daily.service: Deactivated successfully.",
    ),
  },
  "an access log": {
    kind: "log",
    text: Array.from({ length: 10 }, (_, i) =>
      `192.0.2.${10 + i} - - [14/Oct/2026:08:1${i}:02 +0000] "GET /api/items?page=${i} HTTP/1.1" 200 ${512 + i} "-" "Mozilla/5.0"`,
    ).join("\n"),
  },
  "a CSV export saved as .txt": {
    kind: "table",
    text: lines(
      "date,account,description,amount,currency",
      "2026-09-01,4021,Office rent,-1200.00,EUR",
      "2026-09-03,4021,Electricity,-84.20,EUR",
      "2026-09-05,1001,Invoice 2026-118,3400.00,EUR",
      "2026-09-08,4100,Software licences,-149.00,EUR",
      "2026-09-12,1001,Invoice 2026-121,980.00,EUR",
      "2026-09-15,4300,Travel,-312.45,EUR",
    ),
  },
  "a tab-separated sheet": {
    kind: "table",
    text: Array.from({ length: 9 }, (_, i) => `SKU-${100 + i}\tWidget ${i}\t${i * 4}\t${(i * 1.5).toFixed(2)}`).join("\n"),
  },
  "columns of numbers": {
    kind: "table",
    text: Array.from({ length: 12 }, (_, i) => `${i}   ${(i * 0.37).toFixed(3)}   ${(i * i * 1.1).toFixed(2)}   ${-i * 4}`).join("\n"),
  },
  "a base64 blob": {
    kind: "encoded",
    text: Array.from({ length: 10 }, (_, i) => `TWFueSBoYW5kcyBtYWtlIGxpZ2h0IHdvcmsu${i}QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODkw`).join("\n"),
  },
  "a hex dump": {
    kind: "encoded",
    text: Array.from({ length: 8 }, (_, i) =>
      `${(i * 16).toString(16).padStart(8, "0")}: 4865 6c6c 6f2c 2077 6f72 6c64 210a 0000  Hello, world!...`,
    ).join("\n"),
  },
  "a settings dump": {
    kind: "keyvalue",
    text: lines(
      "[database]",
      "host=127.0.0.1",
      "port=5432",
      "user=acme_app",
      "pool_size = 20",
      "",
      "[cache]",
      "ttl_seconds=600",
      "backend=redis",
      "export PATH=/usr/local/bin:/usr/bin",
    ),
  },
  "JSON lines": {
    kind: "keyvalue",
    text: Array.from({ length: 8 }, (_, i) => `{"ts":"2026-10-14","event":"click","id":${i},"ok":true}`).join("\n"),
  },
};

const PROSE: Record<string, string> = {
  "a personal note": lines(
    "Things to sort out before the move",
    "",
    "The landlord wants the keys back by the end of November, so the van has to be booked for the 28th.",
    "Ask Maria whether she still wants the bookshelf; otherwise it goes to the charity shop on Elm Street.",
    "Transfer the internet contract to the new flat and cancel the gym membership near the old one.",
    "Remember that the cat needs a vet appointment before the long drive.",
    "Pack the winter clothes last because the weather is turning cold already.",
  ),
  "a markdown document with headings, a list and a pasted log in a fence": lines(
    "# Why the backup failed",
    "",
    "The nightly backup stopped writing to the NAS last Tuesday. Here is what the log said:",
    "",
    "```",
    "2026-10-08 03:00:01 ERROR rsync: connection unexpectedly closed (0 bytes received so far)",
    "2026-10-08 03:00:01 ERROR rsync error: error in rsync protocol data stream (code 12)",
    "2026-10-08 03:00:02 INFO retrying in 60 seconds",
    "2026-10-08 03:01:02 ERROR rsync: connection unexpectedly closed (0 bytes received so far)",
    "2026-10-08 03:01:02 ERROR giving up after 2 attempts",
    "```",
    "",
    "- The NAS had rebooted for an update and came back with a new IP address.",
    "- I pinned the address in the router so it cannot happen again.",
  ),
  "a recipe": lines(
    "Grandma's apple cake",
    "",
    "200 g flour",
    "150 g sugar",
    "3 eggs",
    "4 apples, peeled and sliced",
    "Mix the flour, sugar and eggs until the batter is smooth and pale.",
    "Fold in the apples and bake at 180 degrees for about forty minutes.",
  ),
  "a chat export": lines(
    "[14/10/2026, 21:15:42] Ana: Are we still on for dinner on Friday?",
    "[14/10/2026, 21:16:03] Ben: Yes! The new place near the river",
    "[14/10/2026, 21:16:10] Ana: ok",
    "[14/10/2026, 21:16:12] Ana: should I book a table for four?",
    "[14/10/2026, 21:17:55] Ben: please, and tell Chris to bring the photos from the trip",
    "[14/10/2026, 21:18:01] Ana: 👍",
    "[14/10/2026, 21:18:30] Ben: see you then",
  ),
  "a markdown table inside notes": lines(
    "# Budget for the garden",
    "",
    "| Item | Cost |",
    "|------|------|",
    "| Soil | 40 |",
    "| Seeds | 12 |",
    "| Fence | 230 |",
    "",
    "The fence is the big one, so we should get two more quotes before deciding anything.",
    "Paul said his brother can help with the digging if we buy him lunch.",
  ),
  "dated journal entries": lines(
    "2026-10-01 Started the new job today and met most of the team over coffee.",
    "2026-10-02 Long day of onboarding; the laptop finally arrived in the afternoon.",
    "2026-10-03 First real task: cleaning up the old customer list with Priya.",
    "2026-10-06 Weekend hike to the lake was cold but the views were worth it.",
    "2026-10-07 Presented the cleanup plan and it went better than I expected.",
    "2026-10-08 Booked flights for the conference in Lisbon next month.",
  ),
  "a list of contacts with commas in the prose": lines(
    "People to invite to the party, roughly in the order I thought of them:",
    "Maria, who organised the last one and knows everybody in the building.",
    "Tom and Lisa, if they are back from their trip by then, otherwise next time.",
    "The neighbours downstairs, since the music will reach them anyway, and they are nice.",
    "My cousin Pete, who promised to bring his guitar, his speakers, and his famous chili.",
    "Someone from work, maybe Anna, maybe Carl, depending on who is around that weekend.",
  ),
};

describe("judgeMachineText", () => {
  for (const [name, sample] of Object.entries(MACHINE)) {
    it(`leaves out ${name}`, () => {
      const v = judgeMachineText(sample.text);
      expect(v.machine, JSON.stringify(v)).toBe(true);
      expect(v.kind).toBe(sample.kind);
      expect(isMachineText(sample.text)).toBe(true);
    });
  }

  for (const [name, text] of Object.entries(PROSE)) {
    it(`keeps ${name}`, () => {
      const v = judgeMachineText(text);
      expect(v.machine, JSON.stringify(v)).toBe(false);
    });
  }

  it("keeps a file too short to judge, however machine-like", () => {
    const short = Array.from({ length: MIN_LINES - 1 }, (_, i) => `2026-10-14 08:00:0${i} ERROR boom`).join("\n");
    expect(judgeMachineText(short)).toMatchObject({ machine: false, lines: MIN_LINES - 1 });
    expect(isMachineText("")).toBe(false);
  });

  it("looks at the opening only: a log after a long letter is the letter's", () => {
    const letter = "Dear Sam, thank you for the lovely flowers you sent after the concert last week.\n".repeat(120);
    const log = "2026-10-14 08:00:01 ERROR something failed in the worker pool\n".repeat(500);
    expect(letter.length).toBeGreaterThan(MACHINE_TEXT_SAMPLE_CHARS);
    expect(isMachineText(letter + log)).toBe(false);
    expect(isMachineText(log + letter)).toBe(true);
  });

  it("reads a UTF-16 file decoded as UTF-8 by its letters, and ignores markdown front matter", () => {
    const note = PROSE["a personal note"];
    const utf16ish = Buffer.from(note, "utf16le").toString("utf8");
    expect(isMachineText(utf16ish)).toBe(false);
    const withFrontMatter = `---\ntitle: Moving\ntags: [home, todo]\ndate: 2026-10-14\nstatus: draft\nowner: me\n---\n${note}`;
    expect(isMachineText(withFrontMatter)).toBe(false);
  });

  it("does not take a decimal at the start of a line or a phone number for a timestamp", () => {
    const text = lines(
      "3.5 cups of flour",
      "0888123456 Ana",
      "1.25 litres of milk",
      "0899765432 Ben",
      "2.0 teaspoons of salt",
      "0877000111 the plumber",
    );
    expect(judgeMachineText(text).kind).not.toBe("log");
    expect(isMachineText(text)).toBe(false);
  });
});

// The live import over a home folder: one sample of each kind it met. Three
// got through — a server log whose messages read like prose, a one-line
// base64 blob, a TSV dump whose empty last columns were trimmed away.
describe("the integration test's machine text", () => {
  /** Deterministic base64 of `n` pseudo-random bytes. */
  const base64 = (n: number) => {
    let seed = 42;
    return Buffer.from(Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) % 2147483648) & 0xff)).toString("base64");
  };

  const SAMPLES: Record<string, { text: string; kind: string }> = {
    "a CSV export": {
      kind: "table",
      text: lines(
        "id,name,email,created_at,plan,mrr",
        '1,"Smith, John",john@example.com,2026-01-02 10:00:00,pro,49.00',
        '2,"Doe, Jane",jane@example.com,2026-01-03 11:00:00,free,0.00',
        '3,"Brown, Bob",bob@example.com,2026-01-04 12:00:00,team,199.00',
        '4,"White, Ann",ann@example.com,2026-01-05 13:00:00,pro,49.00',
        '5,"Green, Tom",tom@example.com,2026-01-06 14:00:00,free,0.00',
      ),
    },
    "a TSV dump in .md whose last columns are often empty": {
      kind: "table",
      text: `# Export\n\n${Array.from({ length: 10 }, (_, i) => `row${i}\tvalue ${i}\t${i % 2 ? "" : "x"}\t${i % 3 ? "" : "y"}`).join("\n")}\n`,
    },
    "a base64 blob on one line": { kind: "encoded", text: base64(6_000) },
    "a data URI under a line naming it": { kind: "encoded", text: `Attachment: photo.png\n\ndata:image/png;base64,${base64(3_000)}` },
    "a wrapped base64 blob": { kind: "encoded", text: base64(3_000).match(/.{1,76}/g)!.join("\n") },
    "an env key=value dump": {
      kind: "keyvalue",
      text: lines("SHELL=/bin/bash", "HOME=/home/user", "LANG=en_US.UTF-8", "PATH=/usr/local/bin:/usr/bin:/bin", "XDG_SESSION_TYPE=wayland", "DISPLAY=:0", "TERM=xterm-256color"),
    },
    "a hexdump -C": {
      kind: "encoded",
      text: Array.from({ length: 10 }, (_, i) => `${(i * 16).toString(16).padStart(8, "0")}  48 65 6c 6c 6f 2c 20 77  6f 72 6c 64 21 0a 00 00  |Hello, world!...|`).join("\n"),
    },
    "a server log whose messages read like prose": {
      kind: "log",
      text: lines(
        "2026-10-14T08:12:01.233Z Server listening on port 3000",
        "2026-10-14T08:12:01.410Z Connected to the database at localhost",
        "2026-10-14T08:12:02.007Z Loaded 14 routes from the routes folder",
        "2026-10-14T08:12:04.131Z Cache warmed up with 230 entries in memory",
        "2026-10-14T08:15:44.902Z Request from the dashboard took a long time",
        "2026-10-14T08:16:02.118Z Scheduled the nightly backup for three in the morning",
      ),
    },
    "a bracketed date-time log": {
      kind: "log",
      text: Array.from({ length: 8 }, (_, i) => `[2026-10-14 08:1${i}:01] Handling the request for the user profile page number ${i}`).join("\n"),
    },
    "an Apache error log": {
      kind: "log",
      text: Array.from({ length: 6 }, (_, i) =>
        `[Wed Oct 14 08:1${i}:01.233456 2026] [core:error] [pid 41${i}] [client 192.0.2.10:51522] AH00124: Request exceeded the limit of internal redirects due to a configuration error.`,
      ).join("\n"),
    },
    "docker compose logs": {
      kind: "log",
      text: Array.from({ length: 8 }, (_, i) => `web-1  | 2026-10-14T08:1${i}:01.000Z GET /health answered in good time for the probe`).join("\n"),
    },
  };

  const KEPT: Record<string, string> = {
    "an RFC": lines(
      "Network Working Group                                          J. Postel",
      "Request for Comments: 791                                            ISI",
      "                                                           September 1981",
      "",
      "                           INTERNET PROTOCOL",
      "",
      "1.  INTRODUCTION",
      "",
      "  The Internet Protocol is designed for use in interconnected systems of",
      "  packet-switched computer communication networks.  Such a system has",
      '  been called a "catenet".  The internet protocol provides for',
      "  transmitting blocks of data called datagrams from sources to",
      "  destinations, where sources and destinations are hosts identified by",
      "  fixed length addresses.",
    ),
    "a Project Gutenberg book": lines(
      "The Project Gutenberg eBook of The Art of War",
      "",
      "This ebook is for the use of anyone anywhere in the United States and",
      "most other parts of the world at no cost and with almost no restrictions",
      "whatsoever. You may copy it, give it away or re-use it under the terms",
      "of the Project Gutenberg License included with this ebook or online",
      "at www.gutenberg.org.",
      "",
      "Title: The Art of War",
      "Author: Sun Tzu",
      "Release date: May 1, 1994 [eBook #132]",
    ),
    "a Wikipedia article in markdown": lines(
      "# Black hole",
      "",
      "A **black hole** is a region of [spacetime](spacetime) wherein gravity is so strong that nothing can escape it.",
      "",
      "| Property | Value |",
      "|---|---|",
      "| Type | Astronomical object |",
      "",
      "The boundary of no escape is called the event horizon. It has a great effect on an object crossing it.",
      "General relativity predicts that a sufficiently compact mass can deform spacetime to form a black hole.",
    ),
    "a transcript with elapsed times": lines(
      "00:00:01 Welcome back to the show, today we talk about gardening in the city.",
      "00:00:09 My guest has grown tomatoes on a balcony for more than ten years.",
      "00:00:17 We start with the soil, because that is where most people go wrong.",
      "00:00:25 Then the watering, which matters more than any fertiliser you can buy.",
      "00:00:34 And at the end a few words about the pests that like balconies too.",
      "00:00:41 So let us begin with the question everybody asks me first.",
    ),
    "a journal stamped to the minute": lines(
      "2026-10-01T08:30 Started the new job today and met most of the team over coffee.",
      "2026-10-02T09:15 Long day of onboarding; the laptop finally arrived in the afternoon.",
      "2026-10-03T08:45 First real task: cleaning up the old customer list with Priya.",
      "2026-10-06T07:50 Weekend hike to the lake was cold but the views were worth it.",
      "2026-10-07T18:20 Presented the cleanup plan and it went better than I expected.",
      "2026-10-08T21:05 Booked flights for the conference in Lisbon next month.",
    ),
    "a short note with an inline picture": `Photo of the whiteboard after the planning meeting with the whole team.\n\n![board](data:image/png;base64,${base64(3_000)})\n`,
  };

  for (const [name, sample] of Object.entries(SAMPLES)) {
    it(`leaves out ${name}`, () => {
      const v = judgeMachineText(sample.text);
      expect(v.machine, JSON.stringify(v)).toBe(true);
      expect(v.kind).toBe(sample.kind);
    });
  }

  for (const [name, text] of Object.entries(KEPT)) {
    it(`keeps ${name}`, () => {
      const v = judgeMachineText(text);
      expect(v.machine, JSON.stringify(v)).toBe(false);
    });
  }

  it("still keeps a short line of base64 too small to be a blob", () => {
    expect(isMachineText(base64(300))).toBe(false);
  });
});
