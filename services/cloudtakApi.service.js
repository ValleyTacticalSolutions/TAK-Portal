"use strict";

/**
 * CloudTAK admin API client (CloudTAK >= 14.2).
 *
 * Auth is a long-lived CloudTAK profile token (`etl.<jwt>`) belonging to a
 * system admin. It is stored encrypted in settings (CLOUDTAK_API_TOKEN) and is
 * never returned to the browser. All calls go through the outbound URL guard,
 * so the CloudTAK host must be the configured CLOUDTAK_API_URL / CLOUDTAK_URL.
 */

const settingsSvc = require("./settings.service");
const cryptoSecrets = require("./cryptoSecrets");
const outbound = require("./outboundUrl");

/** Runtime plugin API version this client understands (CloudTAK PLUGIN_API_VERSION). */
const PLUGIN_API_VERSION = 1;
/** First CloudTAK release with runtime bundle plugins (iOS/Android). */
const MIN_BUNDLE_CLOUDTAK = "14.2.0";
const REQUEST_TIMEOUT_MS = 30000;

class CloudtakApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "CloudtakApiError";
    this.status = status || 0;
    /** "auth" | "not_found" | "already_uploaded" | "unreachable" | "bad_request" | "server" | "not_configured" */
    this.code = code || "server";
  }
}

function cmpVersions(a, b) {
  const parts = (v) =>
    String(v || "").trim().replace(/^v/i, "").split(/[-+]/)[0].split(".").map((p) => parseInt(p, 10) || 0);
  const aa = parts(a);
  const bb = parts(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    if ((aa[i] || 0) !== (bb[i] || 0)) return (aa[i] || 0) < (bb[i] || 0) ? -1 : 1;
  }
  return 0;
}

/** True when this CloudTAK version can run runtime (phone-capable) plugins. */
function supportsBundles(version) {
  return !!version && cmpVersions(version, MIN_BUNDLE_CLOUDTAK) >= 0;
}

function baseUrl() {
  const s = settingsSvc.getSettings();
  const raw = String(s.CLOUDTAK_API_URL || s.CLOUDTAK_URL || "").trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(raw) ? raw : "";
}

function readToken() {
  const s = settingsSvc.getSettings();
  const stored = String(s.CLOUDTAK_API_TOKEN || "").trim();
  if (!stored) return "";
  try {
    return cryptoSecrets.decryptSecret(stored).trim();
  } catch (_) {
    return "";
  }
}

/** True when both an API URL and a token are saved. */
function isConfigured() {
  return !!(baseUrl() && readToken());
}

/** Save (or clear with "") the API token, encrypted. Accepts a bare token or "Bearer <token>". */
function saveToken(token) {
  const clean = String(token || "").trim().replace(/^Bearer\s+/i, "");
  if (clean && !/^etl\.[A-Za-z0-9._-]+$/.test(clean)) {
    throw new CloudtakApiError("That does not look like a CloudTAK API token (it should start with etl.)", 400, "bad_request");
  }
  const current = settingsSvc.getSettings();
  settingsSvc.saveSettings({ ...current, CLOUDTAK_API_TOKEN: clean ? cryptoSecrets.encryptSecret(clean) : "" });
}

async function request(method, apiPath, { body, query, headers, fetchImpl, timeoutMs } = {}) {
  const base = baseUrl();
  const token = readToken();
  if (!base || !token) throw new CloudtakApiError("CloudTAK API is not configured.", 0, "not_configured");
  const url = new URL(base + apiPath);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  const init = {
    method,
    headers: { Authorization: "Bearer " + token, Accept: "application/json", ...(headers || {}) },
    signal: AbortSignal.timeout(timeoutMs || REQUEST_TIMEOUT_MS),
  };
  if (body !== undefined) {
    if (body instanceof FormData) init.body = body;
    else {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
  }
  let res;
  try {
    res = await outbound.guardedFetch(url.toString(), init, fetchImpl ? { fetchImpl } : {});
  } catch (err) {
    throw new CloudtakApiError("Could not reach CloudTAK: " + (err && err.message ? err.message : err), 0, "unreachable");
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }
  if (res.ok) return data;
  const message = (data && (data.message || data.error)) || text.slice(0, 200) || "HTTP " + res.status;
  if (res.status === 401 || res.status === 403) throw new CloudtakApiError("CloudTAK rejected the API token: " + message, res.status, "auth");
  if (res.status === 404) throw new CloudtakApiError(message, 404, "not_found");
  if (res.status === 400 && /has already been uploaded/i.test(message)) throw new CloudtakApiError(message, 400, "already_uploaded");
  if (res.status >= 400 && res.status < 500) throw new CloudtakApiError(message, res.status, "bad_request");
  throw new CloudtakApiError(message, res.status, "server");
}

async function getServerVersion(opts) {
  const data = await request("GET", "/api/server", opts);
  return String((data && data.version) || "").trim();
}

async function listPlugins(opts) {
  const out = [];
  for (let page = 0; page < 20; page += 1) {
    const data = await request("GET", "/api/plugin", { ...opts, query: { limit: 100, page } });
    const items = (data && Array.isArray(data.items) && data.items) || [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

async function findPluginByName(name, opts) {
  const want = String(name || "").trim().toLowerCase();
  return (await listPlugins(opts)).find((p) => String(p.name || "").trim().toLowerCase() === want) || null;
}

/** Upload a .tar.gz bundle (Buffer). "Already uploaded" resolves with { alreadyUploaded: true }. */
async function uploadBundle(buffer, filename, opts) {
  const form = new FormData();
  form.append("bundle", new Blob([buffer], { type: "application/gzip" }), filename || "plugin.tar.gz");
  try {
    const plugin = await request("POST", "/api/plugin/bundle", { ...opts, body: form, timeoutMs: 120000 });
    return { plugin, alreadyUploaded: false };
  } catch (err) {
    if (err instanceof CloudtakApiError && err.code === "already_uploaded") return { plugin: null, alreadyUploaded: true };
    throw err;
  }
}

async function setPluginEnabled(id, enabled, opts) {
  return request("PATCH", "/api/plugin/" + encodeURIComponent(id), { ...opts, body: { enabled: !!enabled } });
}

/** Delete by id. A plugin that is already gone counts as deleted. */
async function deletePlugin(id, opts) {
  try {
    await request("DELETE", "/api/plugin/" + encodeURIComponent(id), opts);
  } catch (err) {
    if (!(err instanceof CloudtakApiError && err.code === "not_found")) throw err;
  }
}

/** Disable/re-enable a CloudTAK user (issue #132). 404 = nothing to do. */
async function setUserDisabled(username, disabled, opts) {
  try {
    await request("PATCH", "/api/user/" + encodeURIComponent(username), { ...opts, body: { disabled: !!disabled } });
    return true;
  } catch (err) {
    if (err instanceof CloudtakApiError && err.code === "not_found") return false;
    throw err;
  }
}

/** Irreversibly erase a CloudTAK user's personal data (issue #132). 404 = nothing to do. */
async function eraseUser(username, opts) {
  try {
    await request("DELETE", "/api/user/" + encodeURIComponent(username), { ...opts, query: { username } });
    return true;
  } catch (err) {
    if (err instanceof CloudtakApiError && err.code === "not_found") return false;
    throw err;
  }
}

/** Token + URL check for the settings page. Never returns the token. */
async function testConnection(opts) {
  if (!isConfigured()) return { ok: false, code: "not_configured", message: "Add the CloudTAK URL and an API token first." };
  try {
    const version = await getServerVersion(opts);
    await request("GET", "/api/user", { ...opts, query: { limit: 1 } }); // admin-only: proves a system admin token
    return { ok: true, version, bundles: supportsBundles(version) };
  } catch (err) {
    if (err instanceof CloudtakApiError) return { ok: false, code: err.code, message: err.message };
    return { ok: false, code: "server", message: String((err && err.message) || err) };
  }
}

module.exports = {
  PLUGIN_API_VERSION,
  MIN_BUNDLE_CLOUDTAK,
  CloudtakApiError,
  supportsBundles,
  baseUrl,
  isConfigured,
  saveToken,
  getServerVersion,
  listPlugins,
  findPluginByName,
  uploadBundle,
  setPluginEnabled,
  deletePlugin,
  setUserDisabled,
  eraseUser,
  testConnection,
};
