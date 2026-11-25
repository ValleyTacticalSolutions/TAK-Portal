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
    { name: "Acme TAK", platform: "ios", downloadUrl: "https://testflight.apple.com/join/x", enrollQr: "itak", prefQr: true, urlScheme: "acme://enroll?host={host}&username={username}&token={token}", recommended: true },
    { name: "Second", platform: "ios", recommended: true },
    { name: "", platform: "ios" },
    { name: "No web address", platform: "web" },
    { name: "Bad platform", platform: "toaster" },
    { name: "Evil", platform: "android", downloadUrl: "javascript:alert(1)", urlScheme: "javascript://x", iconUrl: "data:text/html,x" },
    { name: "Site", platform: "web", downloadUrl: "https://acme.example/app", enrollQr: "standard", prefQr: true, urlScheme: "acme://x" },
  ])
);
assert.deepStrictEqual(list.map((c) => c.name), ["Acme TAK", "Second", "Evil", "Site"]);
assert.strictEqual(list[0].enrollQr, "itak");
assert.strictEqual(list[0].prefQr, true);
assert.strictEqual(list[0].recommended, true);
assert.strictEqual(list[1].recommended, false, "only one recommended per platform");
assert.strictEqual(list[2].downloadUrl, "", "javascript: download link dropped");
assert.strictEqual(list[2].urlScheme, "", "javascript: scheme dropped");
assert.strictEqual(list[2].iconUrl, "", "data: icon dropped");
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
for (const k of ["customIos", "customAndroid", "customWeb", "customPc"]) {
  assert.ok(view.includes(`${k}.forEach`), `${k} cards are rendered`);
}
assert.ok(view.includes('replace(/</g, "\\\\u003c")'), "embedded custom client JSON escapes <");
const settings = read("views", "settings.ejs");
assert.ok(settings.includes('name="settings[CUSTOM_TAK_CLIENTS]"'));
const routes = read("routes", "setupDevice.routes.js");
assert.ok(/host: qrSvc\.getTakHost\(\)/.test(routes) && routes.includes("customClientId"));
assert.ok(read("services", "backup", "catalog.js").includes('"CUSTOM_TAK_CLIENTS"'), "included in backups");

// --- mobile CSS ---
const css = read("public", "styles.css");
assert.ok(/@media \(max-width: 640px\)\s*\{\s*\.customClientsGrid\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/.test(css));
assert.ok(/\.customClientsTitle\s*\{[^}]*overflow-wrap: anywhere/.test(css));

console.log("customTakClients tests passed");
