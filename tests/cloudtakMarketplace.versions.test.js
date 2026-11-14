"use strict";

// #113: plugin version bubble. Only plugins that really have a version get one.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const axios = require("axios");
const m = require("../services/cloudtakMarketplace.service");

// cleanPluginVersion keeps plain versions and drops junk.
assert.strictEqual(m.cleanPluginVersion("1.2.3"), "1.2.3");
assert.strictEqual(m.cleanPluginVersion("v2.0.0"), "2.0.0");
assert.strictEqual(m.cleanPluginVersion("0.1.4-ccso"), "0.1.4-ccso");
assert.strictEqual(m.cleanPluginVersion(""), "");
assert.strictEqual(m.cleanPluginVersion(undefined), "");
assert.strictEqual(m.cleanPluginVersion("<script>alert(1)</script>"), "");
assert.strictEqual(m.cleanPluginVersion({ a: 1 }), "");

// Bubble: nothing without a version.
assert.strictEqual(m.pluginVersionBubble({ installed: false }).label, "");
assert.strictEqual(m.pluginVersionBubble({ installed: true }).label, "");
assert.strictEqual(m.pluginVersionBubble({ installed: false, remoteVersion: "1.1.0" }).label, "v1.1.0");
assert.strictEqual(m.pluginVersionBubble({ installed: true, installedVersion: "1.0.0", remoteVersion: "1.0.0" }).label, "v1.0.0");
assert.strictEqual(
  m.pluginVersionBubble({ installed: true, installedVersion: "1.0.0", remoteVersion: "1.1.0", updateAvailable: true }).label,
  "v1.0.0 → v1.1.0"
);
assert.strictEqual(m.pluginVersionBubble({ installed: true, remoteVersion: "1.1.0" }).label, "Latest v1.1.0");

// Scan: reads version from package.json (root or plugin/), blank when none.
const ct = fs.mkdtempSync(path.join(os.tmpdir(), "ctver-"));
const plugins = path.join(ct, "app", "plugins");
fs.mkdirSync(path.join(ct, "api"), { recursive: true });
fs.mkdirSync(path.join(plugins, "withroot"), { recursive: true });
fs.mkdirSync(path.join(plugins, "withnested", "plugin"), { recursive: true });
fs.mkdirSync(path.join(plugins, "noversion"), { recursive: true });
fs.writeFileSync(path.join(plugins, "withroot", "package.json"), '{\n  "name": "a",\n  "version": "1.2.3"\n}\n');
fs.writeFileSync(path.join(plugins, "withnested", "plugin", "package.json"), '{ "name": "b", "version": "0.4.0" }\n');
fs.writeFileSync(path.join(plugins, "noversion", "index.ts"), "export {}\n");
const out = execFileSync("bash", ["-c", m.scanRemoteScript(ct, [])], { encoding: "utf8" });
const parsed = m.parseScanStdout(out, []);
const by = Object.fromEntries(parsed.plugins.map((p) => [p.dest, p]));
assert.strictEqual(by.withroot.version, "1.2.3");
assert.strictEqual(by.withnested.version, "0.4.0");
assert.strictEqual(by.noversion.version, "");
fs.rmSync(ct, { recursive: true, force: true });

// Remote version: package.json at root, then plugin/; cached; "" when absent.
(async () => {
  const realGet = axios.get;
  const calls = [];
  axios.get = async (url) => {
    calls.push(url);
    if (/\/o1\/r1\/main\/package\.json$/.test(url)) return { data: { version: "3.1.0" } };
    if (/\/o2\/r2\/main\/plugin\/package\.json$/.test(url)) return { data: { version: "1.0.0" } };
    if (/\/o3\/r3\//.test(url)) return { data: { name: "no version here" } };
    throw new Error("404");
  };
  try {
    m.remoteVersionCache.clear();
    const mk = (o, r) => ({ repo: `https://github.com/${o}/${r}.git`, ref: "main" });
    assert.strictEqual(await m.remoteVersionForPlugin(mk("o1", "r1")), "3.1.0");
    assert.strictEqual(await m.remoteVersionForPlugin(mk("o2", "r2")), "1.0.0");
    assert.strictEqual(await m.remoteVersionForPlugin(mk("o3", "r3")), "");
    assert.strictEqual(await m.remoteVersionForPlugin({ repo: "https://example.com/x.git", ref: "main" }), "");
    const n = calls.length;
    assert.strictEqual(await m.remoteVersionForPlugin(mk("o1", "r1")), "3.1.0");
    assert.strictEqual(calls.length, n, "second lookup is served from cache");
  } finally {
    axios.get = realGet;
    m.remoteVersionCache.clear();
  }
  console.log("cloudtakMarketplace versions tests passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
