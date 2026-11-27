"use strict";

// #189: honor each plugin's minimum CloudTAK version on installs and updates.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const m = require("../services/cloudtakMarketplace.service");

// Min-only declarations parse as {min, max: null}; legacy ranges still work.
assert.deepStrictEqual(m.parsePluginCloudtakRange("MIN_CLOUDTAK=\"14.2.0\""), { min: "14.2.0", max: null });
assert.deepStrictEqual(m.parsePluginCloudtakRange("**Minimum CloudTAK: v14.2.0**"), { min: "14.2.0", max: null });
assert.deepStrictEqual(
  m.parsePluginCloudtakRange("# Supported CloudTAK: v13.109.3 through v13.122.8"),
  { min: "13.109.3", max: "13.122.8" }
);
assert.strictEqual(m.parsePluginCloudtakRange("nothing"), null);

// Mismatch: min-only checks only the minimum (server below / equal / above).
const minOnly = { min: "14.2.0", max: null };
assert.strictEqual(m.cloudtakRangeMismatch("14.1.1", minOnly), "below");
assert.strictEqual(m.cloudtakRangeMismatch("14.2.0", minOnly), "");
assert.strictEqual(m.cloudtakRangeMismatch("14.4.1", minOnly), "");
assert.strictEqual(m.cloudtakRangeMismatch("99.0.0", minOnly), "");

// Blocked message: only when the server is older than the minimum.
assert.strictEqual(m.updateBlockedMessage("14.1.1", "14.2.0"), "Needs CloudTAK v14.2.0 (this server runs v14.1.1)");
assert.strictEqual(m.updateBlockedMessage("14.2.0", "14.2.0"), "");
assert.strictEqual(m.updateBlockedMessage("14.4.1", "14.2.0"), "");
assert.strictEqual(m.updateBlockedMessage("14.4.1", ""), "", "no minimum declared: unchanged");
assert.strictEqual(m.updateBlockedMessage("", "14.2.0"), "", "unknown server version never blocks");

// Remote minimum: package.json cloudtak.minVersion, then README, then install.sh.
(async () => {
  const realGet = axios.get;
  const files = {};
  axios.get = async (url) => {
    const file = String(url).split("/main/")[1];
    if (!(file in files)) throw new Error("404");
    return { data: files[file] };
  };
  try {
    const plugin = (n) => ({ repo: "https://github.com/example/min-" + n, ref: "main" });
    files["package.json"] = { version: "1.0.0", cloudtak: { minVersion: "14.2.0" } };
    assert.strictEqual(await m.remoteMinCloudtakForPlugin(plugin("a")), "14.2.0");
    delete files["package.json"];
    files["plugin/package.json"] = { cloudtak: { minVersion: "14.3.0" } };
    assert.strictEqual(await m.remoteMinCloudtakForPlugin(plugin("b")), "14.3.0");
    delete files["plugin/package.json"];
    files["README.md"] = "# P\n**Minimum CloudTAK: v14.1.0**\n";
    assert.strictEqual(await m.remoteMinCloudtakForPlugin(plugin("c")), "14.1.0");
    delete files["README.md"];
    files["install.sh"] = "#!/bin/bash\nMIN_CLOUDTAK=14.0.5\n";
    assert.strictEqual(await m.remoteMinCloudtakForPlugin(plugin("d")), "14.0.5");
    delete files["install.sh"];
    assert.strictEqual(await m.remoteMinCloudtakForPlugin(plugin("e")), "", "none declared");
  } finally {
    axios.get = realGet;
  }

  // Scan script reports the server version and the parser reads it.
  const script = m.scanRemoteScript("/path/to/CloudTAK", [], {});
  assert.match(script, /CLOUDTAK_VERSION/);
  const parsed = m.parseScanStdout("SCAN_BEGIN\nCLOUDTAK_VERSION 14.4.1\nSCAN_END\n", []);
  assert.strictEqual(parsed.cloudtakVersion, "14.4.1");

  // Fresh install is refused before the host is touched.
  const svc = fs.readFileSync(path.join(__dirname, "..", "services", "cloudtakMarketplace.service.js"), "utf8");
  assert.match(svc, /remoteMinCloudtakForPlugin\(plugin\)[\s\S]{0,120}if \(blocked\) throw[\s\S]{0,200}stageMarketplaceHelperSource/);

  // Card shows the blocked reason.
  const view = fs.readFileSync(path.join(__dirname, "..", "views", "cloudtak-marketplace.ejs"), "utf8");
  assert.match(view, /p\.updateBlocked/);
  assert.match(view, /\.plugin-update-blocked\s*\{[^}]*overflow-wrap/);
  // Legacy vs mobile architecture label.
  const { pluginArchitecture } = require("../services/cloudtakMarketplace.service");
  assert.strictEqual(pluginArchitecture({ rec: null, bundle: null }), "legacy");
  assert.strictEqual(pluginArchitecture({ rec: { installMethod: "ssh" }, bundle: null }), "legacy");
  assert.strictEqual(pluginArchitecture({ rec: null, bundle: { version: "1.0.0" } }), "mobile");
  assert.strictEqual(pluginArchitecture({ rec: { installMethod: "api" }, bundle: null }), "mobile");
  assert.strictEqual(pluginArchitecture({ rec: { bundleName: "x" }, bundle: null }), "mobile");
  assert.match(view, /"v14 Enabled"/);
  assert.match(view, /p\.architecture === "mobile"/);
  assert.ok(!view.includes("Legacy") && !view.includes("Phone app:"), "no Legacy pill and no Phone app line");
  assert.match(view, /\.plugin-arch\s*\{[^}]*white-space/);
  // API connection lives in Settings (above SSH); Marketplace page only shows a red banner.
  const settingsView = fs.readFileSync(path.join(__dirname, "..", "views", "settings.ejs"), "utf8").replace(/\r\n/g, "\n");
  const iApi = settingsView.indexOf("cloudtakApiSaveBtn");
  const iSsh = settingsView.indexOf(">SSH</h3>");
  assert.ok(iApi > 0 && iSsh > iApi, "API connection section sits before the SSH section in Settings");
  assert.ok(!view.includes("mpApiBox") && !view.includes("mpApiToken"), "no API token form on the Marketplace page");
  assert.match(view, /id="mpApiBanner"[^>]*class="mp-banner error"|class="mp-banner error"[^>]*id="mpApiBanner"/);
  assert.match(view, /\.mp-banner\.error\s*\{[^}]*#c0392b/);
  assert.match(view, /api-connection\?test=1/);
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(srv, /api-connection\(\\\/test\)\?/);
  console.log("cloudtakMarketplace minVersion tests passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
