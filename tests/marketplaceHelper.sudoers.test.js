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
assert.match(source, /\bapply-caddyfile\b/);
assert.match(source, /runuser -u caddy/);
assert.match(source, /setpriv --reuid=caddy/);
assert.match(source, /chmod 0644/);
assert.match(source, /Caddy rejected the file/);
assert.match(source, /permission denied|EACCES/);
assert.match(source, /inconclusive.*continuing/i);
assert.match(source, /\[ "\$_caddy_mode" = "as_root" \] && caddy_validate_permission_inconclusive/);
assert.match(source, /\/var\/log\/caddy\|\/var\/lib\/caddy/);
assert.doesNotMatch(source, /sed '\/\^\[\[:space:\]\]\*\$\/d'/);
assert.match(source, /as_user/);
assert.match(source, /run_caddy_validate/);
assert.match(source, /\bcleanup-sudoers\b/);
assert.match(source, /\bcompose_file_rel\b/);
assert.match(source, /refusing compose file outside CloudTAK checkout/);
assert.doesNotMatch(source, /refusing absolute or traversal compose file/);
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

const badCaddyPath = runHelper(["apply-caddyfile", "/tmp/evil"], {
  input: "{\n}\n",
});
assert.notStrictEqual(badCaddyPath.status, 0);
assert.match(badCaddyPath.stderr || "", /refusing caddyfile path|invalid caddyfile/i);

const unknown = runHelper(["rm -rf /"]);
assert.notStrictEqual(unknown.status, 0);
assert.match(unknown.stderr || "", /unknown verb|enable marketplace/i);

const MARK_BEGIN = "# BEGIN caddy_validate_permission_inconclusive";
const MARK_END = "# END caddy_validate_permission_inconclusive";
function extractMarked(text) {
  const start = text.indexOf(MARK_BEGIN);
  const end = text.indexOf(MARK_END);
  assert.ok(start !== -1 && end > start, "caddy validate marker missing");
  return text.slice(start, end + MARK_END.length);
}

const caddy = require("../services/cloudtakMarketplace.caddy");
const applyHost = caddy.applyScript({
  b64: Buffer.from("{\n}\n", "utf8").toString("base64"),
  hostPath: "/etc/caddy/Caddyfile",
  via: "systemd",
  validateCmd: "caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile",
  reloadCmd: "systemctl reload caddy",
});
const helperFn = extractMarked(source).replace(/\r\n/g, "\n");
const applyFn = extractMarked(applyHost).replace(/\r\n/g, "\n");
assert.strictEqual(applyFn, helperFn, "deploy script and marketplace-helper must share the validate filter");

const samples = [
  {
    name: "info and warn plus log permission denied",
    expect: "inconclusive",
    sample: [
      '{"level":"info","ts":1,"msg":"using config from file","file":"/tmp/Caddyfile"}',
      '{"level":"info","ts":1,"msg":"adapted config to JSON","adapter":"caddyfile"}',
      '{"level":"warn","ts":1,"msg":"Caddyfile input is not formatted; run caddy fmt --overwrite to fix inconsistencies","adapter":"caddyfile","file":"/tmp/Caddyfile","line":2}',
      'Error: loading initial config: loading new config: setting up custom log log0: opening log writer using &logging.FileWriter{Filename:"/var/log/caddy/takportal-access.log"}: open /var/log/caddy/takportal-access.log: permission denied',
    ].join("\n"),
  },
  {
    name: "json error on the caddy data dir",
    expect: "inconclusive",
    sample: [
      '{"level":"info","msg":"using config from file"}',
      '{"level":"warn","msg":"Caddyfile input is not formatted"}',
      '{"level":"error","msg":"open /var/lib/caddy/.local/share/caddy/instance.uuid: permission denied"}',
    ].join("\n"),
  },
  {
    name: "fatal permission denied on the caddy data dir",
    expect: "inconclusive",
    sample: '{"level":"fatal","msg":"open /var/lib/caddy/locks: permission denied"}',
  },
  {
    name: "EACCES on a caddy log",
    expect: "inconclusive",
    sample: "Error: open /var/log/caddy/takportal-access.log: EACCES",
  },
  {
    name: "syntax error with info lines",
    expect: "reject",
    sample: [
      '{"level":"info","msg":"using config from file","file":"/tmp/Caddyfile"}',
      "Error: adapting config using caddyfile: parsing caddyfile tokens for 'respnd': unrecognized directive: respnd",
    ].join("\n"),
  },
  {
    name: "permission denied on a log plus a real config error",
    expect: "reject",
    sample: [
      '{"level":"error","msg":"open /var/log/caddy/takportal-access.log: permission denied"}',
      '{"level":"error","msg":"unrecognized directive: respnd"}',
    ].join("\n"),
  },
  {
    name: "permission denied importing a root-only file",
    expect: "reject",
    sample: [
      '{"level":"info","msg":"using config from file"}',
      "Error: adapting config using caddyfile: parsing caddyfile tokens for 'import': open /etc/shadow: permission denied",
    ].join("\n"),
  },
  {
    name: "permission denied with no log or data path",
    expect: "reject",
    sample: "Error: open /etc/caddy/secrets: permission denied",
  },
  {
    name: "info and warn only",
    expect: "reject",
    sample: [
      '{"level":"info","msg":"using config from file"}',
      '{"level":"warn","msg":"Caddyfile input is not formatted; permission denied /var/log/caddy/takportal-access.log"}',
    ].join("\n"),
  },
  {
    name: "empty output",
    expect: "reject",
    sample: "",
  },
];

function classify(sample) {
  const script = [
    "set -euo pipefail",
    helperFn,
    "sample=$(cat)",
    'if caddy_validate_permission_inconclusive "$sample"; then',
    "  echo inconclusive",
    "else",
    "  echo reject",
    "fi",
    "",
  ].join("\n");
  return spawnSync(bash, ["-c", script], {
    encoding: "utf8",
    input: sample,
  });
}

for (const item of samples) {
  const result = classify(item.sample);
  assert.strictEqual(result.status, 0, item.name + " " + (result.stderr || result.stdout));
  assert.strictEqual((result.stdout || "").trim(), item.expect, item.name);
}

console.log("marketplaceHelper.sudoers tests passed");
