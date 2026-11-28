/**
 * services/takMartiCerts.service.js
 *
 * TAK Server 5.6+ Marti API paths for the jobs TAK Portal used to do over SSH:
 * - sign integration client certs (POST /api/tls/signClient/v2, key stays in the portal)
 * - revoke API-issued integration certs (certadmin, same flow as tak.service revokeCertsForUser)
 * - build truststores from the CA chain (verified TLS handshake + TAK_CA_PATH) instead of reading .p12 files
 * - lightweight health / admin checks (GET /api/version, GET /api/util/isAdmin)
 *
 * Every caller keeps SSH as the fallback: when the server is older than 5.6, signing is off,
 * or an API call fails, the old SSH path runs.
 *
 * TAK Server only signs a CSR whose CN is the logged-in user, so signing authenticates as the
 * integration user itself (HTTP basic on the cert enrollment port, default 8446).
 *
 * Settings / env (all optional):
 *   TAK_USE_MARTI_CERT_APIS   default true; false forces the SSH paths
 *   TAK_CERT_ENROLL_PORT      default 8446 (TAK Server cert_https connector)
 *   TAK_API_CERT_SIGN_WAIT_MS how long to retry signing while a new user reaches LDAP
 */

const tls = require("tls");
const https = require("https");
const crypto = require("crypto");
const axios = require("axios");
const forge = require("node-forge");
const { getBool, getInt, getString } = require("./env");
const { guardAxios } = require("./outboundUrl");

const INTEGRATION_P12_PASSWORD = "atakatak";
const TRUSTSTORE_PASSWORD = "atakatak";
const DEFAULT_ENROLL_PORT = 8446;
const VERSION_CACHE_MS = 5 * 60 * 1000;
const MIN_API_MAJOR = 5;
const MIN_API_MINOR = 6;

function takSvc() {
  return require("./tak.service");
}

/* ----------------------------- test hooks ----------------------------- */

const hooks = {
  martiClient: null, // () => axios-like (admin mTLS client)
  enrollClient: null, // ({ username, password }) => axios-like (basic auth)
  peerChain: null, // async () => [DER Buffer, ...] (leaf first)
  sleep: null,
};

function __setTestHooks(next = {}) {
  Object.assign(hooks, next);
  clearVersionCache();
}

function sleep(ms) {
  if (hooks.sleep) return hooks.sleep(ms);
  return new Promise((r) => setTimeout(r, ms));
}

function getMartiClient(timeout) {
  if (hooks.martiClient) return hooks.martiClient();
  return takSvc().buildTakAxios(typeof timeout === "number" ? { timeout } : {});
}

/* ----------------------------- version gate ----------------------------- */

/**
 * Parse "5.6-RELEASE-12", "TAK Server 5.6-RELEASE-12-HEAD" or a /version/info object.
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
function parseTakVersion(input) {
  if (input && typeof input === "object") {
    const src = input.data && typeof input.data === "object" ? input.data : input;
    const major = Number(src.major);
    const minor = Number(src.minor);
    if (Number.isFinite(major) && Number.isFinite(minor) && (major > 0 || minor > 0)) {
      const patch = Number(src.patch);
      return { major, minor, patch: Number.isFinite(patch) ? patch : 0 };
    }
    if (typeof src.version === "string") return parseTakVersion(src.version);
    return null;
  }
  const m = String(input || "").match(/(\d+)\.(\d+)(?:[.-](?:RELEASE-)?(\d+))?/i);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] || 0) };
}

function versionAtLeast(v, major, minor) {
  if (!v) return false;
  if (v.major !== major) return v.major > major;
  return v.minor >= minor;
}

let _versionCache = { at: 0, value: null };

function clearVersionCache() {
  _versionCache = { at: 0, value: null };
}

/**
 * TAK Server version via GET /api/version/info, falling back to GET /api/version.
 * Cached for 5 minutes. Returns null when it can't be read.
 */
async function getTakServerVersion({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && _versionCache.value && now - _versionCache.at < VERSION_CACHE_MS) {
    return _versionCache.value;
  }
  let value = null;
  try {
    const client = getMartiClient(10000);
    try {
      const res = await client.get("/api/version/info");
      value = parseTakVersion(res?.data);
    } catch (_) {
      value = null;
    }
    if (!value) {
      const res = await client.get("/api/version", { responseType: "text" });
      value = parseTakVersion(res?.data);
    }
  } catch (_) {
    value = null;
  }
  if (value) _versionCache = { at: now, value };
  return value;
}

/** Marti cert APIs are on when TAK is configured, not bypassed, not switched off, and the server is 5.6+. */
async function canUseMartiCertApis() {
  if (!getBool("TAK_USE_MARTI_CERT_APIS", true)) return false;
  const tak = takSvc();
  if (!tak.isTakConfigured() || tak.isTakBypassed()) return false;
  const v = await getTakServerVersion();
  return versionAtLeast(v, MIN_API_MAJOR, MIN_API_MINOR);
}

/* ----------------------------- server config ----------------------------- */

/** GET /api/security/config → data.enableEnrollment (server-side signing on). */
async function isServerSigningEnabled() {
  try {
    const res = await getMartiClient(10000).get("/api/security/config");
    const body = res?.data;
    const info = body && typeof body === "object" && body.data && typeof body.data === "object" ? body.data : body;
    return !!(info && info.enableEnrollment === true);
  } catch (_) {
    return false;
  }
}

/** Interpret GET /api/util/isAdmin (true / "true" / { data: true }). */
function parseIsAdminResponse(body) {
  if (body === true) return true;
  if (typeof body === "string") return body.trim().toLowerCase() === "true";
  if (body && typeof body === "object") return parseIsAdminResponse(body.data);
  return false;
}

/** Confirms the portal's admin client cert is accepted as a TAK admin. */
async function checkMartiAdminAccess() {
  const tak = takSvc();
  if (!tak.isTakConfigured()) return { ok: false, skipped: true, message: "TAK URL is not configured." };
  if (tak.isTakBypassed()) return { ok: false, skipped: true, message: "TAK bypass enabled." };
  try {
    const res = await getMartiClient(10000).get("/api/util/isAdmin");
    const isAdmin = parseIsAdminResponse(res?.data);
    return {
      ok: isAdmin,
      isAdmin,
      message: isAdmin
        ? "TAK admin certificate verified."
        : "TAK Server accepted the portal certificate but it is not an admin.",
    };
  } catch (err) {
    const status = err?.response?.status;
    return {
      ok: false,
      isAdmin: false,
      message: `TAK admin check failed${status ? ` (HTTP ${status})` : ""}: ${err?.message || String(err)}`,
    };
  }
}

/**
 * Parse GET /api/tls/config XML into ordered name entries, e.g. [{ name: "O", value: "TAK" }].
 * Accepts attribute form (<nameEntry name="O" value="TAK"/>) and element form.
 */
function parseCertificateConfigNameEntries(xml) {
  const text = String(xml || "");
  const out = [];
  const tagRe = /<(?:[\w-]+:)?nameEntry\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?nameEntry>)/gi;
  let m;
  while ((m = tagRe.exec(text))) {
    const attrs = m[1] || "";
    const inner = m[2] || "";
    const attr = (k) => {
      const am = attrs.match(new RegExp(`\\b${k}\\s*=\\s*"([^"]*)"`, "i")) ||
        attrs.match(new RegExp(`\\b${k}\\s*=\\s*'([^']*)'`, "i"));
      if (am) return am[1];
      const em = inner.match(new RegExp(`<(?:[\\w-]+:)?${k}>([\\s\\S]*?)</(?:[\\w-]+:)?${k}>`, "i"));
      return em ? em[1].trim() : "";
    };
    const name = decodeXmlEntities(attr("name"));
    const value = decodeXmlEntities(attr("value"));
    if (name) out.push({ name, value });
  }
  return out;
}

function decodeXmlEntities(s) {
  return String(s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/* ----------------------------- CSR / PEM / P12 ----------------------------- */

const SHORT_NAMES = new Set(["C", "ST", "L", "O", "OU", "CN", "E", "DC"]);

function subjectAttrFor(entry) {
  const name = String(entry.name || "").trim();
  const upper = name.toUpperCase();
  if (SHORT_NAMES.has(upper)) return { shortName: upper === "E" ? "E" : upper, value: String(entry.value || "") };
  return { name, value: String(entry.value || "") };
}

/**
 * New RSA key + CSR with subject = TAK's required name entries + CN=<username>.
 * @returns {{ keyPem: string, csrBase64: string, csrPem: string }}
 */
function buildIntegrationCsr(username, nameEntries = []) {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const forgeKey = forge.pki.privateKeyFromPem(keyPem);
  const publicKey = forge.pki.setRsaPublicKey(forgeKey.n, forgeKey.e);

  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = publicKey;
  const attrs = (Array.isArray(nameEntries) ? nameEntries : [])
    .filter((e) => e && String(e.name || "").toUpperCase() !== "CN")
    .map(subjectAttrFor);
  attrs.push({ shortName: "CN", value: String(username) });
  csr.setSubject(attrs);
  csr.sign(forgeKey, forge.md.sha256.create());

  const der = forge.asn1.toDer(forge.pki.certificationRequestToAsn1(csr)).getBytes();
  const csrBase64 = forge.util.encode64(der);
  return { keyPem, csrBase64, csrPem: forge.pki.certificationRequestToPem(csr) };
}

/** Normalize a PEM (or bare base64 body) certificate into "-----BEGIN CERTIFICATE-----\n…" form. */
function normalizeCertPem(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const body = text
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/=]+$/.test(body)) return "";
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/**
 * Parse the signClient/v2 JSON ({ signedCert, ca0, ca1, … }) or XML (<enrollment>) response.
 * @returns {{ certPem: string, caPems: string[] }}
 */
function parseSignClientV2Response(body) {
  let obj = body;
  if (typeof obj === "string") {
    const s = obj.trim();
    if (s.startsWith("{")) {
      try {
        obj = JSON.parse(s);
      } catch (_) {
        obj = null;
      }
    } else if (s.startsWith("<")) {
      const signed = (s.match(/<signedCert>([\s\S]*?)<\/signedCert>/i) || [])[1] || "";
      const cas = Array.from(s.matchAll(/<ca>([\s\S]*?)<\/ca>/gi)).map((m) => m[1]);
      obj = { signedCert: signed };
      cas.forEach((c, i) => (obj[`ca${i}`] = c));
    } else {
      obj = null;
    }
  }
  if (!obj || typeof obj !== "object") throw new Error("TAK signClient response was not JSON.");
  const certPem = normalizeCertPem(obj.signedCert);
  if (!certPem) throw new Error("TAK signClient response had no signed certificate.");
  const caKeys = Object.keys(obj)
    .filter((k) => /^ca\d+$/.test(k))
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
  const caPems = caKeys.map((k) => normalizeCertPem(obj[k])).filter(Boolean);
  return { certPem, caPems };
}

/** PKCS#12 with key + cert + CA chain (3DES, like makeCert.sh output). */
function buildClientP12({ keyPem, certPem, caPems = [], password = INTEGRATION_P12_PASSWORD, friendlyName }) {
  const key = forge.pki.privateKeyFromPem(keyPem);
  const chain = [certPem, ...caPems].map((p) => forge.pki.certificateFromPem(p));
  // forge checks `'friendlyName' in options`, so the key must be absent (not undefined) when unset.
  const opts = { algorithm: "3des" };
  if (friendlyName) opts.friendlyName = friendlyName;
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, chain, password, opts);
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary");
}

/** Cert-only PKCS#12 truststore. */
function buildTruststoreP12(caPems, password = TRUSTSTORE_PASSWORD) {
  const certs = (Array.isArray(caPems) ? caPems : []).map((p) => forge.pki.certificateFromPem(p));
  if (!certs.length) throw new Error("No CA certificates to put in the truststore.");
  const asn1 = forge.pkcs12.toPkcs12Asn1(null, certs, password, { algorithm: "3des" });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary");
}

function derToPem(der) {
  return normalizeCertPem(Buffer.from(der).toString("base64"));
}

function splitPemBundle(text) {
  return (String(text || "").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [])
    .map(normalizeCertPem)
    .filter(Boolean);
}

function certInfo(pem) {
  const x = new crypto.X509Certificate(pem);
  return {
    pem,
    subject: x.subject,
    issuer: x.issuer,
    selfSigned: x.subject === x.issuer && x.checkIssued(x),
    isCa: x.ca === true,
    fingerprint256: x.fingerprint256,
  };
}

/**
 * From a leaf-first chain plus extra trusted CA PEMs, return unique CA certs split into roots
 * (self-signed) and intermediates. The leaf (server cert) is dropped.
 */
function classifyCaChain(chainPems = [], extraCaPems = []) {
  const seen = new Set();
  const cas = [];
  const add = (pem, isLeaf) => {
    if (!pem) return;
    let info;
    try {
      info = certInfo(pem);
    } catch (_) {
      return;
    }
    if (isLeaf && !info.isCa) return;
    if (!info.isCa && !info.selfSigned) return;
    if (seen.has(info.fingerprint256)) return;
    seen.add(info.fingerprint256);
    cas.push(info);
  };
  chainPems.forEach((p, i) => add(p, i === 0));
  extraCaPems.forEach((p) => add(p, false));
  return {
    roots: cas.filter((c) => c.selfSigned).map((c) => c.pem),
    intermediates: cas.filter((c) => !c.selfSigned).map((c) => c.pem),
  };
}

/* ----------------------------- TLS chain ----------------------------- */

function takUrlHostPort() {
  const u = new URL(takSvc().getTakBaseUrl());
  return { host: u.hostname, port: Number(u.port) || 443 };
}

/**
 * Leaf-first DER chain from a *verified* mTLS handshake with the Marti port (TAK_CA_PATH must
 * validate the server, so the chain is authentic). Returns [DER Buffer, …].
 */
async function fetchVerifiedPeerChain() {
  if (hooks.peerChain) return hooks.peerChain();
  const tak = takSvc();
  const auth = tak.getTakTlsAuth();
  if (!auth.ca) throw new Error("TAK CA is not configured, so the server chain can't be verified.");
  const { host, port } = takUrlHostPort();
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: net_isIp(host) ? undefined : host,
      ca: auth.ca,
      cert: auth.cert,
      key: auth.key,
      passphrase: auth.passphrase,
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined,
      timeout: 15000,
    });
    const done = (err, val) => {
      try {
        socket.destroy();
      } catch (_) {}
      if (err) reject(err);
      else resolve(val);
    };
    socket.once("secureConnect", () => {
      const out = [];
      const seen = new Set();
      let c = socket.getPeerCertificate(true);
      while (c && c.raw && !seen.has(c.fingerprint256)) {
        seen.add(c.fingerprint256);
        out.push(Buffer.from(c.raw));
        if (!c.issuerCertificate || c.issuerCertificate === c) break;
        c = c.issuerCertificate;
      }
      done(null, out);
    });
    socket.once("timeout", () => done(new Error("TLS handshake with TAK Server timed out.")));
    socket.once("error", (e) => done(e));
  });
}

function net_isIp(h) {
  return require("net").isIP(String(h || "")) !== 0;
}

function readConfiguredCaPems() {
  try {
    const auth = takSvc().getTakTlsAuth();
    if (!auth.ca) return [];
    return splitPemBundle(Buffer.isBuffer(auth.ca) ? auth.ca.toString("utf8") : String(auth.ca));
  } catch (_) {
    return [];
  }
}

/** CA certs for truststores: verified handshake chain + configured TAK CA. */
async function getTakCaChainViaApi() {
  const chain = (await fetchVerifiedPeerChain()).map(derToPem).filter(Boolean);
  const classified = classifyCaChain(chain, readConfiguredCaPems());
  if (!classified.roots.length && !classified.intermediates.length) {
    throw new Error("TAK Server did not present any CA certificates.");
  }
  return classified;
}

/**
 * Enrollment truststore (caCert.p12): root CA(s), or the whole CA chain when no root is known.
 * Same shape as takSsh fetchTakTruststoreP12FromRemote.
 */
async function buildTakRootTruststoreViaApi() {
  const { roots, intermediates } = await getTakCaChainViaApi();
  const pems = roots.length ? roots : intermediates;
  return {
    p12: buildTruststoreP12(pems, TRUSTSTORE_PASSWORD),
    password: TRUSTSTORE_PASSWORD,
    sourcePath: "marti-api:tls-chain",
  };
}

/**
 * Intermediate (signing CA) truststore for the integration cert zip.
 * Same shape as takSsh fetchTakIntermediateTruststoreP12FromRemote.
 */
async function buildTakIntermediateTruststoreViaApi() {
  const { intermediates } = await getTakCaChainViaApi();
  if (!intermediates.length) throw new Error("TAK Server chain has no intermediate CA.");
  return {
    p12: buildTruststoreP12(intermediates, TRUSTSTORE_PASSWORD),
    password: TRUSTSTORE_PASSWORD,
    sourcePath: "marti-api:tls-chain",
    fileName: "truststore-intermediate.p12",
  };
}

/* ----------------------------- signing ----------------------------- */

function getEnrollBaseUrl() {
  const u = new URL(takSvc().getTakBaseUrl());
  u.port = String(getInt("TAK_CERT_ENROLL_PORT", DEFAULT_ENROLL_PORT) || DEFAULT_ENROLL_PORT);
  return u.toString().replace(/\/+$/, "");
}

function getEnrollClient({ username, password }) {
  if (hooks.enrollClient) return hooks.enrollClient({ username, password });
  let ca;
  try {
    ca = takSvc().getTakTlsAuth().ca;
  } catch (_) {
    ca = undefined;
  }
  const client = axios.create({
    baseURL: getEnrollBaseUrl(),
    timeout: 30000,
    auth: { username, password },
    httpsAgent: new https.Agent({
      ca,
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined,
    }),
  });
  guardAxios(client, { builtin: false });
  return client;
}

function isAuthFailure(err) {
  const s = err?.response?.status;
  return s === 401 || s === 403;
}

/**
 * Sign a new client cert for an integration user via POST /api/tls/signClient/v2.
 * Retries 401/403 for up to waitMs (a new Authentik user takes a few minutes to reach LDAP).
 * @returns {{ pem: string, key: string, p12: Buffer, caPems: string[], issuedVia: "marti-api" }}
 */
async function signIntegrationCertViaApi(username, password, { waitMs = 0, retryEveryMs = 10000 } = {}) {
  const un = String(username || "").trim();
  if (!un) throw new Error("Username required.");
  if (!password) throw new Error("Integration password is required to sign via the TAK API.");

  const client = getEnrollClient({ username: un, password });
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  let lastErr = null;
  let nameEntries = null;

  for (;;) {
    try {
      if (!nameEntries) {
        const cfg = await client.get("/api/tls/config", { responseType: "text" });
        nameEntries = parseCertificateConfigNameEntries(cfg?.data);
      }
      const { keyPem, csrBase64 } = buildIntegrationCsr(un, nameEntries);
      const res = await client.post("/api/tls/signClient/v2", csrBase64, {
        params: { clientUid: `tak-portal-${un}` },
        headers: { "Content-Type": "text/plain", Accept: "application/json" },
        responseType: "text",
        transformResponse: [(d) => d],
      });
      const { certPem, caPems } = parseSignClientV2Response(res?.data);
      const signed = new crypto.X509Certificate(certPem);
      const cnMatch = String(signed.subject || "").match(/(?:^|\n)CN=([^\n]+)/);
      if (!cnMatch || cnMatch[1].trim().toLowerCase() !== un.toLowerCase()) {
        throw new Error("TAK signed a certificate for a different name.");
      }
      if (!signed.checkPrivateKey(crypto.createPrivateKey(keyPem))) {
        throw new Error("TAK signed certificate does not match the generated key.");
      }
      const p12 = buildClientP12({ keyPem, certPem, caPems, friendlyName: un });
      return { pem: certPem, key: keyPem, p12, caPems, issuedVia: "marti-api" };
    } catch (err) {
      lastErr = err;
      if (!isAuthFailure(err) || Date.now() + retryEveryMs > deadline) break;
      await sleep(retryEveryMs);
    }
  }
  const status = lastErr?.response?.status;
  const e = new Error(
    `TAK API certificate signing failed${status ? ` (HTTP ${status})` : ""}: ${lastErr?.message || lastErr}`
  );
  e.cause = lastErr;
  throw e;
}

/** Revoke every unrevoked cert TAK has on record for this user (API-issued certs only). */
async function revokeIntegrationCertViaApi(username, { requireVerified = true } = {}) {
  return takSvc().revokeCertsForUser(username, { requireVerified });
}

module.exports = {
  INTEGRATION_P12_PASSWORD,
  TRUSTSTORE_PASSWORD,
  parseTakVersion,
  versionAtLeast,
  getTakServerVersion,
  clearVersionCache,
  canUseMartiCertApis,
  isServerSigningEnabled,
  parseIsAdminResponse,
  checkMartiAdminAccess,
  parseCertificateConfigNameEntries,
  buildIntegrationCsr,
  normalizeCertPem,
  parseSignClientV2Response,
  buildClientP12,
  buildTruststoreP12,
  classifyCaChain,
  splitPemBundle,
  fetchVerifiedPeerChain,
  getTakCaChainViaApi,
  buildTakRootTruststoreViaApi,
  buildTakIntermediateTruststoreViaApi,
  getEnrollBaseUrl,
  signIntegrationCertViaApi,
  revokeIntegrationCertViaApi,
  __setTestHooks,
};
