const assert = require("assert");
const fs = require("fs");
const path = require("path");

const settingsSrc = fs.readFileSync(
  path.join(__dirname, "..", "views", "settings.ejs"),
  "utf8"
);
const setupSrc = fs.readFileSync(
  path.join(__dirname, "..", "views", "setup-my-device.ejs"),
  "utf8"
);
const catalogSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "backup", "catalog.js"),
  "utf8"
);

assert.ok(
  settingsSrc.includes("ALLOWED_CLIENT_TAK_BEACON"),
  "settings must persist ALLOWED_CLIENT_TAK_BEACON"
);
assert.ok(
  /tak_beacon:\s*\{\s*key:\s*"ALLOWED_CLIENT_TAK_BEACON",\s*label:\s*"TAK Beacon",\s*defaultOn:\s*"false"/.test(
    settingsSrc
  ),
  "settings Android clients must include TAK Beacon off by default"
);
assert.ok(
  /allowedClientBool\(\s*"ALLOWED_CLIENT_TAK_BEACON",\s*false\s*\)/.test(setupSrc),
  "setup-my-device must default TAK Beacon off"
);
assert.ok(
  /ALLOWED_CLIENT_ORDER_ANDROID[\s\S]{0,80}\["atak",\s*"tak_beacon"\]/.test(
    settingsSrc
  ),
  "settings Android client order defaults must include tak_beacon after atak"
);

assert.ok(
  setupSrc.includes("ALLOWED_CLIENT_TAK_BEACON"),
  "setup-my-device must honor ALLOWED_CLIENT_TAK_BEACON"
);
assert.ok(
  setupSrc.includes("https://github.com/cfd2474/TAK_Beacon"),
  "setup-my-device must link the standalone TAK Beacon GitHub download"
);
assert.ok(
  setupSrc.includes("Download the standalone TAK Beacon app for Android devices."),
  "setup-my-device TAK Beacon tile must describe the standalone app"
);
assert.ok(
  !/tak_beacon[\s\S]{0,800}Step 2: Enroll/.test(setupSrc),
  "setup-my-device must not list TAK Beacon enrollment instructions"
);

assert.ok(
  catalogSrc.includes("ALLOWED_CLIENT_TAK_BEACON"),
  "backup catalog must include ALLOWED_CLIENT_TAK_BEACON"
);

console.log("takBeaconClient.test.js: passed");
