"use strict";

// CloudTAK API integration (#189 follow-up, #190, #132): API client, runtime bundles,
// API-first install/migration, and user sync. Everything is mocked: no network, SSH or disk.
const assert = require("assert");
const crypto = require("crypto");
const zlib = require("zlib");
const settingsSvc = require("../services/settings.service");
const cryptoSecrets = require("../services/cryptoSecrets");
const outbound = require("../services/outboundUrl");
const store = require("../services/cloudtakMarketplace.store");
const ssh = require("../services/cloudtakMarketplace.ssh");

// ---- in-memory settings (identity "encryption") ----
let settings = { CLOUDTAK_API_URL: "https://cloudtak.example.com", CLOUDTAK_API_TOKEN: "etl.abc.def" };
settingsSvc.getSettings = () => settings;
settingsSvc.saveSettings = (s) => { settings = { ...s }; };
cryptoSecrets.encryptSecret = (t) => "enc:" + t;
cryptoSecrets.decryptSecret = (t) => String(t).replace(/^enc:/, "");

const api = require("../services/cloudtakApi.service");
const bundleSvc = require("../services/cloudtakBundle.service");
const userSync = require("../services/cloudtakUserSync.service");

// ---- tiny tar.gz builder ----
function tarGz(files) {
  const blocks = [];
  for (const [name, data] of Object.entries(files)) {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write("0000644\0", 100);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("0", 156);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}
function makeBundle({ name = "demo", version = "1.2.0", badSha = false, extra = false } = {}) {
  const index = Buffer.from("export default { install() {} }");
  const sha = badSha ? "0".repeat(64) : crypto.createHash("sha256").update(index).digest("hex");
  const files = { "manifest.json": Buffer.from(JSON.stringify({ name, version, sha256: sha, api_version: 1 })), "index.js": index };
  if (extra) files["extra.txt"] = Buffer.from("x");
  return tarGz(files);
}

// ---- mock CloudTAK server through the guarded fetch ----
let serverVersion = "14.4.1";
let plugins = [];
const calls = [];
function installFakeFetch() {
  const real = outbound.guardedFetch;
  outbound.guardedFetch = async (url, init) => {
    const u = new URL(url);
    calls.push(init.method + " " + u.pathname + u.search);
    assert.match(init.headers.Authorization, /^Bearer etl\./);
    const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (u.pathname === "/api/server") return json(200, { version: serverVersion });
    if (u.pathname === "/api/user" && init.method === "GET") return json(200, { items: [] });
    if (u.pathname === "/api/plugin" && init.method === "GET") return json(200, { total: plugins.length, items: plugins });
    if (u.pathname === "/api/plugin/bundle") {
      const file = init.body.get("bundle");
      const buf = Buffer.from(await file.arrayBuffer());
      const { manifest } = bundleSvc.parseBundle(buf);
      if (plugins.some((p) => p.name === manifest.name && p.version === manifest.version)) {
        return json(400, { message: `${manifest.name} ${manifest.version} has already been uploaded` });
      }
      plugins = plugins.filter((p) => p.name !== manifest.name).concat({ id: "id-" + manifest.name, name: manifest.name, version: manifest.version, enabled: false });
      return json(200, plugins[plugins.length - 1]);
    }
    const m = u.pathname.match(/^\/api\/plugin\/([^/]+)$/);
    if (m && init.method === "PATCH") {
      plugins.find((p) => p.id === m[1]).enabled = JSON.parse(init.body).enabled;
      return json(200, {});
    }
    if (m && init.method === "DELETE") {
      plugins = plugins.filter((p) => p.id !== m[1]);
      return json(200, { status: 200 });
    }
    const um = u.pathname.match(/^\/api\/user\/([^/]+)$/);
    if (um && um[1] === "ghost") return json(404, { message: "Not Found" });
    if (um && um[1] === "broken") return json(500, { message: "boom" });
    if (um) return json(200, { status: 200 });
    return json(404, { message: "no route " + u.pathname });
  };
  return () => { outbound.guardedFetch = real; };
}

(async () => {
  // Bundle parsing: valid, bad sha256, extra file, junk.
  assert.strictEqual(bundleSvc.parseBundle(makeBundle()).manifest.name, "demo");
  assert.throws(() => bundleSvc.parseBundle(makeBundle({ badSha: true })), /sha256 does not match/);
  assert.throws(() => bundleSvc.parseBundle(makeBundle({ extra: true })), /exactly manifest.json and index.js/);
  assert.throws(() => bundleSvc.parseBundle(Buffer.from("nope")), /not a valid/);

  // Layout: only bundle-only plugins can skip SSH.
  assert.strictEqual(bundleSvc.isBundleOnlyLayout({ routes: null, sidecars: [] }), true);
  assert.strictEqual(bundleSvc.isBundleOnlyLayout({ routes: { source: "server" }, sidecars: [] }), false);
  assert.strictEqual(bundleSvc.isBundleOnlyLayout({ routes: null, sidecars: [{ dir: "x" }] }), false);

  // supportsBundles: 14.2.0+ only.
  assert.strictEqual(api.supportsBundles("14.1.1"), false);
  assert.strictEqual(api.supportsBundles("14.2.0"), true);
  assert.strictEqual(api.supportsBundles("14.4.1"), true);

  // Token handling: validated, stored encrypted, never plain.
  assert.throws(() => api.saveToken("not-a-token"), /etl\./);
  api.saveToken("Bearer etl.xyz.123");
  assert.strictEqual(settings.CLOUDTAK_API_TOKEN, "enc:etl.xyz.123");
  assert.strictEqual(api.isConfigured(), true);

  const restore = installFakeFetch();
  try {
    const t = await api.testConnection();
    assert.deepStrictEqual({ ok: t.ok, version: t.version, bundles: t.bundles }, { ok: true, version: "14.4.1", bundles: true });

    // Publish: upload + enable; second publish treats "already uploaded" as success.
    const plugin = { id: "demo", name: "Demo", repo: "https://github.com/example/demo", ref: "main", routes: null, sidecars: [], web: { dest: "demo" } };
    const bundle = makeBundle();
    const deps = {
      noCache: true,
      get: async (url) => {
        if (url.includes("api.github.com/repos")) {
          return { data: [{ tag_name: "v1.2.0", assets: [{ name: "demo-1.2.0.tar.gz", browser_download_url: "https://github.com/example/demo/releases/download/v1.2.0/demo-1.2.0.tar.gz" }] }] };
        }
        return { data: bundle };
      },
    };
    let pub = await bundleSvc.publishPlugin(plugin, { deps });
    assert.deepStrictEqual({ s: pub.status, v: pub.version }, { s: "published", v: "1.2.0" });
    assert.strictEqual(plugins[0].enabled, true, "bundle is enabled automatically, no prompt");
    pub = await bundleSvc.publishPlugin(plugin, { deps });
    assert.strictEqual(pub.status, "already");

    // CloudTAK < 14.2 skips the upload.
    serverVersion = "14.1.1";
    calls.length = 0;
    pub = await bundleSvc.publishPlugin(plugin, { deps });
    assert.strictEqual(pub.status, "unsupported");
    assert.ok(!calls.some((c) => c.startsWith("POST /api/plugin/bundle")));
    serverVersion = "14.4.1";

    // No release asset => no-bundle, nothing uploaded.
    const none = await bundleSvc.publishPlugin(plugin, { deps: { noCache: true, get: async () => ({ data: [{ tag_name: "v1", assets: [] }] }) } });
    assert.strictEqual(none.status, "no-bundle");

    // Bad sha256 is refused before any upload.
    const badDeps = { ...deps, get: async (url) => (url.includes("api.github.com/repos") ? deps.get(url) : { data: makeBundle({ badSha: true }) }) };
    plugins = [];
    calls.length = 0;
    const bad = await bundleSvc.publishPlugin(plugin, { deps: badDeps });
    assert.strictEqual(bad.status, "failed");
    assert.match(bad.message, /sha256/);
    assert.ok(!calls.some((c) => c.startsWith("POST /api/plugin/bundle")));

    // Remove deletes it by manifest name.
    plugins = [{ id: "id-demo", name: "demo", version: "1.2.0", enabled: true }];
    await bundleSvc.unpublishPlugin("demo");
    assert.strictEqual(plugins.length, 0);

    // ---- API-first install + SSH migration ----
    const marketplace = require("../services/cloudtakMarketplace.service");
    let installed = { plugins: {} };
    let scan = { ok: true, plugins: [] };
    store.readInstalled = () => JSON.parse(JSON.stringify(installed));
    store.writeInstalled = (r) => { installed = JSON.parse(JSON.stringify(r)); };
    store.readScanCache = () => scan;
    store.appendJobLog = undefined;
    const sshCalls = [];
    ssh.runCommand = async (cmd) => { sshCalls.push(cmd); return { ok: true, stdout: "", stderr: "" }; };

    // Fresh install of a bundle-only plugin over the API: no SSH at all.
    plugins = [];
    const realGet = require("axios").get;
    require("axios").get = async (url) => {
      if (url.includes("/commits/")) return { data: { sha: "abc1234567" } };
      if (url.includes("api.github.com/repos")) return deps.get(url);
      if (url.includes("raw.githubusercontent.com")) throw new Error("404");
      return { data: bundle };
    };
    bundleSvc.clearCache();
    try {
      const job = { id: "job1" };
      const r = await marketplace.tryApiInstall(job, plugin);
      assert.strictEqual(r.via, "api");
      assert.strictEqual(r.skipRebuild, true, "no image rebuild for API installs");
      assert.strictEqual(sshCalls.length, 0, "no SSH used");
      assert.strictEqual(installed.plugins.demo.installMethod, "api");
      assert.strictEqual(installed.plugins.demo.bundleName, "demo");

      // Uninstall of an API-installed plugin: bundle deleted, no SSH, no rebuild.
      const un = await marketplace.performUninstall(job, "demo", plugin);
      assert.strictEqual(un.via, "api");
      assert.strictEqual(installed.plugins.demo, undefined);
      assert.strictEqual(plugins.length, 0);
      assert.strictEqual(sshCalls.length, 0);

      // A plugin with routes is not handled by the API path (falls back to SSH).
      assert.strictEqual(await marketplace.tryApiInstall(job, { ...plugin, routes: { source: "server" } }), null);

      // phoneStatus strings
      const ps = (o) => marketplace.phoneStatus({ plugin, apiOn: true, serverVer: "14.4.1", ...o });
      assert.strictEqual(ps({ apiOn: false }).code, "no-token");
      assert.strictEqual(ps({ serverVer: "14.1.1" }).code, "needs-version");
      assert.strictEqual(ps({ rec: { bundleName: "demo", bundleVersion: "1.2.0" } }).code, "published");
      assert.strictEqual(ps({ bundle: { version: "1.2.0" } }).code, "available");
      assert.strictEqual(ps({}).code, "none");

      // SSH-installed plugin + new phone-capable release => Update appears (migration to the API).
      installed = { plugins: { demo: { sha: "abc1234567", dest: "demo", installedAt: "2026-01-01" } } };
      bundleSvc.clearCache();
      const [row] = await marketplace.enrichUpdateShas([
        { id: "demo", installed: true, catalog: plugin, scan: null, installedVersion: "" },
      ]);
      assert.strictEqual(row.updateAvailable, true, "update offered even though the commit is unchanged");
      assert.strictEqual(row.migratesToApi, true);
      // Already on the API: no migration prompt.
      installed.plugins.demo.installMethod = "api";
      const [row2] = await marketplace.enrichUpdateShas([
        { id: "demo", installed: true, catalog: plugin, scan: null, installedVersion: "" },
      ]);
      assert.ok(!row2.migratesToApi);
      assert.strictEqual(row2.updateAvailable, false);
      // API-managed plugins: updates come from CloudTAK's own plugin list vs the latest bundle.
      installed.plugins.demo = { sha: "abc1234567", dest: "demo", installMethod: "api", bundleName: "demo", bundleVersion: "1.1.0" };
      const apiRow = async () => (await marketplace.enrichUpdateShas([
        { id: "demo", installed: true, catalog: plugin, scan: null, installedVersion: "" },
      ]))[0];
      plugins = [{ id: "id-demo", name: "demo", version: "1.1.0", enabled: true }];
      let ar = await apiRow();
      assert.strictEqual(ar.updateAvailable, true, "server has 1.1.0, release bundle is 1.2.0");
      assert.deepStrictEqual({ i: ar.installedVersion, r: ar.remoteVersion }, { i: "1.1.0", r: "1.2.0" });
      plugins = [{ id: "id-demo", name: "demo", version: "1.2.0", enabled: true }];
      assert.strictEqual((await apiRow()).updateAvailable, false, "server already on the release version");
      plugins = [];
      assert.strictEqual((await apiRow()).updateAvailable, true, "removed from CloudTAK outside TAK Portal: republish");
      const checkSrc = require("fs").readFileSync(require("path").join(__dirname, "..", "routes", "cloudtakMarketplace.routes.js"), "utf8");
      assert.match(checkSrc, /canSkipHostScan\(\) \? \{ ok: true, skipped: true \} : await marketplace\.scanHost\(\)/);
      // Host scan is skipped only when the API is set up and every installed plugin runs through it.
      assert.strictEqual(marketplace.canSkipHostScan(), true);
      installed.plugins.other = { sha: "x", dest: "other", installedAt: "2026-01-01" };
      assert.strictEqual(marketplace.canSkipHostScan(), false, "an SSH-installed plugin still needs the scan");
      delete installed.plugins.other;
      const viewSrc = require("fs").readFileSync(require("path").join(__dirname, "..", "views", "cloudtak-marketplace.ejs"), "utf8");
      assert.ok(!/adds phone app support/i.test(viewSrc), "update button never says it adds phone app support");
      // The migration runs the old-file cleanup after publishing (source check).
      const svcSrc = require("fs").readFileSync(require("path").join(__dirname, "..", "services", "cloudtakMarketplace.service.js"), "utf8");
      const iPub = svcSrc.indexOf("cloudtakBundle.publishPlugin(plugin, { serverVersion })");
      const iUn = svcSrc.indexOf("performUninstall(job, plugin.web.dest, plugin, { keepBundle: true })");
      assert.ok(iPub > 0 && iUn > iPub, "bundle is published before the old SSH files are removed");
    } finally {
      require("axios").get = realGet;
    }

    // ---- user sync (#132) ----
    calls.length = 0;
    assert.strictEqual(userSync.setDisabled, undefined, "disable never touches the CloudTAK profile");
    const usersSrc = require("fs").readFileSync(require("path").join(__dirname, "..", "services", "users.service.js"), "utf8");
    assert.ok(!/cloudtakUserSync\.setDisabled/.test(usersSrc), "toggleUserActive does not call CloudTAK");
    assert.ok(/cloudtakUserSync\.erase\(/.test(usersSrc), "deleteUser erases the CloudTAK profile");
    let r = await userSync.erase("alice");
    assert.strictEqual(r.ok, true);
    assert.ok(calls.includes("DELETE /api/user/alice?username=alice"));
    r = await userSync.erase("ghost");
    assert.deepStrictEqual({ ok: r.ok, found: r.found }, { ok: true, found: false }, "404 counts as done");
    r = await userSync.erase("broken");
    assert.strictEqual(r.ok, false, "CloudTAK errors are reported, never thrown");
    settings = { ...settings, CLOUDTAK_USER_SYNC: false };
    assert.strictEqual((await userSync.erase("alice")).skipped, true, "switch off skips");
    settings = { ...settings, CLOUDTAK_API_TOKEN: "" };
    assert.strictEqual((await userSync.erase("alice")).skipped, true, "no token skips");
  } finally {
    restore();
  }
  console.log("cloudtakApi tests passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
