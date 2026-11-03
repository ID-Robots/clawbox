# Local HTTPS: a trusted https:// address for the box on the home network

Status: box side implemented behind an opt-in switch (TASK-2057); the portal side is specified here and stubbed on the box until it exists. Lands after the 4.3 release.

## The problem

On the home network the owner reaches the box at `http://<LAN IP>` or `http://clawbox.local`. Neither is a [secure context](https://w3c.github.io/webappsec-secure-contexts/), so the browser refuses the APIs a desktop OS needs:

| API | What breaks on plain HTTP |
|---|---|
| `getUserMedia` | voice input in the chat (hold-to-talk) |
| `getDisplayMedia` | the Screenshot app's screen capture |
| `navigator.clipboard` | copy/paste buttons that write or read the clipboard |
| `Notification` | desktop notifications |
| `crypto.subtle` | anything that hashes or signs in the page |

`localhost` is a secure context, so the kiosk on the box itself is fine; the remote tunnel (`*.clawbox.tech`) is HTTPS already. The gap is every other device on the LAN.

A self-signed certificate does not close it: every browser warns, phones make the exception hard or impossible, and the warning teaches owners to click through warnings. What closes it is a **publicly trusted certificate for a public name that resolves to the box's private address** — the scheme Plex uses for `*.plex.direct`.

## What the owner sees

Settings → Network has a **Secure local address** card under the connection status:

1. A sentence on what it is for, and — above the switch, before anything is on — the privacy note: the box's LAN address goes to the ClawBox portal and is published in public DNS under a random name; the name is listed in public certificate logs; switching off removes the DNS record.
2. The switch. Off by default.
3. Once on: the address (`https://k3x9q2m7v4t8p1rz.lan.clawbox.com`), "Getting the certificate…" and then "Certificate valid until …, renewed automatically", whether **this browser** reaches the address, and — when it does not — why, in the owner's language (see [The DNS-rebind fallback](#5-moving-the-browser-and-the-dns-rebind-fallback)).

From then on, opening `http://<LAN IP>` (or `clawbox.local`) on a browser that can reach the secure address moves that browser to it, on the login page, before sign-in. A browser that cannot reach it stays on `http://<LAN IP>`, which keeps working exactly as today.

## At a glance

```
 owner's browser                 box                                   portal (clawbox.com)          Let's Encrypt / DNS
 ───────────────                 ───                                   ────────────────────          ──────────────────
 Settings: switch on  ──POST──▶  state.json enabled
                                 job pass:
                                   LAN IP 192.168.1.20 ──PUT {deviceId, lanIp}──▶ assign <id>.lan.clawbox.com
                                                                                  A <id> → 192.168.1.20 ─────────▶ DNS zone
                                   new P-256 key + CSR ──POST /orders {csr}────▶ ACME order (DNS-01)
                                                                                  TXT _acme-challenge.<id> ─────▶ DNS zone
                                                       ◀──202 pending──────────   …validation…  ◀──────────────▶ LE
                                   poll ───────────────GET /orders/{id}────────▶
                                                       ◀──200 {certificate}────
                                   verify, write tls.json (0600)
 production-server.js :443 ◀──── re-reads, serves it (SNI), hint says "valid"
 http://192.168.1.20/login
   GET /setup-api/local-https/hint ──▶ { url: "https://<id>.lan.clawbox.com" }
   fetch https://<id>…/hint (no-cors) — resolves? TLS trusted?
   yes → location.replace(https://<id>…/login)      no → stay, Settings explains
```

## 1. DNS scheme

- **Zone**: `lan.clawbox.com`, delegated to a DNS provider the portal has an API credential for. The box never holds that credential.
- **Name**: `<label>.lan.clawbox.com`, one label, assigned by the portal and bound to the box's portal identity (`deviceId`, the `dev_<16 hex>` the heartbeat already sends). The label is **opaque and random** (the stub uses 16 base32 characters): not the device id, not the serial, not the account handle or the box's tunnel handle, so the name says nothing about who owns it. It is stable — re-enabling the feature, renewing, or an IP change keep it — so it can be bookmarked.
- **Record**: one `A` record with the box's private IPv4 address, TTL 60 s. Only RFC 1918 addresses are published (`10/8`, `172.16/12`, `192.168/16`), and never the box's own link networks (`10.42.0.0/24`, the setup access point; `10.43.0.0/24`, the cable link) — both the box (`isPrivateLanIpv4`) and the portal check. No `AAAA` in this version: the home network's IPv6 address is a global one, and publishing it is a different privacy decision.
- **IP changes**: the box checks its LAN address every 5 minutes and reports a change at once; it also re-reports an unchanged address once a day so the portal knows the box is alive. The 60 s TTL bounds how long a browser keeps the old answer.

**The Public Suffix List.** `lan.clawbox.com` should be submitted to the [Public Suffix List](https://publicsuffix.org/) (private section) before rollout, for two reasons:

1. *Rate limits.* Let's Encrypt counts certificates per *registered domain*: 50 new certificates per week for `clawbox.com` as a whole. Without a PSL entry the whole fleet shares that, and a renewal wave would starve new boxes. With `lan.clawbox.com` on the PSL, each `<label>.lan.clawbox.com` is its own registered domain. (The alternative is Let's Encrypt's rate-limit adjustment form for large integrators; Plex took the PSL route for `plex.direct`.)
2. *Site isolation.* Without it, `https://<label>.lan.clawbox.com` is *same-site* with `https://clawbox.com`, so the portal's `SameSite=Lax` cookies would ride along on requests a box page makes to the portal, and one box's pages could set cookies for `lan.clawbox.com` that another box's pages receive. The box serves pages the agent writes (sandboxed, but still), so this matters. Until the PSL entry has reached the browsers (months), the portal should use `__Host-` cookies and not rely on `SameSite` alone for CSRF.

A dedicated registrable domain (`clawbox.direct`, in the plex.direct manner) gives the same isolation without waiting for the PSL, at the cost of a second brand; the task asked for a name under `clawbox.com`, so this design uses `lan.clawbox.com`. The box code names the zone in two constants (`LOCAL_HTTPS_ZONE` in `src/lib/local-https-state.ts` and `scripts/local-https.js`) plus the CSP source in `next.config.ts` and the client's URL check in `src/lib/local-https-client.ts`, so changing it is a four-line change.

**Considered and not chosen: the plex.direct encoding.** Plex publishes `*.<hash>.plex.direct` with a wildcard certificate and a resolver that answers `192-168-1-20.<hash>.plex.direct → 192.168.1.20` from the name itself. No DNS update is ever needed, but the URL changes whenever the address does, so nothing can be bookmarked, and it needs a custom authoritative DNS server. The stable name with an `A` record that the box keeps current is simpler to run and is what the owner can keep in a bookmark. If a fallback is ever wanted for boxes that move between networks a lot, the encoded names can be added beside it without touching the box's certificate flow (the certificate would become a wildcard).

## 2. Certificates: issuance and renewal

- **Key**: an ECDSA P-256 key, generated on the box for every order (`generatePrivateKeyPem`). It never leaves the box. Until the order completes it waits in `data/local-https/order-key.pem` (0600).
- **Request**: a PKCS#10 CSR with the hostname as CN and as the only SAN, signed with that key (`buildCsr` in `src/lib/local-https-x509.ts` — DER written with `crypto` alone, because Node cannot build a CSR and the box must not depend on an `openssl` binary or a new package for it; the tests read the bytes back with Node's X509 parser and with `openssl req -verify`).
- **Issuance**: the portal holds the ACME account and the DNS credential. It checks the CSR (below), creates the order at Let's Encrypt, publishes `_acme-challenge.<label>.lan.clawbox.com TXT`, lets the CA validate, removes the record, and finalizes with the box's CSR. The box polls the order.
- **Install**: before anything is written the box checks the certificate against its own key, the hostname and the clock, and refuses a CA certificate (`inspectCertificate`). The key and the chain then go into ONE file, `data/local-https/tls.json` (0600), written temp-file-then-rename, so a renewal swaps the pair in a single step and a reader never sees a new certificate beside an old key.
- **Serving**: `production-server.js` and the Hermes dashboard proxy re-read `tls.json` every 30 s and serve it only while it is *valid* (`scripts/local-https.js`): the box's own name, inside its dates, the key matching, and the chain ending at a root in Node's store. An expired or foreign certificate takes HTTPS down rather than serving something a browser will refuse. A renewal is picked up with `setSecureContext()` — no restart, no dropped connections.
- **Renewal**: when a third of the lifetime is left (30 days of Let's Encrypt's current 90; still right as lifetimes shrink toward 45 days), with a new key. The old certificate is served until the new one is installed. ARI (RFC 9773) can replace the fixed third later; the portal would pass the CA's window through the order answer.
- **Failure handling**: an order the portal has not finished in 15 minutes is abandoned. After a failed order, or a certificate the box refused, the box waits an hour before ordering again (Let's Encrypt allows 5 certificates per week for one exact name); a 429 is honoured to its `Retry-After`; a portal that answers 401/403 is asked again after an hour, one that answers 404/405/501 (no Local HTTPS yet) after six. Switching the feature on in Settings retries at once. A certificate that is still valid keeps being served through all of it.

## 3. Portal API

Base: `https://clawbox.com/api/portal/devices/local-https` (`PORTAL_LOCAL_HTTPS_URL` overrides it; the legacy portal origin is migrated like the heartbeat's). Every call carries `Authorization: Bearer <clawai_token>`, the token the heartbeat uses (`config.json` `clawai_token`, `claw_…`), and the box's `deviceId`. JSON in, JSON out.

### `PUT {base}` — publish or move the address

```json
{ "deviceId": "dev_0123456789abcdef", "lanIp": "192.168.1.20" }
```

`200 { "hostname": "k3x9q2m7v4t8p1rz.lan.clawbox.com", "ip": "192.168.1.20", "ttl": 60 }`

Creates the box's label on first use, sets the `A` record, and is idempotent. The portal MUST check that the device belongs to the token's account, and that `lanIp` is RFC 1918 and not `10.42.0.0/24` or `10.43.0.0/24` (`400 { "error": "invalid_ip" }`). The box refuses a `hostname` that is not exactly one label under the zone.

### `POST {base}/orders` — ask for a certificate

```json
{ "deviceId": "dev_…", "hostname": "k3x9q2m7v4t8p1rz.lan.clawbox.com", "csr": "-----BEGIN CERTIFICATE REQUEST-----\n…" }
```

`202 { "orderId": "ord_…", "status": "pending", "retryAfterSec": 5 }`, or `200 { "orderId": "ord_…", "status": "valid", "certificate": "<PEM leaf + intermediates>" }` when it is already done.

The portal MUST verify the CSR's signature, that its subject and SANs name exactly the box's own hostname and nothing else, and that the key is P-256 or RSA ≥ 2048; otherwise `422 { "error": "csr_names_wrong" | "bad_csr" | … }`. It SHOULD keep its own per-box order budget (for example 3 per day) and answer `429` with `Retry-After` past it.

### `GET {base}/orders/{orderId}?deviceId=…` — poll

`200 { "orderId", "status": "pending", "retryAfterSec" }` · `200 { "orderId", "status": "valid", "certificate" }` · `200 { "orderId", "status": "invalid", "error": "dns-01 challenge failed" }` · `410` for an order the portal no longer knows. The certificate is the full chain the box should serve (leaf first, no root), at most 64 KB.

### `DELETE {base}` — the owner switched it off

```json
{ "deviceId": "dev_…" }
```

`204`. Removes the `A` record. The label stays bound to the device, so switching back on brings back the same name (and bookmarks keep working). Revoking the certificate is optional: the box has already deleted its key. A box that has not reported for 30 days should have its record removed by the portal on its own.

### Status codes the box acts on

| Answer | The box records | And then |
|---|---|---|
| network error, timeout (15 s), 5xx | `portal_error` | next pass (5 min) |
| 401 / 403 | `not_paired` | waits 1 h; the card says to sign in to ClawBox AI |
| 404 / 405 / 501 | `portal_unavailable` | waits 6 h; the card says the portal does not offer it yet |
| 429 | `rate_limited` | waits `Retry-After` (15 min without one) |
| order `invalid`, 400/410/422 on an order | `order_failed` | waits 1 h, then orders with a new key |

### The stub

Until these endpoints exist, `CLAWBOX_LOCAL_HTTPS_PORTAL=stub` (in the box's `.env`) answers the same contract on the box (`createStubPortal`): a label derived from the device id, a CA of the box's own (`data/local-https/stub-ca.json`, 0600, and `stub-ca.pem`), an order that is pending once before it is valid, and the same CSR checks the portal must make. Nothing leaves the box. `state.json` then carries `stubPortal: true`, and only then do the TLS listeners accept a chain ending at the stub CA; browsers never trust it, and the card says "Test mode". It exists so everything after the portal — key, CSR, install, both TLS listeners, the Host allow-list, the hint, renewal and switching off — runs end to end on a real board (`curl --cacert data/local-https/stub-ca.pem --resolve <name>:443:<IP> https://<name>/…`).

## 4. Box side

| Piece | Where |
|---|---|
| State, files, the middleware's synchronous hostname read | `src/lib/local-https-state.ts` |
| The job: one pass (address, certificate, DNS), the queue, the schedule, the switch, the status | `src/lib/local-https.ts`, armed in `src/instrumentation.ts` (first pass 20 s after boot, then every 5 min, sooner while an order is pending) |
| The portal client and the stub | `src/lib/local-https-portal.ts` |
| Key, CSR and the stub's certificates | `src/lib/local-https-x509.ts` |
| What the TLS processes read and serve; the one-port HTTP+TLS front | `scripts/local-https.js` |
| :443 | `production-server.js` (`startHttpsServer`): up while a valid certificate exists, SNI picks the Local HTTPS one for its name and an owner's `data/certs/` pair for any other, down when nothing valid is left; publishes its state to the app in the same process (`src/lib/local-https-listener.ts`) |
| :8090 (Hermes dashboard) | `scripts/hermes-dashboard-proxy.js`: TLS and plain HTTP on the same port (first byte `0x16` → TLS), so the dashboard opens from the HTTPS desktop, whose session cookie is `Secure`; the HTTPS desktop is a trusted referrer; a request without a session goes to the login on its own scheme |
| Host allow-list | rule 8 in `src/lib/host-allowlist.ts` and its CommonJS mirror `scripts/host-allowlist.js` (held together by `host-allowlist-parity.test.ts`), the Hermes proxy's own list, and the gateway proxy's setup redirect: the box's own Local HTTPS name, while the feature is on — that one name, never the zone |
| Routes | `GET/POST /setup-api/local-https` (owner only, POST same-origin) and `GET /setup-api/local-https/hint` (before sign-in, see below) |
| CSP | `connect-src` gains `https://*.lan.clawbox.com` so the probe can leave the page (`next.config.ts`) |
| UI | `src/components/LocalHttpsPanel.tsx` in Settings → Network; `src/components/LocalHttpsRedirect.tsx` in the root layout; strings in `src/lib/local-https-translations.ts`, all ten locales |

Files under `data/local-https/` (directory 0700, every file 0600): `state.json`, `tls.json`, `order-key.pem` while an order is pending, and the stub's `stub-ca.json` / `stub-ca.pem`. The web server is the only writer; it runs as `clawbox` with `CAP_NET_BIND_SERVICE` already, and `scripts/clawbox-firewall.sh` already opens 443 on the LAN — nothing in `install.sh` or a root step changes.

A pass never throws: what went wrong is the state's `problem`, which the card words. Passes run one at a time; a pass that was running when the owner flipped the switch writes nothing (an epoch on the process-wide job slot), so a slow "on" cannot undo an "off".

## 5. Moving the browser, and the DNS-rebind fallback

**Why the browser decides, not a server redirect.** Whether `<label>.lan.clawbox.com` resolves is decided by the resolver *the browser* uses. Many routers — dnsmasq with `stop-dns-rebind` (OpenWrt's default), FRITZ!Box, pfSense/OPNsense, Unbound with `private-address` — drop a public name that answers with a private address, to stop DNS-rebinding attacks. A `301` from `http://<IP>` to the secure name would strand the owner of such a router on a DNS error page, with no way back to the address that works. So:

1. `GET /setup-api/local-https/hint` answers `{ url }` only while the certificate is valid **and** :443 is serving it (the listener's own word), the feature is on, and the request came over the LAN — never through the tunnel, never on loopback (the kiosk's `localhost` is already a secure context), never on the secure name itself. It is readable before sign-in (`PRE_AUTH_API_PATHS`): the move should happen on the login page, because a session is per origin and moving after sign-in would mean signing in twice. It names nothing secret — the hostname is in the public CT logs from the day it is issued.
2. The page (`LocalHttpsRedirect`, top-level windows only) fetches `https://<name>/setup-api/local-https/hint` with `mode: "no-cors"`. A DNS failure, a refused connection or a certificate the browser does not trust all reject that fetch; 3.5 s is the limit.
3. Only when it answered does the page `location.replace()` to the same path on the secure address. A failed probe is remembered for the tab (`sessionStorage`), so the owner is not probed on every navigation.

The owner signs in once more on the new origin — cookies do not cross origins — after which the browser stays there.

**What the owner is told.** The box asks two resolvers for its name every 6 hours and after every change: the system one (normally the router — what the owner's browsers ask) and a public one (1.1.1.1, 8.8.8.8):

| Router | Public DNS | Verdict | Card |
|---|---|---|---|
| this box's IP | — | `ok` | nothing to say |
| nothing | this box's IP | `rebind_blocked` | the router blocks the name; `http://<IP>` keeps working; how to allow `lan.clawbox.com` on OpenWrt/dnsmasq (`rebind-domain-ok=/lan.clawbox.com/`), FRITZ!Box (DNS rebind protection exceptions) and pfSense/OPNsense (private domains) |
| another IP | this box's IP | `stale` | DNS still has an older address; minutes |
| nothing | nothing | `pending` | not published yet; minutes |
| — | unreachable | `unknown` | nothing |

The card also runs the same probe as the redirect, so it can say "This browser reaches the secure address" or "This browser cannot reach the secure address. http://<IP> keeps working" — the box's own resolver cannot speak for a phone on mobile data's DNS.

## 6. Privacy and security

What leaves the box, and only while the owner has the switch on:

| Data | To whom | Why |
|---|---|---|
| the LAN IPv4 address | the portal, and through it **public DNS** | the name must resolve to it |
| `deviceId` (already sent by the heartbeat) | the portal | to bind the name to the box |
| a CSR (public key + hostname) | the portal, Let's Encrypt | to issue the certificate |
| the hostname | **public Certificate Transparency logs**, forever | every publicly trusted certificate is logged |

What follows from that, and is said in the card before the switch: anyone who learns the name can resolve it and learn a private address (low value — it is the same `192.168.x.y` thousands of homes use — but a disclosure); the CT logs show that a ClawBox exists under that random name and when its certificates were issued, not who owns it or where. Switching off deletes the key and certificate on the box at once, stops serving the name, and asks the portal to remove the DNS record (retried until it answers); CT entries cannot be removed by anyone. The portal knows account ↔ device ↔ LAN address; it should keep only the current address, not a history.

Security notes:

- The private key is generated on the box and stays there (0600); the portal and the CA see only the public key. The DNS credential never reaches a box, so a compromised box can neither publish other names nor obtain certificates for them — the portal issues only for the box's own label.
- The box answers to its own Local HTTPS name only while the feature is on (rule 8 of the Host allow-list): another box's name in the same zone is still a foreign name, exactly as with the tunnel's `*.clawbox.tech`. DNS-rebinding protection on the box is unchanged.
- The switch is the owner's alone: a person session that is the owner's, on the box's own origin. Neither another ClawBox user nor the MCP bearer (the assistant) can flip it, because it is a disclosure only the owner can consent to.
- See [the Public Suffix List](#1-dns-scheme) for why the zone must be isolated from `clawbox.com`'s cookies.

## 7. Rollout

1. **This PR** (draft until after 4.3): the box side, off by default. With the real portal not answering yet, switching it on shows "The ClawBox portal does not offer secure local addresses yet" and asks again every six hours; nothing else changes for anyone. Before it leaves draft, decide whether release builds hide the card until the portal advertises the feature (a `localHttps: true` in the heartbeat answer would do).
2. **Portal**: the `lan.clawbox.com` zone and its API credential, the ACME account (staging first), the four endpoints above with their checks and per-box budget, the 30-day cleanup, and the PSL submission (start early: it takes weeks to merge and months to reach browsers).
3. **Beta channel**: the portal proves its ACME flow against Let's Encrypt's staging directory first. Staging certificates do not chain to a trusted root, so a box refuses to serve them — by design, the same check that keeps a broken chain off :443 — which makes staging a portal-side test; boxes on beta then get production certificates.
4. **Release**: the card on by default in Settings, the feature itself still opt-in.

Testing:

- Unit and integration tests (vitest): the DER (read back by Node and openssl), the CommonJS validator and listener refresh, the one-port HTTP+TLS front (bodies, keep-alive, WebSockets), the job's whole cycle against a fake portal and against the stub, every portal status, the epoch race, the Host allow-list parity, both routes, the client's probe rules, the Hermes proxy over TLS, the Settings card, and `production-server.js` started for real (listener up, renewed, down, back).
- On a lab board, in stub mode, on the OpenClaw and the Hermes edition: the switch, the certificate, :443 and :8090 over TLS with `--cacert` the stub CA, the hint, switching off.
- Not testable before the portal exists: a real Let's Encrypt chain, real DNS, and a real router's rebind protection.

Known limits, for later:

- IPv6-only networks get nothing (no `AAAA`).
- A box on several LANs publishes the address of its default-route interface only.
- An app server the agent starts on another port is opened as `http://<host>:<port>` in a desktop frame; on the HTTPS desktop the browser blocks that as mixed content. The Hermes dashboard is handled (TLS on :8090); app servers on other ports are not yet.
- Chrome's Local Network Access prompts do not apply (the page and the box are both on the local network), but that is worth re-checking as the rules settle.
