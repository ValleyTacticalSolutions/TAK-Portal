"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const takSsh = require("../services/takSsh.service");

function resolveBash() {
  const candidates = ["bash", "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"];
  for (const bin of candidates) {
    const probe = spawnSync(bin, ["-c", "echo ok"], { encoding: "utf8" });
    if (probe.status === 0 && /ok/.test(probe.stdout || "")) return bin;
  }
  throw new Error("bash is required to exercise host-helpers/marketplace-helper");
}

const bash = resolveBash();
const helperSrc = path.join(__dirname, "..", "host-helpers", "marketplace-helper");
assert.ok(fs.existsSync(helperSrc), "host-helpers/marketplace-helper must exist");

const source = fs.readFileSync(helperSrc, "utf8");
assert.match(source, /^#!/);
assert.match(source, /\breclaim\b/);
assert.match(source, /\binstall-plugin\b/);
assert.match(source, /\brebuild\b/);
assert.match(source, /\bwrite-caddy-route\b/);
assert.match(source, /\bcleanup-sudoers\b/);
assert.doesNotMatch(source, /eval\s/);
assert.doesNotMatch(source, /NOPASSWD/);

assert.strictEqual(takSsh.TAK_PORTAL_MARKETPLACE_HELPER, "/usr/local/libexec/tak-portal/marketplace-helper");
assert.strictEqual(takSsh.TAK_PORTAL_MARKETPLACE_SUDOERS_LEFTOVER, "/etc/sudoers.d/tak-portal-marketplace");

const sudoers = takSsh.buildPortalSudoersInstallScript("takwerx");
assert.match(sudoers, /HELPER_PATH='\/usr\/local\/libexec\/tak-portal\/marketplace-helper'/);
assert.match(sudoers, /rm -f "\$LEFTOVER_MARKETPLACE_SUDOERS"/);
assert.match(sudoers, /\$PORTAL_USER ALL=\(root\) NOPASSWD: \$HELPER_PATH/);
assert.doesNotMatch(sudoers, /ALL=\(ALL\)\s+NOPASSWD:\s*ALL/);
assert.match(sudoers, /base64 -d > "\$HELPER_PATH"/);
assert.match(sudoers, /\$PORTAL_USER ALL=\(tak\) NOPASSWD: ALL/);
assert.match(sudoers, /PORTAL_USER='takwerx'/);

const fromRead = takSsh.readMarketplaceHelperSource();
assert.strictEqual(fromRead, source);

function runHelper(args, opts = {}) {
  return spawnSync(bash, [helperSrc, ...args], { encoding: "utf8", ...opts });
}

// Helper rejects bad args without needing root for usage/version when run as current user.
const version = runHelper(["version"]);
assert.strictEqual(version.status, 0, version.stderr || version.stdout);
assert.match(version.stdout, /tak-portal-marketplace-helper/);

const badReclaim = runHelper(["reclaim", "../evil", "root", "root"]);
assert.notStrictEqual(badReclaim.status, 0);
assert.match(badReclaim.stderr || "", /invalid cloudtak path/i);

const badHost = runHelper(["write-caddy-route", "bad host", "plugin"], {
  input: "handle /x {\n}\n",
});
assert.notStrictEqual(badHost.status, 0);

const unknown = runHelper(["rm -rf /"]);
assert.notStrictEqual(unknown.status, 0);
assert.match(unknown.stderr || "", /unknown verb|enable marketplace/i);

console.log("marketplaceHelper.sudoers tests passed");
