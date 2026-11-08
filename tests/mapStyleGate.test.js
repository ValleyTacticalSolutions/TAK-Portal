/**
 * Desktop map restore must not wait until every tile has loaded.
 * map.isStyleLoaded() stays false for that whole time. A phone viewport
 * finishes quickly; a desktop one misses the 3s fallback and the marker
 * layers get rebuilt (flash) while missing mimg-* icons are logged.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

async function loadStyleGate() {
  const entry = path.join(__dirname, "..", "client", "map", "styleGate.ts");
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node18",
  });
  const code = result.outputFiles[0].text;
  const mod = { exports: {} };
  Function("module", "exports", "require", code)(mod, mod.exports, require);
  return mod.exports;
}

async function run() {
  const { styleReadyForMarkerLayers, iconFetchAllowed } = await loadStyleGate();

  const desktopTilesStillLoading = {
    isStyleLoaded() {
      return false;
    },
    getStyle() {
      return { layers: [{ id: "background" }] };
    },
  };
  assert.strictEqual(
    styleReadyForMarkerLayers(desktopTilesStillLoading),
    true,
    "style document is enough; do not wait for desktop tiles"
  );

  assert.strictEqual(styleReadyForMarkerLayers(null), false);
  assert.strictEqual(
    styleReadyForMarkerLayers({
      isStyleLoaded() {
        return false;
      },
      getStyle() {
        return null;
      },
    }),
    false
  );
  assert.strictEqual(
    styleReadyForMarkerLayers({
      isStyleLoaded() {
        return true;
      },
      getStyle() {
        throw new Error("style swap");
      },
    }),
    false,
    "tile-idle is not a reason to call addImage during a style swap"
  );
  assert.strictEqual(
    styleReadyForMarkerLayers(null, true),
    true,
    "style.load sets the parsed flag before tiles finish"
  );

  const now = 1_000_000;
  assert.strictEqual(iconFetchAllowed(undefined, now, 30000, false), true);
  assert.strictEqual(iconFetchAllowed(undefined, now, 30000, true), false);
  assert.strictEqual(
    iconFetchAllowed({ state: "pending", at: now }, now, 30000, false),
    false
  );
  assert.strictEqual(
    iconFetchAllowed({ state: "installed", at: now }, now, 30000, false),
    false
  );
  assert.strictEqual(
    iconFetchAllowed({ state: "failed", at: now - 1000 }, now, 30000, false),
    false
  );
  assert.strictEqual(
    iconFetchAllowed({ state: "failed", at: now - 30000 }, now, 30000, false),
    true
  );
  assert.strictEqual(
    styleReadyForMarkerLayers({
      isStyleLoaded() {
        return false;
      },
      getStyle() {
        throw new Error("style swap");
      },
    }),
    false
  );

  const mapJs = fs.readFileSync(
    path.join(__dirname, "..", "client", "map", "legacy", "map.js"),
    "utf8"
  );
  assert.ok(!mapJs.includes("style restore fallback"), "the 3s layer rebuild is gone");
  assert.ok(
    !mapJs.includes('map.on("load", function () {\n    restoreMapAfterStyleChange();'),
    "startup must not restore the style twice"
  );
  assert.ok(mapJs.includes("ICON_DB_VERSION = 2"), "icon cache must drop stale v1 rows");
  assert.ok(mapJs.includes("ICON_FAIL_BACKOFF_MS"), "failed icon fetches must cool down");
  assert.ok(
    mapJs.includes("map.setMissingStyleImageResolver"),
    "missing mimg icons must resolve before MapLibre logs them"
  );
  assert.ok(
    mapJs.includes("ok === true"),
    "circles hide only after addImage succeeds"
  );

  const generator = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "generate-map-app.mjs"),
    "utf8"
  );
  assert.ok(
    generator.includes('from "../styleGate"'),
    "map bundle must import the style gate"
  );
  const diffFn = generator.slice(generator.indexOf("function __applyWorkerDiff"));
  const diffBody = diffFn.slice(0, diffFn.indexOf("function __applyWorkerResync"));
  assert.ok(
    !diffBody.includes("markersByUid.values()"),
    "a worker diff must not preload every marker"
  );
  assert.ok(
    diffBody.includes("__markersFromWorkerFeatures(diff.add)"),
    "a worker diff preloads only icons on new features"
  );

  console.log("ok - map style gate");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
