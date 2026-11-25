"use strict";

/**
 * Custom TAK clients: admin-defined apps shown as cards on Setup My Device.
 * Stored as a JSON string in settings (CUSTOM_TAK_CLIENTS).
 */

const crypto = require("crypto");

const SETTINGS_KEY = "CUSTOM_TAK_CLIENTS";
const PLATFORMS = ["ios", "android", "web", "pc"];
const ENROLL_QR_TYPES = ["standard", "itak", "none"];
const MAX_CLIENTS = 25;
const BLOCKED_SCHEMES = new Set([
  "javascript",
  "data",
  "vbscript",
  "file",
  "blob",
  "about",
]);

function cleanText(v, max) {
  return String(v == null ? "" : v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim()
    .slice(0, max);
}

/** http(s) URL only. Returns "" when invalid. */
function cleanHttpUrl(v) {
  const s = cleanText(v, 2000);
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString();
  } catch (_) {
    return "";
  }
}

/**
 * URL scheme template for "Open In App", e.g. myapp://enroll?host={host}&username={username}&token={token}
 * Returns "" when invalid or when the scheme is unsafe (javascript:, data:, etc.).
 */
function cleanUrlScheme(v) {
  const s = cleanText(v, 1000);
  const m = s.match(/^([a-z][a-z0-9+.-]{1,31}):\/\/(\S*)$/i);
  if (!m) return "";
  const scheme = m[1].toLowerCase();
  if (BLOCKED_SCHEMES.has(scheme) || scheme === "http" || scheme === "https") {
    return "";
  }
  return s;
}

function cleanId(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return /^[a-z0-9_-]{1,40}$/.test(s) ? s : "";
}

function toBool(v, dflt) {
  if (v === true || v === "true" || v === "1" || v === 1) return true;
  if (v === false || v === "false" || v === "0" || v === 0) return false;
  return !!dflt;
}

/** Validate one client. Returns null when it is unusable. */
function normalizeClient(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = cleanText(raw.name, 60);
  const platform = String(raw.platform || "").trim().toLowerCase();
  if (!name || !PLATFORMS.includes(platform)) return null;
  const downloadUrl = cleanHttpUrl(raw.downloadUrl);
  // A web client is just an address to open.
  if (platform === "web" && !downloadUrl) return null;
  const enrollRaw = String(raw.enrollQr || "").trim().toLowerCase();
  const enrollQr = ENROLL_QR_TYPES.includes(enrollRaw) ? enrollRaw : "standard";
  return {
    id: cleanId(raw.id) || "c" + crypto.randomBytes(5).toString("hex"),
    name,
    platform,
    iconUrl: cleanHttpUrl(raw.iconUrl),
    downloadUrl,
    enrollQr: platform === "web" || platform === "pc" ? "none" : enrollQr,
    prefQr: platform === "ios" || platform === "android" ? toBool(raw.prefQr, false) : false,
    urlScheme:
      platform === "ios" || platform === "android" ? cleanUrlScheme(raw.urlScheme) : "",
    instructions: cleanText(raw.instructions, 1000),
    enabled: toBool(raw.enabled, true),
    recommended: toBool(raw.recommended, false),
  };
}

/**
 * Accepts the stored JSON string or an array. Always returns a clean array:
 * invalid entries dropped, duplicate ids made unique, at most one recommended per platform.
 */
function normalizeCustomClients(input) {
  let arr = input;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr || "[]");
    } catch (_) {
      arr = [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seenIds = new Set();
  const recommendedPlatforms = new Set();
  for (const item of arr) {
    if (out.length >= MAX_CLIENTS) break;
    const c = normalizeClient(item);
    if (!c) continue;
    while (seenIds.has(c.id)) c.id = "c" + crypto.randomBytes(5).toString("hex");
    seenIds.add(c.id);
    if (c.recommended) {
      if (recommendedPlatforms.has(c.platform)) c.recommended = false;
      else recommendedPlatforms.add(c.platform);
    }
    out.push(c);
  }
  return out;
}

function serializeCustomClients(input) {
  return JSON.stringify(normalizeCustomClients(input));
}

/** Enabled clients for one platform, in the admin's order. */
function enabledForPlatform(clients, platform) {
  return normalizeCustomClients(clients).filter(
    (c) => c.enabled && c.platform === platform
  );
}

/** Fill {host} {username} {token} in a URL scheme template. */
function buildOpenInAppUrl(template, vars) {
  const t = cleanUrlScheme(template);
  if (!t) return "";
  const v = vars || {};
  return t.replace(/\{(host|username|token)\}/g, (_, k) =>
    encodeURIComponent(String(v[k] == null ? "" : v[k]))
  );
}

module.exports = {
  SETTINGS_KEY,
  PLATFORMS,
  MAX_CLIENTS,
  normalizeCustomClients,
  serializeCustomClients,
  enabledForPlatform,
  buildOpenInAppUrl,
  cleanUrlScheme,
};
