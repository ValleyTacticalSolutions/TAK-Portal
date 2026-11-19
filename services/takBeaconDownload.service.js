/**
 * Resolve the latest standalone TAK Beacon app APK (not the ATAK plugin) from GitHub Releases.
 */

const GITHUB_API = "https://api.github.com";
const OWNER = "cfd2474";
const REPO = "TAK_Beacon";
const USER_AGENT = "TAK-Portal-TAK-Beacon";
const CACHE_TTL_MS = 15 * 60 * 1000;

/** Standalone app asset name: TAKBeacon-app-1.4.9.apk (never ATAK-Plugin-…). */
const STANDALONE_APK_RE = /^TAKBeacon-app-.*\.apk$/i;

/** @type {{ expiry: number, downloadUrl: string, name: string, tag: string } | null} */
let cache = null;

/**
 * Pick the standalone app asset from a GitHub release payload.
 * @param {object} release
 * @returns {{ name: string, downloadUrl: string, tag: string } | null}
 */
function pickStandaloneApkAsset(release) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const asset = assets.find((a) => STANDALONE_APK_RE.test(String(a && a.name || "")));
  if (!asset) return null;
  const downloadUrl = String(asset.browser_download_url || "").trim();
  const name = String(asset.name || "").trim();
  if (!downloadUrl || !name) return null;
  if (!isAllowedBeaconApkUrl(downloadUrl)) return null;
  return {
    name,
    downloadUrl,
    tag: String((release && release.tag_name) || "").trim(),
  };
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isAllowedBeaconApkUrl(url) {
  try {
    const u = new URL(String(url || "").trim());
    if (u.protocol !== "https:") return false;
    if (u.hostname !== "github.com") return false;
    const prefix = `/${OWNER}/${REPO}/releases/download/`;
    if (!u.pathname.startsWith(prefix)) return false;
    if (!STANDALONE_APK_RE.test(pathBasename(u.pathname))) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function pathBasename(pathname) {
  const parts = String(pathname || "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

async function fetchLatestRelease() {
  const res = await fetch(
    `${GITHUB_API}/repos/${OWNER}/${REPO}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error(data.message || `GitHub returned ${res.status}`);
    err.statusCode = res.status;
    throw err;
  }
  return data;
}

/**
 * @returns {Promise<{ name: string, downloadUrl: string, tag: string }>}
 */
async function getLatestStandaloneApk() {
  const now = Date.now();
  if (cache && cache.expiry > now && cache.downloadUrl) {
    return {
      name: cache.name,
      downloadUrl: cache.downloadUrl,
      tag: cache.tag,
    };
  }

  const release = await fetchLatestRelease();
  const picked = pickStandaloneApkAsset(release);
  if (!picked) {
    const err = new Error(
      "Latest TAK Beacon release has no standalone app APK (TAKBeacon-app-*.apk)."
    );
    err.statusCode = 404;
    throw err;
  }

  cache = {
    expiry: now + CACHE_TTL_MS,
    downloadUrl: picked.downloadUrl,
    name: picked.name,
    tag: picked.tag,
  };
  return picked;
}

/** @visibleForTesting */
function _resetCacheForTests() {
  cache = null;
}

module.exports = {
  getLatestStandaloneApk,
  pickStandaloneApkAsset,
  isAllowedBeaconApkUrl,
  STANDALONE_APK_RE,
  DOWNLOAD_PATH: "/api/tak-beacon/download",
  _resetCacheForTests,
};
