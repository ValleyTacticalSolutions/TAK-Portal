/**
 * Proof: outbound URL guard refuses metadata/link-local and unconfigured hosts; configured hosts still work.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const settings = require("../services/settings.service");
const g = require("../services/outboundUrl");

const origGet = settings.get;
const conf = { TAK_URL: "https://tak.example.mil:8443", AUTHENTIK_URL: "https://auth.example.mil" };
settings.get = (k, fb) => (k in conf ? conf[k] : fb);

(async () => {
  // refused
  for (const bad of [
    "http://169.254.169.254/latest/meta-data/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://evil.example.com/",
    "file:///etc/passwd",
    "ftp://tak.example.mil/",
    "not a url",
  ]) {
    assert.throws(() => g.assertOutboundUrl(bad), (e) => e.code === "OUTBOUND_URL_BLOCKED", `must refuse ${bad}`);
  }
  assert.throws(() => g.assertOutboundUrl("http://169.254.169.254/", { builtin: false }), /not a configured host|blocked/);

  // configured + built-in hosts work
  g.assertOutboundUrl("https://tak.example.mil:8443/Marti/api/missions");
  g.assertOutboundUrl("https://auth.example.mil/api/v3/core/users/");
  g.assertOutboundUrl("https://api.github.com/repos/x/y");
  g.assertOutboundUrl("https://evil.example.com/", { allowHosts: ["evil.example.com"] });

  // a link-local host the admin explicitly configured is allowed
  conf.TAK_URL = "https://169.254.10.10:8443";
  g.assertOutboundUrl("https://169.254.10.10:8443/Marti");
  conf.TAK_URL = "https://tak.example.mil:8443";
  assert.throws(() => g.assertOutboundUrl("https://169.254.10.10:8443/Marti"));

  // resolved check refuses direct metadata IP
  await assert.rejects(g.assertOutboundUrlResolved("http://169.254.169.254/"), /not a configured host|blocked/);

  // fetch guard refuses before any network call, and re-checks redirects
  let called = 0;
  const fakeFetch = async (u) => {
    called++;
    return { status: 302, headers: { get: () => "http://169.254.169.254/latest" } };
  };
  await assert.rejects(g.guardedFetch("http://169.254.169.254/", {}, { fetchImpl: fakeFetch }), /blocked|configured/);
  assert.strictEqual(called, 0, "no request may be made to a refused URL");
  await assert.rejects(g.guardedFetch("https://api.github.com/x", {}, { fetchImpl: fakeFetch }), /blocked|configured/);
  assert.strictEqual(called, 1, "redirect to metadata must be refused");

  // axios guard
  const axios = require("axios");
  const client = g.guardAxios(axios.create({ adapter: async (c) => ({ status: 200, data: "ok", headers: {}, config: c }) }), { builtin: false });
  assert.strictEqual((await client.get("https://tak.example.mil:8443/x")).data, "ok");
  await assert.rejects(client.get("http://169.254.169.254/latest"), /blocked|configured/);
  await assert.rejects(client.get("https://api.github.com/x"), /not a configured host/);

  // guardedAxios drop-in refuses before calling axios
  const calls = [];
  const fakeAxios = { get: async (u) => { calls.push(u); return { data: 1 }; }, post: async (u) => { calls.push(u); return { data: 1 }; } };
  await assert.rejects(g.guardedAxios(fakeAxios).get("http://169.254.169.254/latest"), /blocked|configured/);
  await assert.rejects(g.guardedAxios(fakeAxios).post("http://evil.example.com/", "x"), /configured/);
  assert.strictEqual(calls.length, 0);
  await g.guardedAxios(fakeAxios).get("https://api.github.com/x");
  assert.strictEqual(calls.length, 1);

  // every outbound caller is routed through the guard
  const root = path.join(__dirname, "..");
  for (const f of [
    "services/takwerxPlugins.service.js", "services/geocode.service.js", "services/locatorReport.service.js",
    "services/takBeaconDownload.service.js", "services/openaddresses.service.js", "services/plugins.service.js",
    "services/sms.service.js", "services/cloudtakMarketplace.service.js", "services/tak.service.js",
    "services/takMetrics.service.js", "services/authentik.js", "worker.js", "server.js",
  ]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    assert.match(src, /outboundUrl/, `${f} must use the outbound URL guard`);
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ""), /[^.\w](?<!guarded)fetch\(|\baxios\.(get|post|put|delete|request)\(/, `${f} has an unguarded fetch/axios call`);
  }
  settings.get = origGet;
  console.log("outboundUrl.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
