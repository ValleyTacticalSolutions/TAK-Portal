const fs = require("fs");
const path = require("path");

const MAP_DIST_JS = path.join(__dirname, "..", "public", "dist", "map.js");
const MAP_DIST_WORKER = path.join(__dirname, "..", "public", "dist", "map.worker.js");
const MAP_CSS = path.join(__dirname, "..", "public", "map.css");
const MAP_BASEMAPS_JS = path.join(__dirname, "..", "public", "mapBasemaps.js");
const SHAPE_DECOR_JS = path.join(__dirname, "..", "public", "shapeDecorFilter.js");
const MAPLIBRE_BOOTSTRAP = path.join(
  __dirname,
  "..",
  "public",
  "vendor",
  "maplibre-gl",
  "maplibre-bootstrap.mjs"
);
const MAPLIBRE_CSS = path.join(__dirname, "..", "public", "vendor", "maplibre-gl", "maplibre-gl.css");
const MAPLIBRE_WORKER = path.join(
  __dirname,
  "..",
  "public",
  "vendor",
  "maplibre-gl",
  "maplibre-gl-worker.mjs"
);
const DASHBOARD_MINI = path.join(__dirname, "..", "public", "dashboardMiniMap.js");

const CDN_MAPLIBRE = "https://unpkg.com/maplibre-gl@6.16.0/dist";

function fileMtimeToken(filePath) {
  try {
    return String(Math.trunc(fs.statSync(filePath).mtimeMs));
  } catch (_) {
    return "0";
  }
}

/** Fresh URLs for map page assets; busts cache when dist/css change on disk. */
function getRenderLocals() {
  const mapToken = fileMtimeToken(MAP_DIST_JS);
  const vendored = fs.existsSync(MAPLIBRE_BOOTSTRAP);
  return {
    mapJsUrl: `/dist/map.js?v=${mapToken}`,
    mapWorkerJsUrl: `/dist/map.worker.js?v=${fileMtimeToken(MAP_DIST_WORKER)}`,
    mapBasemapsJsUrl: `/mapBasemaps.js?v=${fileMtimeToken(MAP_BASEMAPS_JS)}`,
    shapeDecorFilterJsUrl: `/shapeDecorFilter.js?v=${fileMtimeToken(SHAPE_DECOR_JS)}`,
    mapCssUrl: `/map.css?v=${fileMtimeToken(MAP_CSS)}`,
    // MapLibre 6: ESM bootstrap (sets window.maplibregl + worker URL). Load as type=module.
    maplibreJsUrl: vendored
      ? `/vendor/maplibre-gl/maplibre-bootstrap.mjs?v=${fileMtimeToken(MAPLIBRE_BOOTSTRAP)}`
      : `${CDN_MAPLIBRE}/maplibre-gl.mjs`,
    maplibreWorkerJsUrl: vendored
      ? `/vendor/maplibre-gl/maplibre-gl-worker.mjs?v=${fileMtimeToken(MAPLIBRE_WORKER)}`
      : `${CDN_MAPLIBRE}/maplibre-gl-worker.mjs`,
    maplibreCssUrl: fs.existsSync(MAPLIBRE_CSS)
      ? `/vendor/maplibre-gl/maplibre-gl.css?v=${fileMtimeToken(MAPLIBRE_CSS)}`
      : `${CDN_MAPLIBRE}/maplibre-gl.css`,
    dashboardMiniMapJsUrl: `/dashboardMiniMap.js?v=${fileMtimeToken(DASHBOARD_MINI)}`,
    // Overlays are bundled into dist/map.js
    mapMissionsJsUrl: "",
    mapPackagesJsUrl: "",
    mapGeofencesJsUrl: "",
  };
}

module.exports = {
  getRenderLocals,
};
