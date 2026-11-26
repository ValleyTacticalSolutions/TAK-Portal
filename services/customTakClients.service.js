"use strict";

/**
 * Custom TAK clients: admin-defined apps shown as cards on Setup My Device.
 * Stored as a JSON string in settings (CUSTOM_TAK_CLIENTS).
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { resolveInside } = require("./safePath");

const FILES_DIR = path.join(__dirname, "..", "data", "custom-clients");
const UPLOADS_DIR = path.join(__dirname, "..", "data", "uploads");
/** Authenticated download of an uploaded client file (APK, IPA, ...). */
const FILE_URL_PREFIX = "/api/custom-clients/file/";
const FILE_URL_RE = /^\/api\/custom-clients\/file\/([a-f0-9]{16})$/;
const ALLOWED_FILE_EXT = /\.(apk|aab|ipa|zip|exe|msi|dmg|pkg|deb|appimage)$/i;

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

/** Download target: an http(s) link, or the portal path of an uploaded file. */
function cleanDownloadTarget(v) {
  const s = cleanText(v, 2000);
  if (FILE_URL_RE.test(s)) return s;
  return cleanHttpUrl(s);
}

function cleanFileName(v) {
  return cleanText(v, 120).replace(/[^a-zA-Z0-9 _.()+-]/g, "_");
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
  const downloadUrl = cleanDownloadTarget(raw.downloadUrl);
  // A web client is just an address to open.
  if (platform === "web" && !downloadUrl) return null;
  const enrollRaw = String(raw.enrollQr || "").trim().toLowerCase();
  const enrollQr = ENROLL_QR_TYPES.includes(enrollRaw) ? enrollRaw : "standard";
  return {
    id: cleanId(raw.id) || "c" + crypto.randomBytes(5).toString("hex"),
    name,
    platform,
    downloadUrl,
    fileName: FILE_URL_RE.test(downloadUrl) ? cleanFileName(raw.fileName) : "",
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

function fileIdFromUrl(url) {
  const m = FILE_URL_RE.exec(String(url || ""));
  return m ? m[1] : "";
}

/** Move an uploaded temp file into data/custom-clients. Returns { downloadUrl, fileName }. */
function saveUploadedFile(tempPath, originalName) {
  const name = cleanFileName(originalName);
  if (!ALLOWED_FILE_EXT.test(name)) {
    throw new Error("Unsupported file type. Use .apk, .aab, .ipa, .zip, .exe, .msi, .dmg, .pkg or .deb.");
  }
  const src = resolveInside(UPLOADS_DIR, tempPath);
  if (!fs.existsSync(src)) throw new Error("Uploaded file not found.");
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const id = crypto.randomBytes(8).toString("hex");
  const dest = path.join(FILES_DIR, id);
  try {
    fs.renameSync(src, dest);
  } catch (_) {
    fs.copyFileSync(src, dest);
    try { fs.unlinkSync(src); } catch (_e) { /* ignore */ }
  }
  return { downloadUrl: FILE_URL_PREFIX + id, fileName: name };
}

/** Find an uploaded file and its display name for a download request. */
function getFileForDownload(fileId, clients) {
  if (!/^[a-f0-9]{16}$/.test(String(fileId || ""))) return null;
  const url = FILE_URL_PREFIX + fileId;
  const client = normalizeCustomClients(clients).find((c) => c.enabled && c.downloadUrl === url);
  if (!client) return null;
  const filePath = path.join(FILES_DIR, fileId);
  if (!fs.existsSync(filePath)) return null;
  return { filePath, fileName: client.fileName || "client-download" };
}

/** Delete uploaded files that no client references any more. */
function pruneUnreferencedFiles(clients) {
  try {
    const keep = new Set(normalizeCustomClients(clients).map((c) => fileIdFromUrl(c.downloadUrl)).filter(Boolean));
    if (!fs.existsSync(FILES_DIR)) return;
    for (const f of fs.readdirSync(FILES_DIR)) {
      if (/^[a-f0-9]{16}$/.test(f) && !keep.has(f)) {
        const fp = path.join(FILES_DIR, f);
        try {
          // Keep fresh uploads: the admin may not have saved the client yet.
          if (Date.now() - fs.statSync(fp).mtimeMs < 60 * 60 * 1000) continue;
          fs.unlinkSync(fp);
        } catch (_) { /* ignore */ }
      }
    }
  } catch (_) {
    /* never block a settings save */
  }
}

module.exports = {
  FILE_URL_PREFIX,
  ALLOWED_FILE_EXT,
  saveUploadedFile,
  getFileForDownload,
  pruneUnreferencedFiles,
  SETTINGS_KEY,
  PLATFORMS,
  MAX_CLIENTS,
  normalizeCustomClients,
  serializeCustomClients,
  enabledForPlatform,
  buildOpenInAppUrl,
  cleanUrlScheme,
};
