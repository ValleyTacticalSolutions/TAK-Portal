"use strict";

// Issue 181: a failed fresh Marketplace install (e.g. the Print image pull timing out during
// the rebuild) must not leave app/plugins/<dest> behind. The batch runs the uninstall
// script for failed install jobs; update jobs keep their previous copy.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ssh = require("../services/cloudtakMarketplace.ssh");
const store = require("../services/cloudtakMarketplace.store");
const marketplace = require("../services/cloudtakMarketplace.service");

const src = fs.readFileSync(path.join(__dirname, "../services/cloudtakMarketplace.service.js"), "utf8");

// Both failure paths in the batch roll back before recording the failure.
const batch = src.slice(src.indexOf("async function runChangeBatch"), src.indexOf("async function claimAndRunJobs"));
assert.ok(
  /await rollbackFailedInstall\(job\);\s*recordCommandFailure\(job, "FAILED "/.test(batch),
  "install script failure must roll back"
);
assert.ok(
  /for \(const j of succeeded\) \{\s*await rollbackFailedInstall\(j\);/.test(batch),
  "rebuild failure must roll back every install job in the batch"
);

(async () => {
  const origs = {
    resolved: ssh.resolvedCheckoutPath,
    runCommand: ssh.runCommand,
    runBashScript: ssh.runBashScript,
    readInstalled: store.readInstalled,
    writeInstalled: store.writeInstalled,
    withJobs: store.withJobs,
  };
  const scripts = [];
  let installed = { plugins: { print: { error: "x" } } };
  try {
    ssh.resolvedCheckoutPath = () => "/opt/CloudTAK";
    ssh.runCommand = async () => ({ ok: true, stdout: "CHECKOUT_OK\n" });
    ssh.runBashScript = async (script) => {
      scripts.push(String(script));
      return { ok: true, stdout: "", stderr: "" };
    };
    store.readInstalled = () => installed;
    store.writeInstalled = (d) => {
      installed = d;
    };
    store.withJobs = () => {};

    const update = await marketplace.rollbackFailedInstall({ id: "j0", kind: "update", pluginId: "print" });
    assert.strictEqual(update, false, "update jobs are not rolled back");
    assert.strictEqual(scripts.length, 0);

    const ok = await marketplace.rollbackFailedInstall({ id: "j1", kind: "install", pluginId: "print" });
    assert.strictEqual(ok, true);
    assert.strictEqual(scripts.length, 1, "uninstall script runs for a failed fresh install");
    assert.ok(/remove_plugin_dest_all_layouts "\$DEST"/.test(scripts[0]));
    assert.ok(/DEST='?print'?\n/.test(scripts[0]), "script targets the print folder");
    assert.ok(!installed.plugins.print, "installed record dropped");

    // A failing cleanup never throws (the install failure is still recorded by the caller).
    ssh.runBashScript = async () => ({ ok: false, stdout: "", stderr: "boom", message: "boom" });
    const bad = await marketplace.rollbackFailedInstall({ id: "j2", kind: "install", pluginId: "print" });
    assert.strictEqual(bad, false);
  } finally {
    ssh.resolvedCheckoutPath = origs.resolved;
    ssh.runCommand = origs.runCommand;
    ssh.runBashScript = origs.runBashScript;
    store.readInstalled = origs.readInstalled;
    store.writeInstalled = origs.writeInstalled;
    store.withJobs = origs.withJobs;
  }
  console.log("cloudtakMarketplace.issue181 ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
