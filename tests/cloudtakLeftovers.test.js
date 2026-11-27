"use strict";

/**
 * Leftover check: old SSH files for plugins that moved to the API.
 * Plugins installed over SSH or present on the host must never be listed or removed.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const store = require("../services/cloudtakMarketplace.store");
const svc = require("../services/cloudtakMarketplace.service");

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "catalog", "cloudtak-plugins.json"), "utf8"));
const ids = (catalog.plugins || []).map((p) => p.id).filter(Boolean);
assert.ok(ids.length >= 3, "catalog has plugins");
const [apiId, sshId, hostId] = ids;

const realInstalled = store.readInstalled;
const realScan = store.readScanCache;
store.readInstalled = () => ({
  plugins: {
    [apiId]: { installMethod: "api", dest: apiId },
    [sshId]: { installMethod: "ssh", dest: sshId },
  },
});
// hostId has no record but is found on the host (installed outside TAK Portal).
store.readScanCache = () => ({ plugins: [{ dest: hostId, catalogId: hostId, onDisk: true }] });

try {
  const plan = svc.leftoverPlan();
  const byId = Object.fromEntries(plan.map((e) => [e.id, e]));
  assert.strictEqual(byId[apiId].mode, "api", "API-managed plugin is checked");
  assert.ok(!byId[sshId], "SSH-installed plugin is never checked");
  assert.ok(!byId[hostId], "plugin present on the host is never checked");
  const other = ids.slice(3).find((id) => byId[id]);
  if (other) assert.strictEqual(byId[other].mode, "none", "unrecorded, absent plugin only gets stale-state checks");
  assert.ok(
    plan.every((e) => e.routes.every((f) => f !== `${e.id}.ts` && f !== `${e.dest}.ts`)),
    "bare <id>.ts is never guessed (could be a CloudTAK core route)"
  );

  const checkScript = svc.leftoverScript("/srv/CloudTAK", plan, false);
  assert.ok(!/\brm\s+-rf\b/.test(checkScript), "check mode never deletes");
  assert.ok(checkScript.includes(`"$CT/app/plugins/${apiId}"`), "API-managed web folder is listed");
  assert.ok(!checkScript.includes(`"$CT/app/plugins/${sshId}"`), "SSH plugin folder is not listed");
  assert.ok(!checkScript.includes(`"$CT/app/plugins/${hostId}"`), "host plugin folder is not listed");
  if (other) {
    assert.ok(!new RegExp(`act "${other}\\|web"`).test(checkScript), "web folders are only checked for API-managed plugins");
    assert.ok(checkScript.includes(`[ ! -e "$CT/app/plugins/${other}" ]`), "unrecorded plugin is skipped when a folder exists");
  }
  assert.ok(/LEFTOVER_END/.test(checkScript));

  const cleanScript = svc.leftoverScript("/srv/CloudTAK", plan, true);
  assert.ok(/rm_path\(\)/.test(cleanScript) && /elevate_run/.test(cleanScript), "clean mode removes and can elevate");

  const out = [
    `FOUND\t${apiId}|web\t/srv/CloudTAK/app/plugins/${apiId}\t120`,
    `REMOVED\t${apiId}|route\t/srv/CloudTAK/api/stateless/routes/plugin-${apiId}.ts`,
    `FAILED\t${apiId}|cache\t/home/u/.cache/cloudtak-marketplace/${apiId}`,
    `FOUND\tnot-a-plugin|web\t/x`,
    `FOUND\t${apiId}|bogus\t/x`,
    "LEFTOVER_END",
  ].join("\n");
  const items = svc.parseLeftoverOutput(out, plan);
  assert.deepStrictEqual(items.map((i) => i.state), ["found", "removed", "failed"], "unknown plugins and kinds are ignored");
  assert.strictEqual(items[0].needsRebuild, true);
  assert.strictEqual(items[2].needsRebuild, false);
  assert.strictEqual(items[0].sizeKb, 120);

  const view = fs.readFileSync(path.join(__dirname, "..", "views", "cloudtak-marketplace.ejs"), "utf8");
  assert.ok(view.includes("mpCheckLeftovers") && view.includes("/api/cloudtak-marketplace/leftovers/clean"));
  assert.match(view, /\.mp-leftovers\s*\{[^}]*overflow-wrap/);
  const routes = fs.readFileSync(path.join(__dirname, "..", "routes", "cloudtakMarketplace.routes.js"), "utf8");
  assert.ok(routes.includes('"/leftovers"') && routes.includes('"/leftovers/clean"'));
  console.log("cloudtakLeftovers tests passed");
} finally {
  store.readInstalled = realInstalled;
  store.readScanCache = realScan;
}
