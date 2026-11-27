"use strict";

/**
 * Runtime plugin bundles for CloudTAK >= 14.2 (iOS/Android and web).
 *
 * A bundle is a .tar.gz holding exactly manifest.json and index.js, attached to
 * a plugin repo's GitHub release. Publishing is: find the release asset, check
 * the manifest sha256 against index.js, upload it through the CloudTAK admin API
 * and enable it. No SSH, checkout or image rebuild is involved.
 */

const crypto = require("crypto");
const zlib = require("zlib");
const axios = require("axios");
const { guardedAxios } = require("./outboundUrl");
const cloudtakApi = require("./cloudtakApi.service");

const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
const RELEASE_TTL_MS = 10 * 60 * 1000;
const releaseCache = new Map();

class BundleError extends Error {}

/** Minimal ustar reader: returns Map(name -> Buffer) of regular files. */
function readTarGz(buffer) {
  let tar;
  try {
    tar = zlib.gunzipSync(buffer, { maxOutputLength: MAX_BUNDLE_BYTES });
  } catch (err) {
    throw new BundleError("Bundle is not a valid .tar.gz");
  }
  const files = new Map();
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "").replace(/^\.\//, "");
    const size = parseInt(header.toString("utf8", 124, 136).replace(/\0.*$/, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    off += 512;
    if (!Number.isFinite(size) || size < 0 || off + size > tar.length) throw new BundleError("Bundle archive is corrupt");
    if (type === "0" || type === "\0") {
      if (files.has(name)) throw new BundleError("Bundle has a duplicate entry: " + name);
      files.set(name, Buffer.from(tar.subarray(off, off + size)));
    } else if (type !== "x" && type !== "g" && type !== "5") {
      throw new BundleError("Bundle may only contain manifest.json and index.js");
    }
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Validate a bundle buffer. Returns { manifest, sha256 }. Throws BundleError. */
function parseBundle(buffer) {
  if (!buffer || !buffer.length) throw new BundleError("Bundle is empty");
  if (buffer.length > MAX_BUNDLE_BYTES) throw new BundleError("Bundle is larger than 25 MiB");
  const files = readTarGz(buffer);
  const names = [...files.keys()].sort();
  if (names.length !== 2 || names[0] !== "index.js" || names[1] !== "manifest.json") {
    throw new BundleError("Bundle must contain exactly manifest.json and index.js");
  }
  let manifest;
  try {
    manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  } catch (_) {
    throw new BundleError("manifest.json is not valid JSON");
  }
  const name = String((manifest && manifest.name) || "").trim();
  const version = String((manifest && manifest.version) || "").trim();
  if (!name) throw new BundleError("manifest.json has no name");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/.test(version)) throw new BundleError("manifest.json version is not valid");
  const apiVersion = manifest.api_version == null ? 1 : Number(manifest.api_version);
  if (!Number.isInteger(apiVersion) || apiVersion < 1 || apiVersion > cloudtakApi.PLUGIN_API_VERSION) {
    throw new BundleError("Bundle needs plugin API v" + manifest.api_version + " (this portal supports v" + cloudtakApi.PLUGIN_API_VERSION + ")");
  }
  const actual = crypto.createHash("sha256").update(files.get("index.js")).digest("hex");
  if (String(manifest.sha256 || "").toLowerCase() !== actual) {
    throw new BundleError("Bundle sha256 does not match index.js; refusing to upload it");
  }
  return { manifest: { ...manifest, name, version }, sha256: actual };
}

function githubRepo(plugin) {
  const m = String((plugin && plugin.repo) || "").match(/github\.com[:/]+([^/\s]+)\/([^/\s#]+?)(?:\.git)?\/?(?:#.*)?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** True when the plugin only needs a runtime bundle (no server routes, sidecars or core patches). */
function isBundleOnlyLayout(plugin) {
  if (!plugin) return false;
  const sidecars = Array.isArray(plugin.sidecars) ? plugin.sidecars : [];
  return !plugin.routes && !plugin.composeFile && !plugin.composeService && sidecars.length === 0;
}

/**
 * Find the bundle asset on the plugin's GitHub release. Uses the catalog
 * `bundle.asset` name ({version} is replaced) or any *.tar.gz asset.
 * Returns { url, name, tag } or null. Cached for a few minutes.
 */
async function findReleaseBundle(plugin, deps = {}) {
  const gh = githubRepo(plugin);
  if (!gh) return null;
  const key = gh.owner + "/" + gh.repo + "@" + ((plugin.bundle && plugin.bundle.asset) || "");
  const now = Date.now();
  const hit = releaseCache.get(key);
  if (hit && now - hit.at < RELEASE_TTL_MS && !deps.noCache) return hit.value;
  const get = deps.get || ((url, cfg) => guardedAxios(axios).get(url, cfg));
  let value = null;
  try {
    const res = await get(`https://api.github.com/repos/${gh.owner}/${gh.repo}/releases?per_page=10`, {
      timeout: 10000,
      headers: { Accept: "application/vnd.github+json", "User-Agent": "TAK-Portal" },
    });
    const releases = Array.isArray(res.data) ? res.data.filter((r) => r && !r.draft && !r.prerelease) : [];
    for (const rel of releases) {
      const tag = String(rel.tag_name || "");
      const version = tag.replace(/^v(?=\d)/i, "");
      const assets = Array.isArray(rel.assets) ? rel.assets : [];
      const wanted = plugin.bundle && plugin.bundle.asset ? plugin.bundle.asset.replace(/\{version\}/g, version) : "";
      const asset = wanted
        ? assets.find((a) => a && a.name === wanted)
        : assets.find((a) => a && /\.(tar\.gz|tgz)$/i.test(String(a.name || "")));
      if (asset && asset.browser_download_url) {
        value = { url: asset.browser_download_url, name: asset.name, tag, version };
        break;
      }
    }
  } catch (_) {
    value = null;
  }
  releaseCache.set(key, { at: now, value });
  return value;
}

async function downloadBundle(asset, deps = {}) {
  const get = deps.get || ((url, cfg) => guardedAxios(axios).get(url, cfg));
  const res = await get(asset.url, {
    timeout: 60000,
    responseType: "arraybuffer",
    maxContentLength: MAX_BUNDLE_BYTES,
    headers: { "User-Agent": "TAK-Portal" },
  });
  return Buffer.from(res.data);
}

/**
 * Publish a plugin's bundle to CloudTAK and enable it. Never throws for "nothing to do".
 * Returns { status, version?, name?, message? } where status is one of
 * "published" | "already" | "no-bundle" | "unsupported" | "no-api" | "failed".
 */
async function publishPlugin(plugin, { serverVersion, deps } = {}) {
  if (!cloudtakApi.isConfigured()) return { status: "no-api", message: "CloudTAK API token is not set." };
  try {
    const version = serverVersion || (await cloudtakApi.getServerVersion());
    if (!cloudtakApi.supportsBundles(version)) {
      return { status: "unsupported", message: "Needs CloudTAK v" + cloudtakApi.MIN_BUNDLE_CLOUDTAK + " (this server runs v" + version + ")" };
    }
    const asset = await findReleaseBundle(plugin, deps);
    if (!asset) return { status: "no-bundle", message: "No phone bundle in this release." };
    const buffer = await downloadBundle(asset, deps);
    const { manifest } = parseBundle(buffer);
    const { alreadyUploaded } = await cloudtakApi.uploadBundle(buffer, asset.name);
    const existing = await cloudtakApi.findPluginByName(manifest.name);
    if (existing && existing.id) await cloudtakApi.setPluginEnabled(existing.id, true);
    return { status: alreadyUploaded ? "already" : "published", version: manifest.version, name: manifest.name };
  } catch (err) {
    return { status: "failed", message: (err && err.message) || String(err) };
  }
}

/** Remove a published bundle by manifest name. Returns true when it is gone. */
async function unpublishPlugin(name) {
  if (!name || !cloudtakApi.isConfigured()) return false;
  const existing = await cloudtakApi.findPluginByName(name);
  if (existing && existing.id) await cloudtakApi.deletePlugin(existing.id);
  return true;
}

function clearCache() {
  releaseCache.clear();
}

module.exports = {
  BundleError,
  readTarGz,
  parseBundle,
  isBundleOnlyLayout,
  findReleaseBundle,
  downloadBundle,
  publishPlugin,
  unpublishPlugin,
  clearCache,
};
