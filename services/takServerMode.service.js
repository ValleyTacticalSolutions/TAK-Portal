/**
 * services/takServerMode.service.js
 *
 * Standard (native install) vs Docker TAK Server. In Docker mode the portal reaches TAK Server's
 * files and service through `docker exec` / `docker restart` on the SSH host instead of
 * /opt/tak on the host, and QR enrollment can advertise a different host than TAK_URL.
 *
 * Settings: TAK_SERVER_MODE ("standard" | "docker"), TAK_DOCKER_CONTAINER (default "takserver"),
 * TAK_ENROLL_HOST (optional external hostname for QR/enrollment; works in either mode).
 */
const { getString } = require("./env");

const DEFAULT_CONTAINER = "takserver";
// Container names: letters/digits first, then letters, digits, _ . -
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$|^\[[0-9a-fA-F:.]+\]$/;

function normalizeMode(raw) {
  return String(raw || "").trim().toLowerCase() === "docker" ? "docker" : "standard";
}

function isValidContainerName(raw) {
  return CONTAINER_RE.test(String(raw || "").trim());
}

/** Bare hostname/IP only (no scheme, port or path). */
function isValidEnrollHost(raw) {
  return HOST_RE.test(String(raw || "").trim());
}

function getTakServerMode() {
  return normalizeMode(getString("TAK_SERVER_MODE", "standard"));
}

function isDockerMode() {
  return getTakServerMode() === "docker";
}

function getDockerContainer() {
  const v = String(getString("TAK_DOCKER_CONTAINER", "") || "").trim();
  return isValidContainerName(v) ? v : DEFAULT_CONTAINER;
}

/** External host for QR/enrollment, or "" when unset/invalid. */
function getEnrollHost() {
  const v = String(getString("TAK_ENROLL_HOST", "") || "").trim();
  return isValidEnrollHost(v) ? v : "";
}

/** True when a command targets TAK Server's own files/service rather than the host. */
function touchesTakServer(innerCommand, runAsUser) {
  return String(runAsUser || "") === "tak" || /\/opt\/tak\b/.test(String(innerCommand || ""));
}

/**
 * Rewrite a native-install command for Docker TAK Server.
 * Commands that don't touch TAK Server come back unchanged. The caller's wrapper still runs the
 * result with privilege, so runAsUser is cleared when rewritten (the user is set in the container).
 * @returns {{ command: string, runAsUser: string, rewritten: boolean }}
 */
function toDockerCommand(innerCommand, runAsUser, container = getDockerContainer()) {
  const inner = String(innerCommand || "").trim();
  if (/^systemctl\s+restart\s+takserver$/.test(inner)) {
    return { command: `docker restart ${container}`, runAsUser: "", rewritten: true };
  }
  if (!touchesTakServer(inner, runAsUser)) {
    return { command: inner, runAsUser: String(runAsUser || ""), rewritten: false };
  }
  const user = String(runAsUser || "") === "tak" ? "-u tak " : "";
  return { command: `docker exec -i ${user}${container} ${inner}`, runAsUser: "", rewritten: true };
}

/** Unprivileged tee into a file inside the container (CoreConfig.xml etc.). */
function dockerTeeInner(escapedPath, container = getDockerContainer()) {
  return `docker exec -i ${container} tee '${escapedPath}' > /dev/null`;
}

module.exports = {
  DEFAULT_CONTAINER,
  normalizeMode,
  isValidContainerName,
  isValidEnrollHost,
  getTakServerMode,
  isDockerMode,
  getDockerContainer,
  getEnrollHost,
  toDockerCommand,
  dockerTeeInner,
};
