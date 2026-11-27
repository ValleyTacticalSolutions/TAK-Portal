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
assert.ok(ids.length >= 5, "catalog has plugins");
const [apiId, sshId, hostId, hybridId] = ids;

const realInstalled = store.readInstalled;
const realScan = store.readScanCache;
store.readInstalled = () => ({
  plugins: {
    [apiId]: { installMethod: "api", dest: apiId },
    [sshId]: { installMethod: "ssh", dest: sshId },
    // Installed over SSH for its server routes, but the phone bundle is published too.
    [hybridId]: { sha: "abc1234", dest: hybridId, installedAt: "2026-01-01", bundleName: hybridId, bundleVersion: "1.0.0" },
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
  const other = ids.slice(4).find((id) => byId[id]);
  if (other) assert.strictEqual(byId[other].mode, "none", "unrecorded, absent plugin only gets stale-state checks");
  assert.ok(
    plan.every((e) => e.routes.every((f) => f !== `${e.id}.ts` && f !== `${e.dest}.ts`)),
    "bare <id>.ts is never guessed (could be a CloudTAK core route)"
  );

  assert.strictEqual(byId[hybridId].mode, "ssh-bundle", "published SSH plugin has a duplicate web copy");
  const checkScript = svc.leftoverScript("/srv/CloudTAK", plan, false);
  assert.ok(checkScript.includes(`act "${hybridId}|web" "$CT/app/plugins/${hybridId}"`), "duplicate web folder is listed");
  assert.ok(!new RegExp(`act "${hybridId}\\|(route|runtime|overlay|cache)"`).test(checkScript), "routes, runtime, overlay and clone of a running plugin are kept");
  assert.ok(!/\brm\s+-rf\b/.test(checkScript), "check mode never deletes");
  assert.ok(checkScript.includes(`"$CT/app/plugins/${apiId}"`), "API-managed web folder is listed");
  assert.ok(!checkScript.includes(`"$CT/app/plugins/${sshId}"`), "SSH plugin folder is not listed");
  assert.ok(!checkScript.includes(`"$CT/app/plugins/${hostId}"`), "host plugin folder is not listed");
  if (other) {
    assert.ok(!new RegExp(`act "${other}\\|web"`).test(checkScript), "web folders are only checked for API-managed plugins");
    assert.ok(checkScript.includes(`[ ! -e "$CT/app/plugins/${byId[other].dest}" ]`), "unrecorded plugin is skipped when a folder exists");
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

// ---- CloudTAK package.json is put back when a job ends, fails or is cancelled ----
{
  const svcSrc = fs.readFileSync(path.join(__dirname, "..", "services", "cloudtakMarketplace.service.js"), "utf8").replace(/\r\n/g, "\n");
  assert.deepStrictEqual(svc.HOST_PACKAGE_JSON_FILES, ["app/package.json", "api/web/package.json"]);
  const script = svc.restorePackageJsonScript("/srv/CloudTAK");
  assert.ok(/G restore --worktree --staged/.test(script) && /checkout HEAD/.test(script), "restores from git");
  assert.ok(/PKGJSON_SKIP not a git checkout/.test(script), "non-git checkouts are left alone");
  // Runs in the finally of the job runner, so it also runs for failed and cancelled batches.
  const iRun = svcSrc.indexOf("if (changes.length && !_cancelRequested) await runChangeBatch(changes);");
  const iFinally = svcSrc.indexOf("} finally {", iRun);
  const iRestore = svcSrc.indexOf("await restoreHostPackageJson(", iFinally);
  const iUnlock = svcSrc.indexOf("_jobRunning = false;", iFinally);
  assert.ok(iRun > 0 && iFinally > iRun && iRestore > iFinally && iRestore < iUnlock, "restore runs in finally before the runner is released");
  assert.ok(/async function runLoggedScript\(jobIds, script, timeoutMs\) \{\n  _hostScriptRan = true;/.test(svcSrc), "API-only jobs never SSH just to restore");
  console.log("cloudtak package.json restore tests passed");
}

// ---- cleanup is a queued job, and new SSH installs drop the duplicate web copy ----
{
  const svcSrc = fs.readFileSync(path.join(__dirname, "..", "services", "cloudtakMarketplace.service.js"), "utf8").replace(/\r\n/g, "\n");
  const routeSrc = fs.readFileSync(path.join(__dirname, "..", "routes", "cloudtakMarketplace.routes.js"), "utf8");
  assert.ok(typeof svc.queueCleanup === "function" && typeof svc.performCleanup === "function");
  assert.match(svcSrc, /\["install", "update", "uninstall", "update-all", "cleanup"\]\.includes/, "cleanup counts as a change job");
  assert.match(svcSrc, /job\.kind === "cleanup"\) \{\n\s+const c = await performCleanup\(job\);[\s\S]{0,160}needsRebuild = true/, "cleanup rebuilds once when web or route files were removed");
  assert.match(routeSrc, /queueCleanup\(username\(req\)\)/);
  assert.ok(!/marketplace\.cleanLeftovers/.test(routeSrc), "the route no longer deletes inline");
  // After an SSH install publishes the bundle, the compiled-in web copy is removed and a rebuild is forced.
  const iPub = svcSrc.indexOf("return removeCompiledInWeb(job, plugin, ctPath);");
  assert.ok(iPub > svcSrc.indexOf("rec.plugins[plugin.id].bundleVersion = pub.version;"), "web copy is removed only after the bundle is published");
  assert.match(svcSrc, /const skipRebuild = webRemoved\n\s+\? false/, "removal forces a rebuild even if the install script built the image");
  const script = svc.leftoverScript("/srv/CloudTAK", [{ id: "x", name: "X", dest: "x", mode: "ssh-bundle", routes: ["plugin-x.ts"] }], true);
  assert.ok(/rm_path\(\)/.test(script) && !/plugin-x\.ts/.test(script));
  console.log("cloudtak cleanup job tests passed");
}

// ---- the job log sent to the page covers the whole stored log (5000 lines), not the last 120 ----
{
  const routeSrc = fs.readFileSync(path.join(__dirname, "..", "routes", "cloudtakMarketplace.routes.js"), "utf8");
  assert.ok(/log\.length > 5000 \? log\.slice\(-5000\) : log/.test(routeSrc) && !/slice\(-120\)/.test(routeSrc));
  console.log("cloudtak job log limit tests passed");
}
