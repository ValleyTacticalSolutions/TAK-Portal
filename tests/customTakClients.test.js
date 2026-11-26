"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ejs = require("ejs");
const svc = require("../services/customTakClients.service");

const root = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

// --- normalization ---
const list = svc.normalizeCustomClients(
  JSON.stringify([
    { name: "Acme TAK", platform: "ios", downloadUrl: "https://testflight.apple.com/join/x", enrollQr: "itak", prefQr: true, urlScheme: "acme://enroll?host={host}&username={username}&token={token}" },
    { name: "Second", platform: "ios" },
    { name: "", platform: "ios" },
    { name: "No web address", platform: "web" },
    { name: "Bad platform", platform: "toaster" },
    { name: "Evil", platform: "android", downloadUrl: "javascript:alert(1)", urlScheme: "javascript://x", iconUrl: "https://x.example/i.png" },
    { name: "Site", platform: "web", downloadUrl: "https://acme.example/app", enrollQr: "standard", prefQr: true, urlScheme: "acme://x" },
  ])
);
assert.deepStrictEqual(list.map((c) => c.name), ["Acme TAK", "Second", "Evil", "Site"]);
assert.strictEqual(list[0].enrollQr, "itak");
assert.strictEqual(list[0].prefQr, true);
assert.strictEqual("recommended" in list[0], false, "star lives in the platform recommended setting");
assert.strictEqual(list[2].downloadUrl, "", "javascript: download link dropped");
assert.strictEqual(list[2].urlScheme, "", "javascript: scheme dropped");
assert.strictEqual("iconUrl" in list[2], false, "icons are not supported");
const settingsView = fs.readFileSync(path.join(__dirname, "..", "views", "settings.ejs"), "utf8");
assert.ok(!/ccIcon|Icon URL/.test(settingsView), "no icon field in custom client editor");
assert.ok(settingsView.includes('<option value="standard">Standard / ATAK</option>'), "enrollment QR option reads Standard / ATAK");
assert.strictEqual(list[3].enrollQr, "none", "web clients have no enrollment QR");
assert.strictEqual(list[3].prefQr, false);
assert.strictEqual(list[3].urlScheme, "");
assert.ok(/^[a-z0-9_-]{1,40}$/.test(list[0].id));
assert.strictEqual(new Set(list.map((c) => c.id)).size, list.length);
assert.deepStrictEqual(svc.normalizeCustomClients("not json"), []);
assert.deepStrictEqual(svc.normalizeCustomClients(null), []);
assert.strictEqual(
  svc.normalizeCustomClients(Array.from({ length: 40 }, (_, i) => ({ name: "n" + i, platform: "pc" }))).length,
  svc.MAX_CLIENTS
);
assert.deepStrictEqual(svc.enabledForPlatform([{ name: "a", platform: "pc", enabled: false }, { name: "b", platform: "pc" }], "pc").map((c) => c.name), ["b"]);

// --- Open In App url ---
assert.strictEqual(
  svc.buildOpenInAppUrl("myapp://enroll?host={host}&username={username}&token={token}", { host: "tak.example.com", username: "a b", token: "t&k" }),
  "myapp://enroll?host=tak.example.com&username=a%20b&token=t%26k"
);
assert.strictEqual(svc.buildOpenInAppUrl("https://evil", {}), "");

// --- card template escapes admin text ---
const [card] = svc.normalizeCustomClients([
  { id: "x1", name: "<script>alert(1)</script>", platform: "ios", downloadUrl: "https://a.example/\"onmouseover=\"x", instructions: "<img src=x onerror=y>", enrollQr: "standard", prefQr: true, urlScheme: "acme://e" },
]);
const html = ejs.render(read("views", "partials", "custom_client_card.ejs"), { c: card });
assert.ok(!/<script>alert/.test(html) && !/<img src=x/.test(html), "admin text is escaped");
assert.ok(html.includes('data-custom-enroll="x1"') && html.includes('data-custom-pref="x1"'));
assert.ok(html.includes("Step 1: Download") && html.includes("Step 2: Enroll") && html.includes("Step 3: Configure"));

// --- wiring ---
const server = read("server.js");
assert.ok(/key === "CUSTOM_TAK_CLIENTS"[\s\S]{0,200}serializeCustomClients/.test(server), "settings save normalizes custom clients");
assert.ok(/customClients:[\s\S]{0,200}normalizeCustomClients/.test(server), "setup page gets custom clients");
const view = read("views", "setup-my-device.ejs");
for (const k of ["ALLOWED_CLIENT_ORDER_IOS", "ALLOWED_CLIENT_ORDER_ANDROID", "ALLOWED_CLIENT_ORDER_WEB", "ALLOWED_CLIENT_ORDER_PC"]) {
  assert.ok(view.includes(k), `${k} orders cards`);
}
assert.strictEqual((view.match(/customByAppId\[appId\]\) \{ %>/g) || []).length, 4, "custom cards render inside each platform's ordered loop");
assert.ok(view.includes('recommendedByPlatform[c.platform] === "custom:" + c.id'), "star picks the recommended custom card");
assert.ok(view.includes('replace(/</g, "\\\\u003c")'), "embedded custom client JSON escapes <");
const settings = read("views", "settings.ejs");
assert.ok(settings.includes('name="settings[CUSTOM_TAK_CLIENTS]"'));
const routes = read("routes", "setupDevice.routes.js");
assert.ok(/host: qrSvc\.getTakHost\(\)/.test(routes) && routes.includes("customClientId"));
assert.ok(read("services", "backup", "catalog.js").includes('"CUSTOM_TAK_CLIENTS"'), "included in backups");

// --- mobile CSS ---
const css = read("public", "styles.css");
assert.ok(/@media \(max-width: 640px\)\s*\{\s*\.customClientsGrid\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/.test(css));
assert.ok(/\.settings-custom-client-actions\s*\{[^}]*flex-wrap: wrap/.test(css));
assert.ok(/data-custom-client-id\]\s*\.settings-allowed-client-row\s*\{[^}]*flex-wrap: wrap/.test(css), "custom rows wrap on phones");

// --- uploaded file as download source ---
const up = svc.normalizeCustomClients([
  { name: "Apk", platform: "android", downloadUrl: "/api/custom-clients/file/0123456789abcdef", fileName: "my app<1>.apk" },
  { name: "Bad path", platform: "android", downloadUrl: "/api/custom-clients/file/../../etc/passwd", fileName: "x.apk" },
  { name: "Other path", platform: "android", downloadUrl: "/admin" },
]);
assert.strictEqual(up[0].downloadUrl, "/api/custom-clients/file/0123456789abcdef");
assert.strictEqual(up[0].fileName, "my app_1_.apk", "file name is sanitized");
assert.strictEqual(up[1].downloadUrl, "", "path traversal rejected");
assert.strictEqual(up[2].downloadUrl, "", "arbitrary portal paths rejected");
assert.strictEqual(svc.normalizeCustomClients([{ name: "L", platform: "android", downloadUrl: "https://a.example/x.apk", fileName: "x.apk" }])[0].fileName, "", "file name only kept for uploads");
assert.ok(svc.ALLOWED_FILE_EXT.test("a.apk") && svc.ALLOWED_FILE_EXT.test("a.IPA") && !svc.ALLOWED_FILE_EXT.test("a.html") && !svc.ALLOWED_FILE_EXT.test("a.js"));
assert.strictEqual(svc.getFileForDownload("../etc", up), null);
assert.strictEqual(svc.getFileForDownload("0123456789abcdef", up), null, "missing file on disk");
assert.ok(/custom-clients\/file\/:id/.test(server) && /pruneUnreferencedFiles/.test(server), "download route and pruning wired");
assert.ok(/\/api\/settings\/custom-clients"[\s\S]{0,120}requirePermission\("page\.settings"\)/.test(server), "upload route is admin only");
assert.ok(settings.includes('id="ccUpload"') && settings.includes("/api/settings/custom-clients/upload"), "editor has file upload");
assert.ok(!/Add your own TAK client app\. Each enabled client appears[\s\S]{0,60}<\/p>/.test(settings) && settings.includes("ccTip("), "help text lives in ? hovers");

// --- custom clients live in the platform blocks like built-in clients ---
assert.ok(!/id="customClientsList"|Custom Clients <%-/.test(settings), "no separate Custom Clients list");
assert.strictEqual((settings.match(/const customDef = customById\(appId\)/g) || []).length, 4, "custom rows render in each platform block");
assert.ok(settings.includes('"custom:" + c.id') && settings.includes("custom: customDef"), "custom rows use the same star/order ids");
const rowTpl = settings.slice(settings.indexOf("renderAllowedClientApp(opts)") === -1 ? settings.indexOf("function renderAllowedClientApp") : settings.indexOf("function renderAllowedClientApp"));
assert.ok(rowTpl.includes("data-allowed-client-star") && rowTpl.includes("settings-allowed-client-grip") && rowTpl.includes("data-settings-bool-toggle"), "same handle, star and toggle");
assert.ok(rowTpl.includes("data-custom-client-edit") && rowTpl.includes("data-custom-client-remove"), "custom rows have Edit and Remove");
assert.ok(!/Up<\/|"Down"|btn\("Up"/.test(settings), "no Up/Down buttons, the handle moves them");

// --- settings modal stays inside the screen on short windows ---
assert.ok(
  /@media \(max-height: 900px\) and \(min-width: 991px\)\s*\{\s*\.settings-modal-overlay\s*\{[^}]*overflow: hidden[^}]*\}\s*\.settings-modal\s*\{[^}]*max-height: 100%/.test(css),
  "settings modal is capped to the overlay; only its body scrolls"
);

console.log("customTakClients tests passed");
