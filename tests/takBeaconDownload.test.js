const assert = require("assert");
const fs = require("fs");
const path = require("path");
const svc = require("../services/takBeaconDownload.service");

svc._resetCacheForTests();

const pluginUrl =
  "https://github.com/cfd2474/TAK_Beacon/releases/download/v1.4.9/ATAK-Plugin-TAKBeacon-1.4.9--5.8.0-civ-release.apk";
const appUrl =
  "https://github.com/cfd2474/TAK_Beacon/releases/download/v1.4.9/TAKBeacon-app-1.4.9.apk";

assert.strictEqual(svc.isAllowedBeaconApkUrl(appUrl), true);
assert.strictEqual(svc.isAllowedBeaconApkUrl(pluginUrl), false);
assert.strictEqual(
  svc.isAllowedBeaconApkUrl(
    "https://evil.example/cfd2474/TAK_Beacon/releases/download/v1/TAKBeacon-app-1.apk"
  ),
  false
);

const picked = svc.pickStandaloneApkAsset({
  tag_name: "v1.4.9",
  assets: [
    {
      name: "ATAK-Plugin-TAKBeacon-1.4.9--5.8.0-civ-release.apk",
      browser_download_url: pluginUrl,
    },
    {
      name: "TAKBeacon-app-1.4.9.apk",
      browser_download_url: appUrl,
    },
  ],
});
assert.ok(picked, "must pick standalone app asset");
assert.strictEqual(picked.name, "TAKBeacon-app-1.4.9.apk");
assert.strictEqual(picked.downloadUrl, appUrl);
assert.strictEqual(picked.tag, "v1.4.9");

assert.strictEqual(
  svc.pickStandaloneApkAsset({
    tag_name: "v1.4.9",
    assets: [
      {
        name: "ATAK-Plugin-TAKBeacon-1.4.9--5.8.0-civ-release.apk",
        browser_download_url: pluginUrl,
      },
    ],
  }),
  null,
  "must not treat plugin APK as standalone"
);

const setupSrc = fs.readFileSync(
  path.join(__dirname, "..", "views", "setup-my-device.ejs"),
  "utf8"
);
assert.ok(
  setupSrc.includes('href="/api/tak-beacon/download"'),
  "setup-my-device download button must hit the portal TAK Beacon download API"
);
assert.ok(
  !/tak_beacon[\s\S]{0,600}href="https:\/\/github\.com\/cfd2474\/TAK_Beacon"/.test(
    setupSrc
  ),
  "setup-my-device must not link the TAK Beacon repo page for download"
);

const serverSrc = fs.readFileSync(
  path.join(__dirname, "..", "server.js"),
  "utf8"
);
assert.ok(
  serverSrc.includes("takBeaconDownloadSvc.DOWNLOAD_PATH") ||
    serverSrc.includes("/api/tak-beacon/download"),
  "server must expose /api/tak-beacon/download"
);

const permsSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "permissions.registry.js"),
  "utf8"
);
assert.ok(
  permsSrc.includes("/api/tak-beacon/download"),
  "permissions registry must allow TAK Beacon download for setup users"
);

console.log("takBeaconDownload.test.js: passed");
