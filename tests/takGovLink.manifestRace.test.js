/**
 * Proof for #136: TAK.gov "unlinks" when a keepalive token refresh and a catalog
 * write race on plugin-manifest.json (lost refresh token → invalid_grant → clear).
 *
 * Also proves Plugin Manager re-syncs Unlink/Link UI after sessionExpired.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const serviceSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "plugins.service.js"),
  "utf8"
);
const viewSrc = fs.readFileSync(
  path.join(__dirname, "..", "views", "plugin-manager.ejs"),
  "utf8"
);
const routesSrc = fs.readFileSync(
  path.join(__dirname, "..", "routes", "plugins.routes.js"),
  "utf8"
);

/** Same mutex shape as withCatalogLock in plugins.service.js */
function makeMutex() {
  let chain = Promise.resolve();
  return function withLock(fn) {
    const run = chain.then(
      () => fn(),
      () => fn()
    );
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Reproduces the pre-fix lost-update: refresh reads, catalog reads, refresh
 * writes token-B, catalog writes stale token-A + new plugin.
 */
async function simulateUnlockedLostRefreshToken(dir) {
  const file = path.join(dir, "plugin-manifest.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        takGovLink: { linked: true, refreshToken: "token-A" },
        plugins: [],
      },
      null,
      2
    )
  );

  const catalogHasStaleSnap = deferred();
  const refreshWroteB = deferred();

  const refresh = (async () => {
    const snap = JSON.parse(fs.readFileSync(file, "utf8"));
    await catalogHasStaleSnap.promise;
    snap.takGovLink = {
      ...snap.takGovLink,
      refreshToken: "token-B",
      lastRefreshAt: Date.now(),
    };
    fs.writeFileSync(file, JSON.stringify(snap, null, 2));
    refreshWroteB.resolve();
  })();

  const catalog = (async () => {
    const snap = JSON.parse(fs.readFileSync(file, "utf8"));
    snap.plugins.push({ id: "plugin-1", name: "Demo" });
    catalogHasStaleSnap.resolve();
    await refreshWroteB.promise;
    fs.writeFileSync(file, JSON.stringify(snap, null, 2));
  })();

  await Promise.all([refresh, catalog]);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Fix pattern: shared mutex + re-read before write (persistTakGovLink / withCatalogLock).
 */
async function simulateLockedPreservesRefreshToken(dir) {
  const file = path.join(dir, "plugin-manifest.json");
  const withLock = makeMutex();
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        takGovLink: { linked: true, refreshToken: "token-A" },
        plugins: [],
      },
      null,
      2
    )
  );

  const refresh = withLock(() => {
    const latest = JSON.parse(fs.readFileSync(file, "utf8"));
    latest.takGovLink = {
      ...latest.takGovLink,
      refreshToken: "token-B",
      lastRefreshAt: Date.now(),
    };
    fs.writeFileSync(file, JSON.stringify(latest, null, 2));
  });

  const catalog = withLock(() => {
    const latest = JSON.parse(fs.readFileSync(file, "utf8"));
    latest.plugins = [...(latest.plugins || []), { id: "plugin-1", name: "Demo" }];
    fs.writeFileSync(file, JSON.stringify(latest, null, 2));
  });

  await Promise.all([refresh, catalog]);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "takgov-race-"));
  try {
    const lost = await simulateUnlockedLostRefreshToken(tmp);
    assert.strictEqual(
      lost.takGovLink.refreshToken,
      "token-A",
      "unlocked race should overwrite rotated refresh token (reproduces #136)"
    );
    assert.strictEqual(lost.plugins.length, 1, "catalog plugin should still be present after race");

    const kept = await simulateLockedPreservesRefreshToken(tmp);
    assert.strictEqual(
      kept.takGovLink.refreshToken,
      "token-B",
      "shared manifest lock must keep rotated refresh token"
    );
    assert.strictEqual(kept.plugins.length, 1, "shared manifest lock must keep catalog plugin");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Source: token persistence goes through persistTakGovLink / withCatalogLock (#136).
  assert.ok(
    serviceSrc.includes("lost-update race was clearing the TAK.gov link (#136)"),
    "plugins.service must document the #136 manifest race"
  );
  assert.ok(
    /persistTakGovLink\s*\(/.test(serviceSrc),
    "plugins.service must expose persistTakGovLink"
  );
  const refreshPersistIdx = serviceSrc.indexOf("Persist rotated refresh token under the same lock");
  assert.ok(refreshPersistIdx > 0, "getTakGovAccessToken must persist under manifest lock");
  assert.ok(
    serviceSrc.slice(refreshPersistIdx, refreshPersistIdx + 400).includes("persistTakGovLink"),
    "successful refresh must call persistTakGovLink"
  );

  const clearIdx = serviceSrc.indexOf("function clearStoredTakGovLink(reason)");
  assert.ok(clearIdx > 0, "clearStoredTakGovLink must exist");
  const clearSlice = serviceSrc.slice(clearIdx, clearIdx + 600);
  assert.ok(
    clearSlice.includes("withCatalogLock"),
    "clearStoredTakGovLink must clear under withCatalogLock"
  );

  const metaIdx = serviceSrc.indexOf("function updatePluginMetadata");
  assert.ok(metaIdx > 0, "updatePluginMetadata must exist");
  assert.ok(
    serviceSrc.slice(metaIdx, metaIdx + 500).includes("withCatalogLock"),
    "updatePluginMetadata must use withCatalogLock"
  );

  // UI: after session expiry, Unlink button must re-sync via loadState (#136 symptom).
  assert.ok(
    viewSrc.includes("resyncTakGovLinkUi"),
    "plugin-manager must re-sync link UI after TAK.gov auth failures"
  );
  assert.ok(
    viewSrc.includes("sessionExpired") && viewSrc.includes("loadState()"),
    "plugin-manager resync must key off sessionExpired and call loadState"
  );

  // API surfaces sessionExpired so the UI can react without parsing error strings alone.
  assert.ok(
    routesSrc.includes("sessionExpired: !!result.sessionExpired"),
    "plugins routes must return sessionExpired on TAK.gov auth failures"
  );

  console.log("PASS takGovLink.manifestRace.test.js");
})().catch((err) => {
  console.error("FAIL takGovLink.manifestRace.test.js:", err && err.stack ? err.stack : err);
  process.exit(1);
});
