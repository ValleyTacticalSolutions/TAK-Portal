/**
 * services/outboundUrl.js — outbound URL guard (SSRF defence).
 *
 * Every server-side axios/fetch call goes through this module so a URL can never
 * point the portal at a host the admin did not configure (or a well-known
 * public service we ship with), and never at link-local / cloud-metadata ranges.
 *
 *  - http/https only
 *  - host must be in the allow list (configured hosts + built-in public hosts + caller extras)
 *  - 169.254.0.0/16, fe80::/10, fd00::/8 (and IPv4-mapped forms) are refused unless the
 *    admin configured that exact host
 *  - hostnames are DNS-resolved and refused if they resolve into a blocked range
 *  - redirects are re-checked hop by hop
 */

const dns = require("dns");
const net = require("net");
const { getString } = require("./env");

/** Settings keys whose host the admin configured. */
const CONFIGURED_URL_KEYS = [
  "TAK_URL",
  "AUTHENTIK_URL",
  "AUTHENTIK_PUBLIC_URL",
  "CLOUDTAK_URL",
  "CLOUDTAK_API_URL",
  "CLOUDTAK_MARKETPLACE_CATALOG_URL",
  "TAK_PORTAL_PUBLIC_URL",
];

/** Public services the portal itself ships with (fixed in code, never from a request). */
const BUILTIN_HOSTS = [
  "api.github.com",
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "codeload.github.com",
  "tak.gov",
  "auth.tak.gov",
  "api.twilio.com",
  "api.brevo.com",
  "hcaptcha.com",
  "api.geocod.io",
  "geocoding.geo.census.gov",
  "photon.komoot.io",
  "nominatim.openstreetmap.org",
  "tile.openstreetmap.org",
  "server.arcgisonline.com",
  "batch.openaddresses.io",
  "results.openaddresses.io",
  "data.openaddresses.io",
  "v2.openaddresses.io",
  "openaddresses.io",
];

class OutboundUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = "OutboundUrlError";
    this.code = "OUTBOUND_URL_BLOCKED";
  }
}

function normHost(h) {
  return String(h || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function hostOf(urlLike) {
  const raw = String(urlLike || "").trim();
  if (!raw) return "";
  try {
    return normHost(new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname);
  } catch (_) {
    return "";
  }
}

/** Hosts the admin configured in Server Settings. */
function getConfiguredHosts() {
  const out = new Set();
  for (const key of CONFIGURED_URL_KEYS) {
    const h = hostOf(getString(key, ""));
    if (h) out.add(h);
  }
  for (const key of ["CLOUDTAK_SSH_HOST", "TAK_ENROLL_HOST"]) {
    const h = hostOf(getString(key, ""));
    if (h) out.add(h);
  }
  return out;
}

/** True if the literal IP is link-local / metadata (169.254/16, fe80::/10, fd00::/8) or unspecified. */
function isBlockedIp(ip) {
  let addr = normHost(ip);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) addr = mapped[1];
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    addr = `${hi >> 8}.${hi & 255}.${parseInt(mappedHex[2], 16) >> 8}.${parseInt(mappedHex[2], 16) & 255}`;
  }
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number);
    return (a === 169 && b === 254) || a === 0;
  }
  if (net.isIPv6(addr)) {
    const first = parseInt(addr.split(":")[0] || "0", 16);
    if (addr === "::") return true;
    if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10
    if ((first & 0xff00) === 0xfd00) return true; // fd00::/8
  }
  return false;
}

/** True for loopback / RFC1918 / CGNAT / unique-local addresses, plus anything isBlockedIp blocks. */
function isPrivateOrBlockedIp(ip) {
  if (isBlockedIp(ip)) return true;
  let addr = normHost(ip);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) addr = mapped[1];
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(addr)) {
    return addr === "::1" || /^::ffff:/.test(addr) || ((parseInt(addr.split(":")[0] || "0", 16) & 0xfe00) === 0xfc00);
  }
  return false;
}

/** Redirect hops: https only, and never a loopback/private/link-local literal or localhost name. */
function assertRedirectHop(urlLike, opts = {}) {
  const u = assertOutboundUrl(urlLike, { ...opts, anyHost: true });
  const host = normHost(u.hostname);
  const configured = getConfiguredHosts();
  if (configured.has(host) || (opts.allowHosts || []).map(normHost).includes(host)) return u;
  if (u.protocol !== "https:") throw new OutboundUrlError("Redirect target must be https.");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local") || isPrivateOrBlockedIp(host)) {
    throw new OutboundUrlError("Redirect target points at a blocked address range.");
  }
  return u;
}

/** dns.lookup replacement for redirect hops: refuses names that resolve to private/blocked addresses. */
function guardedLookup(hostname, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  const host = normHost(hostname);
  const configured = getConfiguredHosts();
  dns.lookup(hostname, { ...(options || {}), all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }];
    if (!configured.has(host) && list.some((a) => isPrivateOrBlockedIp(a.address))) {
      return cb(new OutboundUrlError("Outbound host resolves to a blocked address range."));
    }
    if (options && options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

function hostMatches(host, allowed) {
  for (const a of allowed) {
    const n = normHost(a);
    if (!n) continue;
    if (host === n) return true;
    if (n.startsWith("*.") && host.endsWith(n.slice(1))) return true;
  }
  return false;
}

function buildAllowed(opts = {}) {
  const set = new Set([...getConfiguredHosts()]);
  if (opts.builtin !== false) for (const h of BUILTIN_HOSTS) set.add(h);
  for (const h of opts.allowHosts || []) {
    const n = h && h.includes("/") ? hostOf(h) : normHost(h);
    if (n) set.add(n);
  }
  return set;
}

/**
 * Validate a URL synchronously (scheme, allow list, literal IP ranges).
 * @param {string|URL} urlLike
 * @param {{ allowHosts?: string[], builtin?: boolean, configuredOnly?: boolean }} [opts]
 * @returns {URL}
 */
function assertOutboundUrl(urlLike, opts = {}) {
  let u;
  try {
    u = urlLike instanceof URL ? urlLike : new URL(String(urlLike || "").trim());
  } catch (_) {
    throw new OutboundUrlError("Outbound URL is not valid.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new OutboundUrlError("Outbound URL must be http or https.");
  }
  const host = normHost(u.hostname);
  if (!host) throw new OutboundUrlError("Outbound URL has no host.");
  // Redirect hops (opts.anyHost): the first hop was allow-listed; CDN/S3 targets can't be listed,
  // so only scheme and blocked address ranges are enforced.
  const allowed = opts.anyHost ? null : opts.configuredOnly
    ? new Set([...getConfiguredHosts(), ...(opts.allowHosts || []).map(hostOf)])
    : buildAllowed(opts);
  const explicit = opts.anyHost || hostMatches(host, allowed);
  if (!explicit) {
    throw new OutboundUrlError(`Outbound host "${host}" is not a configured host.`);
  }
  // Blocked ranges only pass when the admin configured that exact host.
  const configured = getConfiguredHosts();
  if (isBlockedIp(host) && !configured.has(host) && !(opts.allowHosts || []).map(normHost).includes(host)) {
    throw new OutboundUrlError("Outbound URL points at a blocked address range.");
  }
  return u;
}

/** Same as assertOutboundUrl, plus a DNS check that the name does not resolve into a blocked range. */
async function assertOutboundUrlResolved(urlLike, opts = {}) {
  const u = assertOutboundUrl(urlLike, opts);
  const host = normHost(u.hostname);
  if (net.isIP(host)) return u;
  const configured = getConfiguredHosts();
  if (configured.has(host) || (opts.allowHosts || []).map(normHost).includes(host)) return u;
  let addrs = [];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch (_) {
    return u; // let the HTTP client report the real DNS error
  }
  if (addrs.some((a) => isBlockedIp(a.address))) {
    throw new OutboundUrlError("Outbound host resolves to a blocked address range.");
  }
  return u;
}

/**
 * Attach the guard to an axios instance. `opts.allowHosts` may be a function (evaluated per request).
 */
function guardAxios(client, opts = {}) {
  client.interceptors.request.use(async (config) => {
    const axiosUri = client.getUri ? client.getUri(config) : String(config.url || "");
    const extra = typeof opts.allowHosts === "function" ? opts.allowHosts() : opts.allowHosts;
    const o = { ...opts, allowHosts: extra || [] };
    await assertOutboundUrlResolved(axiosUri, o);
    if (config.maxRedirects !== 0) {
      if (!config.lookup) config.lookup = guardedLookup;
      const prev = config.beforeRedirect;
      config.beforeRedirect = (options, resp) => {
        assertRedirectHop(`${options.protocol}//${options.hostname || options.host}${options.path || ""}`, o);
        if (typeof prev === "function") prev(options, resp);
      };
    }
    return config;
  });
  return client;
}

/**
 * Drop-in for `axios.get/post/...` on the shared axios module: validates the URL (and each redirect hop)
 * first, then calls the real method. `guardedAxios(axios).get(url, cfg)`.
 */
function guardedAxios(axiosLib, opts = {}) {
  const withRedirectCheck = (cfg) => {
    const c = { ...(cfg || {}) };
    if (c.maxRedirects !== 0) {
      if (!c.lookup) c.lookup = guardedLookup;
      const prev = c.beforeRedirect;
      c.beforeRedirect = (options, resp) => {
        assertRedirectHop(`${options.protocol}//${options.hostname || options.host}${options.path || ""}`, opts);
        if (typeof prev === "function") prev(options, resp);
      };
    }
    return c;
  };
  return {
    async get(url, cfg) {
      await assertOutboundUrlResolved(url, opts);
      return axiosLib.get(url, withRedirectCheck(cfg));
    },
    async post(url, data, cfg) {
      await assertOutboundUrlResolved(url, opts);
      return axiosLib.post(url, data, withRedirectCheck(cfg));
    },
  };
}

/** fetch with the guard; follows redirects manually so each hop is re-validated. */
async function guardedFetch(url, init = {}, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  let current = String(url);
  const max = 5;
  for (let i = 0; i <= max; i++) {
    if (i === 0) await assertOutboundUrlResolved(current, opts);
    else {
      const hop = assertRedirectHop(current, opts);
      const h = normHost(hop.hostname);
      if (!net.isIP(h) && !getConfiguredHosts().has(h)) {
        let addrs = [];
        try { addrs = await dns.promises.lookup(h, { all: true }); } catch (_) { /* client reports DNS error */ }
        if (addrs.some((a) => isPrivateOrBlockedIp(a.address))) throw new OutboundUrlError("Outbound host resolves to a blocked address range.");
      }
    }
    const res = await fetchImpl(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers && res.headers.get("location")) {
      if (init.redirect === "manual") return res;
      current = new URL(res.headers.get("location"), current).toString();
      continue;
    }
    return res;
  }
  throw new OutboundUrlError("Too many redirects.");
}

module.exports = {
  OutboundUrlError,
  BUILTIN_HOSTS,
  getConfiguredHosts,
  isBlockedIp,
  isPrivateOrBlockedIp,
  assertRedirectHop,
  guardedLookup,
  assertOutboundUrl,
  assertOutboundUrlResolved,
  guardAxios,
  guardedAxios,
  guardedFetch,
  hostOf,
};
