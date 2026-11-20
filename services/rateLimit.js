"use strict";
const { rateLimit } = require("express-rate-limit");

function normalizeIp(ip) {
  const s = String(ip || "").trim();
  if (s.startsWith("::ffff:")) return s.slice(7);
  return s;
}

/** True when the TCP peer may set/append X-Forwarded-For (Caddy on loopback/private). */
function isTrustedProxy(ip) {
  const n = normalizeIp(ip);
  if (!n) return false;
  const extra = String(process.env.TRUSTED_PROXIES || "")
    .split(",")
    .map((s) => normalizeIp(s))
    .filter(Boolean);
  if (extra.includes(n)) return true;
  if (n === "127.0.0.1" || n === "::1") return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(n)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(n)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(n)) return true;
  if (/^fc[0-9a-f]{2}:/i.test(n) || /^fd[0-9a-f]{2}:/i.test(n)) return true;
  return false;
}

/**
 * Per-client key. X-Forwarded-For is only used when the socket peer is a trusted
 * proxy (loopback, RFC1918, or TRUSTED_PROXIES). Otherwise the socket IP is used
 * so a client that can reach the portal port directly cannot rotate XFF to bypass.
 * When XFF is trusted, the last hop is used (set/appended by the immediate proxy).
 */
function clientKey(req) {
  const peer = normalizeIp(req.socket?.remoteAddress || req.ip || "");
  if (isTrustedProxy(peer)) {
    const hops = String(req.headers?.["x-forwarded-for"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (hops.length) return normalizeIp(hops[hops.length - 1]) || hops[hops.length - 1];
  }
  return peer || "unknown";
}

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Generous per-client limiter for the portal's HTTP routes. Normal UI use (map polling,
 * list refreshes) stays far below it; it only stops floods and brute-force loops.
 * Tune with RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS.
 */
function createApiRateLimiter(opts = {}) {
  return rateLimit({
    windowMs: opts.windowMs ?? envInt("RATE_LIMIT_WINDOW_MS", 60 * 1000),
    limit: opts.limit ?? envInt("RATE_LIMIT_MAX", 1200),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: clientKey,
    validate: { trustProxy: false, xForwardedForHeader: false, keyGeneratorIpFallback: false },
    handler: (req, res) => {
      res.status(429).json({ error: "Too many requests. Please slow down and try again shortly." });
    },
  });
}

module.exports = { createApiRateLimiter, clientKey, isTrustedProxy, normalizeIp };
