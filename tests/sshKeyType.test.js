/**
 * SSH key generation offers RSA and FIPS-friendly ECDSA key types (#60).
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { utils } = require("ssh2");
const keySvc = require("../services/takSsh.service");

assert.strictEqual(keySvc.normalizeSshKeyType("bogus"), "rsa");
assert.strictEqual(keySvc.normalizeSshKeyType(undefined), "rsa");

const expected = {
  rsa: "ssh-rsa",
  "ecdsa-256": "ecdsa-sha2-nistp256",
  "ecdsa-384": "ecdsa-sha2-nistp384",
  "ecdsa-521": "ecdsa-sha2-nistp521",
};
for (const [type, sshType] of Object.entries(expected)) {
  const { privatePem, publicOpenssh } = keySvc.generateSshKeyMaterial(type, "t");
  assert.strictEqual(keySvc.detectSshKeyType(privatePem), type);
  assert.ok(publicOpenssh.startsWith(sshType + " "), `${type} public key prefix`);
  assert.strictEqual(utils.parseKey(privatePem).type, sshType);
  assert.strictEqual(utils.parseKey(publicOpenssh).type, sshType);
}

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const settings = read("views/settings.ejs");
assert.ok(settings.includes('id="sshKeyTypeSelect"') && settings.includes("ECDSA P-256"));
assert.ok(settings.includes('id="cloudtakSshKeyTypeSelect"'));
assert.ok(settings.includes("keyType:"));
assert.ok(read("routes/ssh.routes.js").includes("normalizeSshKeyType(body.keyType)"));
assert.ok(read("routes/cloudtakMarketplace.routes.js").includes("keyType: body.keyType"));
console.log("sshKeyType tests passed");
