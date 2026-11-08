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
  const { styleReadyForMarkerLayers } = await loadStyleGate();

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
  const restoreAt = mapJs.indexOf("function tryRestore(attempt)");
  assert.ok(restoreAt > 0, "tryRestore must exist");
  const restoreBody = mapJs.slice(restoreAt, restoreAt + 1200);
  assert.ok(
    restoreBody.includes("styleReadyForMarkerLayers()"),
    "style restore must use the style-document gate"
  );
  assert.ok(
    !restoreBody.includes("map.isStyleLoaded()"),
    "style restore must not wait on isStyleLoaded()"
  );
  assert.ok(
    !restoreBody.includes("removeMarkerLayers()"),
    "a failed restore retry must not wipe marker layers first"
  );
  assert.ok(
    mapJs.includes("map.setMissingStyleImageResolver"),
    "missing mimg icons must resolve before MapLibre logs them"
  );

  const generator = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "generate-map-app.mjs"),
    "utf8"
  );
  assert.ok(
    generator.includes('from "../styleGate"'),
    "map bundle must import the style gate"
  );

  console.log("ok - map style gate");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
