"use strict";

// Docker TAK Server support (TAK-Portal #61, #27). Settings come from process.env here.
const assert = require("assert");
const mode = require("../services/takServerMode.service");
const qr = require("../services/qr.service");
const takSsh = require("../services/takSsh.service");

function reset() {
  delete process.env.TAK_SERVER_MODE;
  delete process.env.TAK_DOCKER_CONTAINER;
  delete process.env.TAK_ENROLL_HOST;
  process.env.TAK_URL = "https://takserver-internal:8443/Marti";
}

const baseHost = () => new URL(qr.getTakUrl()).hostname;
const nopass = { mode: "nopasswd" };
const asTak = { runAsUser: "tak" };

// Standard (default) is unchanged.
reset();
assert.strictEqual(mode.getTakServerMode(), "standard");
assert.strictEqual(
  takSsh.buildPrivilegedCommand("cat /opt/tak/CoreConfig.xml", nopass),
  "sudo -n cat /opt/tak/CoreConfig.xml"
);
assert.strictEqual(
  takSsh.buildPrivilegedCommand("systemctl restart takserver", nopass),
  "sudo -n systemctl restart takserver"
);
assert.strictEqual(qr.getTakHost(), baseHost());

// Docker mode.
process.env.TAK_SERVER_MODE = "docker";
assert.strictEqual(mode.getDockerContainer(), "takserver");
assert.strictEqual(
  takSsh.buildPrivilegedCommand("systemctl restart takserver", nopass),
  "sudo -n docker restart takserver"
);
assert.strictEqual(
  takSsh.buildPrivilegedCommand("cat /opt/tak/CoreConfig.xml", nopass),
  "sudo -n docker exec -i takserver cat /opt/tak/CoreConfig.xml"
);
assert.strictEqual(
  takSsh.buildPrivilegedCommand("bash -lc 'cd /opt/tak/certs'", nopass, asTak),
  "sudo -n docker exec -i -u tak takserver bash -lc 'cd /opt/tak/certs'"
);
// Root SSH user: no sudo prefix, still goes through the container.
assert.strictEqual(
  takSsh.buildPrivilegedCommand("bash -lc 'cd /opt/tak/certs'", { mode: "root" }, asTak),
  "docker exec -i -u tak takserver bash -lc 'cd /opt/tak/certs'"
);
// Stored-password repair path (formerly bypassed the rewrite and hit host /opt/tak).
const repair = takSsh.buildPrivilegedCommand("bash -lc 'chown -R tak:tak /opt/tak/certs'", { mode: "password", password: "pw" });
assert.ok(repair.includes("-S -p '' docker exec -i takserver bash"), repair);
// Non-TAK commands are untouched.
assert.strictEqual(takSsh.buildPrivilegedCommand("reboot", nopass), "sudo -n reboot");
// CoreConfig write goes into the container.
assert.strictEqual(
  takSsh.buildPrivilegedTeeCommand("/opt/tak/CoreConfig.xml", nopass),
  "sudo -n docker exec -i takserver tee '/opt/tak/CoreConfig.xml' > /dev/null"
);
// Custom and invalid container names.
process.env.TAK_DOCKER_CONTAINER = "tak-prod_1";
assert.strictEqual(mode.getDockerContainer(), "tak-prod_1");
process.env.TAK_DOCKER_CONTAINER = "x; rm -rf /";
assert.strictEqual(mode.getDockerContainer(), "takserver", "unsafe name falls back to default");
// Sudoers lists only the configured container, and only in Docker mode.
process.env.TAK_DOCKER_CONTAINER = "tak-prod_1";
const sudoers = takSsh.buildPortalSudoersInstallScript("portal");
assert.ok(sudoers.includes("exec -i -u tak tak-prod_1 *"));
assert.ok(sudoers.includes("restart tak-prod_1"));
reset();
assert.ok(!takSsh.buildPortalSudoersInstallScript("portal").includes("DOCKER"));

// "unknown user tak" on a native-mode config gets a Docker hint (ops #36); Docker mode adds nothing.
const sudoErr = "sudo: unknown user tak\nsudo: error initializing audit plugin sudoers_audit";
assert.ok(takSsh.withMissingTakUserHint(sudoErr).includes("TAK Server mode to Docker"));
assert.strictEqual(takSsh.withMissingTakUserHint("other failure"), "other failure");
process.env.TAK_SERVER_MODE = "docker";
assert.strictEqual(takSsh.withMissingTakUserHint(sudoErr), sudoErr);
reset();

// External enrollment host (#27).
process.env.TAK_ENROLL_HOST = "tak.example.gov";
assert.strictEqual(qr.getTakHost(), "tak.example.gov");
assert.ok(qr.buildEnrollUrl({ username: "u", token: "t" }).includes("host=tak.example.gov"));
process.env.TAK_ENROLL_HOST = "https://bad host/";
assert.strictEqual(qr.getTakHost(), baseHost(), "invalid enroll host is ignored");
reset();

console.log("takServerMode tests passed");
