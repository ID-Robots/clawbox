// scripts/local-https.js
//
// Local HTTPS (docs/design/local-https.md) for the processes that terminate
// TLS: production-server.js on :443 and the Hermes dashboard proxy on :8090.
// CommonJS because both are plain node entry points, like scripts/host-allowlist.js.
//
// The Next app (src/lib/local-https.ts) is the only WRITER of data/local-https/:
//   state.json   { enabled, hostname, … } — the owner's switch and the portal's
//                answer. Only `enabled` and `hostname` are read here.
//   tls.json     { hostname, key, cert } 0600 — the private key and the chain
//                the portal issued for it, in ONE file so a renewal swaps the
//                pair in a single rename and no reader ever sees a new
//                certificate beside an old key.
//   stub-ca.pem  the stub portal's CA, trusted only while state.json says the
//                certificate came from the stub (`stubPortal: true`) — the
//                switch lives in the file, not the environment, because the
//                Hermes dashboard proxy does not share the web server's env.
//
// Nothing here trusts those files: a pair is served only while it is VALID —
// the box's own hostname, inside its validity window, the key matching the
// leaf, and the chain ending at a root in Node's store (or at the stub CA, and
// only in stub mode). That check is a guard against serving something broken,
// not a boundary: whoever can write data/ can install data/certs/ anyway. An expired or foreign certificate takes HTTPS down rather
// than serving something a browser will refuse.

/* eslint-disable @typescript-eslint/no-require-imports */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const tls = require("tls");

/** The zone every box hostname lives in: exactly one label under it. */
const LOCAL_HTTPS_ZONE = "lan.clawbox.com";
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LISTENER_KEY = Symbol.for("clawbox.local-https.listener");

function localHttpsDir(root) {
  return path.join(root || process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox", "data", "local-https");
}

function localHttpsPaths(root) {
  const dir = localHttpsDir(root);
  return {
    dir,
    state: path.join(dir, "state.json"),
    tls: path.join(dir, "tls.json"),
    stubCa: path.join(dir, "stub-ca.pem"),
  };
}

function isLocalHttpsHostname(value) {
  if (typeof value !== "string") return false;
  const suffix = `.${LOCAL_HTTPS_ZONE}`;
  return value.endsWith(suffix) && LABEL_RE.test(value.slice(0, -suffix.length));
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf-8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The box's Local HTTPS hostname while the owner has it switched on, else
 * null. Mirrors readLocalHttpsHostnameSync() in src/lib/local-https-state.ts;
 * src/tests/unit/host-allowlist-parity.test.ts runs both.
 */
function localHttpsHostname(root) {
  return enabledState(root).hostname;
}

function enabledState(root) {
  const state = readJson(localHttpsPaths(root).state);
  if (!state || state.enabled !== true || !isLocalHttpsHostname(state.hostname)) return { hostname: null, stubPortal: false };
  return { hostname: state.hostname, stubPortal: state.stubPortal === true };
}

function splitPemCertificates(pem) {
  return String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
}

let storeRoots = null;
function nodeRootStore() {
  if (!storeRoots) {
    storeRoots = [];
    for (const pem of tls.rootCertificates) {
      try {
        storeRoots.push(new crypto.X509Certificate(pem));
      } catch {
        // A root Node ships but OpenSSL will not parse is no root of ours.
      }
    }
  }
  return storeRoots;
}

function signedBy(cert, issuer) {
  try {
    return Boolean(cert.checkIssued(issuer)) && cert.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

/** Every link signs the one before it, and the last is, or is signed by, a trusted root. */
function chainIsTrusted(certs, roots) {
  for (let i = 0; i + 1 < certs.length; i++) {
    if (!signedBy(certs[i], certs[i + 1])) return false;
  }
  const last = certs[certs.length - 1];
  return roots.some((root) => root.fingerprint256 === last.fingerprint256 || signedBy(last, root));
}

/**
 * Judge one key + chain for `hostname` at `now`. `{ ok: true, … }` with the
 * dates and fingerprint, or `{ ok: false, reason }`. Never throws.
 */
function validateMaterial(material, opts) {
  const { hostname, key, cert } = material || {};
  if (!isLocalHttpsHostname(hostname)) return { ok: false, reason: "bad_hostname" };
  if (typeof key !== "string" || typeof cert !== "string") return { ok: false, reason: "no_certificate" };
  let certs;
  let privateKey;
  try {
    certs = splitPemCertificates(cert).map((pem) => new crypto.X509Certificate(pem));
    privateKey = crypto.createPrivateKey(key);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (!certs.length) return { ok: false, reason: "unreadable" };
  const leaf = certs[0];
  if (leaf.ca) return { ok: false, reason: "not_a_server_certificate" };
  if (leaf.checkHost(hostname) !== hostname) return { ok: false, reason: "wrong_hostname" };
  const notBefore = Date.parse(leaf.validFrom);
  const notAfter = Date.parse(leaf.validTo);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) return { ok: false, reason: "unreadable" };
  if (opts.now < notBefore) return { ok: false, reason: "not_yet_valid" };
  if (opts.now >= notAfter) return { ok: false, reason: "expired" };
  if (!leaf.checkPrivateKey(privateKey)) return { ok: false, reason: "key_mismatch" };
  if (!chainIsTrusted(certs, opts.roots)) return { ok: false, reason: "untrusted" };
  return { ok: true, hostname, notBefore, notAfter, fingerprint256: leaf.fingerprint256 };
}

function trustedRoots(root, stubPortal) {
  if (!stubPortal) return nodeRootStore();
  const extra = [];
  try {
    for (const pem of splitPemCertificates(fs.readFileSync(localHttpsPaths(root).stubCa, "utf-8"))) {
      extra.push(new crypto.X509Certificate(pem));
    }
  } catch {
    // No stub CA yet: nothing extra to trust.
  }
  return [...nodeRootStore(), ...extra];
}

/**
 * The pair to serve for the box's hostname, judged now: `{ ok: true, hostname,
 * key, cert, notBefore, notAfter, fingerprint256 }` or `{ ok: false, reason }`
 * — `off` while the owner has the feature switched off.
 */
function loadLocalHttpsMaterial(opts) {
  const root = opts && opts.root;
  const now = opts && typeof opts.now === "number" ? opts.now : Date.now();
  const { hostname, stubPortal } = enabledState(root);
  if (!hostname) return { ok: false, reason: "off" };
  const stored = readJson(localHttpsPaths(root).tls);
  if (!stored) return { ok: false, reason: "no_certificate" };
  if (stored.hostname !== hostname) return { ok: false, reason: "wrong_hostname" };
  const verdict = validateMaterial(stored, { now, roots: trustedRoots(root, stubPortal) });
  return verdict.ok ? { ...verdict, key: stored.key, cert: stored.cert } : verdict;
}

function fileSignature(file) {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "-";
  }
}

/**
 * The certificates a TLS listener serves, re-read when their files change and
 * dropped the moment the Local HTTPS one expires.
 *
 *   local   the Local HTTPS pair, for its hostname (SNI) and as the default.
 *   legacy  an owner-installed data/certs/{cert,key}.pem pair, served as it
 *           always was (no validation: the owner put it there).
 *
 * `refresh()` answers whether what is served changed; `defaultOptions()` is the
 * pair for a client that sends no SNI (an IP literal): the owner's pair when
 * there is one — a Local HTTPS certificate can never match an IP, and an
 * owner who installed a certificate for `https://<LAN IP>` keeps it working —
 * else the Local HTTPS one. A client naming the Local HTTPS host by SNI always
 * gets that certificate.
 */
function createLocalHttpsTls(opts) {
  const root = opts && opts.root;
  const legacyDir = opts && opts.legacyCertDir;
  const clock = (opts && opts.now) || Date.now;
  const log = (opts && opts.log) || console;
  const paths = localHttpsPaths(root);
  const legacyCert = legacyDir ? path.join(legacyDir, "cert.pem") : null;
  const legacyKey = legacyDir ? path.join(legacyDir, "key.pem") : null;

  let signature = null;
  let local = null;
  let legacy = null;
  let lastReason = null;

  function readLegacy() {
    if (!legacyCert || !fs.existsSync(legacyCert) || !fs.existsSync(legacyKey)) return null;
    try {
      const pair = { key: fs.readFileSync(legacyKey), cert: fs.readFileSync(legacyCert) };
      // The files' identity, so a pair the owner REPLACES counts as a change.
      const signature = `${fileSignature(legacyCert)}/${fileSignature(legacyKey)}`;
      return { ...pair, signature, context: tls.createSecureContext(pair) };
    } catch (err) {
      log.warn("[local-https] the certificate in data/certs/ could not be loaded:", err && err.message);
      return null;
    }
  }

  function refresh() {
    const now = clock();
    const sig = [paths.state, paths.tls, paths.stubCa, legacyCert, legacyKey]
      .map((f) => (f ? fileSignature(f) : "-"))
      .join("|");
    const expired = local !== null && now >= local.notAfter;
    if (sig === signature && !expired) return false;
    signature = sig;

    const before = `${local ? local.fingerprint256 : "-"}|${legacy ? legacy.signature : "-"}`;
    const material = loadLocalHttpsMaterial({ root, now });
    if (material.ok) {
      local = {
        hostname: material.hostname,
        notBefore: material.notBefore,
        notAfter: material.notAfter,
        fingerprint256: material.fingerprint256,
        key: material.key,
        cert: material.cert,
        context: tls.createSecureContext({ key: material.key, cert: material.cert }),
      };
      lastReason = null;
    } else {
      local = null;
      if (material.reason !== lastReason && material.reason !== "off" && material.reason !== "no_certificate") {
        log.warn(`[local-https] not serving the Local HTTPS certificate: ${material.reason}`);
      }
      lastReason = material.reason;
    }
    legacy = readLegacy();
    return before !== `${local ? local.fingerprint256 : "-"}|${legacy ? legacy.signature : "-"}`;
  }

  function defaultOptions() {
    if (legacy) return { key: legacy.key, cert: legacy.cert };
    if (local) return { key: local.key, cert: local.cert };
    return null;
  }

  function sniCallback(servername, cb) {
    const name = String(servername || "").toLowerCase().replace(/\.$/, "");
    if (local && name === local.hostname) return cb(null, local.context);
    if (legacy) return cb(null, legacy.context);
    if (local) return cb(null, local.context);
    return cb(new Error("no certificate to serve"));
  }

  /** What is served for the Local HTTPS hostname, or null. */
  function status() {
    return local
      ? { hostname: local.hostname, notBefore: local.notBefore, notAfter: local.notAfter, fingerprint256: local.fingerprint256 }
      : null;
  }

  return { refresh, defaultOptions, sniCallback, status };
}

/**
 * Publish the running listener to the Next app in this same process
 * (src/lib/local-https-listener.ts reads it): whether :443 serves the Local
 * HTTPS certificate right now, and a way to make it re-read the files at once
 * after the app wrote them.
 */
function publishListener(listener) {
  globalThis[LISTENER_KEY] = listener;
}

/**
 * One port, both protocols: a connection whose first byte opens a TLS
 * handshake (0x16) goes to `httpsServer`, anything else to `httpServer`.
 * For the Hermes dashboard proxy, whose :8090 must keep answering plain HTTP
 * on the box's IP while the desktop on the HTTPS address opens it over TLS.
 * `getHttpsServer()` is read per connection, so TLS can come and go.
 */
function createDualProtocolServer(httpServer, getHttpsServer, opts) {
  const net = require("net");
  // Until the first byte, no server owns the socket and none of Node's own
  // header timeouts run: a client that connects and says nothing is closed
  // here instead of being held forever.
  const firstByteMs = (opts && opts.firstByteTimeoutMs) || 10_000;
  return net.createServer((socket) => {
    socket.once("error", () => socket.destroy());
    socket.setTimeout(firstByteMs, () => socket.destroy());
    socket.once("readable", () => {
      socket.setTimeout(0);
      const first = socket.read(1);
      if (first === null) {
        socket.destroy();
        return;
      }
      socket.unshift(first);
      const httpsServer = first[0] === 0x16 ? getHttpsServer() : null;
      if (first[0] === 0x16 && !httpsServer) {
        socket.destroy();
        return;
      }
      (httpsServer || httpServer).emit("connection", socket);
    });
  });
}

module.exports = {
  LISTENER_KEY,
  LOCAL_HTTPS_ZONE,
  createDualProtocolServer,
  createLocalHttpsTls,
  isLocalHttpsHostname,
  loadLocalHttpsMaterial,
  localHttpsHostname,
  localHttpsPaths,
  publishListener,
  splitPemCertificates,
  validateMaterial,
};
