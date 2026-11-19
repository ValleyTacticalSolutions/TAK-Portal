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
  setupSrc.includes('href="/api/tak-beacon/download"'),
  "setup-my-device must download the latest standalone TAK Beacon APK via portal API"
);
assert.ok(
  setupSrc.includes("Download the latest standalone TAK Beacon app APK for Android devices."),
  "setup-my-device TAK Beacon tile must describe the standalone app APK"
);
assert.ok(
  setupSrc.includes('id="scanQrBtnTakBeacon"'),
  "setup-my-device must offer TAK Beacon enrollment QR (ATAK QR flow)"
);
assert.ok(
  /scanQrBtnTakBeacon[\s\S]{0,200}handleScanClick\("atak"\)/.test(setupSrc),
  "TAK Beacon enrollment QR must reuse the ATAK enroll QR"
);

assert.ok(
  catalogSrc.includes("ALLOWED_CLIENT_TAK_BEACON"),
  "backup catalog must include ALLOWED_CLIENT_TAK_BEACON"
);

console.log("takBeaconClient.test.js: passed");
