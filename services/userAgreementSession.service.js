const mouStore = require("./mouStore");

const USER_AGREEMENT_SESSION_COOKIE = "mou_user_agreement_session";

function getCookieValue(req, cookieName) {
  const pair = String(req.headers.cookie || "")
    .split(/;\s*/)
    .map((entry) => entry.split("="))
    .find(([key]) => String(key || "").trim() === cookieName);
  if (!pair) return "";
  const rawValue = String(pair[1] || "").trim();
  try {
    return decodeURIComponent(rawValue);
  } catch {
    return rawValue;
  }
}

function getAuthentikJwt(req) {
  const rawHeader = req?.headers?.["x-authentik-jwt"];
  const rawValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const token = String(rawValue || "").trim();
  if (!token) return "";
  const parts = token.split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : token;
}

function decodeBase64UrlJson(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function getAuthentikJwtPayload(req) {
  const token = getAuthentikJwt(req);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  return decodeBase64UrlJson(parts[1]);
}

function getAgreementLoginMarker(req) {
  const payload = getAuthentikJwtPayload(req);
  if (!payload || typeof payload !== "object") return "";
  const markerCandidates = [
    ["sid", payload.sid],
    ["session", payload.session_id || payload.sessionId || payload.session],
    ["auth", payload.auth_time],
    ["iat", payload.iat],
  ];
  for (const [prefix, value] of markerCandidates) {
    if (value === undefined || value === null || value === "") continue;
    return `${prefix}:${String(value).trim()}`;
  }
  return "";
}

function agreementUserKey(user) {
  return String(user?.uid || user?.username || "")
    .trim()
    .toLowerCase();
}

function agreementVersion(agreement) {
  return Number(agreement?.version || 0) || 0;
}

function buildAgreementSessionValue(req, user, agreement) {
  const userKey = agreementUserKey(user);
  const version = agreementVersion(agreement);
  if (!userKey || !version) return "";
  const loginMarker = getAgreementLoginMarker(req);
  return loginMarker
    ? `${userKey}:${version}:${loginMarker}`
    : `${userKey}:${version}`;
}

/**
 * Persistent acceptances for bridge clients (CloudTAK Locator) that cannot
 * carry the browser session cookie. Stored on the MOU user-agreement payload.
 */
function loadAcceptanceMap() {
  try {
    mouStore.ensureStorage();
  } catch (_) {
    /* ignore */
  }
  const data = mouStore.loadUserAgreement() || {};
  if (!data.acceptances || typeof data.acceptances !== "object" || Array.isArray(data.acceptances)) {
    data.acceptances = {};
  }
  return data;
}

function hasPersistedAgreementAcceptance(user, agreement) {
  const userKey = agreementUserKey(user);
  const version = agreementVersion(agreement);
  if (!userKey || !version) return false;
  const data = loadAcceptanceMap();
  const row = data.acceptances[userKey];
  return !!(row && Number(row.version) === version);
}

function recordAgreementAcceptance(user, agreement, meta = {}) {
  const userKey = agreementUserKey(user);
  const version = agreementVersion(agreement);
  if (!userKey || !version) {
    throw new Error("Cannot record user agreement acceptance without a user and version.");
  }
  const data = loadAcceptanceMap();
  data.acceptances[userKey] = {
    version,
    acceptedAt: new Date().toISOString(),
    username: String(user?.username || "").trim() || null,
    source: String(meta.source || "api").trim() || "api",
  };
  mouStore.saveUserAgreement(data);
  return data.acceptances[userKey];
}

function hasAcceptedAgreementForSession(req, user, agreement) {
  const cookieOk =
    getCookieValue(req, USER_AGREEMENT_SESSION_COOKIE) ===
    buildAgreementSessionValue(req, user, agreement);
  if (cookieOk) return true;
  // Bridge / plugin accepts persist without a cookie so later locate API calls pass the gate.
  return hasPersistedAgreementAcceptance(user, agreement);
}

module.exports = {
  USER_AGREEMENT_SESSION_COOKIE,
  buildAgreementSessionValue,
  getCookieValue,
  hasAcceptedAgreementForSession,
  hasPersistedAgreementAcceptance,
  recordAgreementAcceptance,
  agreementUserKey,
  agreementVersion,
};
