"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client, utils: sshUtils } = require("ssh2");
const { getString, getInt, getBool } = require("./env");
const takSshSvc = require("./takSsh.service");
const settingsSvc = require("./settings.service");

const DATA_SSH_DIR = path.join(__dirname, "..", "data", "ssh");
const DEFAULT_CLOUDTAK_KEY = path.join(DATA_SSH_DIR, "cloudtak_ssh_ed25519");
const DEFAULT_CLOUDTAK_PUB = `${DEFAULT_CLOUDTAK_KEY}.pub`;

function resolvePathMaybe(p) {
  if (!p || !String(p).trim()) return null;
  const raw = String(p).trim();
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function shellQuote(str) {
  return `'${String(str || "").replace(/'/g, `'\"'\"'`)}'`;
}

function quoteForSingleQuotedShell(str) {
  return String(str || "").replace(/'/g, "'\"'\"'");
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function isUsablePrivateKey(privateKeyText, passphrase) {
  try {
    const parsed = sshUtils.parseKey(String(privateKeyText || ""), passphrase);
    if (parsed instanceof Error) return false;
    if (Array.isArray(parsed)) {
      return parsed.length > 0 && parsed.every((p) => !(p instanceof Error));
    }
    return !!parsed;
  } catch (_) {
    return false;
  }
}

function b64UrlToBuffer(input) {
  const s = String(input || "");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (b64.length % 4)) % 4;
  return Buffer.from(b64 + "=".repeat(padLen), "base64");
}

function packSshString(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length, 0);
  return Buffer.concat([len, b]);
}

function toMpint(buf) {
  let b = Buffer.isBuffer(buf) ? Buffer.from(buf) : Buffer.from(buf || []);
  while (b.length > 0 && b[0] === 0x00) {
    b = b.slice(1);
  }
  if (b.length === 0) return Buffer.alloc(0);
  if (b[0] & 0x80) {
    return Buffer.concat([Buffer.from([0x00]), b]);
  }
  return b;
}

function buildSshRsaPublicFromJwk(jwk, comment) {
  const e = toMpint(b64UrlToBuffer(jwk.e));
  const n = toMpint(b64UrlToBuffer(jwk.n));
  const payload = Buffer.concat([
    packSshString(Buffer.from("ssh-rsa")),
    packSshString(e),
    packSshString(n),
  ]);
  return `ssh-rsa ${payload.toString("base64")} ${comment || "tak-portal-cloudtak"}`;
}

function opensshPublicFromPrivate(privateKeyText, passphrase, comment) {
  const label = comment || "tak-portal-cloudtak";
  try {
    const keyObj = crypto.createPrivateKey({
      key: String(privateKeyText || ""),
      format: "pem",
      passphrase: passphrase || undefined,
    });
    const publicKey = crypto.createPublicKey(keyObj);
    const jwk = publicKey.export({ format: "jwk" });
    if (jwk && jwk.kty === "RSA") return buildSshRsaPublicFromJwk(jwk, label);
  } catch (_) {}
  try {
    const parsed = sshUtils.parseKey(String(privateKeyText || ""), passphrase);
    if (parsed instanceof Error) return null;
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!key || typeof key.getPublicSSH !== "function") return null;
    const pub = key.getPublicSSH();
    const asUtf8 = Buffer.isBuffer(pub) ? pub.toString("utf8") : String(pub || "");
    if (/^(ssh-|ecdsa-)/.test(asUtf8)) {
      const parts = asUtf8.trim().split(/\s+/);
      return `${parts[0]} ${parts[1]} ${label}`;
    }
    const type = (key.type && String(key.type)) || "ssh-rsa";
    const b64 = Buffer.isBuffer(pub) ? pub.toString("base64") : Buffer.from(pub).toString("base64");
    return `${type} ${b64} ${label}`;
  } catch (_) {
    return null;
  }
}

function getLocalKeyStatus() {
  const privateKeyPath =
    resolvePathMaybe(getString("CLOUDTAK_SSH_PRIVATE_KEY_PATH", "")) || DEFAULT_CLOUDTAK_KEY;
  const publicKeyPath =
    resolvePathMaybe(getString("CLOUDTAK_SSH_PUBLIC_KEY_PATH", "")) || DEFAULT_CLOUDTAK_PUB;
  const hasPrivateKey = fs.existsSync(privateKeyPath);
  const hasPublicKey = fs.existsSync(publicKeyPath);
  return {
    privateKeyPath: path.relative(process.cwd(), privateKeyPath).replace(/\\/g, "/"),
    publicKeyPath: path.relative(process.cwd(), publicKeyPath).replace(/\\/g, "/"),
    hasPrivateKey,
    hasPublicKey,
    hasKeyPair: hasPrivateKey && hasPublicKey,
  };
}

function persistKeyPaths(keyStatus) {
  const current = settingsSvc.getSettings() || {};
  const next = { ...current };
  let changed = false;
  if (String(next.CLOUDTAK_SSH_PRIVATE_KEY_PATH || "") !== keyStatus.privateKeyPath) {
    next.CLOUDTAK_SSH_PRIVATE_KEY_PATH = keyStatus.privateKeyPath;
    changed = true;
  }
  if (String(next.CLOUDTAK_SSH_PUBLIC_KEY_PATH || "") !== keyStatus.publicKeyPath) {
    next.CLOUDTAK_SSH_PUBLIC_KEY_PATH = keyStatus.publicKeyPath;
    changed = true;
  }
  if (changed) settingsSvc.saveSettings(next);
}

function ensureCloudtakSshKeyPair() {
  ensureDir(DATA_SSH_DIR);

  const existingPrivate = readKeyFile(DEFAULT_CLOUDTAK_KEY);
  if (existingPrivate && isUsablePrivateKey(existingPrivate, undefined)) {
    if (!fs.existsSync(DEFAULT_CLOUDTAK_PUB)) {
      const derived = opensshPublicFromPrivate(existingPrivate, undefined, "tak-portal-cloudtak");
      if (derived) {
        fs.writeFileSync(DEFAULT_CLOUDTAK_PUB, `${derived.trim()}\n`, { mode: 0o644 });
      }
    }
    const status = getLocalKeyStatus();
    persistKeyPaths(status);
    return status;
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicExponent: 0x10001,
  });
  const privatePem = privateKey.export({ format: "pem", type: "pkcs1" });
  fs.writeFileSync(DEFAULT_CLOUDTAK_KEY, String(privatePem), { mode: 0o600 });

  const jwk = publicKey.export({ format: "jwk" });
  const opensshPublic = buildSshRsaPublicFromJwk(jwk, "tak-portal-cloudtak");
  fs.writeFileSync(DEFAULT_CLOUDTAK_PUB, `${String(opensshPublic).trim()}\n`, { mode: 0o644 });

  const verifyPrivate = fs.readFileSync(DEFAULT_CLOUDTAK_KEY, "utf8");
  if (!isUsablePrivateKey(verifyPrivate, undefined)) {
    throw new Error("Generated CloudTAK private key is not parseable by ssh2.");
  }

  const status = getLocalKeyStatus();
  persistKeyPaths(status);
  return status;
}

function readPublicKeyText(keyStatus) {
  const pubPath = path.resolve(process.cwd(), keyStatus.publicKeyPath);
  if (fs.existsSync(pubPath)) {
    const pub = fs.readFileSync(pubPath, "utf8").trim();
    if (pub) return pub;
  }
  const privPath = path.resolve(process.cwd(), keyStatus.privateKeyPath);
  if (fs.existsSync(privPath)) {
    const derived = opensshPublicFromPrivate(fs.readFileSync(privPath, "utf8"), undefined, "tak-portal-cloudtak");
    if (derived) return derived.trim();
  }
  return "";
}

async function onboardWithPassword({ host, port, username, password }) {
  const h = String(host || "").trim();
  const u = String(username || "").trim();
  const p = String(password || "");
  const sshPort = Number.parseInt(String(port || "22"), 10) || 22;

  if (!h) throw new Error("CloudTAK SSH host is required.");
  if (!u) throw new Error("CloudTAK SSH username is required.");
  if (!p) throw new Error("SSH password is required to generate and install the key.");

  const keyStatus = ensureCloudtakSshKeyPair();
  const pubKey = readPublicKeyText(keyStatus);
  if (!pubKey) throw new Error("Generated public key is empty.");

  const safePub = quoteForSingleQuotedShell(pubKey);
  const addKeyCommand =
    "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys; " +
    `grep -qxF '${safePub}' ~/.ssh/authorized_keys || echo '${safePub}' >> ~/.ssh/authorized_keys`;

  const result = await execOverSsh(
    {
      host: h,
      port: sshPort,
      username: u,
      password: p,
      readyTimeout: 15000,
      tryKeyboard: true,
    },
    addKeyCommand
  );

  if (!result.ok) {
    throw new Error(result.message || "Could not log in with that password to install the SSH key.");
  }

  const current = settingsSvc.getSettings() || {};
  settingsSvc.saveSettings({
    ...current,
    CLOUDTAK_MARKETPLACE_USE_TAK_SSH: "false",
    CLOUDTAK_SSH_HOST: h,
    CLOUDTAK_SSH_PORT: String(sshPort),
    CLOUDTAK_SSH_USER: u,
    CLOUDTAK_SSH_PRIVATE_KEY_PATH: keyStatus.privateKeyPath,
    CLOUDTAK_SSH_PUBLIC_KEY_PATH: keyStatus.publicKeyPath,
  });

  return {
    ok: true,
    keyStatus: getLocalKeyStatus(),
    message: "SSH key generated and installed on the CloudTAK host.",
  };
}

function useTakSsh() {
  return getBool("CLOUDTAK_MARKETPLACE_USE_TAK_SSH", true);
}

function readKeyFile(keyPath) {
  if (!keyPath || !fs.existsSync(keyPath)) return null;
  try {
    return fs.readFileSync(keyPath, "utf8");
  } catch (_) {
    return null;
  }
}

/**
 * @returns {{ host: string, port: number, username: string, privateKey: string, passphrase?: string, readyTimeout: number, source: string } | null}
 */
function getConnectConfig() {
  const tak = takSshSvc.getTakSshConfig();

  if (useTakSsh()) {
    if (!tak) return null;
    return {
      host: tak.host,
      port: tak.port,
      username: tak.username,
      privateKey: tak.privateKey,
      passphrase: tak.passphrase,
      readyTimeout: 15000,
      source: "tak",
    };
  }

  const host = String(getString("CLOUDTAK_SSH_HOST", "")).trim();
  const username = String(getString("CLOUDTAK_SSH_USER", "")).trim();
  if (!host || !username) return null;

  const port = getInt("CLOUDTAK_SSH_PORT", 22) || 22;
  const keyPath =
    resolvePathMaybe(getString("CLOUDTAK_SSH_PRIVATE_KEY_PATH", "")) || DEFAULT_CLOUDTAK_KEY;
  let privateKey = readKeyFile(keyPath);
  let passphrase = getString("CLOUDTAK_SSH_PASSPHRASE", "").trim() || undefined;

  if (!privateKey && tak) {
    privateKey = tak.privateKey;
    passphrase = tak.passphrase;
  }
  if (!privateKey) return null;

  return {
    host,
    port,
    username,
    privateKey,
    passphrase,
    readyTimeout: 15000,
    source: "cloudtak",
    keyPath,
  };
}

function sshStatus() {
  const usingTak = useTakSsh();
  const tak = takSshSvc.getTakSshConfig();
  const cfg = getConnectConfig();
  const dedicatedKeyPath =
    resolvePathMaybe(getString("CLOUDTAK_SSH_PRIVATE_KEY_PATH", "")) || DEFAULT_CLOUDTAK_KEY;
  return {
    useTakSsh: usingTak,
    configured: !!cfg,
    source: cfg ? cfg.source : usingTak ? "tak" : "cloudtak",
    host: cfg ? cfg.host : usingTak ? "" : String(getString("CLOUDTAK_SSH_HOST", "")).trim(),
    port: cfg ? cfg.port : getInt("CLOUDTAK_SSH_PORT", 22) || 22,
    username: cfg ? cfg.username : String(getString("CLOUDTAK_SSH_USER", "")).trim(),
    takConfigured: !!tak,
    hasDedicatedKey: !!(dedicatedKeyPath && fs.existsSync(dedicatedKeyPath)),
    hasKeyPair: getLocalKeyStatus().hasKeyPair,
    checkoutPath: String(getString("CLOUDTAK_MARKETPLACE_PATH", "")).trim(),
    composeService: String(getString("CLOUDTAK_MARKETPLACE_COMPOSE_SERVICE", "")).trim(),
  };
}

// Wide enough that a registry URL and its HTTP status stay on one line.
const SSH_PTY_COLS = 1024;

function ptyExecOptions() {
  return { pty: { term: "xterm", cols: SSH_PTY_COLS, rows: 40 } };
}

/** ssh2 reports this when the server rejects the pty-req (PermitTTY no / no-pty). */
function isPtyRefusal(err) {
  const msg = err && err.message ? String(err.message) : String(err || "");
  return /unable to request a pseudo-terminal/i.test(msg);
}

/** After a host refuses a PTY once, skip PTY on later marketplace SSH in this process. */
let sshPreferNoPty = false;

function resetSshPtyPreference() {
  sshPreferNoPty = false;
}

const PTY_FALLBACK_LOG = "SSH refused a pseudo-terminal; retrying without one";

let activeAbort = null;

function abortActiveCommand() {
  const abort = activeAbort;
  activeAbort = null;
  if (!abort) return false;
  try {
    abort();
  } catch (_) {}
  return true;
}

function sendRemoteInterrupt(stream, signalName) {
  if (!stream) return;
  try {
    if (signalName === "INT" && typeof stream.write === "function") stream.write("\x03");
  } catch (_) {}
  try {
    if (typeof stream.signal === "function") stream.signal(signalName);
  } catch (_) {}
}

function stripAnsi(text) {
  return String(text || "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[()]./g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function feedPtyChunk(hold, chunk) {
  let all = String(hold || "") + String(chunk || "");
  all = all.replace(/\r\n/g, "\n");
  const lines = [];
  let current = "";
  for (let i = 0; i < all.length; i++) {
    const ch = all[i];
    if (ch === "\n") {
      const cleaned = stripAnsi(current).replace(/\s+$/, "");
      if (cleaned) lines.push(cleaned);
      current = "";
    } else if (ch === "\r") {
      // BuildKit/docker often refresh the same TTY line with CR. Emit docker/npm
      // progress so the marketplace rebuild log keeps moving; still collapse git
      // "Counting objects: N%" style churn until the final newline.
      const cleaned = stripAnsi(current).replace(/\s+$/, "");
      if (
        cleaned &&
        cleaned.length >= 12 &&
        /^(?:#\d+|\[+\]|={3}| =>|Step \d|RUN |npm |yarn |pnpm |vite |eslint |tsc |#\s*\d)/.test(cleaned)
      ) {
        lines.push(cleaned);
      }
      current = "";
    } else {
      current += ch;
    }
  }
  return { lines, hold: current };
}

/**
 * Run a remote command over SSH. Prefers a wide PTY for progress when the host
 * allows it. On PTY refusal (#109/#75), tear down and reconnect without a PTY —
 * same-connection retry is not reliable on PermitTTY no hosts.
 *
 * @param {object} connectConfig
 * @param {string} command
 * @param {number} [timeoutMs]
 * @param {((line: string) => void)|null} [onChunk]
 * @param {(() => import("ssh2").Client)|null} [createClient]
 * @param {boolean} [forceNoPty] internal: skip PTY (reconnect path / remembered preference)
 */
function execOverSsh(connectConfig, command, timeoutMs = 30000, onChunk, createClient, forceNoPty) {
  const usePty = !(forceNoPty === true || sshPreferNoPty);
  return new Promise((resolve) => {
    const conn = typeof createClient === "function" ? createClient() : new Client();
    let finished = false;
    let cancelled = false;
    let stream = null;
    let handingOff = false;
    const timers = [];
    const later = (ms, fn) => {
      const id = setTimeout(fn, ms);
      timers.push(id);
      return id;
    };
    const clearTimers = () => {
      while (timers.length) clearTimeout(timers.pop());
    };
    const cancelledPayload = () => ({
      ok: false,
      cancelled: true,
      message: "Cancelled.",
      stdout: "",
      stderr: "",
      exitCode: null,
    });
    const done = (payload) => {
      if (finished || handingOff) return;
      finished = true;
      if (activeAbort === abort) activeAbort = null;
      clearTimeout(t);
      clearTimers();
      try {
        if (cancelled) conn.destroy();
        else conn.end();
      } catch (_) {}
      resolve(payload);
    };
    const abort = () => {
      if (finished || handingOff) return;
      cancelled = true;
      sendRemoteInterrupt(stream, "INT");
      if (!stream) {
        done(cancelledPayload());
        return;
      }
      later(800, () => {
        if (finished || handingOff) return;
        sendRemoteInterrupt(stream, "TERM");
        later(800, () => {
          if (finished || handingOff) return;
          sendRemoteInterrupt(stream, "KILL");
          done(cancelledPayload());
        });
      });
    };
    activeAbort = abort;

    const t = setTimeout(() => {
      done({
        ok: false,
        message: "SSH command timed out.",
        stdout: "",
        stderr: "",
        exitCode: null,
      });
    }, timeoutMs);

    const emit = (text) => {
      if (!onChunk || !text) return;
      const raw = stripAnsi(text).replace(/\s+$/, "");
      if (raw) onChunk(raw);
    };

    const connectOpts = {
      host: connectConfig.host,
      port: connectConfig.port,
      username: connectConfig.username,
      readyTimeout: connectConfig.readyTimeout || 15000,
    };
    if (connectConfig.privateKey) {
      connectOpts.privateKey = connectConfig.privateKey;
      if (connectConfig.passphrase) connectOpts.passphrase = connectConfig.passphrase;
    }
    if (connectConfig.password) {
      connectOpts.password = connectConfig.password;
      connectOpts.tryKeyboard = true;
    }

    const reconnectWithoutPty = () => {
      if (finished || cancelled || handingOff) return;
      handingOff = true;
      sshPreferNoPty = true;
      emit(PTY_FALLBACK_LOG);
      if (activeAbort === abort) activeAbort = null;
      clearTimeout(t);
      clearTimers();
      try {
        conn.destroy();
      } catch (_) {}
      execOverSsh(connectConfig, command, timeoutMs, onChunk, createClient, true).then(resolve);
    };

    conn
      .on("keyboard-interactive", (name, instructions, instructionsLang, prompts, finish) => {
        if (connectConfig && connectConfig.password) {
          finish([String(connectConfig.password)]);
          return;
        }
        finish([]);
      })
      .on("ready", () => {
        if (cancelled) {
          done(cancelledPayload());
          return;
        }
        if (finished || handingOff) return;
        const opts = usePty ? ptyExecOptions() : {};
        try {
          conn.exec(command, opts, (err, strm) => {
            if (finished || handingOff) return;
            if (err) {
              // ssh2 closes the session channel and never sends the command when
              // pty-req fails. A same-connection retry is flaky; reconnect fresh.
              if (usePty && !cancelled && isPtyRefusal(err)) {
                reconnectWithoutPty();
                return;
              }
              if (cancelled) return;
              done({
                ok: false,
                message: err.message || String(err),
                stdout: "",
                stderr: "",
                exitCode: null,
              });
              return;
            }
            stream = strm;
            if (cancelled) {
              sendRemoteInterrupt(stream, "INT");
              return;
            }
            let stdout = "";
            let stderr = "";
            let stdoutHold = "";
            let stderrHold = "";
            const takeLines = (hold, chunk) => {
              const next = feedPtyChunk(hold, chunk);
              next.lines.forEach((line) => emit(line));
              return next.hold;
            };
            stream.on("data", (data) => {
              const s = data.toString();
              stdout += s;
              stdoutHold = takeLines(stdoutHold, s);
            });
            if (stream.stderr && typeof stream.stderr.on === "function") {
              stream.stderr.on("data", (data) => {
                const s = data.toString();
                stderr += s;
                stderrHold = takeLines(stderrHold, s);
              });
            }
            stream.on("close", (code) => {
              emit(stripAnsi(stdoutHold).replace(/\s+$/, ""));
              emit(stripAnsi(stderrHold).replace(/\s+$/, ""));
              if (cancelled) {
                done(cancelledPayload());
                return;
              }
              const exitCode = Number.isInteger(code) ? code : null;
              if (exitCode !== 0) {
                done({
                  ok: false,
                  message: stderr.trim() || stdout.trim() || `Exit code ${exitCode}`,
                  stdout,
                  stderr,
                  exitCode,
                });
                return;
              }
              done({ ok: true, stdout, stderr, exitCode: 0 });
            });
          });
        } catch (err) {
          if (finished || cancelled || handingOff) return;
          done({
            ok: false,
            message: err.message || String(err),
            stdout: "",
            stderr: "",
            exitCode: null,
          });
        }
      })
      .on("error", (err) => {
        if (cancelled || handingOff) return;
        done({
          ok: false,
          message: err.message || String(err),
          stdout: "",
          stderr: "",
          exitCode: null,
        });
      })
      .connect(connectOpts);
  });
}

function sshNotConfiguredPayload() {
  return {
    ok: false,
    message: useTakSsh()
      ? "TAK Server SSH is not configured. Complete SSH setup under Connection & Certificates."
      : "CloudTAK SSH is not configured. Enter host, user, and password, then generate and install a key.",
    stdout: "",
    stderr: "",
    exitCode: null,
  };
}

async function runCommand(command, timeoutMs = 30000, onChunk) {
  const raw = String(command || "").trim();
  if (!raw) {
    return { ok: false, message: "Command is required.", stdout: "", stderr: "", exitCode: null };
  }
  const cfg = getConnectConfig();
  if (!cfg) return sshNotConfiguredPayload();
  return execOverSsh(cfg, raw, timeoutMs, onChunk);
}

/**
 * Upload utf8 content to a remote path via SFTP (avoids ARG_MAX on large bash -lc payloads).
 */
function sftpWriteUtf8(connectConfig, remotePath, contents, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const conn = new Client();
    let finished = false;
    const done = (payload) => {
      if (finished) return;
      finished = true;
      clearTimeout(t);
      try {
        conn.end();
      } catch (_) {}
      resolve(payload);
    };
    const t = setTimeout(() => {
      done({ ok: false, message: "SFTP upload timed out.", stdout: "", stderr: "", exitCode: null });
    }, timeoutMs);

    const connectOpts = {
      host: connectConfig.host,
      port: connectConfig.port,
      username: connectConfig.username,
      readyTimeout: connectConfig.readyTimeout || 15000,
    };
    if (connectConfig.privateKey) {
      connectOpts.privateKey = connectConfig.privateKey;
      if (connectConfig.passphrase) connectOpts.passphrase = connectConfig.passphrase;
    }
    if (connectConfig.password) {
      connectOpts.password = connectConfig.password;
      connectOpts.tryKeyboard = true;
    }

    conn
      .on("keyboard-interactive", (name, instructions, instructionsLang, prompts, finish) => {
        if (connectConfig && connectConfig.password) {
          finish([String(connectConfig.password)]);
          return;
        }
        finish([]);
      })
      .on("ready", () => {
        conn.sftp((err, sftp) => {
          if (err) {
            done({ ok: false, message: err.message || String(err), stdout: "", stderr: "", exitCode: null });
            return;
          }
          const stream = sftp.createWriteStream(remotePath, { mode: 0o600 });
          stream.on("error", (e) => {
            done({ ok: false, message: e.message || String(e), stdout: "", stderr: "", exitCode: null });
          });
          stream.on("close", () => {
            done({ ok: true, stdout: "", stderr: "", exitCode: 0, remotePath });
          });
          stream.end(Buffer.from(String(contents || ""), "utf8"));
        });
      })
      .on("error", (err) => {
        done({ ok: false, message: err.message || String(err), stdout: "", stderr: "", exitCode: null });
      })
      .connect(connectOpts);
  });
}

async function uploadUtf8(remotePath, contents, timeoutMs = 60000) {
  const cfg = getConnectConfig();
  if (!cfg) return sshNotConfiguredPayload();
  const dest = String(remotePath || "").trim();
  if (!dest.startsWith("/")) {
    return { ok: false, message: "Remote path must be absolute.", stdout: "", stderr: "", exitCode: null };
  }
  return sftpWriteUtf8(cfg, dest, contents, timeoutMs);
}

/**
 * Run a large bash script without stuffing it into argv (ARG_MAX).
 * Uploads to /tmp, executes with pty for progress, then deletes.
 */
async function runBashScript(script, timeoutMs = 30000, onChunk) {
  const body = String(script || "");
  if (!body.trim()) {
    return { ok: false, message: "Script is required.", stdout: "", stderr: "", exitCode: null };
  }
  const cfg = getConnectConfig();
  if (!cfg) return sshNotConfiguredPayload();

  const remote = `/tmp/ctak-mp-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.sh`;
  const up = await sftpWriteUtf8(cfg, remote, body.endsWith("\n") ? body : `${body}\n`, Math.min(timeoutMs, 120000));
  if (!up.ok) return up;

  const quoted = shellQuote(remote);
  const result = await execOverSsh(
    cfg,
    `bash ${quoted}; ec=$?; rm -f ${quoted}; exit $ec`,
    timeoutMs,
    onChunk
  );
  return result;
}

/**
 * Shared bash: a directory is a CloudTAK checkout only when api/package.json exists
 * and a compose file resolves under it (COMPOSE_FILE entries or default compose names).
 * Portal reclaim never creates api/package.json, so fabricated leftover trees fail.
 */
function ctakCheckoutOkBash() {
  return `
ctak_checkout_ok() {
  local ct="\${1:-}" envf current f ct_abs
  [ -n "\$ct" ] || return 1
  ct=\${ct%/}
  [ -f "\$ct/api/package.json" ] || return 1
  envf="\$ct/.env"
  if [ -f "\$envf" ]; then
    current=\$(grep -E '^[[:space:]]*COMPOSE_FILE=' "\$envf" | tail -n 1 | cut -d= -f2- || true)
    current=\$(printf '%s' "\$current" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*\$//' -e 's/^"//' -e 's/"\$//' -e "s/^'//" -e "s/'\$//")
    if [ -n "\$current" ]; then
      ct_abs=\$(cd "\$ct" 2>/dev/null && pwd -P || printf '%s' "\$ct")
      local IFS=':'
      for f in \$current; do
        [ -n "\$f" ] || continue
        case "\$f" in *..*) continue ;; esac
        case "\$f" in
          "\$ct_abs"/*|"\$ct"/*)
            [ -f "\$f" ] && return 0
            f=\${f#"\$ct_abs"/}
            f=\${f#"\$ct"/}
            [ -f "\$ct/\$f" ] && return 0
            ;;
          /*) continue ;;
          *)
            [ -f "\$ct/\$f" ] && return 0
            ;;
        esac
      done
    fi
  fi
  [ -f "\$ct/docker-compose.yml" ] \\
    || [ -f "\$ct/docker-compose.yaml" ] \\
    || [ -f "\$ct/compose.yml" ] \\
    || [ -f "\$ct/compose.yaml" ]
}

ctak_checkout_reason() {
  local ct="\${1:-}"
  [ -n "\$ct" ] || { printf '%s' "empty path"; return 0; }
  ct=\${ct%/}
  if [ ! -d "\$ct" ]; then
    printf '%s' "directory missing"
    return 0
  fi
  if [ ! -f "\$ct/api/package.json" ]; then
    printf '%s' "missing api/package.json"
    return 0
  fi
  if ! ctak_checkout_ok "\$ct"; then
    printf '%s' "no compose file under checkout"
    return 0
  fi
  printf '%s' "ok"
  return 0
}

ctak_package_looks_like_cloudtak() {
  local pkg="\${1:-}/api/package.json"
  [ -f "\$pkg" ] || return 1
  grep -qiE 'cloudtak|@tak-ps' "\$pkg"
}
`.trim();
}

function detectScript() {
  const wantSvc = String(getString("CLOUDTAK_MARKETPLACE_COMPOSE_SERVICE", "")).trim() || "api";
  return `
set -eu
# infra-TAK: broker PATH shims so docker works for non-root takwerx.
if [ -d /opt/infratak/.shims ]; then
  case ":\${PATH:-}:" in
    *:/opt/infratak/.shims:*) ;;
    *) export PATH="/opt/infratak/.shims:\${PATH:-/usr/bin:/bin}" ;;
  esac
fi
${ctakCheckoutOkBash()}
consider() {
  local d="\$1"
  [ -n "\$d" ] || return 1
  d=\${d%/}
  if ctak_checkout_ok "\$d"; then
    found="\$d"
    return 0
  fi
  return 1
}
found=""
# Prefer the running CloudTAK compose project's working_dir when Docker is available.
if command -v docker >/dev/null 2>&1; then
  while IFS= read -r c; do
    [ -n "\$c" ] || continue
    svc=\$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "\$c" 2>/dev/null || true)
    case "\$svc" in
      api|cloudtak-api|${wantSvc.replace(/[^a-zA-Z0-9._-]/g, "")}) ;;
      *) continue ;;
    esac
    wd=\$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "\$c" 2>/dev/null || true)
    [ -n "\$wd" ] || continue
    if ctak_checkout_ok "\$wd" && ctak_package_looks_like_cloudtak "\$wd"; then
      found="\$wd"
      break
    fi
  done <<CONTAINERS
\$(docker ps --format '{{.Names}}' 2>/dev/null || true)
CONTAINERS
fi
if [ -z "\$found" ]; then
  if [ -n "\${CLOUDTAK:-}" ]; then consider "\$CLOUDTAK" || true; fi
fi
if [ -z "\$found" ]; then
  for d in \\
    "\$HOME/CloudTAK" "\$HOME/cloudtak" "\$HOME/src/CloudTAK" "\$HOME/git/CloudTAK" "\$HOME/apps/CloudTAK" \\
    /home/takwerx/CloudTAK /home/tak/CloudTAK /opt/CloudTAK /opt/cloudtak \\
    /root/CloudTAK /root/cloudtak /usr/local/CloudTAK /var/lib/CloudTAK
  do
    [ -z "\$found" ] || break
    consider "\$d" || true
  done
fi
if [ -z "\$found" ]; then
  for d in /home/*/CloudTAK /home/*/cloudtak /opt/*/CloudTAK; do
    [ -z "\$found" ] || break
    consider "\$d" || true
  done
fi
if [ -z "\$found" ]; then
  while IFS= read -r d; do
    [ -n "\$d" ] || continue
    case "\$d" in
      */app/plugins)
        consider "\$(dirname "\$(dirname "\$d")")" && break
        ;;
      */api/web/plugins)
        consider "\$(dirname "\$(dirname "\$(dirname "\$d")")")" && break
        ;;
      *)
        consider "\$d" && break
        ;;
    esac
  done <<EOF
\$(find /home /opt /root /usr/local /var/lib -maxdepth 5 -type d \\( -iname CloudTAK -o -path '*/api/web/plugins' -o -path '*/app/plugins' \\) 2>/dev/null | head -n 40 || true)
EOF
fi
if [ -z "\$found" ] && command -v docker >/dev/null 2>&1; then
  while IFS= read -r c; do
    [ -n "\$c" ] || continue
    echo "\$c" | grep -qiE 'cloudtak|takwerx' || continue
    while IFS=\$'\\t' read -r src dest; do
      [ -n "\${src:-}" ] || continue
      case "\$src" in
        *[Cc]loud[Tt][Aa][Kk]*) consider "\$src" && break 2 ;;
      esac
      case "\$dest" in
        */api/web/plugins|*/web/plugins|*/app/plugins)
          consider "\$src" && break 2
          consider "\$(dirname "\$src")" && break 2
          consider "\$(dirname "\$(dirname "\$src")")" && break 2
          consider "\$(dirname "\$(dirname "\$(dirname "\$src")")")" && break 2
          ;;
        */api)
          consider "\$(dirname "\$src")" && break 2
          ;;
      esac
    done <<MOUNTS
\$(docker inspect -f '{{range .Mounts}}{{.Source}}	{{.Destination}}{{println}}{{end}}' "\$c" 2>/dev/null || true)
MOUNTS
  done <<CONTAINERS
\$(docker ps --format '{{.Names}}' 2>/dev/null || true)
CONTAINERS
fi
if [ -z "\$found" ]; then
  echo "DETECT_FAIL no CloudTAK checkout with api/package.json and a compose file"
  exit 1
fi
compose=""
svc=""
if [ -f "\$found/docker-compose.yml" ]; then compose="docker-compose.yml"
elif [ -f "\$found/docker-compose.yaml" ]; then compose="docker-compose.yaml"
elif [ -f "\$found/compose.yml" ]; then compose="compose.yml"
elif [ -f "\$found/compose.yaml" ]; then compose="compose.yaml"
fi
if [ -z "\$compose" ] && [ -f "\$found/.env" ]; then
  _cf=\$(grep -E '^[[:space:]]*COMPOSE_FILE=' "\$found/.env" | tail -n 1 | cut -d= -f2- || true)
  _cf=\$(printf '%s' "\$_cf" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*\$//' -e 's/^"//' -e 's/"\$//' -e "s/^'//" -e "s/'\$//")
  _ct_abs=\$(cd "\$found" 2>/dev/null && pwd -P || printf '%s' "\$found")
  IFS=':' read -r -a _cffiles <<< "\$_cf"
  for _f in "\${_cffiles[@]}"; do
    [ -n "\$_f" ] || continue
    case "\$_f" in
      "\$_ct_abs"/*) _f="\${_f#\$_ct_abs/}" ;;
      "\$found"/*) _f="\${_f#\$found/}" ;;
    esac
    case "\$_f" in /*) continue ;; esac
    if [ -f "\$found/\$_f" ]; then compose="\$_f"; break; fi
  done
fi
if [ -n "\$compose" ]; then
  cf="\$found/\$compose"
  if grep -Eq '^[[:space:]]*cloudtak-api:' "\$cf"; then svc="cloudtak-api"
  elif grep -Eq '^[[:space:]]*api:' "\$cf"; then svc="api"
  elif grep -q 'build:[[:space:]]*\\./api' "\$cf"; then
    svc=\$(awk '
      /^[[:space:]]*[A-Za-z0-9._-]+:[[:space:]]*$/ { cur=\$1; sub(":","",cur) }
      /build:[[:space:]]*\\.\\/api/ { print cur; exit }
    ' "\$cf")
  fi
fi
printf 'DETECT_OK path=%s compose=%s service=%s\\n' "\$found" "\$compose" "\${svc:-api}"
`.trim();
}

/** Probe a specific path: CHECKOUT_OK / CHECKOUT_INVALID reason=... / optionally RUNNING_DIR=... */
function probeCheckoutScript(ctPath) {
  const wantSvc = String(getString("CLOUDTAK_MARKETPLACE_COMPOSE_SERVICE", "")).trim() || "api";
  return `
set -eu
if [ -d /opt/infratak/.shims ]; then
  case ":\${PATH:-}:" in
    *:/opt/infratak/.shims:*) ;;
    *) export PATH="/opt/infratak/.shims:\${PATH:-/usr/bin:/bin}" ;;
  esac
fi
${ctakCheckoutOkBash()}
CT=${shellQuote(ctPath)}
reason=\$(ctak_checkout_reason "\$CT")
running=""
if command -v docker >/dev/null 2>&1; then
  while IFS= read -r c; do
    [ -n "\$c" ] || continue
    svc=\$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "\$c" 2>/dev/null || true)
    case "\$svc" in
      api|cloudtak-api|${wantSvc.replace(/[^a-zA-Z0-9._-]/g, "")}) ;;
      *) continue ;;
    esac
    wd=\$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "\$c" 2>/dev/null || true)
    [ -n "\$wd" ] || continue
    if ctak_checkout_ok "\$wd" && ctak_package_looks_like_cloudtak "\$wd"; then
      running="\$wd"
      break
    fi
  done <<CONTAINERS
\$(docker ps --format '{{.Names}}' 2>/dev/null || true)
CONTAINERS
fi
if [ "\$reason" = "ok" ]; then
  if [ -n "\$running" ] && [ "\$running" != "\$CT" ] && [ "\$(cd "\$CT" 2>/dev/null && pwd -P)" != "\$(cd "\$running" 2>/dev/null && pwd -P)" ]; then
    printf 'CHECKOUT_OK path=%s RUNNING_DIR=%s\\n' "\$CT" "\$running"
  else
    printf 'CHECKOUT_OK path=%s\\n' "\$CT"
  fi
  exit 0
fi
printf 'CHECKOUT_INVALID path=%s reason=%s\\n' "\$CT" "\$reason"
exit 0
`.trim();
}

async function detectCheckout() {
  const result = await runCommand(`bash -lc ${shellQuote(detectScript())}`, 40000);
  if (!result.ok) return result;
  const line = String(result.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.startsWith("DETECT_OK"));
  if (!line) {
    return { ok: false, message: result.stdout || result.message || "Detect failed." };
  }
  const pathMatch = line.match(/path=(\S+)/);
  const composeMatch = line.match(/compose=(\S+)/);
  const svcMatch = line.match(/service=(\S+)/);
  return {
    ok: true,
    path: pathMatch ? pathMatch[1] : "",
    composeFile: composeMatch && composeMatch[1] !== "" ? composeMatch[1] : "",
    composeService: svcMatch ? svcMatch[1] : "api",
    stdout: result.stdout,
  };
}

async function testConnection() {
  const cfg = getConnectConfig();
  if (!cfg) {
    return {
      ok: false,
      message: useTakSsh()
        ? "TAK Server SSH is not configured. Complete SSH setup under Connection & Certificates."
        : "CloudTAK SSH is not configured. Enter host, user, and password, then generate and install a key.",
    };
  }
  const uname = await runCommand("uname -s && whoami && echo HOST:$(hostname)", 15000);
  if (!uname.ok) {
    return {
      ok: false,
      message: uname.message || "SSH failed.",
      host: cfg.host,
      source: cfg.source,
    };
  }
  const override = String(getString("CLOUDTAK_MARKETPLACE_PATH", "")).trim();
  let detected = null;
  if (override) {
    const check = await runCommand(
      `bash -lc ${shellQuote(probeCheckoutScript(override))}`,
      40000
    );
    const out = String(check.stdout || "");
    const okPath = /CHECKOUT_OK/.test(out);
    const reasonMatch = out.match(/reason=(.+)$/m);
    detected = {
      path: override,
      composeService: String(getString("CLOUDTAK_MARKETPLACE_COMPOSE_SERVICE", "")).trim() || "api",
      pathOk: okPath,
      reason: reasonMatch ? reasonMatch[1].trim() : "",
    };
    if (!okPath) {
      return {
        ok: false,
        message: check.ok
          ? `Connected, but CloudTAK path ${override} is not a checkout (${detected.reason || "missing api/package.json or compose"}).`
          : `Connected, but could not verify CloudTAK path ${override}: ${check.message || "probe failed"}`,
        host: cfg.host,
        username: cfg.username,
        source: cfg.source,
        uname: String(uname.stdout || "").trim(),
        detected,
      };
    }
  } else {
    detected = await detectCheckout();
    if (!detected.ok) {
      return {
        ok: false,
        message: `Connected, but could not find a CloudTAK checkout: ${detected.message || "not found"}`,
        host: cfg.host,
        username: cfg.username,
        source: cfg.source,
        uname: String(uname.stdout || "").trim(),
      };
    }
  }
  return {
    ok: true,
    message: "SSH connected.",
    host: cfg.host,
    username: cfg.username,
    source: cfg.source,
    uname: String(uname.stdout || "").trim(),
    path: detected.path,
    composeService:
      String(getString("CLOUDTAK_MARKETPLACE_COMPOSE_SERVICE", "")).trim() ||
      detected.composeService ||
      "api",
    composeFile: detected.composeFile || "",
  };
}

function resolvedCheckoutPath() {
  return String(getString("CLOUDTAK_MARKETPLACE_PATH", "")).trim();
}

function resolvedComposeService() {
  return String(getString("CLOUDTAK_MARKETPLACE_COMPOSE_SERVICE", "")).trim() || "api";
}

module.exports = {
  DEFAULT_CLOUDTAK_KEY,
  DEFAULT_CLOUDTAK_PUB,
  useTakSsh,
  getConnectConfig,
  sshStatus,
  getLocalKeyStatus,
  ensureCloudtakSshKeyPair,
  onboardWithPassword,
  runCommand,
  runBashScript,
  uploadUtf8,
  abortActiveCommand,
  sendRemoteInterrupt,
  stripAnsi,
  feedPtyChunk,
  SSH_PTY_COLS,
  PTY_FALLBACK_LOG,
  isPtyRefusal,
  resetSshPtyPreference,
  execOverSsh,
  ctakCheckoutOkBash,
  detectScript,
  probeCheckoutScript,
  detectCheckout,
  testConnection,
  shellQuote,
  resolvedCheckoutPath,
  resolvedComposeService,
};
